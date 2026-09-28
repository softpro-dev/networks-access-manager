import type { Organization, Prisma, User } from '@prisma/client';
import { z } from 'zod';
import type { AppContext } from '../../types.js';
import type { AdminPrincipal } from '../../domain/rbac.js';
import { assertOrgAccess, listScope, requireSuperAdmin } from '../../domain/rbac.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../../services/password.js';
import { AuditAction, writeAudit } from '../../services/audit.js';
import { AppError, badRequest, conflict, notFound } from '../../utils/errors.js';
import { iso, pageArgs, pageBody } from '../../utils/http.js';

export function serializeUser(u: User & { organization?: Organization | null }) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    organization_id: u.organizationId,
    organization_code: u.organization?.code ?? null,
    status: u.status,
    last_login_at: iso(u.lastLoginAt),
    locked_until: iso(u.lockedUntil),
    created_at: iso(u.createdAt),
  };
}

const password = z.string().min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`).max(1024);

export const createUserBody = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    name: z.string().trim().min(1).max(200).optional(),
    password,
    role: z.enum(['SUPER_ADMIN', 'ORGANIZATION_ADMIN']),
    organization_id: z.string().min(1).max(64).nullish(),
  })
  .strict();

export const updateUserBody = z
  .object({
    name: z.string().trim().min(1).max(200).nullable().optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    password: password.optional(),
  })
  .strict();

export const listUsersQuery = z.object({
  organization_id: z.string().max(64).optional(),
  role: z.enum(['SUPER_ADMIN', 'ORGANIZATION_ADMIN']).optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
});

export async function listUsers(ctx: AppContext, p: AdminPrincipal, q: z.infer<typeof listUsersQuery>) {
  const orgId = listScope(p, q.organization_id);
  const where: Prisma.UserWhereInput = {
    ...(orgId ? { organizationId: orgId } : {}),
    ...(q.role ? { role: q.role } : {}),
    ...(q.status ? { status: q.status } : {}),
  };
  const [items, total] = await Promise.all([
    ctx.prisma.user.findMany({ where, include: { organization: true }, orderBy: { createdAt: 'asc' }, ...pageArgs(q) }),
    ctx.prisma.user.count({ where }),
  ]);
  return pageBody(items.map(serializeUser), total, q);
}

export async function getUser(ctx: AppContext, p: AdminPrincipal, id: string) {
  const u = await ctx.prisma.user.findUnique({ where: { id }, include: { organization: true } });
  // SUPER_ADMIN rows have organizationId = null and are therefore invisible to org admins.
  return serializeUser(assertOrgAccess(p, u, 'User'));
}

export async function createUser(ctx: AppContext, p: AdminPrincipal, body: z.infer<typeof createUserBody>, ip: string) {
  requireSuperAdmin(p);
  let organizationId: string | null = null;
  if (body.role === 'ORGANIZATION_ADMIN') {
    if (!body.organization_id) throw badRequest('organization_id is required for ORGANIZATION_ADMIN', [{ path: 'organization_id', message: 'Required' }]);
    const org = await ctx.prisma.organization.findUnique({ where: { id: body.organization_id } });
    if (!org) throw notFound('Organization not found');
    organizationId = org.id;
  } else if (body.organization_id) {
    throw badRequest('SUPER_ADMIN must not belong to an organization', [{ path: 'organization_id', message: 'Must be null' }]);
  }
  const existing = await ctx.prisma.user.findUnique({ where: { email: body.email } });
  if (existing) throw conflict('EMAIL_IN_USE', 'A user with this email already exists');
  const user = await ctx.prisma.user.create({
    data: {
      email: body.email,
      name: body.name ?? null,
      passwordHash: await hashPassword(body.password),
      role: body.role,
      organizationId,
    },
    include: { organization: true },
  });
  await writeAudit(ctx.prisma, {
    organizationId,
    actorType: 'USER',
    actorId: p.userId,
    action: AuditAction.ADMIN_CREATED,
    targetType: 'User',
    targetId: user.id,
    metadata: { email: user.email, role: user.role },
    ip,
  });
  return serializeUser(user);
}

export async function updateUser(ctx: AppContext, p: AdminPrincipal, id: string, body: z.infer<typeof updateUserBody>, ip: string) {
  requireSuperAdmin(p);
  const u = await ctx.prisma.user.findUnique({ where: { id } });
  if (!u) throw notFound('User not found');
  if (u.id === p.userId && body.status === 'DISABLED') throw new AppError(400, 'VALIDATION_ERROR', 'You cannot disable your own account');
  const data: Prisma.UserUpdateInput = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.status) data.status = body.status;
  if (body.password) {
    data.passwordHash = await hashPassword(body.password);
    data.failedLoginAttempts = 0;
    data.lockedUntil = null;
  }
  const updated = await ctx.prisma.$transaction(async (tx) => {
    const r = await tx.user.update({ where: { id }, data, include: { organization: true } });
    if (body.status === 'DISABLED' || body.password) {
      await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    return r;
  });
  await writeAudit(ctx.prisma, {
    organizationId: u.organizationId,
    actorType: 'USER',
    actorId: p.userId,
    action: AuditAction.ADMIN_UPDATED,
    targetType: 'User',
    targetId: id,
    metadata: { changed: Object.keys(body).filter((k) => k !== 'password'), password_changed: Boolean(body.password), status: body.status },
    ip,
  });
  return serializeUser(updated);
}
