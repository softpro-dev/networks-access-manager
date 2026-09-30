/**
 * Runs `next <dev|start> web --port <port>`. Port: WEB_PORT from the environment, else WEB_PORT
 * from ../.env, else 3001. Replaces the POSIX-only `${WEB_PORT:-3001}` in package.json, which
 * cmd.exe (npm's shell on Windows) does not expand.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/** Read ONLY WEB_PORT from ../.env (the server's secrets never enter the Next process env). */
function fileWebPort(): string | undefined {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
  if (!existsSync(file)) return undefined;
  try {
    return parseEnv(readFileSync(file, 'utf8')).WEB_PORT;
  } catch {
    return undefined;
  }
}

const command = process.argv[2];
if (command !== 'dev' && command !== 'start') {
  console.error('usage: tsx scripts/next-web.ts <dev|start>');
  process.exit(2);
}

const port = process.env.WEB_PORT || fileWebPort() || '3001';
const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');

const child = spawn(process.execPath, [nextBin, command, 'web', '--port', port], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
