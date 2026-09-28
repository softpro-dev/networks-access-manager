import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../types.js';
import type { AdminPrincipal } from '../domain/rbac.js';
import { AppError } from '../utils/errors.js';

const unauth = () => new AppError(401, 'UNAUTHORIZED', 'Authentication required');

/**
 * Admin authentication: verify the short-lived JWT, then check the session row, user status and
 * organization status on EVERY request so logout/disable take effect immediately.
 */
export function adminAuth(ctx: AppContext) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const header = req.headers.authorization;
    const m = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    if (!m || m[1]!.startsWith('ndc_')) throw unauth();
    const claims = await ctx.jwt.verify(m[1]!);
    if (!claims) throw unauth();
    const session = await ctx.prisma.session.findUnique({
      where: { id: claims.sid },
      include: { user: { include: { organization: true } } },
    });
    const now = new Date();
    if (!session || session.revokedAt || session.expiresAt <= now || session.userId !== claims.sub) throw unauth();
    const u = session.user;
    if (u.status !== 'ACTIVE') throw unauth();
    if (u.role === 'ORGANIZATION_ADMIN' && (!u.organization || u.organization.status !== 'ACTIVE')) throw unauth();
    // Role/org come from the DB row (source of truth), not only from the token.
    const principal: AdminPrincipal = {
      userId: u.id,
      email: u.email,
      role: u.role,
      organizationId: u.role === 'SUPER_ADMIN' ? null : u.organizationId,
      sessionId: session.id,
    };
    req.admin = principal;
  };
}

export function getAdmin(req: FastifyRequest): AdminPrincipal {
  if (!req.admin) throw unauth();
  return req.admin;
}
