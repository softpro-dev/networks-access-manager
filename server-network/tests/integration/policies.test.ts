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
    const c = await api('POST', '/api/policies', { name: 'Baseline', kind: 'BLACKLIST', content: { blocked_domains: ['Example.com.'] } });
    expect(c.statusCode).toBe(201);
    const p = c.json();
    expect(p).toMatchObject({ code: 'POL-001', kind: 'BLACKLIST' });
    expect(p.versions).toEqual([expect.objectContaining({ version: 1, status: 'DRAFT' })]);

    const bad = await api('PUT', `/api/policies/${p.id}/versions/1`, { content: { blocked_domains: ['1.2.3.4'], extra: 1 } });
    expect(bad.statusCode).toBe(400);
    const wrongKind = await api('PUT', `/api/policies/${p.id}/versions/1`, { content: { allowed_domains: ['ok.com'] } });
    expect(wrongKind.statusCode).toBe(400);
    expect(wrongKind.json().error.details[0].path).toBe('allowed_domains');
    const edit = await api('PUT', `/api/policies/${p.id}/versions/1`, { content: { blocked_domains: ['example.com', '*.example.com', 'bücher.de'] } });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().content.blocked_domains).toEqual(['example.com', '*.example.com', 'xn--bcher-kva.de']);
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

    // Console "save": publishes a new version in one step; an identical save is a no-op.
    const save = await api('PUT', `/api/policies/${p.id}/content`, { content: { blocked_domains: ['saved.example.com'] } });
    expect(save.statusCode).toBe(200);
    expect(save.json()).toMatchObject({ active_version: 3, unchanged: false });
    expect((await api('PUT', `/api/policies/${p.id}/content`, { content: { blocked_domains: ['saved.example.com'] } })).json()).toMatchObject({ active_version: 3, unchanged: true });

    const actions = (await h.prisma.auditLog.findMany()).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['POLICY_CREATED', 'POLICY_PUBLISHED', 'POLICY_ROLLED_BACK']));
  });

  it('agent sync of the merged policy: version check, document, ETag/304, ack, status, rollback', async () => {
    const p = (await api('POST', '/api/policies', { name: 'P', content: { blocked_domains: ['example.com'] }, publish: true })).json();
    const dev = await enroll(h.app, 'INST-001', t);
    const agent = (method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
      h.app.inject({ method, url, headers: { ...bearer(dev.token), ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });

    expect((await agent('GET', '/api/agent/policy/version')).json()).toEqual({ policy_id: null, version: 0, etag: null });
    const none = await agent('GET', '/api/agent/policy');
    expect(none.statusCode).toBe(404);
    expect(none.json().error.code).toBe('NO_POLICY_ASSIGNED');

    await api('POST', `/api/policies/${p.id}/assignments`, { scope: 'ORGANIZATION' });
    const ver = (await agent('GET', '/api/agent/policy/version')).json();
    expect(ver).toMatchObject({ policy_id: 'EFFECTIVE', version: 1 });
    expect(ver.etag).toMatch(/^"EFFECTIVE:1:[0-9a-f]{8}"$/);

    const hb = await agent('POST', '/api/agent/heartbeat', heartbeatPayload(dev));
    expect(hb.json().policy).toEqual(ver);

    const doc = await agent('GET', '/api/agent/policy');
    expect(doc.statusCode).toBe(200);
    expect(doc.headers.etag).toBe(ver.etag);
    const body = doc.json();
    expect(body).toMatchObject({ schema_version: 1, policy_id: 'EFFECTIVE', version: 1, organization_id: 'INST-001', device_uuid: dev.deviceUuid, assignment_scope: 'MERGED' });
    expect(body.sources).toEqual([{ code: 'POL-001', kind: 'BLACKLIST', version: 1, via: ['ORGANIZATION'] }]);
    expect(canonicalSha256(body.content)).toBe(body.content_sha256);
    expect(ver.etag).toBe(`"EFFECTIVE:1:${body.content_sha256.slice(0, 8)}"`);

    const cached = await agent('GET', '/api/agent/policy', undefined, { 'if-none-match': ver.etag });
    expect(cached.statusCode).toBe(304);
    expect(cached.body).toBe('');
    expect((await agent('GET', '/api/agent/policy', undefined, { 'if-none-match': '"EFFECTIVE:0:00000000"' })).statusCode).toBe(200);

    expect((await agent('POST', '/api/agent/policy/status', { policy_id: 'EFFECTIVE', version: 1, status: 'APPLYING' })).statusCode).toBe(204);
    expect((await agent('POST', '/api/agent/policy/ack', { policy_id: 'EFFECTIVE', version: 1, content_sha256: body.content_sha256 })).statusCode).toBe(204);
    expect((await agent('POST', '/api/agent/policy/ack', { policy_id: 'EFFECTIVE', version: 2, content_sha256: body.content_sha256 })).statusCode).toBe(409);
    const view = (await api('GET', `/api/devices/${dev.deviceId}`)).json();
    expect(view.policy_status).toMatchObject({ status: 'APPLIED', version: 1 });
    expect(view.effective_policy).toMatchObject({ policy_id: 'EFFECTIVE', version: 1, content: { blocked_domains: ['example.com'] } });

    const fail = await agent('POST', '/api/agent/policy/status', { policy_id: 'EFFECTIVE', version: 1, status: 'FAILED', error_code: 'policy_apply_failed', message: 'apply failed', active_policy_id: 'EFFECTIVE', active_version: 0 });
    expect(fail.statusCode).toBe(204);
    expect(await h.prisma.auditLog.count({ where: { action: 'POLICY_APPLICATION_FAILED' } })).toBe(1);
    expect((await agent('POST', '/api/agent/policy/status', { policy_id: 'EFFECTIVE', version: 1, status: 'BROKEN' })).statusCode).toBe(400);

    // A new restriction version with identical rules does not bump the merged version.
    await api('POST', `/api/policies/${p.id}/versions`, {});
    await api('POST', `/api/policies/${p.id}/versions/2/publish`);
    expect((await agent('GET', '/api/agent/policy/version')).json().version).toBe(1);
    // Changed rules → version 2; rolling the restriction back → version 3 with v1's content (versions never repeat).
    await api('PUT', `/api/policies/${p.id}/content`, { content: { blocked_domains: ['other.com'] } });
    expect((await agent('GET', '/api/agent/policy/version')).json().version).toBe(2);
    await api('POST', `/api/policies/${p.id}/rollback`, { version: 1 });
    const back = (await agent('GET', '/api/agent/policy')).json();
    expect(back).toMatchObject({ version: 3, content_sha256: body.content_sha256 });

    // deactivate → nothing applies
    await api('POST', `/api/policies/${p.id}/deactivate`);
    expect((await agent('GET', '/api/agent/policy')).statusCode).toBe(404);
    await api('POST', `/api/policies/${p.id}/activate`);
    expect((await agent('GET', '/api/agent/policy')).statusCode).toBe(200);
  });

  it('every restriction reaching a computer is merged (organization + groups + device)', async () => {
    const mk = async (code: string, kind: string, content: object) => (await api('POST', '/api/policies', { name: code, code, kind, content, publish: true })).json().id as string;
    const orgPol = await mk('ORG-POL', 'BLACKLIST', { blocked_domains: ['org.com'] });
    const grpPol = await mk('GRP-POL', 'BLACKLIST', { blocked_domains: ['grp.com'] });
    const allow = await mk('ALLOW', 'ALLOW_ONLY', { allowed_domains: ['school.org', '*.school.org'] });
    const redir = await mk('REDIR', 'REDIRECT', { redirect_rules: [{ from: 'games.com', to: 'learn.school.org' }] });
    const dev = await enroll(h.app, 'INST-001', t);
    const g1 = (await api('POST', '/api/device-groups', { name: 'g1' })).json().id;
    await api('POST', `/api/device-groups/${g1}/members`, { device_ids: [dev.deviceId] });
    const content = async () => (await h.app.inject({ method: 'GET', url: '/api/agent/policy', headers: bearer(dev.token) })).json().content;

    await api('POST', `/api/policies/${orgPol}/assignments`, { scope: 'ORGANIZATION' });
    await api('POST', `/api/policies/${grpPol}/assignments`, { scope: 'GROUP', target_group_id: g1 });
    expect(await content()).toMatchObject({ default_action: 'allow', blocked_domains: ['grp.com', 'org.com'] });

    const bulk = await api('POST', '/api/assignments/bulk', { policy_id: allow, device_ids: [dev.deviceId] });
    expect(bulk.statusCode).toBe(201);
    expect((await api('POST', '/api/assignments/bulk', { policy_id: allow, device_ids: [dev.deviceId] })).json().created).toEqual([]);
    await api('POST', '/api/assignments/bulk', { policy_id: redir, group_ids: [g1] });
    const merged = await content();
    expect(merged).toMatchObject({
      default_action: 'block',
      allowed_domains: ['*.school.org', 'learn.school.org', 'school.org'],
      blocked_domains: ['grp.com', 'org.com'],
      redirect_rules: [{ from: 'games.com', to: 'learn.school.org' }],
    });
    const list = (await api('GET', '/api/assignments')).json().items;
    expect(list).toHaveLength(4);
    expect(list.find((a: { scope: string; policy: { code: string } }) => a.scope === 'GROUP' && a.policy.code === 'REDIR').target_name).toBe('g1');

    const devAssign = list.find((a: { scope: string }) => a.scope === 'DEVICE');
    expect((await api('DELETE', `/api/policies/${allow}/assignments/${devAssign.id}`)).statusCode).toBe(204);
    expect((await content()).default_action).toBe('allow');
    await api('POST', `/api/policies/${grpPol}/deactivate`);
    expect((await content()).blocked_domains).toEqual(['org.com']);
  });

  it('deleting a restriction removes its versions and assignments (tenant-scoped, audited)', async () => {
    const c = await api('POST', '/api/policies', { name: 'Temp', kind: 'BLACKLIST', publish: true, content: { blocked_domains: ['bad.com'] } });
    expect(c.statusCode, c.body).toBe(201);
    const id: string = c.json().id;
    await api('POST', `/api/policies/${id}/versions`, {}); // a second (draft) version
    expect((await api('POST', '/api/assignments/bulk', { policy_id: id, organization: true })).statusCode).toBe(201);

    // Another organization's admin cannot see or delete it.
    const orgB = (await createOrg(h.prisma, 'COMPANY-002')).id;
    await createUser(h.prisma, 'b@example.com', 'ORGANIZATION_ADMIN', orgB);
    const tb = await login(h.app, 'b@example.com');
    expect((await h.app.inject({ method: 'DELETE', url: `/api/policies/${id}`, headers: bearer(tb) })).statusCode).toBe(404);

    const d = await api('DELETE', `/api/policies/${id}`);
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json()).toMatchObject({ code: 'POL-001', assignments: 1 });
    expect(d.json().versions).toBeGreaterThanOrEqual(1);
    expect(await h.prisma.policy.findUnique({ where: { id } })).toBeNull();
    expect(await h.prisma.policyVersion.count({ where: { policyId: id } })).toBe(0);
    expect(await h.prisma.policyAssignment.count({ where: { policyId: id } })).toBe(0);
    expect((await api('GET', `/api/policies/${id}`)).statusCode).toBe(404);
    expect(await h.prisma.auditLog.count({ where: { action: 'POLICY_DELETED', targetId: id } })).toBe(1);
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
