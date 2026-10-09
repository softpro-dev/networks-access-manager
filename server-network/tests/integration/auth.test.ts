import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { bearer, closeHarness, createHarness, createOrg, createUser, describeDb, login, PASSWORD, resetDb, type Harness } from '../helpers/integration.js';

describeDb('admin authentication & authorization', () => {
  let h: Harness;
  let orgId: string;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => closeHarness(h));
  beforeEach(async () => {
    await resetDb(h.prisma);
    orgId = (await createOrg(h.prisma, 'INST-001')).id;
    await createUser(h.prisma, 'super@example.com', 'SUPER_ADMIN', null);
    await createUser(h.prisma, 'admin@inst.example.com', 'ORGANIZATION_ADMIN', orgId);
  });

  it('logs in, returns /me, and audits success without secrets', async () => {
    const t = await login(h.app, 'SUPER@example.com');
    const me = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer(t) });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({ email: 'super@example.com', role: 'SUPER_ADMIN' });
    const logs = await h.prisma.auditLog.findMany({ where: { action: 'LOGIN_SUCCESS' } });
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain(PASSWORD);
  });

  it('returns the same generic error for unknown user and bad password, and audits failures', async () => {
    const a = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nobody@example.com', password: 'whatever-password' } });
    const b = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'super@example.com', password: 'wrong-password-123' } });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json()).toEqual(b.json());
    const logs = await h.prisma.auditLog.findMany({ where: { action: 'LOGIN_FAILURE' } });
    expect(logs).toHaveLength(2);
    expect(JSON.stringify(logs)).not.toContain('wrong-password-123');
  });

  it('logout revokes the session immediately', async () => {
    const t = await login(h.app, 'super@example.com');
    expect((await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: bearer(t) })).statusCode).toBe(204);
    expect((await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer(t) })).statusCode).toBe(401);
  });

  it('disabling a user revokes their sessions and blocks login', async () => {
    const superT = await login(h.app, 'super@example.com');
    const orgT = await login(h.app, 'admin@inst.example.com');
    const u = await h.prisma.user.findUniqueOrThrow({ where: { email: 'admin@inst.example.com' } });
    const r = await h.app.inject({ method: 'PATCH', url: `/api/users/${u.id}`, headers: bearer(superT), payload: { status: 'DISABLED' } });
    expect(r.statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/api/devices', headers: bearer(orgT) })).statusCode).toBe(401);
    const again = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@inst.example.com', password: PASSWORD } });
    expect(again.statusCode).toBe(401);
  });

  it('super admin changes an admin email: unique, signs them out, new email signs in, audited', async () => {
    const superT = await login(h.app, 'super@example.com');
    const orgT = await login(h.app, 'admin@inst.example.com');
    const u = await h.prisma.user.findUniqueOrThrow({ where: { email: 'admin@inst.example.com' } });
    const patch = (payload: object, t = superT) => h.app.inject({ method: 'PATCH', url: `/api/users/${u.id}`, headers: bearer(t), payload });

    const taken = await patch({ email: 'super@example.com' });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.code).toBe('EMAIL_IN_USE');
    expect((await patch({ email: 'not-an-email' })).statusCode).toBe(400);
    expect((await patch({ email: 'x@inst.example.com' }, orgT)).statusCode).toBe(403); // org admins cannot

    const r = await patch({ email: '  New.Admin@Inst.Example.com ' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().email).toBe('new.admin@inst.example.com');
    expect((await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer(orgT) })).statusCode).toBe(401);
    const oldLogin = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@inst.example.com', password: PASSWORD } });
    expect(oldLogin.statusCode).toBe(401);
    await login(h.app, 'new.admin@inst.example.com');
    const log = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'ADMIN_UPDATED', targetId: u.id } });
    expect(log.metadata).toMatchObject({ email_from: 'admin@inst.example.com', email_to: 'new.admin@inst.example.com' });
  });

  it('disabling an organization locks out its admins', async () => {
    const superT = await login(h.app, 'super@example.com');
    const orgT = await login(h.app, 'admin@inst.example.com');
    await h.app.inject({ method: 'PATCH', url: `/api/organizations/${orgId}`, headers: bearer(superT), payload: { status: 'DISABLED' } });
    expect((await h.app.inject({ method: 'GET', url: '/api/devices', headers: bearer(orgT) })).statusCode).toBe(401);
  });

  it('ORGANIZATION_ADMIN cannot perform super-admin operations', async () => {
    const t = await login(h.app, 'admin@inst.example.com');
    expect((await h.app.inject({ method: 'POST', url: '/api/organizations', headers: bearer(t), payload: { code: 'NEW-001', name: 'x' } })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'POST', url: '/api/users', headers: bearer(t), payload: { email: 'x@example.com', password: 'long-enough-pass', role: 'SUPER_ADMIN' } })).statusCode).toBe(403);
    const list = await h.app.inject({ method: 'GET', url: '/api/users', headers: bearer(t) });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((u: { email: string }) => u.email)).toEqual(['admin@inst.example.com']);
  });

  it('SUPER_ADMIN creates organizations and admins (audited)', async () => {
    const t = await login(h.app, 'super@example.com');
    const o = await h.app.inject({ method: 'POST', url: '/api/organizations', headers: bearer(t), payload: { code: 'company-002', name: 'B', phone: '01712345678', admin_email: 'b-admin@example.com', admin_password: 'long-enough-pass' } });
    expect(o.statusCode).toBe(201);
    expect(o.json().code).toBe('COMPANY-002');
    expect(o.json().phone).toBe('01712345678');
    expect(o.json().admin.email).toBe('b-admin@example.com');
    expect(o.body).not.toContain('long-enough-pass');
    expect(await login(h.app, 'b-admin@example.com', 'long-enough-pass')).toBeTruthy();
    const badPhone = await h.app.inject({ method: 'POST', url: '/api/organizations', headers: bearer(t), payload: { code: 'X-1', name: 'X', phone: '0171234567', admin_email: 'x@example.com', admin_password: 'long-enough-pass' } });
    expect(badPhone.statusCode).toBe(400);
    const dupEmail = await h.app.inject({ method: 'POST', url: '/api/organizations', headers: bearer(t), payload: { code: 'X-2', name: 'X', phone: '01712345678', admin_email: 'b-admin@example.com', admin_password: 'long-enough-pass' } });
    expect(dupEmail.statusCode).toBe(409);
    expect(await h.prisma.organization.findUnique({ where: { code: 'X-2' } })).toBeNull();
    const u = await h.app.inject({ method: 'POST', url: '/api/users', headers: bearer(t), payload: { email: 'b@example.com', password: 'long-enough-pass', role: 'ORGANIZATION_ADMIN', organization_id: o.json().id } });
    expect(u.statusCode).toBe(201);
    expect(u.body).not.toContain('passwordHash');
    const short = await h.app.inject({ method: 'POST', url: '/api/users', headers: bearer(t), payload: { email: 'c@example.com', password: 'short', role: 'SUPER_ADMIN' } });
    expect(short.statusCode).toBe(400);
    const actions = (await h.prisma.auditLog.findMany()).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['ORGANIZATION_CREATED', 'ADMIN_CREATED']));
  });

  it('registration token is returned once and only its hash is stored', async () => {
    const t = await login(h.app, 'super@example.com');
    const r = await h.app.inject({ method: 'POST', url: `/api/organizations/${orgId}/registration-token`, headers: bearer(t) });
    expect(r.statusCode).toBe(200);
    const raw = r.json().registration_token as string;
    expect(raw).toMatch(/^nrt_/);
    const org = await h.prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(org.registrationTokenHash).not.toContain(raw);
    const get = await h.app.inject({ method: 'GET', url: `/api/organizations/${orgId}`, headers: bearer(t) });
    expect(get.body).not.toContain(raw);
    expect(get.json().has_registration_token).toBe(true);
  });
});
