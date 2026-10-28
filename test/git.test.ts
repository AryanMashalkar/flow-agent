import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { branchName, git, gitTools, parseGitHubRemote } from '../src/git.ts';
import type { PullRequestInfo, ToolContext } from '../src/tools.ts';
import { allTools } from '../src/tools.ts';

/** A repo with one commit on main, and a local bare repo as its origin. */
async function repo() {
  const dir = await mkdtemp(path.join(tmpdir(), 'flow-git-'));
  const origin = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  await git(dir, ['init', '--bare', '-b', 'main', origin]);
  await git(dir, ['init', '-b', 'main', work]);
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 't@example.com'], ['commit.gpgsign', 'false']]) await git(work, ['config', k, v]);
  await writeFile(path.join(work, 'db.js'), 'export const driver = "sqlite";\n');
  await git(work, ['add', '-A']);
  await git(work, ['commit', '-m', 'init']);
  await git(work, ['remote', 'add', 'origin', origin]);
  await git(work, ['push', '-u', 'origin', 'main']);
  return { work, origin };
}

const prs: PullRequestInfo[] = [];
const ctx: ToolContext = { signal: new AbortController().signal, onFileChange: () => {}, onPullRequest: (pr) => prs.push(pr) };
const byName = (root: string, name: string) => gitTools(root).find((t) => t.spec.function.name === name)!;

test('branchName makes safe, prefixed names', () => {
  assert.equal(branchName('Add Postgres users table!'), 'flow/add-postgres-users-table');
  assert.equal(branchName('flow/fix bug; rm -rf /'), 'flow/fix-bug-rm-rf');
  assert.equal(branchName('???'), 'flow/change');
});

test('parseGitHubRemote reads https and ssh remotes', () => {
  assert.deepEqual(parseGitHubRemote('https://github.com/AryanMashalkar/flow-agent.git'), { owner: 'AryanMashalkar', repo: 'flow-agent' });
  assert.deepEqual(parseGitHubRemote('git@github.com:a/b.git'), { owner: 'a', repo: 'b' });
  assert.equal(parseGitHubRemote('https://gitlab.com/a/b'), null);
});

test('commit on main moves the work to a new branch first', async () => {
  const { work } = await repo();
  await writeFile(path.join(work, 'db.js'), 'export const driver = "postgres";\n');
  const out = await byName(work, 'commit').run({ message: 'Switch to Postgres' }, ctx);
  assert.match(out, /on flow\/switch-to-postgres:\ndb\.js/);
  assert.equal((await git(work, ['rev-parse', '--abbrev-ref', 'HEAD'])).out, 'flow/switch-to-postgres');
  assert.equal((await git(work, ['rev-list', '--count', 'main'])).out, '1', 'main is untouched');
});

test('open_pull_request refuses main, pushes a branch, and offers the PR page without a token', async () => {
  const { work, origin } = await repo();
  await assert.rejects(byName(work, 'open_pull_request').run({ title: 'x' }, ctx), /You are on main/);

  await byName(work, 'create_branch').run({ name: 'users table' }, ctx);
  await writeFile(path.join(work, 'users.js'), 'export const users = [];\n');
  await byName(work, 'commit').run({ message: 'Add users table' }, ctx);
  // Pretend origin lives on GitHub so the compare URL can be built; pushes still go to the local bare repo.
  await git(work, ['config', 'remote.origin.pushurl', origin]);
  await git(work, ['remote', 'set-url', 'origin', 'https://github.com/demo/app.git']);
  await git(work, ['config', 'remote.origin.pushurl', origin]);

  const saved = { t: process.env.GITHUB_TOKEN, g: process.env.GH_TOKEN, p: process.env.PATH };
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  try {
    prs.length = 0;
    const out = await byName(work, 'open_pull_request').run({ title: 'Add users table', body: 'Adds it.' }, ctx);
    assert.match(out, /Pushed flow\/users-table/);
    assert.equal((await git(origin, ['rev-parse', '--verify', 'flow/users-table'])).code, 0, 'branch reached origin');
    assert.equal(prs.length, 1);
    assert.ok(prs[0].url.startsWith('https://github.com/demo/app/compare/main...flow/users-table?'));
  } finally {
    if (saved.t) process.env.GITHUB_TOKEN = saved.t;
    if (saved.g) process.env.GH_TOKEN = saved.g;
  }
});

test('run_command will not push; that goes through open_pull_request', async () => {
  const { work } = await repo();
  const run = allTools(work).find((t) => t.spec.function.name === 'run_command')!;
  await assert.rejects(run.run({ command: 'git push origin main' }, ctx), /open_pull_request/);
});
