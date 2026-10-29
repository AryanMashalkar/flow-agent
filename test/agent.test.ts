import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent, compactHistory, type AgentEvent } from '../src/agent.ts';
import type { Plan } from '../src/plan.ts';
import type { ChatMessage, ChatResult, LLM } from '../src/llm.ts';
import { allTools, readOnlyTools, resolveInside, type FileChange, type ToolContext } from '../src/tools.ts';
import { OpenAICompatibleLLM, pickModel, rankModels, retryAfterSeconds, salvageToolCalls, stripThoughts } from '../src/llm.ts';
import http from 'node:http';

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

test('a tool name with a namespace in front still runs the tool', async () => {
  const llm = new ScriptedLLM([
    { content: null, tool_calls: [call('a', 'repo_browser.search', { pattern: 'sqlite' })] },
    { content: 'Found it.' },
  ]);
  const agent = new Agent({ llm, tools: readOnlyTools(await workspace()) });
  await agent.submit('Which database do we use?');
  assert.match(agent.history.find((m) => m.role === 'tool')!.content!, /src\/db\.ts:1/);
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

/** A fake OpenAI-compatible server that answers with the given statuses in order. */
async function fakeProvider(statuses: number[], models: string[] = []) {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      const model = JSON.parse(body).model;
      seen.push(model);
      const status = statuses.shift() ?? 200;
      res.statusCode = status;
      res.end(JSON.stringify(status === 200 ? { choices: [{ message: { content: `hi from ${model}` } }] } : { error: 'busy' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://localhost:${port}`,
    seen,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

test('retries a busy model, then succeeds', async () => {
  const p = await fakeProvider([503, 503, 200]);
  const llm = new OpenAICompatibleLLM(p.url, 'main', 'k', false, [], [1, 1, 1]);
  const out = await llm.chat([], [], new AbortController().signal);
  assert.equal(out.content, 'hi from main');
  assert.deepEqual(p.seen, ['main', 'main', 'main']);
  p.close();
});

test('switches to a backup model when the main one stays busy', async () => {
  const p = await fakeProvider([503, 503, 503, 503, 200], ['models/gemini-3.8-flash', 'models/gemini-3.8-flash-lite', 'models/text-embedding-004']);
  const llm = new OpenAICompatibleLLM(p.url, 'gemini-3.8-flash', 'k', false, [], [1, 1, 1]);
  const out = await llm.chat([], [], new AbortController().signal);
  assert.equal(out.content, 'hi from gemini-3.8-flash-lite');
  assert.equal(llm.label, 'gemini-3.8-flash-lite');
  p.close();
});

test('a barge-in cancels the retry wait', async () => {
  const p = await fakeProvider([503, 503, 503, 503]);
  const llm = new OpenAICompatibleLLM(p.url, 'main', 'k', false, [], [10_000]);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  await assert.rejects(llm.chat([], [], controller.signal));
  assert.ok(Date.now() - started < 2000);
  p.close();
});

test('backups prefer the same model family', () => {
  const ids = ['models/gemma-4-26b-a4b-it', 'models/gemini-3.8-flash', 'models/gemini-3.8-flash-lite', 'models/gemini-3.5-flash'];
  assert.deepEqual(rankModels(ids, 'gemini').slice(0, 3), ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.8-flash-lite']);
});

test('private reasoning is stripped from replies', () => {
  assert.equal(stripThoughts('<thought>The user wants files.\nLet me check.</thought>I will list the files.'), 'I will list the files.');
  assert.equal(stripThoughts('<think>still thinking with no end'), '');
  assert.equal(stripThoughts('Plain answer.'), 'Plain answer.');
});

test('goes back to the main model once the backup window ends', async () => {
  const p = await fakeProvider([503, 503, 200, 200], ['gemini-3.8-flash', 'gemini-3.8-flash-lite']);
  const llm = new OpenAICompatibleLLM(p.url, 'gemini-3.8-flash', 'k', false, [], [1], 0);
  await llm.chat([], [], new AbortController().signal);
  assert.equal(llm.label, 'gemini-3.8-flash-lite');
  await new Promise((r) => setTimeout(r, 5));
  const out = await llm.chat([], [], new AbortController().signal);
  assert.equal(out.content, 'hi from gemini-3.8-flash');
  p.close();
});

test('a request that hangs past the timeout is retried, with a notice', async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (++calls === 1) return; // never answer the first request
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'finally' } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://localhost:${(server.address() as { port: number }).port}`;
  const llm = new OpenAICompatibleLLM(url, 'main', 'k', false, [], [1], 60_000, 150);
  const notices: string[] = [];
  llm.onNotice = (t) => notices.push(t);
  const out = await llm.chat([], [], new AbortController().signal);
  assert.equal(out.content, 'finally');
  assert.match(notices[0], /main is slow \(504\)/);
  server.closeAllConnections();
  server.close();
});

test('old tool results are shortened before sending, recent ones kept', () => {
  const big = 'x'.repeat(1000);
  const history: ChatMessage[] = [{ role: 'user', content: 'go' }];
  for (let i = 0; i < 8; i++) history.push({ role: 'tool', tool_call_id: String(i), content: big });
  const out = compactHistory(history);
  assert.match(out[1].content!, /older result shortened/);
  assert.match(out[2].content!, /older result shortened/);
  assert.equal(out[3].content, big);
  assert.equal(out.at(-1)!.content, big);
  assert.equal(history[1].content, big, 'the real history is not modified');
});

for (const code of ['tool_use_failed', 'output_parse_failed']) {
  test(`a ${code} reply from the provider is retried`, async () => {
    let calls = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (++calls === 1) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: { code } }));
        }
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const url = `http://localhost:${(server.address() as { port: number }).port}`;
    const llm = new OpenAICompatibleLLM(url, 'main', 'k', false, [], [1]);
    assert.equal((await llm.chat([], [], new AbortController().signal)).content, 'ok');
    server.close();
  });
}

test('update_plan is shown to the user and a barge-in marks the next plan as a re-plan', async () => {
  const plan1 = { steps: [{ text: 'Add SQLite', status: 'active' }, { text: 'Create users table', status: 'pending' }] };
  const plan2 = { steps: [{ text: 'Add SQLite', status: 'dropped' }, { text: 'Add Postgres', status: 'active' }, { text: 'Create users table', status: 'pending' }] };
  const llm = new ScriptedLLM([
    { content: 'Planning.', tool_calls: [call('p1', 'update_plan', plan1)] },
    'hang',
    { content: 'Switching to Postgres.', tool_calls: [call('p2', 'update_plan', plan2)] },
    { content: 'Done.' },
  ]);
  const agent = new Agent({ llm, tools: [] });
  const plans: Plan[] = [];
  agent.on('event', (e: AgentEvent) => e.type === 'plan' && plans.push(e.plan));

  const first = agent.submit('add a users table with sqlite');
  while (llm.calls.length < 2) await new Promise((r) => setImmediate(r));
  await agent.submit('stop, use Postgres not SQLite');
  await first;

  // v3 is the finished task: the step the agent was on is marked done.
  assert.deepEqual(plans.map((p) => [p.version, p.replanned]), [[1, false], [2, true], [3, false]]);
  assert.deepEqual(plans[2].steps.map((s) => s.status), ['dropped', 'done', 'pending']);
  assert.equal(plans[1].reason, 'stop, use Postgres not SQLite');
  // The interruption reminds the model of the plan it had.
  const interruption = llm.calls[2].at(-1)!.content!;
  assert.match(interruption, /1\. \[active\] Add SQLite/);
  assert.match(interruption, /Call update_plan first/);
  // The plan tool is offered to the model.
  assertPaired(agent.history);
});

test('a bad plan is reported back to the model instead of crashing', async () => {
  const llm = new ScriptedLLM([
    { content: 'Planning.', tool_calls: [call('p1', 'update_plan', { steps: [] })] },
    { content: 'Done.' },
  ]);
  const agent = new Agent({ llm, tools: [] });
  await agent.submit('do it');
  assert.match(agent.history.find((m) => m.tool_call_id === 'p1')!.content!, /non-empty list/);
});

test('a rate limit goes to a backup model at once instead of burning retries', async () => {
  const p = await fakeProvider([429, 200], ['gemini-3.8-flash', 'gemini-3.6-flash']);
  const llm = new OpenAICompatibleLLM(p.url, 'gemini-3.8-flash', 'k', false, [], [1, 1, 1]);
  const out = await llm.chat([], [], new AbortController().signal);
  assert.equal(out.content, 'hi from gemini-3.6-flash');
  assert.deepEqual(p.seen, ['gemini-3.8-flash', 'gemini-3.6-flash']);
  p.close();
});

test('a rate limit with no backup waits, then tries once more', async () => {
  const p = await fakeProvider([429, 200], ['only-model']);
  const llm = new OpenAICompatibleLLM(p.url, 'only-model', 'k', false, ['only-model'], [1], 60_000, 45_000, 0);
  const notices: string[] = [];
  llm.onNotice = (t) => notices.push(t);
  const out = await llm.chat([], [], new AbortController().signal);
  assert.equal(out.content, 'hi from only-model');
  assert.ok(notices.some((n) => /Free-tier limit reached/.test(n)));
  p.close();
});

test('a per-minute rate limit is waited out several times before the task gives up', async () => {
  const p = await fakeProvider([429, 429, 429, 200], ['only-model']);
  const llm = new OpenAICompatibleLLM(p.url, 'only-model', 'k', false, ['only-model'], [1], 60_000, 45_000, 0);
  const out = await llm.chat([], [], new AbortController().signal);
  assert.equal(out.content, 'hi from only-model');
  assert.equal(p.seen.length, 4);
  p.close();
});

test('a rate limit still fails after the last wait', async () => {
  const p = await fakeProvider([429, 429, 429, 429, 429, 429], ['only-model']);
  const llm = new OpenAICompatibleLLM(p.url, 'only-model', 'k', false, ['only-model'], [1], 60_000, 45_000, 0);
  await assert.rejects(llm.chat([], [], new AbortController().signal), /free-tier limit/);
  assert.equal(p.seen.length, 5);
  p.close();
});

test('retryAfterSeconds reads headers and Gemini retryDelay', () => {
  assert.equal(retryAfterSeconds(new Headers({ 'retry-after': '7' }), ''), 7);
  assert.equal(retryAfterSeconds(new Headers(), '[{"error":{"details":[{"retryDelay": "23.4s"}]}}]'), 24);
  assert.equal(retryAfterSeconds(new Headers(), 'Rate limit reached. Please try again in 9.4725s. Need more tokens?'), 10);
  assert.equal(retryAfterSeconds(new Headers(), 'nothing'), undefined);
});

test('reset stops a running task and starts a clean conversation', async () => {
  const llm = new ScriptedLLM(['hang', { content: 'Fresh answer.' }]);
  const agent = new Agent({ llm, tools: readOnlyTools(await workspace()) });
  void agent.submit('Add tags to todos.');
  await new Promise((r) => setTimeout(r, 20));
  await agent.reset();
  assert.equal(agent.busy, false);
  assert.equal(agent.history.length, 1, 'only the system prompt is left');
  await agent.submit('What does this project do?');
  assert.equal(llm.calls[1].length, 2, 'the new task sees none of the old one');
});

// Faults found by stress-testing the agent with misbehaving model replies.

test('a tool call written as text is turned back into a real tool call', () => {
  const calls = salvageToolCalls('<function=read_file>{"path": "README.md"}</function>');
  assert.equal(calls?.[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(calls![0].function.arguments), { path: 'README.md' });
  assert.equal(salvageToolCalls('Plain answer with {braces}.'), undefined);
});

test('tool arguments sent as an object are accepted', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const call = { id: 'a', type: 'function', function: { name: 'read_file', arguments: { path: 'x.js' } } };
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const llm = new OpenAICompatibleLLM(`http://localhost:${(server.address() as { port: number }).port}`, 'm', 'k', false);
  const out = await llm.chat([], [], new AbortController().signal);
  assert.equal(out.tool_calls?.[0].function.arguments, '{"path":"x.js"}');
  server.closeAllConnections();
  server.close();
});

test('broken tool arguments are shown and sent back so the model can retry', async () => {
  const llm = new ScriptedLLM([
    { content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{path: oops' } }] },
    { content: '' },
  ]);
  const agent = new Agent({ llm, tools: readOnlyTools(await workspace()) });
  const events: AgentEvent[] = [];
  agent.on('event', (e) => events.push(e));
  await agent.submit('read it');
  assert.equal(events.find((e) => e.type === 'tool_result')?.type, 'tool_result');
  assert.match(agent.history.find((m) => m.role === 'tool')!.content!, /not a valid JSON object.*Call read_file again/);
  // An empty final reply still tells the user it finished.
  assert.deepEqual(events.find((e) => e.type === 'done'), { type: 'done', text: 'Done.' });
});

test('binary files are described instead of dumped', async () => {
  const dir = await workspace();
  await writeFile(path.join(dir, 'logo.dat'), Buffer.from([0x89, 0x50, 0, 0, 0xff]));
  const read = readOnlyTools(dir).find((t) => t.spec.function.name === 'read_file')!;
  assert.match(await read.run({ path: 'logo.dat' }, ctx()), /binary file \(5 bytes\)/);
});

test('a command waiting for input ends instead of hanging', async () => {
  const run = allTools(await workspace()).find((t) => t.spec.function.name === 'run_command')!;
  const started = Date.now();
  const out = await run.run({ command: `node -e "process.stdin.on('data', () => {})"` }, ctx());
  assert.match(out, /^Exit code 0/);
  assert.ok(Date.now() - started < 10_000);
});

test('more ways of wiping the workspace are blocked', async () => {
  const run = allTools(await workspace()).find((t) => t.spec.function.name === 'run_command')!;
  for (const command of ['rm -rf ./*', 'rm -fr .', 'rm -r -f ..', 'powershell Remove-Item -Recurse -Force .']) {
    await assert.rejects(run.run({ command }, ctx()), /destructive/, command);
  }
  assert.match(await run.run({ command: 'rm -rf ./build' }, ctx()), /^Exit code 0/);
});
