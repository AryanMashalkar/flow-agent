import { test } from 'node:test';
import assert from 'node:assert/strict';
import { login } from '../src/auth.js';

test('accepts the right password', () => {
  assert.equal(login('priya', 'hunter2'), true);
});

test('rejects the wrong password', () => {
  assert.equal(login('priya', 'nope'), false);
});
