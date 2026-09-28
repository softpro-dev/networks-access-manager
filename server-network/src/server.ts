import { readFileSync } from 'node:fs';
import { loadConfig, ConfigError } from './config/index.js';
import { createPrismaClient } from './database/prisma.js';
import { buildApp } from './app.js';

function loadDotEnv() {
  // Real environment variables take precedence; .env is optional (absent in production).
  try {
    process.loadEnvFile('.env');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

async function main() {
  loadDotEnv();
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  const prisma = createPrismaClient(config.databaseUrl);
  const https =
    config.tlsCertPath && config.tlsKeyPath
      ? { cert: readFileSync(config.tlsCertPath), key: readFileSync(config.tlsKeyPath), minVersion: 'TLSv1.2' as const }
      : null;
  const app = await buildApp({ config, prisma, fastifyOptions: https ? { https } : {} });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await prisma.$disconnect();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  if (config.nodeEnv === 'production' && !https && config.trustProxy === false) {
    app.log.warn('Serving plain HTTP without TRUST_PROXY: terminate TLS at a reverse proxy (TLS is mandatory for agents).');
  }
  await prisma.$connect();
  await app.listen({ host: config.host, port: config.port });
  printBanner(config.port, Boolean(https), process.env.WEB_PUBLIC_URL ?? webUrlFromPort());
}

function webUrlFromPort(): string {
  return `http://localhost:${process.env.WEB_PORT ?? '3001'}`;
}

// Plain stdout (not the JSON logger) so the URLs are easy to spot and click in the terminal.
function printBanner(port: number, tls: boolean, webUrl: string) {
  const api = `${tls ? 'https' : 'http'}://localhost:${port}`;
  const lines = [
    'Network Access Manager is running',
    '',
    `  Admin console : ${webUrl}`,
    `  API           : ${api}/api`,
    `  Health check  : ${api}/api/health`,
  ];
  const width = Math.max(...lines.map((l) => l.length)) + 2;
  const bar = '─'.repeat(width);
  console.log(`\n┌${bar}┐\n${lines.map((l) => `│ ${l.padEnd(width - 1)}│`).join('\n')}\n└${bar}┘\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
