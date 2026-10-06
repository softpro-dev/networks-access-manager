import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import next from 'next';
import { loadConfig, ConfigError } from './config/index.js';
import { createPrismaClient } from './database/prisma.js';
import { buildApp } from './app.js';
import { errorBody } from './utils/errors.js';

function loadDotEnv() {
  // Real environment variables take precedence. In production, .env supplies optional shared
  // values while ENV_FILE (.env.prod) wins for values defined there.
  const primary = process.env.ENV_FILE ?? '.env';
  const files = primary === '.env' ? [primary] : [primary, '.env'];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const values = parseEnv(readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(values)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
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
  const web = next({ dev: config.nodeEnv !== 'production', dir: resolve(process.cwd(), 'web') });
  await web.prepare();
  const handleWebRequest = web.getRequestHandler();

  // Fastify owns the API namespace. It delegates the console, its assets, and client-side routes
  // to Next through the same Node listener.
  const app = await buildApp({
    config,
    prisma,
    fastifyOptions: https ? { https } : {},
    notFoundHandler: (req, reply) => {
      if (req.url === '/api' || req.url.startsWith('/api/')) {
        return reply.code(404).send(errorBody('NOT_FOUND', 'Route not found'));
      }
      reply.hijack();
      return handleWebRequest(req.raw, reply.raw).catch((err: unknown) => {
        req.log.error({ err }, 'web request failed');
        if (!reply.raw.headersSent) {
          reply.raw.statusCode = 500;
          reply.raw.setHeader('content-type', 'text/plain; charset=utf-8');
        }
        if (!reply.raw.writableEnded) reply.raw.end('Internal Server Error');
      });
    },
  });

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
  printBanner(config.port, Boolean(https), config.webPublicUrl);
}

// Plain stdout (not the JSON logger) so the URLs are easy to spot and click in the terminal.
// No right-hand border: it can't misalign when a URL is long or the terminal wraps/prefixes lines.
function printBanner(port: number, tls: boolean, webUrl: string) {
  const api = `${tls ? 'https' : 'http'}://localhost:${port}`;
  const lines = [
    '',
    '  ✔ Network Access Manager is running',
    '',
    `    Admin console : ${webUrl}`,
    `    API           : ${api}/api`,
    `    Health check  : ${api}/api/health`,
    '',
  ];
  for (const l of lines) console.log(l);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
