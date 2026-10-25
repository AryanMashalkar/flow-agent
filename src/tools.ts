import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ToolSpec } from './llm.ts';

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv']);
const MAX_READ = 40_000;

export interface Tool {
  spec: ToolSpec;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export interface FileChange {
  path: string;
  diff: string;
  created: boolean;
}

export interface ToolContext {
  signal: AbortSignal;
  /** Tools call this after changing a file so the UI can show the diff. */
  onFileChange(change: FileChange): void;
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

const MAX_DIFF_LINES = 80;

function prefixLines(text: string, mark: string): string[] {
  return text.length ? text.replace(/\n$/, '').split('\n').map((l) => mark + l) : [];
}

function clip(lines: string[]): string {
  return lines.length > MAX_DIFF_LINES
    ? [...lines.slice(0, MAX_DIFF_LINES), `… ${lines.length - MAX_DIFF_LINES} more lines`].join('\n')
    : lines.join('\n');
}

function relPath(root: string, full: string): string {
  return path.relative(root, full).split(path.sep).join('/');
}

// Commands that are never worth running from a voice instruction.
const BLOCKED_COMMANDS = [
  /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\*|\.\s*$)/i,
  /\b(format|mkfs|diskpart|shutdown|reboot)\b/i,
  /\bdel\s+\/[sq]/i,
  /\brd\s+\/s/i,
  /\bgit\s+push\b.*(--force|-f\b)/i,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/i,
];

const COMMAND_TIMEOUT_MS = 180_000;
const MAX_OUTPUT = 12_000;

/** Run a shell command in the workspace, killing it if the user barges in. */
export function runShell(root: string, command: string, signal: AbortSignal, timeoutMs = COMMAND_TIMEOUT_MS) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const isWin = process.platform === 'win32';
    // detached gives the command its own process group so the whole group can be killed.
    const child = spawn(command, { cwd: root, shell: true, detached: !isWin, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    let output = '';
    const collect = (d: Buffer) => {
      output += d.toString();
      if (output.length > MAX_OUTPUT * 2) output = output.slice(-MAX_OUTPUT * 2);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const kill = () => {
      // The shell's children survive a plain kill, so take down the whole tree.
      if (!child.pid) return;
      if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f']);
      else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      }
    };
    const timer = setTimeout(() => {
      output += `\n[killed after ${timeoutMs / 1000}s timeout]`;
      kill();
    }, timeoutMs);
    const onAbort = () => kill();
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ code, output });
    });
  });
}

export function writeTools(root: string): Tool[] {
  return [
    tool(
      'write_file',
      'Create a new file, or overwrite a whole file. Prefer edit_file for changes to existing files.',
      {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        content: { type: 'string', description: 'The complete file content.' },
      },
      ['path', 'content'],
      async (args, ctx) => {
        const file = resolveInside(root, args.path);
        const content = String(args.content ?? '');
        let before: string | null = null;
        try {
          before = await readFile(file, 'utf8');
        } catch {
          // New file.
        }
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, content);
        const rel = relPath(root, file);
        const diff = clip([...(before === null ? [] : prefixLines(before, '-')), ...prefixLines(content, '+')]);
        ctx.onFileChange({ path: rel, diff, created: before === null });
        return `${before === null ? 'Created' : 'Overwrote'} ${rel} (${content.split('\n').length} lines).`;
      },
    ),
    tool(
      'edit_file',
      'Replace an exact snippet in an existing file. old_text must appear exactly once; include enough surrounding lines to make it unique.',
      {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        old_text: { type: 'string', description: 'Exact text currently in the file, including whitespace.' },
        new_text: { type: 'string', description: 'Text to put in its place.' },
      },
      ['path', 'old_text', 'new_text'],
      async (args, ctx) => {
        const file = resolveInside(root, args.path);
        const oldText = String(args.old_text ?? '');
        const newText = String(args.new_text ?? '');
        const before = await readFile(file, 'utf8');
        // Models often send \n while Windows files use \r\n; match either.
        const crlf = before.includes('\r\n');
        const norm = (t: string) => (crlf ? t.replace(/\r?\n/g, '\r\n') : t);
        const needle = norm(oldText);
        const count = needle ? before.split(needle).length - 1 : 0;
        if (count === 0) throw new Error('old_text was not found. Read the file again and copy the text exactly.');
        if (count > 1) throw new Error(`old_text appears ${count} times. Include more surrounding lines.`);
        await writeFile(file, before.replace(needle, () => norm(newText)));
        const rel = relPath(root, file);
        ctx.onFileChange({ path: rel, diff: clip([...prefixLines(oldText, '-'), ...prefixLines(newText, '+')]), created: false });
        return `Edited ${rel}.`;
      },
    ),
    tool(
      'run_command',
      'Run a shell command in the workspace, for example the test suite. Returns the exit code and output. Commands run in cmd.exe on Windows and sh elsewhere.',
      { command: { type: 'string', description: 'The command line to run, for example "npm test".' } },
      ['command'],
      async (args, ctx) => {
        const command = String(args.command ?? '').trim();
        if (!command) throw new Error('command is empty');
        if (BLOCKED_COMMANDS.some((re) => re.test(command))) throw new Error(`Refusing to run a destructive command: ${command}`);
        const { code, output } = await runShell(root, command, ctx.signal);
        if (ctx.signal.aborted) return 'Command cancelled: the user interrupted.';
        const tail = output.length > MAX_OUTPUT ? '…' + output.slice(-MAX_OUTPUT) : output;
        return `Exit code ${code}\n${tail || '(no output)'}`;
      },
    ),
  ];
}

export function allTools(root: string): Tool[] {
  return [...readOnlyTools(root), ...writeTools(root)];
}
