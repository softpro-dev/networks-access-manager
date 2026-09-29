import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
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
});
