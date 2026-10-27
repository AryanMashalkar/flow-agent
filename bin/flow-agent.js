#!/usr/bin/env node
// Launcher so `npx flow-agent` works from any project folder.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'server.ts')], {
  stdio: 'inherit',
  env: { ...process.env, WORKSPACE: process.env.WORKSPACE || process.cwd() },
  cwd: root,
});
child.on('exit', (code) => process.exit(code ?? 0));
// Pass Ctrl+C and kills on to the server so it never outlives the launcher.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
