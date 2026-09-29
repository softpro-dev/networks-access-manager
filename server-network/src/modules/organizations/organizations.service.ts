import type { Organization, Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AppContext } from '../../types.js';
import type { AdminPrincipal } from '../../domain/rbac.js';
import { assertOrgAccess, isSuperAdmin, requireSuperAdmin } from '../../domain/rbac.js';
import { AuditAction, writeAudit } from '../../services/audit.js';
import { randomSecret, sha256Hex } from '../../utils/crypto.js';
import { generateAccessToken } from '../../domain/deviceToken.js';
import { badRequest, conflict, forbidden, notFound } from '../../utils/errors.js';
import { iso, ORG_CODE_RE } from '../../utils/http.js';

export function serializeOrg(o: Organization) {
  return {
    id: o.id,
    code: o.code,
    name: o.name,
    status: o.status,
    has_registration_token: o.registrationTokenHash !== null,
    has_access_token: o.accessTokenHash !== null,
    created_at: iso(o.createdAt),
    updated_at: iso(o.updatedAt),
  };
}

export const createOrgBody = z
  .object({
    code: z.string().trim().toUpperCase().regex(ORG_CODE_RE, 'Must match ^[A-Z0-9][A-Z0-9-]{1,31}$'),
    name: z.string().trim().min(1).max(200),
  })
  .strict();

export const updateOrgBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  })
  .strict();

export async function listOrgs(ctx: AppContext, p: AdminPrincipal) {
  const where: Prisma.OrganizationWhereInput = isSuperAdmin(p) ? {} : { id: p.organizationId ?? '__none__' };
  const items = await ctx.prisma.organization.findMany({ where, orderBy: { code: 'asc' } });
  return { items: items.map(serializeOrg) };
}

async function loadOrg(ctx: AppContext, p: AdminPrincipal, id: string) {
  const org = await ctx.prisma.organization.findUnique({ where: { id } });
  return assertOrgAccess(p, org ? { ...org, organizationId: org.id } : null, 'Organization');
}

export async function getOrg(ctx: AppContext, p: AdminPrincipal, id: string) {
  const org = await loadOrg(ctx, p, id);
  const [devices, pending, policies] = await Promise.all([
    ctx.prisma.device.count({ where: { organizationId: id } }),
    ctx.prisma.device.count({ where: { organizationId: id, status: 'PENDING' } }),
    ctx.prisma.policy.count({ where: { organizationId: id } }),
  ]);
  return { ...serializeOrg(org), stats: { devices, pending_devices: pending, policies } };
}

export async function createOrg(ctx: AppContext, p: AdminPrincipal, body: z.infer<typeof createOrgBody>, ip: string) {
  requireSuperAdmin(p);
  if (await ctx.prisma.organization.findUnique({ where: { code: body.code } })) {
    throw conflict('ORGANIZATION_CODE_IN_USE', 'Organization code already exists');
  }
  const org = await ctx.prisma.organization.create({ data: { code: body.code, name: body.name } });
  await writeAudit(ctx.prisma, {
    organizationId: org.id,
    actorType: 'USER',
    actorId: p.userId,
    action: AuditAction.ORGANIZATION_CREATED,
    targetType: 'Organization',
    targetId: org.id,
    metadata: { code: org.code, name: org.name },
    ip,
  });
  return serializeOrg(org);
}

export async function updateOrg(ctx: AppContext, p: AdminPrincipal, id: string, body: z.infer<typeof updateOrgBody>, ip: string) {
  requireSuperAdmin(p);
  const org = await ctx.prisma.organization.findUnique({ where: { id } });
  if (!org) throw notFound('Organization not found');
  const updated = await ctx.prisma.organization.update({ where: { id }, data: body });
  await writeAudit(ctx.prisma, {
    organizationId: id,
    actorType: 'USER',
    actorId: p.userId,
    action: AuditAction.ORGANIZATION_UPDATED,
    targetType: 'Organization',
    targetId: id,
    metadata: { ...body },
    ip,
  });
  return serializeOrg(updated);
}

/** Generates a new per-organization registration token. The raw value is returned exactly once. */
export async function rotateRegistrationToken(ctx: AppContext, p: AdminPrincipal, id: string, ip: string) {
  await loadOrg(ctx, p, id);
  const raw = `nrt_${randomSecret(32)}`;
  const org = await ctx.prisma.organization.update({ where: { id }, data: { registrationTokenHash: sha256Hex(raw) } });
  await writeAudit(ctx.prisma, {
    organizationId: id,
    actorType: 'USER',
    actorId: p.userId,
    action: AuditAction.REGISTRATION_TOKEN_SET,
    targetType: 'Organization',
    targetId: id,
    ip,
  });
  return { organization: serializeOrg(org), registration_token: raw };
}

export async function rotateAccessToken(ctx: AppContext, p: AdminPrincipal, id: string, ip: string) {
  await loadOrg(ctx, p, id);
  const { token, tokenHash } = generateAccessToken();
  const org = await ctx.prisma.organization.update({ where: { id }, data: { accessTokenHash: tokenHash } });
  await writeAudit(ctx.prisma, { organizationId: id, actorType: 'USER', actorId: p.userId, action: AuditAction.ACCESS_TOKEN_SET, targetType: 'Organization', targetId: id, ip });
  return { organization: serializeOrg(org), access_token: token };
}

