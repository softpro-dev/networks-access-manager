/** Fastify owns only /api/*; the combined server forwards console routes to Next.js. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { testConfig } from '../helpers/config.js';

let app: FastifyInstance;
const prisma = new PrismaClient({ datasources: { db: { url: 'mysql://nobody:nothing@127.0.0.1:1/none' } } });

beforeAll(async () => {
  app = await buildApp({ config: testConfig(), prisma });
});
afterAll(async () => {
  await app.close();
});

describe('API boundary', () => {
  it('WEB_PUBLIC_URL defaults to the development app origin and rejects non-http schemes', () => {
    expect(testConfig().webPublicUrl).toBe('http://localhost:3000');
    expect(() => loadConfig({ DATABASE_URL: 'x', JWT_SECRET: 'x', WEB_PUBLIC_URL: 'javascript:alert(1)' })).toThrow(/WEB_PUBLIC_URL/);
  });
  it('/api/* keeps the strict CSP and unknown API routes stay JSON 404', async () => {
    const h = await app.inject({ method: 'GET', url: '/api/health' });
    expect(h.statusCode).toBe(200);
    expect(h.headers['content-security-policy']).toMatch(/default-src 'none'/);
    const n = await app.inject({ method: 'GET', url: '/api/nope', headers: { accept: 'text/html' } });
    expect(n.statusCode).toBe(404);
    expect(n.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });
});
