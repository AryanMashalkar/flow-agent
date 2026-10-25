import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent, type AgentEvent } from '../src/agent.ts';
import type { ChatMessage, ChatResult, LLM } from '../src/llm.ts';
import { allTools, readOnlyTools, resolveInside, type FileChange, type ToolContext } from '../src/tools.ts';
import { pickModel } from '../src/llm.ts';

/** A fake model that replays scripted replies, optionally waiting until aborted. */
class ScriptedLLM implements LLM {
  readonly label = 'scripted';
  calls: ChatMessage[][] = [];
  constructor(private script: (ChatResult | 'hang')[]) {}
  async chat(messages: ChatMessage[], _tools: unknown, signal: AbortSignal): Promise<ChatResult> {
    this.calls.push(structuredClone(messages));
    const next = this.script.shift();
    if (!next) throw new Error('script exhausted');
    if (next === 'hang') {
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    return next;
  }
}

function ctx(changes: FileChange[] = [], signal = new AbortController().signal): ToolContext {
  return { signal, onFileChange: (c) => changes.push(c) };
}

function call(id: string, name: string, args: object) {
  return { id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } };
}

async function workspace() {
  const dir = await mkdtemp(path.join(tmpdir(), 'flow-agent-'));
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, 'src', 'db.ts'), 'export const db = "sqlite";\n');
  await mkdir(path.join(dir, 'node_modules'));
  return dir;
}

/** Every assistant tool call must be answered by a tool message, or providers reject the request. */
function assertPaired(history: ChatMessage[]) {
  const asked = history.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? []);
  const answered = history.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  assert.deepEqual(answered, asked);
}

test('runs tools, narrates, and finishes', async () => {
  const llm = new ScriptedLLM([
    { content: 'Looking for the database code.', tool_calls: [call('a', 'search', { pattern: 'sqlite' })] },
    { content: 'The database is SQLite, set in src/db.ts.' },
  ]);
  const agent = new Agent({ llm, tools: readOnlyTools(await workspace()) });
  const events: AgentEvent[] = [];
  agent.on('event', (e) => events.push(e));

  await agent.submit('Which database do we use?');

  assert.deepEqual(events.find((e) => e.type === 'say'), { type: 'say', text: 'Looking for the database code.' });
  const toolMsg = agent.history.find((m) => m.role === 'tool');
  assert.match(toolMsg!.content!, /src\/db\.ts:1: export const db = "sqlite";/);
  assert.equal(events.at(-2)?.type, 'done');
  assertPaired(agent.history);
});

test('barge-in aborts the in-flight step and re-plans with the interruption', async () => {
  const llm = new ScriptedLLM([
    'hang',
    { content: 'Switching to Postgres instead.' },
  ]);
  const agent = new Agent({ llm, tools: readOnlyTools(await workspace()) });
  const events: AgentEvent[] = [];
  agent.on('event', (e) => events.push(e));

  const first = agent.submit('Add a users table with SQLite');
  await new Promise((r) => setImmediate(r));
  assert.equal(agent.busy, true);
  await agent.submit('stop, use Postgres not SQLite');
  await first;

  assert.ok(events.some((e) => e.type === 'interrupted'));
  const last = llm.calls.at(-1)!;
  assert.match(last.at(-1)!.content!, /interrupted you mid-task.*Postgres/s);
  assert.equal(last.filter((m) => m.role === 'user').length, 2);
  assert.equal(agent.busy, false);
  assertPaired(agent.history);
});

test('interrupt between tool calls answers the skipped calls', async () => {
  const dir = await workspace();
  let agentRef: Agent;
  const tools = readOnlyTools(dir).map((t) =>
    t.spec.function.name === 'list_files'
      ? { ...t, run: async (a: Record<string, unknown>, ctx: ToolContext) => { void agentRef.submit('actually, just read db.ts'); return t.run(a, ctx); } }
      : t,
  );
  const llm = new ScriptedLLM([
    { content: 'Listing then reading.', tool_calls: [call('a', 'list_files', {}), call('b', 'read_file', { path: 'src/db.ts' })] },
    { content: 'Done.' },
  ]);
  const agent = (agentRef = new Agent({ llm, tools }));
  await agent.submit('look around');
  await new Promise((r) => setTimeout(r, 10));

  const skipped = agent.history.find((m) => m.tool_call_id === 'b');
  assert.equal(skipped?.content, 'Skipped: the user interrupted.');
  assertPaired(agent.history);
});

