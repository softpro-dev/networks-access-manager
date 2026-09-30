/**
 * Runs `next <dev|start> web --port $WEB_PORT` (default 3001). Replaces the POSIX-only
 * `${WEB_PORT:-3001}` in package.json, which cmd.exe (npm's shell on Windows) does not expand.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const command = process.argv[2];
if (command !== 'dev' && command !== 'start') {
  console.error('usage: tsx scripts/next-web.ts <dev|start>');
  process.exit(2);
}

const port = process.env.WEB_PORT || '3001';
const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');

const child = spawn(process.execPath, [nextBin, command, 'web', '--port', port], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
