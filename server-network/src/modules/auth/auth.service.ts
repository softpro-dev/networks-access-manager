import type { Prisma } from '@prisma/client';
import type { AppContext } from '../../types.js';
import { getDummyHash, verifyPassword } from '../../services/password.js';
import { AuditAction, writeAudit } from '../../services/audit.js';
import { AppError } from '../../utils/errors.js';
import { sha256Hex } from '../../utils/crypto.js';
import { serializeUser } from '../users/users.service.js';

export const invalidLogin = () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');

export async function login(ctx: AppContext, email: string, password: string, meta: { ip: string; userAgent?: string }) {
  const { prisma, config, jwt } = ctx;
  const normalizedEmail = email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email: normalizedEmail }, include: { organization: true } });
  const now = new Date();

  const fail = async (reason: string, userId?: string, organizationId?: string | null) => {
    await writeAudit(prisma, {
      organizationId: organizationId ?? null,
      actorType: userId ? 'USER' : 'SYSTEM',
      actorId: userId ?? null,
      action: AuditAction.LOGIN_FAILURE,
      targetType: 'User',
      targetId: userId ?? null,
      metadata: { email: normalizedEmail.slice(0, 254), reason },
      ip: meta.ip,
    });
    return invalidLogin();
  };

  if (!user) {
    await verifyPassword(await getDummyHash(), password);
    throw await fail('unknown_user');
  }
  if (user.lockedUntil && user.lockedUntil > now) {
    await verifyPassword(await getDummyHash(), password);
    throw await fail('locked', user.id, user.organizationId);
  }
  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) {
    const attempts = user.failedLoginAttempts + 1;
    const lock = config.loginLockoutThreshold > 0 && attempts >= config.loginLockoutThreshold;
    await prisma.user.update({
      where: { id: user.id },
      data: lock
        ? { failedLoginAttempts: 0, lockedUntil: new Date(now.getTime() + config.loginLockoutMinutes * 60_000) }
        : { failedLoginAttempts: attempts },
    });
    throw await fail(lock ? 'bad_password_locked' : 'bad_password', user.id, user.organizationId);
  }
  if (user.status !== 'ACTIVE') throw await fail('user_disabled', user.id, user.organizationId);
  if (user.role === 'ORGANIZATION_ADMIN' && (!user.organization || user.organization.status !== 'ACTIVE')) {
    throw await fail('organization_disabled', user.id, user.organizationId);
  }

  return issueSession(ctx, user, now, meta, 'password');
}

type LoginUser = Prisma.UserGetPayload<{ include: { organization: true } }>;

/** Create a session + access token for an already-authenticated user (password or one-time link). */
async function issueSession(ctx: AppContext, user: LoginUser, now: Date, meta: { ip: string; userAgent?: string }, method: 'password' | 'login_link') {
  const { prisma, jwt } = ctx;
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      expiresAt: new Date(now.getTime() + jwt.ttl * 1000),
      ip: meta.ip.slice(0, 45),
      userAgent: meta.userAgent?.slice(0, 255) ?? null,
    },
  });
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: now, failedLoginAttempts: 0, lockedUntil: null } });
  await writeAudit(prisma, {
    organizationId: user.organizationId,
    actorType: 'USER',
    actorId: user.id,
    action: AuditAction.LOGIN_SUCCESS,
    targetType: 'User',
    targetId: user.id,
    metadata: { session_id: session.id, method },
    ip: meta.ip,
  });
  const token = await jwt.sign({ sub: user.id, role: user.role, org: user.organizationId, sid: session.id });
  return {
    access_token: token,
    token_type: 'Bearer',
    expires_in: jwt.ttl,
    user: serializeUser({ ...user, lastLoginAt: now }),
  };
}

const invalidLink = () => new AppError(401, 'INVALID_LOGIN_LINK', 'This sign-in link is invalid, expired or already used');

/**
 * Exchange a one-time sign-in link token for a session. The token is single-use (consumed with a
 * conditional update), expires after LOGIN_LINK_TTL_MINUTES, and only its sha256 is stored.
 */
export async function loginWithLink(ctx: AppContext, rawToken: string, meta: { ip: string; userAgent?: string }) {
  const { prisma } = ctx;
  const now = new Date();
  const link = await prisma.loginLink.findUnique({ where: { tokenHash: sha256Hex(rawToken) } });
  if (!link || link.usedAt || link.expiresAt <= now) throw invalidLink();
  const consumed = await prisma.loginLink.updateMany({ where: { id: link.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
  if (consumed.count !== 1) throw invalidLink();
  const user = await prisma.user.findUnique({ where: { id: link.userId }, include: { organization: true } });
  if (!user || user.status !== 'ACTIVE' || user.role !== 'ORGANIZATION_ADMIN' || !user.organization || user.organization.status !== 'ACTIVE') {
    throw invalidLink();
  }
  await writeAudit(prisma, {
    organizationId: user.organizationId,
    actorType: 'USER',
    actorId: user.id,
    action: AuditAction.LOGIN_LINK_USED,
    targetType: 'LoginLink',
    targetId: link.id,
    metadata: { issued_by_id: link.createdById },
    ip: meta.ip,
  });
  return issueSession(ctx, user, now, meta, 'login_link');
}

export async function logout(ctx: AppContext, sessionId: string, userId: string, organizationId: string | null, ip: string) {
  await ctx.prisma.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
  await writeAudit(ctx.prisma, {
    organizationId,
    actorType: 'USER',
    actorId: userId,
    action: AuditAction.LOGOUT,
    targetType: 'Session',
    targetId: sessionId,
    ip,
  });
}
