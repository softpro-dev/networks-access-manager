/** HTTP-level tests that never reach the database (validation, auth rejection, envelopes, rate limits). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../../src/app.js';
import { testConfig } from '../helpers/config.js';

let app: FastifyInstance;
let limited: FastifyInstance;
const prisma = new PrismaClient({ datasources: { db: { url: 'mysql://nobody:nothing@127.0.0.1:1/none' } } });

beforeAll(async () => {
  app = await buildApp({ config: testConfig(), prisma });
  limited = await buildApp({ config: testConfig({ RATE_LIMIT_ENABLED: 'true' }), prisma });
});
afterAll(async () => {
  await app.close();
  await limited.close();
});

describe('app without database', () => {
  it('GET /api/health', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'ok' });
    expect(new Date(r.json().time).toString()).not.toBe('Invalid Date');
  });
  it('unknown route uses the error envelope', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });
  it('sets security headers', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/health' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });
  it('admin endpoints require a valid JWT', async () => {
    for (const url of ['/api/devices', '/api/policies', '/api/organizations', '/api/audit-logs', '/api/users', '/api/auth/me']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(401);
      expect(r.json().error.code).toBe('UNAUTHORIZED');
      const r2 = await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer not.a.jwt' } });
      expect(r2.statusCode, url).toBe(401);
    }
  });
  it('device tokens are not admin tokens', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/devices', headers: { authorization: `Bearer ndc_abcdefgh.${'a'.repeat(43)}` } });
    expect(r.statusCode).toBe(401);
  });
  it('agent endpoints reject missing/malformed credentials with INVALID_CREDENTIAL', async () => {
    for (const [method, url] of [['POST', '/api/agent/heartbeat'], ['GET', '/api/agent/policy'], ['GET', '/api/agent/policy/version'], ['POST', '/api/agent/policy/status'], ['POST', '/api/agent/policy/ack']] as const) {
      const r = await app.inject({ method, url, headers: { authorization: 'Bearer garbage' }, payload: method === 'POST' ? {} : undefined });
      expect(r.statusCode, url).toBe(401);
      expect(r.json()).toEqual({ error: { code: 'INVALID_CREDENTIAL', message: 'Invalid device credential' } });
    }
  });
  it('login validates its body', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@b.c' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('VALIDATION_ERROR');
  });
  it('register validates its body (400 VALIDATION_ERROR with details)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/agent/register',
      headers: { 'x-registration-token': 'x' },
      payload: { organization_id: 'inst-001', device_uuid: 'not-a-uuid', enrollment_secret_hash: 'XYZ' },
    });
    expect(r.statusCode).toBe(400);
    const body = r.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(['organization_id', 'device_uuid', 'enrollment_secret_hash']));
  });
  it('malformed JSON → 400 VALIDATION_ERROR', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/agent/register', headers: { 'content-type': 'application/json' }, payload: '{bad' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('VALIDATION_ERROR');
  });
  it('registration-status requires its headers', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/agent/registration-status' });
    expect(r.statusCode).toBe(400);
  });
  it('rate-limits /api/agent/register at 10/min per IP with RATE_LIMITED', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await limited.inject({ method: 'POST', url: '/api/agent/register', payload: {} });
      codes.push(r.statusCode);
      if (r.statusCode === 429) {
        expect(r.json().error.code).toBe('RATE_LIMITED');
        expect(r.headers['retry-after']).toBeDefined();
      }
    }
    expect(codes.slice(0, 10).every((c) => c === 400)).toBe(true);
    expect(codes[10]).toBe(429);
  });
  it('rate-limits login at 5/min per IP+username', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      // invalid password field type → 400 after the limiter ran; never touches the DB
      const r = await limited.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'victim@example.com', password: 123 } });
      codes.push(r.statusCode);
    }
    expect(codes).toEqual([400, 400, 400, 400, 400, 429]);
    const other = await limited.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'other@example.com', password: 123 } });
    expect(other.statusCode).toBe(400);
  });
  it('rate-limits authenticated agent calls (120/min; unparseable tokens fall back to the IP bucket)', async () => {
    let last = 0;
    for (let i = 0; i < 121; i++) {
      const r = await limited.inject({ method: 'GET', url: '/api/agent/policy/version', headers: { authorization: 'Bearer x' + i } });
      last = r.statusCode;
    }
    // different (unparseable) tokens share the IP bucket
    expect(last).toBe(429);
  });
});
