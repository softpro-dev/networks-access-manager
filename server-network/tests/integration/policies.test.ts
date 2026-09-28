import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { bearer, closeHarness, createHarness, createOrg, createUser, describeDb, enroll, heartbeatPayload, login, resetDb, type Harness } from '../helpers/integration.js';
import { canonicalSha256 } from '../../src/domain/canonicalJson.js';

describeDb('policy lifecycle, assignment and agent sync', () => {
  let h: Harness;
  let orgA: string;
  let t: string;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => closeHarness(h));
  beforeEach(async () => {
    await resetDb(h.prisma);
    orgA = (await createOrg(h.prisma, 'INST-001')).id;
    await createUser(h.prisma, 'a@example.com', 'ORGANIZATION_ADMIN', orgA);
    t = await login(h.app, 'a@example.com');
  });

  const api = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    h.app.inject({ method, url, headers: bearer(t), ...(payload !== undefined ? { payload: payload as object } : {}) });

  it('create → edit draft → publish → immutable → new version → rollback', async () => {
    const c = await api('POST', '/api/policies', { name: 'Baseline', content: { blocked_domains: ['Example.com.'] } });
    expect(c.statusCode).toBe(201);
    const p = c.json();
    expect(p.code).toBe('POL-001');
    expect(p.versions).toEqual([expect.objectContaining({ version: 1, status: 'DRAFT' })]);

    const bad = await api('PUT', `/api/policies/${p.id}/versions/1`, { content: { blocked_domains: ['1.2.3.4'], extra: 1 } });
    expect(bad.statusCode).toBe(400);
    const edit = await api('PUT', `/api/policies/${p.id}/versions/1`, { content: { blocked_domains: ['example.com', '*.example.com'], allowed_domains: ['bücher.de'] } });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().content.allowed_domains).toEqual(['xn--bcher-kva.de']);
    expect(Object.keys(edit.json().content)).toHaveLength(9);

    const val = await api('POST', `/api/policies/${p.id}/versions/1/validate`);
    expect(val.json()).toMatchObject({ valid: true, errors: [] });

    const pub = await api('POST', `/api/policies/${p.id}/versions/1/publish`);
    expect(pub.statusCode).toBe(200);
    expect(pub.json()).toMatchObject({ status: 'PUBLISHED', is_active_version: true });
    expect(pub.json().content_sha256).toBe(canonicalSha256(pub.json().content));

    const immut = await api('PUT', `/api/policies/${p.id}/versions/1`, { content: {} });
    expect(immut.statusCode).toBe(409);
    expect(immut.json().error.code).toBe('POLICY_VERSION_IMMUTABLE');
    expect((await api('POST', `/api/policies/${p.id}/versions/1/publish`)).statusCode).toBe(409);

    const v2 = await api('POST', `/api/policies/${p.id}/versions`, {});
    expect(v2.statusCode).toBe(201);
    expect(v2.json()).toMatchObject({ version: 2, status: 'DRAFT', content: pub.json().content });
    expect((await api('POST', `/api/policies/${p.id}/versions`, {})).json().error.code).toBe('DRAFT_EXISTS');
    await api('PUT', `/api/policies/${p.id}/versions/2`, { content: { blocked_domains: ['v2.example.com'] } });
    await api('POST', `/api/policies/${p.id}/versions/2/publish`);
    expect((await api('GET', `/api/policies/${p.id}`)).json().active_version).toBe(2);

    const rb = await api('POST', `/api/policies/${p.id}/rollback`, { version: 1 });
    expect(rb.statusCode).toBe(200);
    expect(rb.json().active_version).toBe(1);
    expect((await api('POST', `/api/policies/${p.id}/rollback`, { version: 1 })).statusCode).toBe(409);
    const actions = (await h.prisma.auditLog.findMany()).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['POLICY_CREATED', 'POLICY_PUBLISHED', 'POLICY_ROLLED_BACK']));
  });

  it('agent sync: version check, document, ETag/304, ack, status, rollback to a lower version', async () => {
    const p = (await api('POST', '/api/policies', { name: 'P', content: { blocked_domains: ['example.com'] } })).json();
    await api('POST', `/api/policies/${p.id}/versions/1/publish`);
    const dev = await enroll(h.app, 'INST-001', t);
    const agent = (method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
      h.app.inject({ method, url, headers: { ...bearer(dev.token), ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });

    expect((await agent('GET', '/api/agent/policy/version')).json()).toEqual({ policy_id: null, version: 0, etag: null });
    const none = await agent('GET', '/api/agent/policy');
    expect(none.statusCode).toBe(404);
    expect(none.json().error.code).toBe('NO_POLICY_ASSIGNED');

    await api('POST', `/api/policies/${p.id}/assignments`, { scope: 'ORGANIZATION' });
    const ver = (await agent('GET', '/api/agent/policy/version')).json();
    expect(ver).toMatchObject({ policy_id: 'POL-001', version: 1 });
    expect(ver.etag).toMatch(/^"POL-001:1:[0-9a-f]{8}"$/);

    const hb = await agent('POST', '/api/agent/heartbeat', heartbeatPayload(dev));
    expect(hb.json().policy).toEqual(ver);

    const doc = await agent('GET', '/api/agent/policy');
    expect(doc.statusCode).toBe(200);
    expect(doc.headers.etag).toBe(ver.etag);
    const body = doc.json();
    expect(body).toMatchObject({ schema_version: 1, policy_id: 'POL-001', version: 1, organization_id: 'INST-001', device_uuid: dev.deviceUuid, assignment_scope: 'ORGANIZATION' });
    expect(canonicalSha256(body.content)).toBe(body.content_sha256);
    expect(ver.etag).toBe(`"POL-001:1:${body.content_sha256.slice(0, 8)}"`);

    const cached = await agent('GET', '/api/agent/policy', undefined, { 'if-none-match': ver.etag });
    expect(cached.statusCode).toBe(304);
    expect(cached.body).toBe('');
    expect((await agent('GET', '/api/agent/policy', undefined, { 'if-none-match': '"POL-001:0:00000000"' })).statusCode).toBe(200);

    expect((await agent('POST', '/api/agent/policy/status', { policy_id: 'POL-001', version: 1, status: 'APPLYING' })).statusCode).toBe(204);
    expect((await agent('POST', '/api/agent/policy/ack', { policy_id: 'POL-001', version: 1, content_sha256: body.content_sha256 })).statusCode).toBe(204);
    expect((await agent('POST', '/api/agent/policy/ack', { policy_id: 'POL-001', version: 2, content_sha256: body.content_sha256 })).statusCode).toBe(409);
    const view = (await api('GET', `/api/devices/${dev.deviceId}`)).json();
    expect(view.policy_status).toMatchObject({ status: 'APPLIED', version: 1 });
    expect(view.current_policy).toMatchObject({ policy_id: 'POL-001', version: 1 });

    const fail = await agent('POST', '/api/agent/policy/status', { policy_id: 'POL-001', version: 1, status: 'FAILED', error_code: 'policy_apply_failed', message: 'WFP filter add failed: 0x80320009', active_policy_id: 'POL-001', active_version: 0 });
    expect(fail.statusCode).toBe(204);
    expect(await h.prisma.auditLog.count({ where: { action: 'POLICY_APPLICATION_FAILED' } })).toBe(1);
    expect((await agent('POST', '/api/agent/policy/status', { policy_id: 'POL-001', version: 1, status: 'BROKEN' })).statusCode).toBe(400);

    // v2 then rollback: agent is told the LOWER version again
    await api('POST', `/api/policies/${p.id}/versions`, {});
    await api('POST', `/api/policies/${p.id}/versions/2/publish`);
    expect((await agent('GET', '/api/agent/policy/version')).json().version).toBe(2);
    await api('POST', `/api/policies/${p.id}/rollback`, { version: 1 });
    expect((await agent('GET', '/api/agent/policy/version')).json()).toEqual(ver);

    // deactivate → nothing applies
    await api('POST', `/api/policies/${p.id}/deactivate`);
    expect((await agent('GET', '/api/agent/policy')).statusCode).toBe(404);
    await api('POST', `/api/policies/${p.id}/activate`);
    expect((await agent('GET', '/api/agent/policy')).statusCode).toBe(200);
  });

  it('assignment precedence: DEVICE > GROUP > ORGANIZATION, priority within scope', async () => {
    const mk = async (code: string) => {
      const p = (await api('POST', '/api/policies', { name: code, code })).json();
      await api('POST', `/api/policies/${p.id}/versions/1/publish`);
      return p.id as string;
    };
    const [orgPol, grpLow, grpHigh, devPol] = [await mk('ORG-POL'), await mk('GRP-LOW'), await mk('GRP-HIGH'), await mk('DEV-POL')];
    const dev = await enroll(h.app, 'INST-001', t);
    const g1 = (await api('POST', '/api/device-groups', { name: 'g1' })).json().id;
    const g2 = (await api('POST', '/api/device-groups', { name: 'g2' })).json().id;
    await api('POST', `/api/device-groups/${g1}/members`, { device_ids: [dev.deviceId] });
    await api('POST', `/api/device-groups/${g2}/members`, { device_ids: [dev.deviceId] });
    const current = async () => (await h.app.inject({ method: 'GET', url: '/api/agent/policy/version', headers: bearer(dev.token) })).json().policy_id;

    await api('POST', `/api/policies/${orgPol}/assignments`, { scope: 'ORGANIZATION', priority: 999 });
    expect(await current()).toBe('ORG-POL');
    await api('POST', `/api/policies/${grpLow}/assignments`, { scope: 'GROUP', target_group_id: g1, priority: 1 });
    expect(await current()).toBe('GRP-LOW');
    await api('POST', `/api/policies/${grpHigh}/assignments`, { scope: 'GROUP', target_group_id: g2, priority: 5 });
    expect(await current()).toBe('GRP-HIGH');
    const da = (await api('POST', `/api/policies/${devPol}/assignments`, { scope: 'DEVICE', target_device_id: dev.deviceId, priority: -10 })).json();
    expect(await current()).toBe('DEV-POL');
    const doc = await h.app.inject({ method: 'GET', url: '/api/agent/policy', headers: bearer(dev.token) });
    expect(doc.json().assignment_scope).toBe('DEVICE');
    expect((await api('DELETE', `/api/policies/${devPol}/assignments/${da.id}`)).statusCode).toBe(204);
    expect(await current()).toBe('GRP-HIGH');
    await api('POST', `/api/policies/${grpHigh}/deactivate`);
    expect(await current()).toBe('GRP-LOW');
  });

  it('ad-hoc validation returns errors, warnings and decisions', async () => {
    const r = await api('POST', '/api/policies/validate', {
      content: { default_action: 'block', allowed_domains: ['company.com', '*.company.com'], blocked_domains: ['*.example.com'] },
      names: ['www.company.com', 'mgmt.example.com', 'other.org'],
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().valid).toBe(true);
    expect(r.json().decisions.map((d: { action: string }) => d.action)).toEqual(['allow', 'allow', 'block']);
    expect(r.json().warnings.length).toBeGreaterThan(0);
    const bad = await api('POST', '/api/policies/validate', { content: { blocked_domains: ['*'] } });
    expect(bad.json().valid).toBe(false);
  });
});
