import { spawn } from 'node:child_process';
import type { Tool, ToolContext } from './tools.ts';

export interface GitResult {
  code: number | null;
  out: string;
}

/** Run git with an argument list (never through a shell, so names and messages can't inject commands). */
export function git(root: string, args: string[], signal?: AbortSignal): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: root, signal, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out: out.trim() }));
  });
}

async function mustGit(root: string, args: string[], signal?: AbortSignal): Promise<string> {
  const r = await git(root, args, signal);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.out.slice(0, 800)}`);
  return r.out;
}

export async function currentBranch(root: string): Promise<string> {
  return mustGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

/** The branch pull requests go into: origin's HEAD if known, else main or master. */
export async function defaultBranch(root: string): Promise<string> {
  const head = await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head.code === 0 && head.out) return head.out.replace(/^origin\//, '');
  for (const name of ['main', 'master']) {
    if ((await git(root, ['rev-parse', '--verify', '--quiet', name])).code === 0) return name;
  }
  return 'main';
}

/**
 * Go back to the default branch, so the next task's branch starts from it instead of stacking on
 * the last task's. Unfinished changes are stashed, never thrown away. Returns what it did, or ''.
 */
export async function startFromDefaultBranch(root: string): Promise<string> {
  const branch = await currentBranch(root);
  const base = await defaultBranch(root);
  if (branch === base) return '';
  let stashed = '';
  if ((await mustGit(root, ['status', '--porcelain'])).trim()) {
    await mustGit(root, ['stash', 'push', '--include-untracked', '-m', `Flow Agent: unfinished work on ${branch}`]);
    stashed = ` Unfinished changes from ${branch} are saved in git stash.`;
  }
  await mustGit(root, ['checkout', base]);
  return `Switched from ${branch} back to ${base} for the next task.${stashed}`;
}

/** "Add Postgres users table!" → "flow/add-postgres-users-table" */
export function branchName(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/^flow\//, '')
    .replace(/[^a-z0-9/]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^[-/]+|[-/]+$/g, '')
    .slice(0, 48)
    .replace(/[-/]+$/, '');
  return `flow/${slug || 'change'}`;
}

/** owner/repo from an https or ssh GitHub remote URL. */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const m = url.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

async function createPullRequest(
  root: string,
  branch: string,
  base: string,
  title: string,
  body: string,
  signal: AbortSignal,
): Promise<{ url: string; created: boolean } | null> {
  const remote = parseGitHubRemote((await git(root, ['remote', 'get-url', 'origin'])).out);
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (remote && token) {
    const res = await fetch(`https://api.github.com/repos/${remote.owner}/${remote.repo}/pulls`, {
      method: 'POST',
      signal,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
      body: JSON.stringify({ title, body, head: branch, base }),
    });
    const data = (await res.json()) as { html_url?: string; message?: string };
    if (res.ok && data.html_url) return { url: data.html_url, created: true };
    throw new Error(`GitHub refused the pull request: ${data.message ?? res.status}`);
  }
  // The GitHub CLI, if it's installed and signed in.
  const gh = await new Promise<GitResult>((resolve) => {
    const child = spawn('gh', ['pr', 'create', '--title', title, '--body', body, '--base', base, '--head', branch], { cwd: root, signal });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', () => resolve({ code: -1, out: '' }));
    child.on('close', (code) => resolve({ code, out: out.trim() }));
  });
  const ghUrl = gh.out.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0];
  if (gh.code === 0 && ghUrl) return { url: ghUrl, created: true };
  // No token and no CLI: hand back the page where the user can open it with one click.
  if (remote) {
    const q = new URLSearchParams({ expand: '1', title, body });
    return { url: `https://github.com/${remote.owner}/${remote.repo}/compare/${base}...${branch}?${q}`, created: false };
  }
  // A local or non-GitHub remote (like the bundled demo's): the push is the whole result.
  return null;
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[], run: Tool['run']): Tool {
  return { spec: { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } }, run };
}

export function gitTools(root: string): Tool[] {
  return [
    tool('git_status', 'Show the current branch, changed files and a diff summary.', {}, [], async (_args, ctx) => {
      const status = await mustGit(root, ['status', '--short', '--branch'], ctx.signal);
      const stat = (await git(root, ['diff', '--stat', 'HEAD'], ctx.signal)).out;
      return [status, stat].filter(Boolean).join('\n\n');
    }),
    tool(
      'create_branch',
      'Create and switch to a new branch for this change. Do this before editing files when the work should end in a pull request.',
      { name: { type: 'string', description: 'A few words describing the change, for example "add users table".' } },
      ['name'],
      async (args, ctx) => {
        const name = branchName(String(args.name ?? ''));
        const exists = (await git(root, ['rev-parse', '--verify', '--quiet', name], ctx.signal)).code === 0;
        await mustGit(root, exists ? ['checkout', name] : ['checkout', '-b', name], ctx.signal);
        return `${exists ? 'Switched to existing' : 'Created and switched to'} branch ${name}.`;
      },
    ),
    tool(
      'commit',
      'Stage every change and commit it. If you are on the default branch, a new branch is created first.',
      { message: { type: 'string', description: 'Commit message: a short summary line, optionally a blank line and details.' } },
      ['message'],
      async (args, ctx) => {
        const message = String(args.message ?? '').trim();
        if (!message) throw new Error('message is empty');
        let branch = await currentBranch(root);
        if (branch === (await defaultBranch(root))) {
          branch = branchName(message.split('\n')[0]);
          await mustGit(root, ['checkout', '-b', branch], ctx.signal);
        }
        await mustGit(root, ['add', '-A'], ctx.signal);
        const staged = (await git(root, ['diff', '--cached', '--name-only'], ctx.signal)).out;
        if (!staged) return `Nothing to commit on ${branch}.`;
        await mustGit(root, ['commit', '-m', message], ctx.signal);
        const sha = await mustGit(root, ['rev-parse', '--short', 'HEAD'], ctx.signal);
        return `Committed ${sha} on ${branch}:\n${staged}`;
      },
    ),
    tool(
      'open_pull_request',
      'Push the current branch and open a pull request into the default branch. Commit first.',
      {
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'What changed and how it was tested, in a few lines.' },
      },
      ['title'],
      async (args, ctx: ToolContext) => {
        const branch = await currentBranch(root);
        const base = await defaultBranch(root);
        if (branch === base) throw new Error(`You are on ${base}. Create a branch and commit before opening a pull request.`);
        const ahead = (await git(root, ['rev-list', '--count', `${base}..${branch}`], ctx.signal)).out;
        if (ahead === '0') throw new Error(`${branch} has no commits that ${base} lacks. Commit first.`);
        // Never force: a rejected push is reported, not overwritten.
        await mustGit(root, ['push', '-u', 'origin', branch], ctx.signal);
        const title = String(args.title ?? '').trim() || branch;
        const body = `${String(args.body ?? '').trim()}\n\n_Opened by voice with Flow Agent._`.trim();
        const pr = await createPullRequest(root, branch, base, title, body, ctx.signal);
        if (!pr) return `Pushed ${branch} to origin. origin is not on GitHub, so there is no pull request page to open.`;
        const { url, created } = pr;
        ctx.onPullRequest?.({ url, title, created });
        return created
          ? `Pushed ${branch} and opened a pull request: ${url}`
          : `Pushed ${branch}. No GitHub token or gh CLI was found, so the pull request page is ready to open: ${url}`;
      },
    ),
  ];
}
