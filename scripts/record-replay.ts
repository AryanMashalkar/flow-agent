// `npm run record-replay -- <scenario> [ws-url]`: drives a running Flow Agent with a fixed script of
// instructions and saves every event it sends back as public/replays/<scenario>.json.
// The agent and the model are real; only the instructions are sent as text instead of dictated.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = new Set(['user', 'say', 'tool', 'tool_result', 'file_changed', 'done', 'plan', 'pull_request', 'meeting', 'notice', 'stopped', 'error', 'interrupted', 'status']);

type Ev = { type: string; t: number; [k: string]: any };
type Step = { send?: string; transcript?: string; after: (log: Ev[], since: number) => boolean };

const lastOf = (log: Ev[], type: string) => [...log].reverse().find((e) => e.type === type);
const busyWith = (log: Ev[], since: number, type: string) => log.slice(since).some((e) => e.type === type);
const idle = (log: Ev[], since: number) => {
  const tail = log.slice(since);
  const last = lastOf(tail, 'status');
  return !!last && last.running === false && Date.now() - tail.at(-1)!.t > 4000;
};

const SCENARIOS: Record<string, { title: string; steps: Step[] }> = {
  'barge-in': {
    title: 'Talk over it: tags become priorities mid-task',
    steps: [
      { send: 'Add tags to todos, with a test.', after: () => true },
      // Barge in once it has a plan and has started working on it.
      {
        send: 'Stop. Use priority levels instead of tags: low, medium and high, and keep the test.',
        after: (log, since) => busyWith(log, since, 'plan') && log.slice(since).filter((e) => e.type === 'tool').length >= 2,
      },
      { send: 'Yes, commit it and open a pull request.', after: idle },
      { after: idle },
    ],
  },
  meeting: {
    title: 'Meeting in, pull request out',
    steps: [
      { transcript: 'docs/sample-meeting.txt', after: () => true },
      { send: 'Do task 2.', after: (log, since) => log.slice(since).some((e) => e.type === 'meeting' && e.tasks.length) && Date.now() - log.at(-1)!.t > 2500 },
      {
        after: (log, since) =>
          idle(log, since) && !lastOf(log.slice(since), 'meeting')?.tasks.some((t: any) => t.status === 'running'),
      },
    ],
  },
};

const name = process.argv[2] ?? 'barge-in';
const scenario = SCENARIOS[name];
if (!scenario) throw new Error(`Unknown scenario "${name}". Try: ${Object.keys(SCENARIOS).join(', ')}`);
const ws = new WebSocket(process.argv[3] ?? 'ws://localhost:4242/ws');
const log: Ev[] = [];
let model = '';
let workspace = '';
await new Promise((r) => ws.once('open', r));
ws.on('message', (raw) => {
  const e = JSON.parse(String(raw));
  if (e.type === 'hello') ({ model, workspace } = e);
  if (e.type === 'metrics' && e.model) model = e.model;
  if (KEEP.has(e.type)) {
    log.push({ ...e, t: Date.now() });
    console.log(e.type, (e.text ?? e.name ?? e.message ?? '').toString().slice(0, 100));
  }
});
ws.send(JSON.stringify({ type: 'new_session' }));
await new Promise((r) => setTimeout(r, 500));
log.length = 0;

const deadline = Date.now() + 15 * 60_000;
let since = 0;
for (const step of scenario.steps) {
  while (!step.after(log, since)) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 250));
  }
  since = log.length;
  if (step.send) ws.send(JSON.stringify({ type: 'command', text: step.send, source: 'script' }));
  if (step.transcript) ws.send(JSON.stringify({ type: 'transcript', name: 'Standup', text: await readFile(path.join(root, step.transcript), 'utf8') }));
}
ws.close();

const started = log[0]?.t ?? Date.now();
const out = {
  format: 'flow-agent-replay/1',
  title: scenario.title,
  recorded: new Date(started).toISOString(),
  model,
  workspace: path.basename(workspace),
  note: `A real run against ${model}, recorded ${new Date(started).toISOString().slice(0, 10)}. Backup models may have answered some steps if the rate limit hit. The instructions were sent as text by a script, not dictated, so the keys-typed counter is not shown. Waits for the model are shortened.`,
  events: log.map((e) => (e.type === 'file_changed' && e.diff.length > 4000 ? { ...e, diff: `${e.diff.slice(0, 4000)}\n…` } : e)),
};
await mkdir(path.join(root, 'public', 'replays'), { recursive: true });
const file = path.join(root, 'public', 'replays', `${name}.json`);
await writeFile(file, JSON.stringify(out, null, 1));
console.log(`\nSaved ${log.length} events to ${path.relative(root, file)} (${Math.round((Date.now() - started) / 1000)}s)`);
