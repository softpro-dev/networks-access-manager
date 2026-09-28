/** GET / (API origin) serves a tiny HTML pointer to the Next.js admin console; /api/* is unchanged. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../../src/app.js';
import { landingPage } from '../../src/routes/index.js';
import { loadConfig } from '../../src/config/index.js';
import { testConfig } from '../helpers/config.js';

let app: FastifyInstance;
const prisma = new PrismaClient({ datasources: { db: { url: 'mysql://nobody:nothing@127.0.0.1:1/none' } } });

beforeAll(async () => {
  app = await buildApp({ config: testConfig({ WEB_PUBLIC_URL: 'https://admin.example.com' }), prisma });
});
afterAll(async () => {
  await app.close();
});

describe('landing page', () => {
  it('GET / returns HTML linking to the admin console with the strict CSP', async () => {
    const r = await app.inject({ method: 'GET', url: '/' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/html/);
    expect(r.body).toContain('href="https://admin.example.com"');
    expect(r.headers['content-security-policy']).toMatch(/default-src 'none'/);
  });
  it('escapes the configured URL', () => {
    expect(landingPage('https://x.example/?a="<b>')).toContain('https://x.example/?a=&quot;&lt;b&gt;');
  });
  it('WEB_PUBLIC_URL defaults to the dev console and rejects non-http schemes', () => {
    expect(testConfig().webPublicUrl).toBe('http://localhost:3001');
    expect(() => loadConfig({ DATABASE_URL: 'x', JWT_SECRET: 'x', WEB_PUBLIC_URL: 'javascript:alert(1)' })).toThrow(/WEB_PUBLIC_URL/);
  });
  it('/api/* is unaffected: health keeps the strict CSP, unknown routes stay JSON 404', async () => {
    const h = await app.inject({ method: 'GET', url: '/api/health' });
    expect(h.statusCode).toBe(200);
    expect(h.headers['content-security-policy']).toMatch(/default-src 'none'/);
    const n = await app.inject({ method: 'GET', url: '/api/nope', headers: { accept: 'text/html' } });
    expect(n.statusCode).toBe(404);
    expect(n.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    const deep = await app.inject({ method: 'GET', url: '/devices/abc', headers: { accept: 'text/html' } });
    expect(deep.statusCode).toBe(404);
    expect(deep.json().error.code).toBe('NOT_FOUND');
  });
});