export async function clearAccessToken(ctx: AppContext, p: AdminPrincipal, id: string, ip: string) {
  await loadOrg(ctx, p, id);
  const org = await ctx.prisma.organization.update({ where: { id }, data: { accessTokenHash: null } });
  await writeAudit(ctx.prisma, { organizationId: id, actorType: 'USER', actorId: p.userId, action: AuditAction.ACCESS_TOKEN_CLEARED, targetType: 'Organization', targetId: id, ip });
  return serializeOrg(org);
}

export async function clearRegistrationToken(ctx: AppContext, p: AdminPrincipal, id: string, ip: string) {
  await loadOrg(ctx, p, id);
  const org = await ctx.prisma.organization.update({ where: { id }, data: { registrationTokenHash: null } });
  await writeAudit(ctx.prisma, {
    organizationId: id,
    actorType: 'USER',
    actorId: p.userId,
    action: AuditAction.REGISTRATION_TOKEN_CLEARED,
    targetType: 'Organization',
    targetId: id,
    ip,
  });
  return serializeOrg(org);
}

// ---------- one-time sign-in links (SUPER_ADMIN → an organization admin) ----------
export const loginLinkBody = z.object({ user_id: z.string().min(1).max(64).optional() }).strict();

/**
 * Issue a single-use sign-in link for one of the organization's active admins (the given user, or
 * the oldest active admin). The URL carries a random token; only its sha256 is stored, it expires
 * after LOGIN_LINK_TTL_MINUTES and it cannot be used twice. Never issued for super admins.
 */
export async function createLoginLink(ctx: AppContext, p: AdminPrincipal, id: string, body: z.infer<typeof loginLinkBody>, ip: string) {
  requireSuperAdmin(p);
  const org = await loadOrg(ctx, p, id);
  if (org.status !== 'ACTIVE') throw conflict('ORGANIZATION_DISABLED', 'Organization is disabled');
  const user = await ctx.prisma.user.findFirst({
    where: { organizationId: org.id, role: 'ORGANIZATION_ADMIN', status: 'ACTIVE', ...(body.user_id ? { id: body.user_id } : {}) },
    orderBy: { createdAt: 'asc' },
  });
  if (!user) throw notFound(body.user_id ? 'Administrator not found in this organization' : 'This organization has no active administrator');
  const token = randomSecret(32);
  const expiresAt = new Date(Date.now() + ctx.config.loginLinkTtlMinutes * 60_000);
  const link = await ctx.prisma.loginLink.create({ data: { userId: user.id, tokenHash: sha256Hex(token), expiresAt, createdById: p.userId } });
  await writeAudit(ctx.prisma, {
    organizationId: org.id,
    actorType: 'USER',
    actorId: p.userId,
    action: AuditAction.LOGIN_LINK_CREATED,
    targetType: 'User',
    targetId: user.id,
    metadata: { login_link_id: link.id, email: user.email, expires_at: expiresAt.toISOString() },
    ip,
  });
  const url = new URL('/login', ctx.config.webPublicUrl);
  url.searchParams.set('org_admin', token);
  return { url: url.toString(), expires_at: expiresAt.toISOString(), user: { id: user.id, email: user.email } };
}

// ---------- delete (development tool) ----------
export const deleteOrgQuery = z.object({ confirm: z.string().max(64) });

/**
 * Permanently delete an organization and everything in it. SUPER_ADMIN only, only when
 * ALLOW_ORGANIZATION_DELETE is on (default: outside production), and the caller must repeat the
 * organization code. Audit history is kept (detached from the organization).
 */
export async function deleteOrg(ctx: AppContext, p: AdminPrincipal, id: string, confirm: string, ip: string) {
  requireSuperAdmin(p);
  if (!ctx.config.allowOrganizationDelete) throw forbidden('ORGANIZATION_DELETE_DISABLED', 'Deleting organizations is disabled on this server');
  const org = await loadOrg(ctx, p, id);
  if (confirm !== org.code) throw badRequest('Confirmation does not match the organization code', [{ path: 'confirm', message: `Type ${org.code} to confirm` }]);

  const counts = await ctx.prisma.$transaction(async (tx) => {
    const where = { organizationId: org.id };
    await tx.auditLog.updateMany({ where, data: { organizationId: null } });
    await tx.policyAssignment.deleteMany({ where });
    const devices = await tx.device.deleteMany({ where }); // cascades credentials, memberships, status, effective policy
    await tx.deviceCredential.deleteMany({ where });
    await tx.deviceGroup.deleteMany({ where });
    await tx.policy.updateMany({ where, data: { activeVersionId: null } });
    await tx.policyVersion.deleteMany({ where: { policy: { organizationId: org.id } } });
    const policies = await tx.policy.deleteMany({ where });
    const users = await tx.user.deleteMany({ where });
    await tx.organization.delete({ where: { id: org.id } });
    return { devices: devices.count, policies: policies.count, users: users.count };
  });
  await writeAudit(ctx.prisma, {
    organizationId: null,
    actorType: 'USER',
    actorId: p.userId,
    action: AuditAction.ORGANIZATION_DELETED,
    targetType: 'Organization',
    targetId: org.id,
    metadata: { code: org.code, name: org.name, ...counts },
    ip,
  });
  return counts;
}
