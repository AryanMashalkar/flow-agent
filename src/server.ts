import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { Agent, type AgentEvent } from './agent.ts';
import { llmFromEnv } from './llm.ts';
import { allTools } from './tools.ts';
import type { Plan } from './plan.ts';
import { MeetingBoard, parseMeetingCommand } from './meeting.ts';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(appRoot, '.env'));
} catch {
  // No .env file: fall back to the real environment.
}

const workspace = path.resolve(process.env.WORKSPACE || process.cwd());
const port = Number(process.env.PORT) || 4242;
const llm = llmFromEnv();
const agent = new Agent({ llm, tools: allTools(workspace) });

const metrics = { wordsDictated: 0, instructions: 0, interruptions: 0, toolCalls: 0, filesChanged: 0, testRuns: 0, replans: 0, prsOpened: 0, startedAt: Date.now() };
const changedFiles = new Set<string>();
let lastPlan: Plan | null = null;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

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
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(msg: unknown): void {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) if (client.readyState === client.OPEN) client.send(data);
}

const board = new MeetingBoard(llm, agent, (b) => broadcast(meetingState(b)));

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
  ws.send(JSON.stringify({ type: 'hello', workspace, model: llm.label, running: agent.busy }));
  ws.send(JSON.stringify({ type: 'metrics', model: llm.label, ...metrics }));
  // A page opened mid-task still sees the current plan, but not as a fresh re-plan.
  if (lastPlan) ws.send(JSON.stringify({ type: 'plan', plan: { ...lastPlan, replanned: false } }));
  if (board.tasks.length) ws.send(JSON.stringify(meetingState(board)));
  ws.on('message', (raw) => {
    let msg: { type?: string; text?: string; name?: string; id?: number; all?: boolean };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === 'command' && msg.text?.trim()) {
      const text = msg.text.trim();
      metrics.instructions++;
      metrics.wordsDictated += text.split(/\s+/).length;
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
    } else if (msg.type === 'transcript' && msg.text?.trim()) {
      void loadTranscript(msg.name?.trim() || 'Meeting', msg.text);
    } else if (msg.type === 'run_task') {
      board.run(msg.all ? { kind: 'all' } : { kind: 'one', id: Number(msg.id) });
    }
  });
});

server.listen(port, () => {
  console.log(`\n  Flow Agent is listening on http://localhost:${port}`);
  console.log(`  Workspace: ${workspace}`);
  console.log(`  Model:     ${llm.label}\n`);
});
