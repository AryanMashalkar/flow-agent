import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MeetingBoard, parseMeetingCommand, parseTasks, taskInstruction, type TaskRunner } from '../src/meeting.ts';
import type { ChatResult, LLM } from '../src/llm.ts';

const REPLY = '```json\n{"tasks":[{"title":"Add a users table","detail":"Use Postgres, not SQLite","owner":"Priya","kind":"code"},{"title":"Email the client","detail":"","owner":"","kind":"other"},{"title":"Fix login bug","detail":"Empty password crashes","kind":"code"}]}\n```';

test('parseTasks reads fenced JSON and numbers the tasks', () => {
  const tasks = parseTasks(REPLY);
  assert.equal(tasks.length, 3);
  assert.deepEqual(tasks[0], { id: 1, title: 'Add a users table', detail: 'Use Postgres, not SQLite', owner: 'Priya', kind: 'code', status: 'todo' });
  assert.equal(tasks[1].kind, 'other');
  assert.equal(tasks[1].owner, undefined);
  assert.throws(() => parseTasks('no json here'), /did not return/);
});

test('parseTasks ignores prose with braces around the JSON, and accepts a bare list', () => {
  assert.equal(parseTasks('{"tasks":[{"title":"A"}]}\n\nNote: {see above}')[0].title, 'A');
  assert.deepEqual(parseTasks('Sure! {"tasks": []} hope it helps {x}'), []);
  assert.equal(parseTasks('[{"title":"Bare"}]')[0].title, 'Bare');
  assert.throws(() => parseTasks('no tasks here'), /did not return a task list/);
});

test('parseMeetingCommand understands more ways of saying it', () => {
  assert.deepEqual(parseMeetingCommand('Do task #2.'), { kind: 'one', id: 2 });
  assert.deepEqual(parseMeetingCommand('Go ahead with task three.'), { kind: 'one', id: 3 });
  assert.deepEqual(parseMeetingCommand('Do tasks 1 and 4.'), { kind: 'some', ids: [1, 4] });
  assert.equal(parseMeetingCommand('What do you think about task 2?'), null);
});

test('parseMeetingCommand understands spoken task commands', () => {
  assert.deepEqual(parseMeetingCommand('Do task 2.'), { kind: 'one', id: 2 });
  assert.deepEqual(parseMeetingCommand('work on task three'), { kind: 'one', id: 3 });
  assert.deepEqual(parseMeetingCommand('do the first task'), { kind: 'one', id: 1 });
  assert.deepEqual(parseMeetingCommand('run task number 4'), { kind: 'one', id: 4 });
  assert.deepEqual(parseMeetingCommand('Okay, do all the code tasks'), { kind: 'all' });
  assert.equal(parseMeetingCommand('add a users table with sqlite'), null);
});

test('taskInstruction asks for a branch and a pull request', () => {
  assert.match(taskInstruction(parseTasks(REPLY)[0]), /Meeting task 1: Add a users table\.\nUse Postgres, not SQLite\n.*open a pull request/);
});

class FakeLLM implements LLM {
  readonly label = 'fake';
  tools: unknown[] = [];
  async chat(_m: unknown, tools: unknown[]): Promise<ChatResult> {
    this.tools = tools;
    return { content: REPLY };
  }
}

test('MeetingBoard extracts tasks and runs code tasks one at a time', async () => {
  const ran: string[] = [];
  let active = 0;
  const runner: TaskRunner = {
    async submit(text) {
      active++;
      assert.equal(active, 1, 'never two tasks at once');
      ran.push(text.split('\n')[0]);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    },
    async whenIdle() {},
  };
  const updates: string[][] = [];
  const llm = new FakeLLM();
  const board = new MeetingBoard(llm, runner, (b) => updates.push(b.tasks.map((t) => t.status)));
  await board.load('Standup', 'transcript text', new AbortController().signal);
  assert.deepEqual(llm.tools, [], 'extraction is a plain completion');

  assert.deepEqual(board.run({ kind: 'all' }), [1, 3]);
  while (board.tasks.some((t) => t.kind === 'code' && t.status !== 'done')) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(ran, ['Meeting task 1: Add a users table.', 'Meeting task 3: Fix login bug.']);
  assert.deepEqual(board.tasks.map((t) => t.status), ['done', 'todo', 'done']);
  assert.deepEqual(board.run({ kind: 'all' }), [], 'nothing left to run');
});

test('stopping leaves the current meeting task to run again', async () => {
  let release!: () => void;
  const runner: TaskRunner = { submit: () => new Promise<void>((r) => (release = r)), async whenIdle() {} };
  const board = new MeetingBoard(new FakeLLM(), runner, () => {});
  await board.load('m', 't', new AbortController().signal);
  board.run({ kind: 'all' });
  await new Promise((r) => setTimeout(r, 5));
  board.cancel();
  release();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(board.tasks.map((t) => t.status), ['todo', 'todo', 'todo']);
});

test('a task that ends in an error goes back on the list, and each task is prepared first', async () => {
  const prepared: number[] = [];
  const runner = { failed: false, async submit(text: string) { this.failed = text.includes('task 1'); }, async whenIdle() {} };
  const board = new MeetingBoard(new FakeLLM(), runner, () => {}, async (t) => void prepared.push(t.id));
  await board.load('m', 't', new AbortController().signal);
  board.run({ kind: 'all' });
  while (board.tasks[2].status !== 'done') await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(board.tasks.map((t) => t.status), ['todo', 'todo', 'done']);
  assert.deepEqual(prepared, [1, 3]);
});
