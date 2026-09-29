import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { adminAuth, getAdmin } from '../../middleware/adminAuth.js';
import { makeLimiter } from '../../services/rateLimit.js';
import { parse } from '../../utils/validation.js';
import { notFound } from '../../utils/errors.js';
import { login, loginWithLink, logout } from './auth.service.js';
import { serializeUser } from '../users/users.service.js';

const loginBody = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(1024),
});

export async function authRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const enabled = ctx.config.rateLimitEnabled;
  const perIp = makeLimiter(app, enabled, { name: 'login-ip', max: 20, windowMs: 60_000, key: (req) => req.ip });
  const perUser = makeLimiter(app, enabled, {
    name: 'login-user',
    max: 5,
    windowMs: 60_000,
    key: (req) => {
      const b = req.body as { email?: unknown } | undefined;
      const email = typeof b?.email === 'string' ? b.email.trim().toLowerCase().slice(0, 254) : '';
      return `${req.ip}|${email}`;
    },
  });

  app.post('/api/auth/login', { preHandler: [perIp, perUser] }, async (req) => {
    const body = parse(loginBody, req.body);
    return login(ctx, body.email, body.password, { ip: req.ip, userAgent: req.headers['user-agent'] });
  });

  const linkBody = z.object({ token: z.string().min(20).max(200) }).strict();
  const perIpLink = makeLimiter(app, enabled, { name: 'login-link-ip', max: 10, windowMs: 60_000, key: (req) => req.ip });
  app.post('/api/auth/login-link', { preHandler: perIpLink }, async (req) => {
    const body = parse(linkBody, req.body);
    return loginWithLink(ctx, body.token, { ip: req.ip, userAgent: req.headers['user-agent'] });
  });

  const auth = adminAuth(ctx);

  app.post('/api/auth/logout', { preHandler: auth }, async (req, reply) => {
    const a = getAdmin(req);
    await logout(ctx, a.sessionId, a.userId, a.organizationId, req.ip);
    return reply.code(204).send();
  });

  app.get('/api/auth/me', { preHandler: auth }, async (req) => {
    const a = getAdmin(req);
    const user = await ctx.prisma.user.findUnique({ where: { id: a.userId }, include: { organization: true } });
    if (!user) throw notFound();
    return { user: serializeUser(user), session_id: a.sessionId, features: { organization_delete: ctx.config.allowOrganizationDelete } };
  });
}