test('two quick barge-ins only run the latest one', async () => {
  const llm = new ScriptedLLM(['hang', { content: 'Using MySQL.' }]);
  const agent = new Agent({ llm, tools: [] });
  const first = agent.submit('use sqlite');
  await new Promise((r) => setImmediate(r));
  const second = agent.submit('no, postgres');
  const third = agent.submit('no wait, mysql');
  await Promise.all([first, second, third]);
  assert.equal(llm.calls.length, 2);
  const users = llm.calls[1].filter((m) => m.role === 'user').map((m) => m.content);
  assert.equal(users.length, 3);
  assert.match(users[2]!, /mysql/);
});

test('stop halts without a new instruction', async () => {
  const llm = new ScriptedLLM(['hang']);
  const agent = new Agent({ llm, tools: [] });
  const events: AgentEvent[] = [];
  agent.on('event', (e) => events.push(e));
  void agent.submit('refactor everything');
  await new Promise((r) => setImmediate(r));
  await agent.stop();
  assert.equal(agent.busy, false);
  assert.ok(events.some((e) => e.type === 'stopped'));
});

test('tools refuse paths outside the workspace and skip node_modules', async () => {
  const dir = await workspace();
  assert.throws(() => resolveInside(dir, '../secrets.txt'), /outside the workspace/);
  const list = readOnlyTools(dir).find((t) => t.spec.function.name === 'list_files')!;
  const out = await list.run({}, ctx());
  assert.match(out, /src\/db\.ts/);
  assert.doesNotMatch(out, /node_modules/);
});

function byName(dir: string, name: string) {
  return allTools(dir).find((t) => t.spec.function.name === name)!;
}

test('edit_file replaces exactly one match and reports a diff', async () => {
  const dir = await workspace();
  const changes: FileChange[] = [];
  const out = await byName(dir, 'edit_file').run({ path: 'src/db.ts', old_text: '"sqlite"', new_text: '"postgres"' }, ctx(changes));
  assert.equal(out, 'Edited src/db.ts.');
  assert.equal(await readFile(path.join(dir, 'src/db.ts'), 'utf8'), 'export const db = "postgres";\n');
  assert.deepEqual(changes, [{ path: 'src/db.ts', diff: '-"sqlite"\n+"postgres"', created: false }]);
  await assert.rejects(byName(dir, 'edit_file').run({ path: 'src/db.ts', old_text: 'nope', new_text: 'x' }, ctx()), /not found/);
});

test('edit_file matches LF snippets inside CRLF files', async () => {
  const dir = await workspace();
  await writeFile(path.join(dir, 'win.txt'), 'a\r\nb\r\nc\r\n');
  await byName(dir, 'edit_file').run({ path: 'win.txt', old_text: 'a\nb', new_text: 'A\nB' }, ctx());
  assert.equal(await readFile(path.join(dir, 'win.txt'), 'utf8'), 'A\r\nB\r\nc\r\n');
});

test('write_file creates folders and flags new files', async () => {
  const dir = await workspace();
  const changes: FileChange[] = [];
  await byName(dir, 'write_file').run({ path: 'src/models/user.ts', content: 'export type User = {};\n' }, ctx(changes));
  assert.equal(changes[0].created, true);
  assert.equal(changes[0].diff, '+export type User = {};');
  await assert.rejects(byName(dir, 'write_file').run({ path: '../evil.ts', content: '' }, ctx()), /outside the workspace/);
});

test('run_command returns exit code and output, and blocks destructive commands', async () => {
  const dir = await workspace();
  const run = byName(dir, 'run_command');
  assert.match(await run.run({ command: 'node -e "console.log(41+1); process.exit(3)"' }, ctx()), /^Exit code 3\n42/);
  await assert.rejects(run.run({ command: 'git push --force origin main' }, ctx()), /destructive/);
  await assert.rejects(run.run({ command: 'rm -rf /' }, ctx()), /destructive/);
});

test('run_command is killed when the user barges in', async () => {
  const dir = await workspace();
  const controller = new AbortController();
  const started = Date.now();
  const pending = byName(dir, 'run_command').run({ command: 'node -e "setTimeout(() => {}, 20000)"' }, ctx([], controller.signal));
  setTimeout(() => controller.abort(), 200);
  assert.equal(await pending, 'Command cancelled: the user interrupted.');
  assert.ok(Date.now() - started < 5000);
});

test('pickModel prefers the newest general flash model', () => {
  assert.equal(
    pickModel(['models/gemini-2.5-flash', 'models/gemini-3.8-flash', 'models/gemini-3.8-flash-lite', 'models/gemini-3.8-pro-preview', 'models/text-embedding-004']),
    'gemini-3.8-flash',
  );
});
