import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLog } from '../scripts/dictation-log.ts';

test('dictation log counts dictated instructions, words and barge-ins', () => {
  const md = renderLog([
    { t: '2026-10-30T10:00:00.000Z', text: 'Add tags to todos.', source: 'dictated', interrupt: false },
    { t: '2026-10-30T10:00:20.000Z', text: 'Stop. Use priority | levels.', source: 'dictated', interrupt: true },
    { t: '2026-10-30T10:01:00.000Z', text: 'yes', source: 'typed', interrupt: false },
  ]);
  assert.match(md, /\*\*3\*\* instructions, \*\*2\*\* dictated \(67%\)/);
  assert.match(md, /\*\*10\*\* words, \*\*9\*\* of them dictated \(90%\)/);
  assert.match(md, /\*\*1\*\* barge-ins/);
  assert.match(md, /priority \\\| levels/);
});
