import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describePlan, parseSteps } from '../src/plan.ts';

test('parseSteps cleans up what the model sends', () => {
  assert.deepEqual(parseSteps({ steps: ['Read the code', { text: ' Edit db.ts ', status: 'ACTIVE' }, { text: 'x', status: 'weird' }, { nope: 1 }] }), [
    { text: 'Read the code', status: 'pending' },
    { text: 'Edit db.ts', status: 'active' },
    { text: 'x', status: 'pending' },
  ]);
  assert.throws(() => parseSteps({}), /non-empty/);
});

test('describePlan lists steps with their status', () => {
  assert.equal(
    describePlan({ version: 1, replanned: false, steps: [{ text: 'A', status: 'done' }, { text: 'B', status: 'active' }] }),
    '1. [done] A\n2. [active] B',
  );
  assert.equal(describePlan(null), '');
});
