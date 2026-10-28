import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { addTodo, completeTodo, listTodos, resetTodos } from '../src/todos.js';

beforeEach(resetTodos);

test('adds and lists todos oldest first', () => {
  addTodo('second', 2000);
  addTodo('first', 1000);
  assert.deepEqual(listTodos().map((t) => t.title), ['first', 'second']);
});

test('rejects an empty title', () => {
  assert.throws(() => addTodo('  '), /title is required/);
});

test('completes a todo', () => {
  const t = addTodo('ship it');
  assert.equal(completeTodo(t.id).done, true);
});
