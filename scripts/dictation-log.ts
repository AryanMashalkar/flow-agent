// `npm run dictation-log`: turns logs/dictation.jsonl (written by the server) into docs/dictation-log.md,
// a page that shows every instruction you gave Flow Agent and whether it was dictated or typed.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'logs', 'dictation.jsonl');
const target = path.join(root, 'docs', 'dictation-log.md');

interface Entry {
  t: string;
  text: string;
  source: 'dictated' | 'typed' | 'unknown';
  interrupt: boolean;
}

export function renderLog(entries: Entry[]): string {
  const words = (e: Entry) => e.text.split(/\s+/).length;
  const dictated = entries.filter((e) => e.source === 'dictated');
  const total = entries.reduce((n, e) => n + words(e), 0);
  const spoken = dictated.reduce((n, e) => n + words(e), 0);
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
  const lines = [
    '# Dictation log',
    '',
    'Every instruction given to Flow Agent, written by the app as it ran (`logs/dictation.jsonl`, rendered with `npm run dictation-log`).',
    'An instruction counts as **dictated** when Wispr Flow inserted it as whole phrases, and **typed** when it came in key by key.',
    '',
    `- **${entries.length}** instructions, **${dictated.length}** dictated (${pct(dictated.length, entries.length)}%)`,
    `- **${total}** words, **${spoken}** of them dictated (${pct(spoken, total)}%)`,
    `- **${entries.filter((e) => e.interrupt).length}** barge-ins (spoken while the agent was working)`,
    entries.length ? `- From ${entries[0].t.slice(0, 16).replace('T', ' ')} to ${entries.at(-1)!.t.slice(0, 16).replace('T', ' ')} UTC` : '',
    '',
    '| When (UTC) | How | Barge-in | Instruction |',
    '|---|---|---|---|',
    ...entries.map((e) => `| ${e.t.slice(0, 16).replace('T', ' ')} | ${e.source} | ${e.interrupt ? '⚡' : ''} | ${cell(e.text)} |`),
    '',
  ];
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let raw: string;
  try {
    raw = await readFile(source, 'utf8');
  } catch {
    console.error(`No log yet at ${source}. Run Flow Agent and give it a few instructions first.`);
    process.exit(1);
  }
  const entries = raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Entry);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, renderLog(entries));
  console.log(`Wrote ${entries.length} instructions to ${path.relative(root, target)}`);
}
