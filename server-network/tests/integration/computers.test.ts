import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/canonicalJson.js';
import {
  bearer,
  closeHarness,
  createHarness,
  createOrg,
  createUser,
  describeDb,
  login,
  newAgentIdentity,
  pollStatus,
  register,
  resetDb,
  type Harness,
} from '../helpers/integration.js';

describeDb('computers, login links, organization delete, analytics', () => {
  let h: Harness;
  let orgA: string;
  let orgB: string;
  let adminA: string;
  let adminB: string;
  let superT: string;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => closeHarness(h));
  beforeEach(async () => {
    await resetDb(h.prisma);
    orgA = (await createOrg(h.prisma, 'INST-001')).id;
    orgB = (await createOrg(h.prisma, 'COMPANY-002')).id;
    await createUser(h.prisma, 'a@example.com', 'ORGANIZATION_ADMIN', orgA);
    await createUser(h.prisma, 'b@example.com', 'ORGANIZATION_ADMIN', orgB);
    await createUser(h.prisma, 'root@example.com', 'SUPER_ADMIN', null);
    adminA = await login(h.app, 'a@example.com');
    adminB = await login(h.app, 'b@example.com');
    superT = await login(h.app, 'root@example.com');
  });

  const as = (token: string) => (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    h.app.inject({ method, url, headers: bearer(token), ...(payload !== undefined ? { payload: payload as object } : {}) });

  it('computer CRUD with MAC / title / serial / groups, isolated per organization', async () => {
    const a = as(adminA);
    const g = (await a('POST', '/api/device-groups', { name: 'Lab 1' })).json();
    const c = await a('POST', '/api/devices', { mac_address: '00-1a-2b-3c-4d-5e', title: 'Lab PC 14', serial_number: 'SN-123', group_ids: [g.id] });
    expect(c.statusCode, c.body).toBe(201);
    expect(c.json()).toMatchObject({ status: 'PRE_REGISTERED', mac_address: '00:1A:2B:3C:4D:5E', title: 'Lab PC 14', serial_number: 'SN-123', device_uuid: null, groups: [{ id: g.id, name: 'Lab 1' }] });
    const id = c.json().id;

    expect((await a('POST', '/api/devices', { mac_address: '00:1A:2B:3C:4D:5E', title: 'dup' })).json().error.code).toBe('MAC_IN_USE');
    expect((await a('POST', '/api/devices', { mac_address: 'not-a-mac', title: 'x' })).statusCode).toBe(400);
    const gB = (await as(adminB)('POST', '/api/device-groups', { name: 'B group' })).json();
    expect((await a('POST', '/api/devices', { mac_address: '00:1A:2B:3C:4D:60', title: 'x', group_ids: [gB.id] })).statusCode).toBe(400);

    const u = await a('PATCH', `/api/devices/${id}`, { title: 'Lab PC 15', group_ids: [] });
    expect(u.json()).toMatchObject({ title: 'Lab PC 15', groups: [] });
    expect((await a('GET', '/api/devices?status=PRE_REGISTERED')).json().items).toHaveLength(1);
    expect((await a('GET', '/api/devices?q=SN-123')).json().items).toHaveLength(1);

    // Other organization: not visible, not editable, not deletable
    const b = as(adminB);
    expect((await b('GET', `/api/devices/${id}`)).statusCode).toBe(404);
    expect((await b('PATCH', `/api/devices/${id}`, { title: 'hijack' })).statusCode).toBe(404);
    expect((await b('DELETE', `/api/devices/${id}`)).statusCode).toBe(404);

    expect((await a('DELETE', `/api/devices/${id}`)).statusCode).toBe(204);
    expect((await a('GET', `/api/devices/${id}`)).statusCode).toBe(404);
    const actions = (await h.prisma.auditLog.findMany()).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['DEVICE_CREATED', 'DEVICE_UPDATED', 'DEVICE_DELETED']));
  });

  it('a registering agent whose MAC matches a pre-added computer attaches to it but still needs approval', async () => {
    const a = as(adminA);
    const pre = (await a('POST', '/api/devices', { mac_address: '00:1A:2B:3C:4D:5E', title: 'Front desk' })).json();
    // Same MAC pre-added in another org must not capture org A's agent.
    await as(adminB)('POST', '/api/devices', { mac_address: '00:1A:2B:3C:4D:5E', title: 'B desk' });

    const id = newAgentIdentity();
    const r = await register(h.app, 'INST-001', id);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toEqual({ device_id: pre.id, status: 'PENDING' });
    expect((await pollStatus(h.app, id)).json()).toEqual({ status: 'PENDING' });
    const view = (await a('GET', `/api/devices/${pre.id}`)).json();
    expect(view).toMatchObject({ status: 'PENDING', title: 'Front desk', device_uuid: id.deviceUuid, hostname: 'LAB-PC-014' });
    expect((await a('POST', `/api/devices/${pre.id}/approve`)).statusCode).toBe(200);
    expect((await pollStatus(h.app, id)).json().credential.token).toMatch(/^ndc_/);
    const bDevices = (await as(adminB)('GET', '/api/devices')).json().items;
    expect(bDevices).toEqual([expect.objectContaining({ status: 'PRE_REGISTERED', title: 'B desk' })]);
  });

  it('one-time login link: super admin only, single use, token never stored', async () => {
    expect((await as(adminA)('POST', `/api/organizations/${orgA}/login-link`, {})).statusCode).toBe(403);
    const r = await as(superT)('POST', `/api/organizations/${orgA}/login-link`, {});
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().user.email).toBe('a@example.com');
    const url = new URL(r.json().url);
    expect(url.pathname).toBe('/login');
    const token = url.searchParams.get('org_admin')!;
    expect(token.length).toBeGreaterThan(30);
    const row = await h.prisma.loginLink.findFirstOrThrow();
    expect(row.tokenHash).not.toContain(token);

    const use = await h.app.inject({ method: 'POST', url: '/api/auth/login-link', payload: { token } });
    expect(use.statusCode, use.body).toBe(200);
    expect(use.json().user).toMatchObject({ email: 'a@example.com', role: 'ORGANIZATION_ADMIN' });
    const me = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer(use.json().access_token) });
    expect(me.statusCode).toBe(200);

    const again = await h.app.inject({ method: 'POST', url: '/api/auth/login-link', payload: { token } });
    expect(again.statusCode).toBe(401);
    expect(again.json().error.code).toBe('INVALID_LOGIN_LINK');
    expect((await h.app.inject({ method: 'POST', url: '/api/auth/login-link', payload: { token: 'x'.repeat(43) } })).statusCode).toBe(401);

    await h.prisma.loginLink.updateMany({ data: { usedAt: null, expiresAt: new Date(Date.now() - 1000) } });
    expect((await h.app.inject({ method: 'POST', url: '/api/auth/login-link', payload: { token } })).statusCode).toBe(401);
    const actions = (await h.prisma.auditLog.findMany()).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['LOGIN_LINK_CREATED', 'LOGIN_LINK_USED']));
  });

  it('organization delete: super admin, typed confirmation, removes everything, keeps audit history', async () => {
    const a = as(adminA);
    await a('POST', '/api/devices', { mac_address: '00:1A:2B:3C:4D:5E', title: 'PC' });
    await a('POST', '/api/policies', { name: 'P', content: { blocked_domains: ['x.com'] }, publish: true });
    expect((await a('DELETE', `/api/organizations/${orgA}?confirm=INST-001`)).statusCode).toBe(403);
    expect((await as(superT)('DELETE', `/api/organizations/${orgA}?confirm=WRONG`)).statusCode).toBe(400);

    const d = await as(superT)('DELETE', `/api/organizations/${orgA}?confirm=INST-001`);
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json()).toEqual({ devices: 1, policies: 1, users: 1 });
    expect(await h.prisma.organization.findUnique({ where: { id: orgA } })).toBeNull();
    expect(await h.prisma.organization.findUnique({ where: { id: orgB } })).not.toBeNull();
    const deleted = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'ORGANIZATION_DELETED' } });
    expect(deleted.metadata).toMatchObject({ code: 'INST-001' });
    expect(await h.prisma.auditLog.count({ where: { action: 'DEVICE_CREATED' } })).toBe(1);
  });

  it('organization delete can be switched off by configuration', async () => {
    const off = await createHarness({ ALLOW_ORGANIZATION_DELETE: 'false' });
    const t = await login(off.app, 'root@example.com');
    const r = await off.app.inject({ method: 'DELETE', url: `/api/organizations/${orgA}?confirm=INST-001`, headers: bearer(t) });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('ORGANIZATION_DELETE_DISABLED');
    await closeHarness(off);
  });

  it('analytics: super admin sees all organizations, organization admin only their own', async () => {
    await as(adminA)('POST', '/api/devices', { mac_address: '00:1A:2B:3C:4D:5E', title: 'PC' });
    await as(adminA)('POST', '/api/policies', { name: 'P', kind: 'ALLOW_ONLY', content: { allowed_domains: ['a.com'] }, publish: true });
    const all = (await as(superT)('GET', '/api/analytics/overview')).json();
    expect(all.totals).toMatchObject({ organizations: 2, computers: 1, pre_registered: 1, restrictions: 1 });
    expect((await as(adminB)('GET', `/api/analytics/overview?organization_id=${orgA}`)).statusCode).toBe(404);
    const own = (await as(adminB)('GET', '/api/analytics/overview')).json();
    expect(own.organizations.map((o: { organization: { code: string } }) => o.organization.code)).toEqual(['COMPANY-002']);
    expect(own.totals.computers).toBe(0);
    const a = (await as(adminA)('GET', '/api/analytics/overview')).json();
    expect(a.organizations[0].restrictions.by_kind).toEqual({ ALLOW_ONLY: 1, BLACKLIST: 0, REDIRECT: 0 });
  });

  it('organization access token: fetch merged org-wide policy, ETag/304, rotation revokes', async () => {
    const a = as(adminA);
    const mk = async (code: string, kind: string, content: object) => {
      const p = (await a('POST', '/api/policies', { name: code, code, kind, content, publish: true })).json();
      await a('POST', `/api/policies/${p.id}/assignments`, { scope: 'ORGANIZATION' });
      return p.id as string;
    };
    await mk('RST-001', 'BLACKLIST', { blocked_domains: ['bad.com'] });
    await mk('RST-002', 'ALLOW_ONLY', { allowed_domains: ['school.org'] });

    // Only a super admin or the org's own admin can mint the token.
    expect((await as(adminB)('POST', `/api/organizations/${orgA}/access-token`)).statusCode).toBe(404);
    const mint = await a('POST', `/api/organizations/${orgA}/access-token`);
    expect(mint.statusCode, mint.body).toBe(200);
    const token: string = mint.json().access_token;
    expect(token).toMatch(/^nat_[A-Za-z0-9_-]{43}$/);

    const svc = (headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url: '/api/agent/org-policy', headers });
    expect((await svc()).statusCode).toBe(401);
    expect((await svc({ authorization: 'Bearer nat_' + 'x'.repeat(43) })).statusCode).toBe(401);

    const doc = await svc({ authorization: `Bearer ${token}` });
    expect(doc.statusCode, doc.body).toBe(200);
    const body = doc.json();
    expect(body).toMatchObject({ policy_id: 'EFFECTIVE', organization_id: 'INST-001', assignment_scope: 'ORGANIZATION' });
    expect(body.content.default_action).toBe('block'); // ALLOW_ONLY present
    expect(body.content.blocked_domains).toEqual(['bad.com']);
    expect(body.sources.map((s: { code: string }) => s.code).sort()).toEqual(['RST-001', 'RST-002']);
    expect(canonicalSha256(body.content)).toBe(body.content_sha256);
    const etag = doc.headers.etag as string;
    expect((await svc({ authorization: `Bearer ${token}`, 'if-none-match': etag })).statusCode).toBe(304);

    // Fetching marks the delivered organization-wide assignments synced; a new version resets them.
    const orgAssignments = () => h.prisma.policyAssignment.findMany({ where: { organizationId: orgA, scope: 'ORGANIZATION' } });
    expect((await orgAssignments()).every((x) => x.synced)).toBe(true);
    const listed = (await a('GET', `/api/assignments?organization_id=${orgA}`)).json().items as { scope: string; synced: boolean }[];
    expect(listed.filter((x) => x.scope === 'ORGANIZATION').every((x) => x.synced)).toBe(true);
    const rst1 = await h.prisma.policy.findFirstOrThrow({ where: { organizationId: orgA, code: 'RST-001' } });
    await a('POST', `/api/policies/${rst1.id}/deactivate`);
    expect((await h.prisma.policyAssignment.findFirstOrThrow({ where: { policyId: rst1.id } })).synced).toBe(false);
    await a('POST', `/api/policies/${rst1.id}/activate`);
    expect((await svc({ authorization: `Bearer ${token}` })).statusCode).toBe(200);
    expect((await h.prisma.policyAssignment.findFirstOrThrow({ where: { policyId: rst1.id } })).synced).toBe(true);

    // Per-computer Synced: the service identifies itself with X-Device-MAC (contract §4.2).
    const pc = (await a('POST', '/api/devices', { mac_address: '00:1A:2B:3C:4D:99', title: 'Synced PC' })).json();
    const syncedOf = async () => (await a('GET', `/api/devices/${pc.id}`)).json();
    expect(await syncedOf()).toMatchObject({ synced: null, synced_at: null });
    expect((await svc({ authorization: `Bearer ${token}`, 'x-device-mac': '00-1a-2b-3c-4d-99' })).statusCode).toBe(200);
    expect(await syncedOf()).toMatchObject({ synced: true, synced_via: 'DEVICE' });
    // A registered computer gets its own merged policy: a restriction assigned only to it applies too.
    const own = await a('POST', '/api/policies', { name: 'Only this PC', kind: 'BLACKLIST', publish: true, content: { blocked_domains: ['only-this-pc.example'] } });
    await a('POST', '/api/assignments/bulk', { policy_id: own.json().id, device_ids: [pc.id] });
    const forPc = await svc({ authorization: `Bearer ${token}`, 'x-device-mac': '00:1A:2B:3C:4D:99' });
    expect(forPc.json()).toMatchObject({ assignment_scope: 'MERGED' });
    expect(forPc.json()).not.toHaveProperty('device_uuid');
    expect(forPc.json().content.blocked_domains).toContain('only-this-pc.example');
    const anonymous = await svc({ authorization: `Bearer ${token}` }); // unknown computer: org-wide only
    expect(anonymous.json().assignment_scope).toBe('ORGANIZATION');
    expect(anonymous.json().content.blocked_domains).not.toContain('only-this-pc.example');
    await a('DELETE', `/api/policies/${own.json().id}`);
    const listedPc = (await a('GET', `/api/devices?organization_id=${orgA}`)).json().items.find((d: { id: string }) => d.id === pc.id);
    expect(listedPc.synced).toBe(true);
    await a('POST', `/api/policies/${rst1.id}/deactivate`); // content changes → out of date until next fetch
    expect((await syncedOf()).synced).toBe(false);
    expect((await svc({ authorization: `Bearer ${token}`, 'x-device-mac': '00:1A:2B:3C:4D:99' })).statusCode).toBe(200);
    expect((await syncedOf()).synced).toBe(true);
    // Reset sync: back to "never" until the next check-in.
    expect((await a('POST', `/api/devices/${pc.id}/reset-sync`)).json()).toMatchObject({ synced: null, synced_at: null });
    expect((await svc({ authorization: `Bearer ${token}`, 'x-device-mac': '00:1A:2B:3C:4D:99' })).statusCode).toBe(200);
    expect((await syncedOf()).synced).toBe(true);
    await a('POST', `/api/policies/${rst1.id}/activate`);

    // No org-scoped policy → 404 (org B has none).
    const tokenB = (await as(adminB)('POST', `/api/organizations/${orgB}/access-token`)).json().access_token;
    expect((await svc({ authorization: `Bearer ${tokenB}` })).statusCode).toBe(404);

    // Rotating the token revokes the old one immediately (never expires, but rotatable).
    const rotated = (await a('POST', `/api/organizations/${orgA}/access-token`)).json().access_token;
    expect(rotated).not.toBe(token);
    expect((await svc({ authorization: `Bearer ${token}` })).statusCode).toBe(401);
    expect((await svc({ authorization: `Bearer ${rotated}` })).statusCode).toBe(200);

    // Copy token: returns the current token (stored encrypted, never in clear), audited, not cached.
    const copied = await a('GET', `/api/organizations/${orgA}/access-token`);
    expect(copied.statusCode, copied.body).toBe(200);
    expect(copied.json().access_token).toBe(rotated);
    expect(copied.headers['cache-control']).toBe('no-store');
    const row = await h.prisma.organization.findUniqueOrThrow({ where: { id: orgA } });
    expect(row.accessTokenEnc).toBeTruthy();
    expect(row.accessTokenEnc).not.toContain(rotated);
    expect((await as(adminB)('GET', `/api/organizations/${orgA}/access-token`)).statusCode).toBe(404); // other tenant
    expect((await h.prisma.auditLog.findMany({ where: { action: 'ACCESS_TOKEN_REVEALED' } })).length).toBe(1);
    // A token without a stored copy (generated before this existed) cannot be copied.
    await h.prisma.organization.update({ where: { id: orgA }, data: { accessTokenEnc: null } });
    expect((await a('GET', `/api/organizations/${orgA}/access-token`)).json().error.code).toBe('ACCESS_TOKEN_NOT_RETRIEVABLE');

    // Clearing disables token access entirely.
    await a('DELETE', `/api/organizations/${orgA}/access-token`);
    expect((await svc({ authorization: `Bearer ${rotated}` })).statusCode).toBe(401);
    expect((await a('GET', `/api/organizations/${orgA}/access-token`)).statusCode).toBe(404);
  });
});
