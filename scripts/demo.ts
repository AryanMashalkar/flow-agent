// `npm run demo`: a fresh copy of the bundled todo app, as its own git repo, with Flow Agent pointed at it.
// Every run starts clean, so a botched video take is one restart away.
import { spawn } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from '../src/git.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  // No .env: the server will say what's missing.
}

const demoDir = path.join(root, '.demo');
const work = path.join(demoDir, 'todo-app');
const remote = process.env.DEMO_REPO?.trim();

async function must(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.out}`);
  return r.out;
}

async function seed(dir: string): Promise<void> {
  await cp(path.join(root, 'demo', 'todo-app'), dir, { recursive: true });
  await must(dir, ['add', '-A']);
  await must(dir, ['commit', '-m', 'Initial todo app']);
}

async function identity(dir: string): Promise<void> {
  // Commits need a name; borrow nothing from the user's global config if it's missing.
  if (!(await git(dir, ['config', 'user.email'])).out) {
    await must(dir, ['config', 'user.name', 'Flow Agent Demo']);
    await must(dir, ['config', 'user.email', 'demo@flow-agent.local']);
  }
}

await rm(demoDir, { recursive: true, force: true });
await mkdir(demoDir, { recursive: true });

if (remote) {
  // Your own GitHub repo, so "open a PR" opens a real one. Empty repos are seeded once.
  const cloned = await git(demoDir, ['clone', remote, work]);
  if (cloned.code !== 0) throw new Error(`Could not clone DEMO_REPO (${remote}):\n${cloned.out}`);
  await identity(work);
  if ((await git(work, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code !== 0) {
    await must(work, ['checkout', '-b', 'main']);
    await seed(work);
    await must(work, ['push', '-u', 'origin', 'main']);
  }
  console.log(`Demo workspace cloned from ${remote}`);
} else {
  // No GitHub repo configured: a local bare repo stands in for origin, so pushes still work.
  const origin = path.join(demoDir, 'origin.git');
  await must(demoDir, ['init', '--bare', '-b', 'main', origin]);
  await must(demoDir, ['init', '-b', 'main', work]);
  await identity(work);
  await seed(work);
  await must(work, ['remote', 'add', 'origin', origin]);
  await must(work, ['push', '-u', 'origin', 'main']);
  console.log('Demo workspace ready (set DEMO_REPO in .env to open real pull requests)');
}

const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'server.ts')], {
  stdio: 'inherit',
  env: { ...process.env, WORKSPACE: work },
  cwd: root,
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
