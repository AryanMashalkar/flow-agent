import { createServer } from 'node:http';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { Agent, type AgentEvent } from './agent.ts';
import { llmFromEnv } from './llm.ts';
import { allTools } from './tools.ts';
import type { Plan } from './plan.ts';
import { MeetingBoard, parseMeetingCommand } from './meeting.ts';
import { startFromDefaultBranch } from './git.ts';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(appRoot, '.env'));
} catch {
  // No .env file: fall back to the real environment.
}

const workspace = path.resolve(process.env.WORKSPACE || process.cwd());
const port = Number(process.env.PORT) || 4242;
let llm: ReturnType<typeof llmFromEnv>;
try {
  llm = llmFromEnv();
} catch (err) {
  console.error(`\n  ${(err as Error).message}\n`);
  process.exit(1);
}
const agent = new Agent({ llm, tools: allTools(workspace) });

const metrics = { wordsDictated: 0, instructions: 0, interruptions: 0, toolCalls: 0, filesChanged: 0, testRuns: 0, replans: 0, prsOpened: 0, startedAt: Date.now() };
const changedFiles = new Set<string>();
let lastPlan: Plan | null = null;
/** Identifies this conversation; the browser keeps its history under it. Changes on a new session. */
let sessionId = Date.now();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

/** Every instruction, as said, goes to logs/dictation.jsonl. `npm run dictation-log` turns it into a shareable page. */
const dictationLog = path.join(appRoot, 'logs', 'dictation.jsonl');
async function logInstruction(entry: { text: string; source: string; interrupt: boolean }): Promise<void> {
  try {
    await mkdir(path.dirname(dictationLog), { recursive: true });
    await appendFile(dictationLog, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
  } catch (err) {
    console.warn(`  Could not write the dictation log: ${(err as Error).message}`);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(appRoot, 'public', path.normalize(name));
  if (!file.startsWith(path.join(appRoot, 'public'))) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    // no-cache: after a `git pull` the browser must pick up the new UI, not a stale copy.
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' }).end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });
// Listen errors surface on the http server below; the WebSocket server only re-emits them.
wss.on('error', () => {});

function broadcast(msg: unknown): void {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) if (client.readyState === client.OPEN) client.send(data);
}

const board = new MeetingBoard(
  llm,
  agent,
  (b) => broadcast(meetingState(b)),
  async () => {
    // Each meeting task gets its own branch off the default branch. Not a git repo: nothing to do.
    const note = await startFromDefaultBranch(workspace).catch(() => '');
    if (note) broadcast({ type: 'notice', text: note });
  },
);

function meetingState(b: MeetingBoard) {
  return { type: 'meeting', name: b.name, tasks: b.tasks };
}

async function loadTranscript(name: string, text: string): Promise<void> {
  broadcast({ type: 'notice', text: `Reading the meeting transcript "${name}"…` });
  try {
    const tasks = await board.load(name, text, AbortSignal.timeout(120_000));
    const code = tasks.filter((t) => t.kind === 'code').length;
    broadcast({
      type: 'say',
      text: tasks.length
        ? `I found ${tasks.length} action item${tasks.length === 1 ? '' : 's'} in the meeting, ${code} of them code. Say "do task 1", or "do all code tasks".`
        : 'I could not find any action items in that meeting.',
    });
  } catch (err) {
    broadcast({ type: 'error', message: `Could not read the transcript: ${(err as Error).message}` });
  }
}

async function newSession(): Promise<void> {
  board.clear();
  await agent.reset();
  Object.assign(metrics, { wordsDictated: 0, instructions: 0, interruptions: 0, toolCalls: 0, filesChanged: 0, testRuns: 0, replans: 0, prsOpened: 0, startedAt: Date.now() });
  changedFiles.clear();
  lastPlan = null;
  sessionId = Date.now();
  broadcast({ type: 'session', session: sessionId });
  broadcast({ type: 'status', running: false });
  broadcast({ type: 'metrics', model: llm.label, ...metrics });
}

agent.on('event', (e: AgentEvent) => {
  if (e.type === 'tool') {
    metrics.toolCalls++;
    if (e.name === 'run_command') metrics.testRuns++;
  }
  if (e.type === 'plan' && e.plan.replanned) metrics.replans++;
  if (e.type === 'plan') lastPlan = e.plan;
  if (e.type === 'pull_request') metrics.prsOpened++;
  if (e.type === 'file_changed') {
    changedFiles.add(e.path);
    metrics.filesChanged = changedFiles.size;
  }
  broadcast(e);
  if (e.type === 'tool' || e.type === 'user' || e.type === 'file_changed' || e.type === 'status' || e.type === 'plan' || e.type === 'pull_request') {
    broadcast({ type: 'metrics', model: llm.label, ...metrics });
  }
});

wss.on('connection', (ws: WebSocket) => {
  ws.send(JSON.stringify({ type: 'hello', workspace, model: llm.label, running: agent.busy, session: sessionId }));
  ws.send(JSON.stringify({ type: 'metrics', model: llm.label, ...metrics }));
  // A page opened mid-task still sees the current plan, but not as a fresh re-plan.
  if (lastPlan) ws.send(JSON.stringify({ type: 'plan', plan: { ...lastPlan, replanned: false } }));
  if (board.tasks.length) ws.send(JSON.stringify(meetingState(board)));
  ws.on('message', (raw) => {
    let msg: { type?: string; text?: string; name?: string; id?: number; all?: boolean; source?: string };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === 'command' && msg.text?.trim()) {
      const text = msg.text.trim();
      metrics.instructions++;
      metrics.wordsDictated += text.split(/\s+/).length;
      void logInstruction({ text, source: msg.source === 'typed' ? 'typed' : msg.source === 'dictated' ? 'dictated' : 'unknown', interrupt: agent.busy });
      const meetingCmd = board.tasks.length ? parseMeetingCommand(text) : null;
      if (meetingCmd) {
        const ids = board.run(meetingCmd);
        broadcast({ type: 'user', text, interrupt: false });
        broadcast({ type: 'notice', text: ids.length ? `Queued meeting task ${ids.join(', ')}.` : 'No matching meeting task to run.' });
        return;
      }
      if (agent.busy) metrics.interruptions++;
      void agent.submit(text);
    } else if (msg.type === 'stop') {
      board.cancel();
      void agent.stop();
    } else if (msg.type === 'new_session') {
      void newSession();
    } else if (msg.type === 'transcript' && msg.text?.trim()) {
      void loadTranscript(msg.name?.trim() || 'Meeting', msg.text);
    } else if (msg.type === 'run_task') {
      board.run(msg.all ? { kind: 'all' } : { kind: 'one', id: Number(msg.id) });
    }
  });
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`\n  Port ${port} is busy. Flow Agent is probably already running: close that window, or set PORT in .env.\n`);
  process.exit(1);
});

server.listen(port, () => {
  console.log(`\n  Flow Agent is listening on http://localhost:${port}`);
  console.log(`  Workspace: ${workspace}`);
  console.log(`  Model:     ${llm.label}\n`);
  if (process.env.WARMUP !== '0') void warmUp();
});

/** One tiny request at startup, so the first spoken instruction doesn't hit a cold or busy model. */
async function warmUp(): Promise<void> {
  const started = Date.now();
  try {
    await llm.chat([{ role: 'user', content: 'Reply with the single word OK.' }], [], AbortSignal.timeout(90_000));
    console.log(`  Model ready (${((Date.now() - started) / 1000).toFixed(1)}s): ${llm.label}\n`);
    broadcast({ type: 'metrics', model: llm.label, ...metrics });
  } catch (err) {
    console.log(`  Warm-up failed: ${(err as Error).message}\n`);
  }
}
