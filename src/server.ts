import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { Agent, type AgentEvent } from './agent.ts';
import { llmFromEnv } from './llm.ts';
import { allTools } from './tools.ts';

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

const metrics = { wordsDictated: 0, instructions: 0, interruptions: 0, toolCalls: 0, filesChanged: 0, testRuns: 0, startedAt: Date.now() };
const changedFiles = new Set<string>();

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

agent.on('event', (e: AgentEvent) => {
  if (e.type === 'tool') {
    metrics.toolCalls++;
    if (e.name === 'run_command') metrics.testRuns++;
  }
  if (e.type === 'file_changed') {
    changedFiles.add(e.path);
    metrics.filesChanged = changedFiles.size;
  }
  broadcast(e);
  if (e.type === 'tool' || e.type === 'user' || e.type === 'file_changed' || e.type === 'status') {
    broadcast({ type: 'metrics', model: llm.label, ...metrics });
  }
});

wss.on('connection', (ws: WebSocket) => {
  ws.send(JSON.stringify({ type: 'hello', workspace, model: llm.label, running: agent.busy }));
  ws.send(JSON.stringify({ type: 'metrics', model: llm.label, ...metrics }));
  ws.on('message', (raw) => {
    let msg: { type?: string; text?: string };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === 'command' && msg.text?.trim()) {
      const text = msg.text.trim();
      metrics.instructions++;
      metrics.wordsDictated += text.split(/\s+/).length;
      if (agent.busy) metrics.interruptions++;
      void agent.submit(text);
    } else if (msg.type === 'stop') {
      void agent.stop();
    }
  });
});

server.listen(port, () => {
  console.log(`\n  Flow Agent is listening on http://localhost:${port}`);
  console.log(`  Workspace: ${workspace}`);
  console.log(`  Model:     ${llm.label}\n`);
});
