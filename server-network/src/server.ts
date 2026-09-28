import { readFileSync } from 'node:fs';
import { loadConfig, ConfigError } from './config/index.js';
import { createPrismaClient } from './database/prisma.js';
import { buildApp } from './app.js';

async function main() {
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
