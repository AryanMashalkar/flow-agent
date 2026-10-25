import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolSpec } from './llm.ts';

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv']);
const MAX_READ = 40_000;

export interface Tool {
  spec: ToolSpec;
  run(args: Record<string, unknown>): Promise<string>;
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  run: Tool['run'],
): Tool {
  return {
    spec: { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } },
    run,
  };
}

/** Resolve a user-supplied path, refusing anything outside the workspace. */
export function resolveInside(root: string, p: unknown): string {
  const full = path.resolve(root, typeof p === 'string' && p ? p : '.');
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path "${p}" is outside the workspace`);
  }
  return full;
}

async function walk(root: string, dir: string, depth: number, out: string[], limit: number): Promise<void> {
  if (out.length >= limit) return;
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (out.length >= limit) return;
    if (IGNORED.has(e.name)) continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (e.isDirectory()) {
      out.push(rel + '/');
      if (depth > 1) await walk(root, full, depth - 1, out, limit);
    } else {
      out.push(rel);
    }
  }
}

export function readOnlyTools(root: string): Tool[] {
  return [
    tool(
      'list_files',
      'List files and folders in the workspace.',
      {
        path: { type: 'string', description: 'Folder relative to the workspace root. Defaults to the root.' },
        depth: { type: 'number', description: 'How many levels deep to list (1-5). Defaults to 2.' },
      },
      [],
      async (args) => {
        const dir = resolveInside(root, args.path);
        const depth = Math.min(Math.max(Number(args.depth) || 2, 1), 5);
        const out: string[] = [];
        await walk(root, dir, depth, out, 500);
        return out.length ? out.join('\n') : '(empty)';
      },
    ),
    tool(
      'read_file',
      'Read a text file from the workspace.',
      { path: { type: 'string', description: 'File path relative to the workspace root.' } },
      ['path'],
      async (args) => {
        const file = resolveInside(root, args.path);
        const text = await readFile(file, 'utf8');
        return text.length > MAX_READ ? text.slice(0, MAX_READ) + `\n…(truncated, ${text.length} chars total)` : text;
      },
    ),
    tool(
      'search',
      'Search workspace files for a regular expression. Returns matching lines as path:line: text.',
      {
        pattern: { type: 'string', description: 'JavaScript regular expression, case-insensitive.' },
        path: { type: 'string', description: 'Folder to search in. Defaults to the root.' },
      },
      ['pattern'],
      async (args) => {
        const re = new RegExp(String(args.pattern), 'i');
        const start = resolveInside(root, args.path);
        const files: string[] = [];
        await walk(root, start, 8, files, 2000);
        const hits: string[] = [];
        for (const rel of files) {
          if (rel.endsWith('/') || hits.length >= 100) continue;
          const full = path.join(root, rel);
          if ((await stat(full)).size > 1_000_000) continue;
          const lines = (await readFile(full, 'utf8')).split('\n');
          lines.forEach((line, i) => {
            if (hits.length < 100 && re.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
          });
        }
        return hits.length ? hits.join('\n') : 'No matches.';
      },
    ),
  ];
}
