import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { bearer, closeHarness, createHarness, createOrg, createUser, describeDb, enroll, heartbeatPayload, login, newAgentIdentity, publishedPolicy, register, resetDb, type Harness } from '../helpers/integration.js';

describeDb('organization isolation', () => {
  let h: Harness;
  let orgA: string;
  let orgB: string;
  let superT: string;
  let adminA: string;
  let adminB: string;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => closeHarness(h));
  beforeEach(async () => {
    await resetDb(h.prisma);
    orgA = (await createOrg(h.prisma, 'INST-001')).id;
    orgB = (await createOrg(h.prisma, 'COMPANY-002')).id;
    await createUser(h.prisma, 'super@example.com', 'SUPER_ADMIN', null);
    await createUser(h.prisma, 'a@example.com', 'ORGANIZATION_ADMIN', orgA);
    await createUser(h.prisma, 'b@example.com', 'ORGANIZATION_ADMIN', orgB);
    superT = await login(h.app, 'super@example.com');
    adminA = await login(h.app, 'a@example.com');
    adminB = await login(h.app, 'b@example.com');
  });

  it('org A admin cannot see or modify org B devices', async () => {
    const idB = newAgentIdentity();
    const reg = await register(h.app, 'COMPANY-002', idB);
    const devB = reg.json().device_id as string;
    const list = await h.app.inject({ method: 'GET', url: '/api/devices', headers: bearer(adminA) });
    expect(list.json().items).toHaveLength(0);
    expect((await h.app.inject({ method: 'GET', url: `/api/devices?organization_id=${orgB}`, headers: bearer(adminA) })).statusCode).toBe(404);
    for (const [method, url] of [['GET', `/api/devices/${devB}`], ['POST', `/api/devices/${devB}/approve`], ['POST', `/api/devices/${devB}/revoke`], ['POST', `/api/devices/${devB}/re-enroll`]] as const) {
      const r = await h.app.inject({ method, url, headers: bearer(adminA) });
      expect(r.statusCode, url).toBe(404);
    }
    expect((await h.prisma.device.findUniqueOrThrow({ where: { id: devB } })).status).toBe('PENDING');
    expect((await h.app.inject({ method: 'GET', url: `/api/devices/${devB}`, headers: bearer(adminB) })).statusCode).toBe(200);
  });

  it('org A admin cannot see org B policies, organizations or audit logs', async () => {
    const polB = await publishedPolicy(h.app, adminB, { code: 'POL-001', assignOrg: true });
    expect((await h.app.inject({ method: 'GET', url: '/api/policies', headers: bearer(adminA) })).json().items).toHaveLength(0);
    for (const url of [`/api/policies/${polB.id}`, `/api/policies/${polB.id}/versions/1`, `/api/organizations/${orgB}`]) {
      expect((await h.app.inject({ method: 'GET', url, headers: bearer(adminA) })).statusCode, url).toBe(404);
    }
    expect((await h.app.inject({ method: 'POST', url: `/api/policies/${polB.id}/deactivate`, headers: bearer(adminA) })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'POST', url: '/api/policies', headers: bearer(adminA), payload: { name: 'x', organization_id: orgB } })).statusCode).toBe(404);
    const audit = await h.app.inject({ method: 'GET', url: '/api/audit-logs', headers: bearer(adminA) });
    expect(audit.json().items.every((l: { organization_id: string }) => l.organization_id === orgA)).toBe(true);
    expect((await h.app.inject({ method: 'GET', url: `/api/audit-logs?organization_id=${orgB}`, headers: bearer(adminA) })).statusCode).toBe(404);
    const orgs = await h.app.inject({ method: 'GET', url: '/api/organizations', headers: bearer(adminA) });
    expect(orgs.json().items.map((o: { code: string }) => o.code)).toEqual(['INST-001']);
  });

  it('assignments cannot target another organization\'s groups or devices', async () => {
    const polA = await publishedPolicy(h.app, adminA, { code: 'POL-001' });
    const devB = await enroll(h.app, 'COMPANY-002', adminB);
    const groupB = await h.app.inject({ method: 'POST', url: '/api/device-groups', headers: bearer(adminB), payload: { name: 'lab' } });
    const r1 = await h.app.inject({ method: 'POST', url: `/api/policies/${polA.id}/assignments`, headers: bearer(superT), payload: { scope: 'DEVICE', target_device_id: devB.deviceId } });
    expect(r1.statusCode).toBe(400);
    const r2 = await h.app.inject({ method: 'POST', url: `/api/policies/${polA.id}/assignments`, headers: bearer(superT), payload: { scope: 'GROUP', target_group_id: groupB.json().id } });
    expect(r2.statusCode).toBe(400);
    const groupA = await h.app.inject({ method: 'POST', url: '/api/device-groups', headers: bearer(adminA), payload: { name: 'lab' } });
    const m = await h.app.inject({ method: 'POST', url: `/api/device-groups/${groupA.json().id}/members`, headers: bearer(adminA), payload: { device_ids: [devB.deviceId] } });
    expect(m.statusCode).toBe(400);
  });

  it('a device from org A never receives org B\'s policy, whatever ids it sends', async () => {
    const polA = await publishedPolicy(h.app, adminA, { code: 'POL-001', content: { blocked_domains: ['a-only.com'] }, assignOrg: true });
    await publishedPolicy(h.app, adminB, { code: 'POL-900', content: { blocked_domains: ['b-only.com'] }, assignOrg: true });
    const devA = await enroll(h.app, 'INST-001', adminA);
    const devB = await enroll(h.app, 'COMPANY-002', adminB);

    const doc = await h.app.inject({ method: 'GET', url: '/api/agent/policy?organization_id=' + orgB, headers: bearer(devA.token) });
    expect(doc.statusCode).toBe(200);
    expect(doc.json()).toMatchObject({ policy_id: 'EFFECTIVE', organization_id: 'INST-001', device_uuid: devA.deviceUuid });
    expect(doc.json().content.blocked_domains).toEqual(['a-only.com']);
    expect(doc.json().sources).toEqual([expect.objectContaining({ code: polA.code })]);
    expect(doc.body).not.toContain('b-only.com');

    // Heartbeat claiming to be org B's device → DEVICE_MISMATCH
    const hb = await h.app.inject({ method: 'POST', url: '/api/agent/heartbeat', headers: bearer(devA.token), payload: heartbeatPayload(devB) });
    expect(hb.statusCode).toBe(403);
    expect(hb.json().error.code).toBe('DEVICE_MISMATCH');

    // Ack for org B's policy → POLICY_MISMATCH
    const ack = await h.app.inject({ method: 'POST', url: '/api/agent/policy/ack', headers: bearer(devA.token), payload: { policy_id: 'POL-900', version: 1, content_sha256: 'a'.repeat(64) } });
    expect(ack.statusCode).toBe(409);

    // Status report naming org B's policy is recorded without linking to org B's rows
    const st = await h.app.inject({ method: 'POST', url: '/api/agent/policy/status', headers: bearer(devA.token), payload: { policy_id: 'POL-900', version: 1, status: 'DOWNLOADED' } });
    expect(st.statusCode).toBe(204);
    const row = await h.prisma.devicePolicyStatus.findUniqueOrThrow({ where: { deviceId: devA.deviceId } });
    expect(row.policyId).toBeNull();

    // Admin API is not reachable with a device credential
    expect((await h.app.inject({ method: 'GET', url: '/api/devices', headers: bearer(devA.token) })).statusCode).toBe(401);
  });
});
