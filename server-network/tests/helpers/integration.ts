import { describe, expect } from 'vitest';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/services/password.js';
import { sha256Hex } from '../../src/utils/crypto.js';
import { testConfig } from './config.js';

export const TEST_DB = process.env.TEST_DATABASE_URL;
/** Integration suites run only against a disposable MySQL given by TEST_DATABASE_URL. */
export const describeDb = TEST_DB ? describe : describe.skip;

export const GLOBAL_REG_TOKEN = 'global-registration-token-for-tests';
export const PASSWORD = 'correct-horse-battery-staple';

export interface Harness {
  app: FastifyInstance;
  prisma: PrismaClient;
}

export async function createHarness(overrides: Record<string, string> = {}): Promise<Harness> {
  const prisma = new PrismaClient({ datasources: { db: { url: TEST_DB! } } });
  const app = await buildApp({ config: testConfig(overrides), prisma });
  return { app, prisma };
}

export async function closeHarness(h: Harness | undefined) {
  if (!h) return;
  await h.app.close();
  await h.prisma.$disconnect();
}

/** FK-ordered deletes (no session-level FOREIGN_KEY_CHECKS tricks: Prisma pools connections). */
export async function resetDb(prisma: PrismaClient) {
  await prisma.auditLog.deleteMany();
  await prisma.devicePolicyStatus.deleteMany();
  await prisma.policyAssignment.deleteMany();
  await prisma.deviceGroupMember.deleteMany();
  await prisma.deviceGroup.deleteMany();
  await prisma.deviceCredential.deleteMany();
  await prisma.device.deleteMany();
  await prisma.policy.updateMany({ data: { activeVersionId: null } });
  await prisma.policyVersion.deleteMany();
  await prisma.policy.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
}

export async function createOrg(prisma: PrismaClient, code: string, registrationToken?: string) {
  return prisma.organization.create({
    data: { code, name: `Org ${code}`, registrationTokenHash: registrationToken ? sha256Hex(registrationToken) : null },
  });
}

let pwHash: string | null = null;
export async function createUser(prisma: PrismaClient, email: string, role: 'SUPER_ADMIN' | 'ORGANIZATION_ADMIN', organizationId: string | null) {
  pwHash ??= await hashPassword(PASSWORD);
  return prisma.user.create({ data: { email, role, organizationId, passwordHash: pwHash } });
}

export async function login(app: FastifyInstance, email: string, password = PASSWORD): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().access_token as string;
}

export const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

export interface AgentIdentity {
  deviceUuid: string;
  secret: string;
  secretHash: string;
  deviceId?: string;
  token?: string;
}

export function newAgentIdentity(): AgentIdentity {
  const secret = randomBytes(32).toString('base64url');
  return { deviceUuid: randomUUID(), secret, secretHash: createHash('sha256').update(secret).digest('hex') };
}

export function registerPayload(orgCode: string, id: AgentIdentity, extra: Record<string, unknown> = {}) {
  return {
    organization_id: orgCode,
    device_uuid: id.deviceUuid,
    hostname: 'LAB-PC-014',
    windows_version: 'Windows 11 Pro 23H2 (10.0.22631)',
    agent_version: '1.0.0',
    enrollment_secret_hash: id.secretHash,
    interfaces: [
      { name: 'Ethernet', mac: '00:1A:2B:3C:4D:5E', ipv4: ['192.168.1.24'], ipv6: ['fe80::1c2d:3e4f:5a6b:7c8d'], type: 'ethernet', is_primary: true },
    ],
    ...extra,
  };
}

export async function register(app: FastifyInstance, orgCode: string, id: AgentIdentity, token = GLOBAL_REG_TOKEN) {
  return app.inject({ method: 'POST', url: '/api/agent/register', headers: { 'x-registration-token': token }, payload: registerPayload(orgCode, id) });
}

export async function pollStatus(app: FastifyInstance, id: AgentIdentity) {
  return app.inject({ method: 'GET', url: '/api/agent/registration-status', headers: { 'x-device-uuid': id.deviceUuid, 'x-enrollment-secret': id.secret } });
}

/** Full enrollment: register → admin approve → claim credential. Returns the identity with token. */
export async function enroll(app: FastifyInstance, orgCode: string, adminToken: string): Promise<AgentIdentity & { deviceId: string; token: string }> {
  const id = newAgentIdentity();
  const r = await register(app, orgCode, id);
  expect(r.statusCode, r.body).toBe(201);
  const deviceId = r.json().device_id as string;
  const a = await app.inject({ method: 'POST', url: `/api/devices/${deviceId}/approve`, headers: bearer(adminToken) });
  expect(a.statusCode, a.body).toBe(200);
  const s = await pollStatus(app, id);
  expect(s.statusCode, s.body).toBe(200);
  return { ...id, deviceId, token: s.json().credential.token as string };
}

export function heartbeatPayload(id: AgentIdentity, extra: Record<string, unknown> = {}) {
  return { device_uuid: id.deviceUuid, agent_version: '1.0.1', current_policy_version: 0, current_ip: '192.168.1.25', status: 'HEALTHY', ...extra };
}

/** Create a policy via the admin API, publish v1, optionally assign to the org. */
export async function publishedPolicy(app: FastifyInstance, adminToken: string, opts: { organizationId?: string; code?: string; content?: unknown; assignOrg?: boolean } = {}) {
  const c = await app.inject({
    method: 'POST',
    url: '/api/policies',
    headers: bearer(adminToken),
    payload: { name: `Policy ${opts.code ?? 'auto'}`, ...(opts.code ? { code: opts.code } : {}), ...(opts.organizationId ? { organization_id: opts.organizationId } : {}), content: opts.content ?? { blocked_domains: ['example.com'] } },
  });
  expect(c.statusCode, c.body).toBe(201);
  const policy = c.json();
  const p = await app.inject({ method: 'POST', url: `/api/policies/${policy.id}/versions/1/publish`, headers: bearer(adminToken) });
  expect(p.statusCode, p.body).toBe(200);
  if (opts.assignOrg) {
    const a = await app.inject({ method: 'POST', url: `/api/policies/${policy.id}/assignments`, headers: bearer(adminToken), payload: { scope: 'ORGANIZATION' } });
    expect(a.statusCode, a.body).toBe(201);
  }
  return policy as { id: string; code: string; organization_id: string };
}
