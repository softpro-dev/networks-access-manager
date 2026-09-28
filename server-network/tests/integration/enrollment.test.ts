import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  bearer, closeHarness, createHarness, createOrg, createUser, describeDb, enroll, GLOBAL_REG_TOKEN, heartbeatPayload,
  login, newAgentIdentity, pollStatus, register, registerPayload, resetDb, type Harness,
} from '../helpers/integration.js';
import { sha256Hex } from '../../src/utils/crypto.js';

describeDb('device registration, approval and credentials', () => {
  let h: Harness;
  let orgA: string;
  let adminT: string;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => closeHarness(h));
  beforeEach(async () => {
    await resetDb(h.prisma);
    orgA = (await createOrg(h.prisma, 'INST-001')).id;
    await createOrg(h.prisma, 'COMPANY-002');
    await createUser(h.prisma, 'a@example.com', 'ORGANIZATION_ADMIN', orgA);
    adminT = await login(h.app, 'a@example.com');
  });

  it('registers PENDING (201), is idempotent with the same secret hash (200), 409 otherwise', async () => {
    const id = newAgentIdentity();
    const r1 = await register(h.app, 'INST-001', id);
    expect(r1.statusCode).toBe(201);
    expect(r1.json()).toEqual({ device_id: expect.any(String), status: 'PENDING' });
    const r2 = await register(h.app, 'INST-001', id);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().device_id).toBe(r1.json().device_id);
    const other = { ...newAgentIdentity(), deviceUuid: id.deviceUuid };
    const r3 = await register(h.app, 'INST-001', other);
    expect(r3.statusCode).toBe(409);
    expect(r3.json().error.code).toBe('DEVICE_ALREADY_REGISTERED');
    const r4 = await register(h.app, 'COMPANY-002', id);
    expect(r4.statusCode).toBe(409);
    const dev = await h.prisma.device.findUniqueOrThrow({ where: { deviceUuid: id.deviceUuid } });
    expect(dev.enrollmentSecretHash).toBe(id.secretHash);
    expect((await h.prisma.auditLog.findMany({ where: { action: 'DEVICE_REGISTERED' } })).length).toBe(1);
  });

  it('rejects bad registration tokens and unknown orgs with 401 INVALID_REGISTRATION_TOKEN', async () => {
    const id = newAgentIdentity();
    for (const [org, token] of [['INST-001', 'wrong'], ['NOPE-999', GLOBAL_REG_TOKEN]] as const) {
      const r = await register(h.app, org, id, token);
      expect(r.statusCode).toBe(401);
      expect(r.json().error.code).toBe('INVALID_REGISTRATION_TOKEN');
    }
    const noHeader = await h.app.inject({ method: 'POST', url: '/api/agent/register', payload: registerPayload('INST-001', id) });
    expect(noHeader.statusCode).toBe(401);
  });

  it('a per-organization token replaces the global one', async () => {
    await h.prisma.organization.update({ where: { id: orgA }, data: { registrationTokenHash: sha256Hex('org-specific-token') } });
    expect((await register(h.app, 'INST-001', newAgentIdentity())).statusCode).toBe(401);
    expect((await register(h.app, 'INST-001', newAgentIdentity(), 'org-specific-token')).statusCode).toBe(201);
    expect((await register(h.app, 'COMPANY-002', newAgentIdentity())).statusCode).toBe(201);
  });

  it('registration-status: PENDING → APPROVED with a one-time credential', async () => {
    const id = newAgentIdentity();
    const deviceId = (await register(h.app, 'INST-001', id)).json().device_id as string;
    expect((await pollStatus(h.app, id)).json()).toEqual({ status: 'PENDING' });
    const wrong = await pollStatus(h.app, { ...id, secret: 'x'.repeat(43) });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('INVALID_ENROLLMENT');
    expect((await pollStatus(h.app, { ...newAgentIdentity() })).statusCode).toBe(401);

    const ap = await h.app.inject({ method: 'POST', url: `/api/devices/${deviceId}/approve`, headers: bearer(adminT) });
    expect(ap.statusCode).toBe(200);
    expect(ap.json().status).toBe('APPROVED');

    const s = await pollStatus(h.app, id);
    expect(s.statusCode).toBe(200);
    const cred = s.json().credential;
    expect(s.json().status).toBe('APPROVED');
    expect(cred.token).toMatch(new RegExp(`^ndc_${cred.credential_id}\\.[A-Za-z0-9_-]{43}$`));
    expect(cred.expires_at).toBeNull();
    expect(new Date(cred.issued_at).toString()).not.toBe('Invalid Date');

    // Only the hash is stored; enrollment secret consumed.
    const row = await h.prisma.deviceCredential.findUniqueOrThrow({ where: { id: cred.credential_id } });
    expect(row.secretHash).toBe(sha256Hex(cred.token.split('.')[1]));
    expect((await h.prisma.device.findUniqueOrThrow({ where: { id: deviceId } })).enrollmentSecretHash).toBeNull();
    expect((await pollStatus(h.app, id)).statusCode).toBe(401);
    expect(await h.prisma.auditLog.count({ where: { action: 'CREDENTIAL_CLAIMED' } })).toBe(1);
    expect(JSON.stringify(await h.prisma.auditLog.findMany())).not.toContain(cred.token.split('.')[1]);

    const hb = await h.app.inject({ method: 'POST', url: '/api/agent/heartbeat', headers: bearer(cred.token), payload: heartbeatPayload(id) });
    expect(hb.statusCode).toBe(200);
  });

  it('reject → REJECTED status, and no credential', async () => {
    const id = newAgentIdentity();
    const deviceId = (await register(h.app, 'INST-001', id)).json().device_id as string;
    expect((await h.app.inject({ method: 'POST', url: `/api/devices/${deviceId}/reject`, headers: bearer(adminT) })).statusCode).toBe(200);
    expect((await pollStatus(h.app, id)).json()).toEqual({ status: 'REJECTED' });
    expect((await h.app.inject({ method: 'POST', url: `/api/devices/${deviceId}/approve`, headers: bearer(adminT) })).statusCode).toBe(409);
  });

  it('revocation blocks the credential immediately (403 CREDENTIAL_REVOKED)', async () => {
    const dev = await enroll(h.app, 'INST-001', adminT);
    expect((await h.app.inject({ method: 'GET', url: '/api/agent/policy/version', headers: bearer(dev.token) })).statusCode).toBe(200);
    const rv = await h.app.inject({ method: 'POST', url: `/api/devices/${dev.deviceId}/revoke`, headers: bearer(adminT) });
    expect(rv.statusCode).toBe(200);
    const r = await h.app.inject({ method: 'GET', url: '/api/agent/policy/version', headers: bearer(dev.token) });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('CREDENTIAL_REVOKED');
    expect(await h.prisma.auditLog.count({ where: { action: 'DEVICE_REVOKED' } })).toBe(1);
  });

  it('tampered or unknown tokens → 401 INVALID_CREDENTIAL', async () => {
    const dev = await enroll(h.app, 'INST-001', adminT);
    const [prefix, secret] = dev.token.split('.') as [string, string];
    const flipped = `${prefix}.${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`;
    for (const t of [flipped, `ndc_unknowncredential0.${secret}`]) {
      const r = await h.app.inject({ method: 'GET', url: '/api/agent/policy/version', headers: bearer(t) });
      expect(r.statusCode).toBe(401);
      expect(r.json().error.code).toBe('INVALID_CREDENTIAL');
    }
  });

  it('re-enroll resets to PENDING; the agent registers with a new secret and is approved again', async () => {
    const dev = await enroll(h.app, 'INST-001', adminT);
    const re = await h.app.inject({ method: 'POST', url: `/api/devices/${dev.deviceId}/re-enroll`, headers: bearer(adminT) });
    expect(re.json().status).toBe('PENDING');
    expect((await h.app.inject({ method: 'GET', url: '/api/agent/policy/version', headers: bearer(dev.token) })).statusCode).toBe(403);
    const fresh = { ...newAgentIdentity(), deviceUuid: dev.deviceUuid };
    const r = await register(h.app, 'INST-001', fresh);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ device_id: dev.deviceId, status: 'PENDING' });
    await h.app.inject({ method: 'POST', url: `/api/devices/${dev.deviceId}/approve`, headers: bearer(adminT) });
    const s = await pollStatus(h.app, fresh);
    expect(s.json().status).toBe('APPROVED');
    expect(s.json().credential.token).not.toBe(dev.token);
  });

  it('heartbeat records status fields and validates its body', async () => {
    const dev = await enroll(h.app, 'INST-001', adminT);
    const r = await h.app.inject({ method: 'POST', url: '/api/agent/heartbeat', headers: bearer(dev.token), payload: heartbeatPayload(dev, { status: 'DEGRADED' }) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ heartbeat_interval_seconds: 60, policy: null });
    const d = await h.prisma.device.findUniqueOrThrow({ where: { id: dev.deviceId } });
    expect(d).toMatchObject({ lastIp: '192.168.1.25', agentVersion: '1.0.1', reportedStatus: 'DEGRADED', currentPolicyVersion: 0 });
    expect(d.lastHeartbeatAt).not.toBeNull();
    for (const bad of [{ status: 'OK' }, { current_ip: 'not-an-ip' }, { current_policy_version: -1 }]) {
      const b = await h.app.inject({ method: 'POST', url: '/api/agent/heartbeat', headers: bearer(dev.token), payload: heartbeatPayload(dev, bad) });
      expect(b.statusCode).toBe(400);
      expect(b.json().error.code).toBe('VALIDATION_ERROR');
    }
    const view = await h.app.inject({ method: 'GET', url: `/api/devices/${dev.deviceId}`, headers: bearer(adminT) });
    expect(view.json()).toMatchObject({ hostname: 'LAB-PC-014', device_uuid: dev.deviceUuid, current_ip: '192.168.1.25', online: true, status: 'APPROVED' });
    expect(view.body).not.toMatch(/secretHash|secret_hash/);
  });
});
