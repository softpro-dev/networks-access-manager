import type { Organization, Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AppContext } from '../../types.js';
import type { AdminPrincipal } from '../../domain/rbac.js';
import { assertOrgAccess, isSuperAdmin, requireSuperAdmin } from '../../domain/rbac.js';
import { AuditAction, writeAudit } from '../../services/audit.js';
import { agentEvents } from '../../services/agentEvents.js';
import { openSecret, randomSecret, sealSecret, sha256Hex } from '../../utils/crypto.js';
import { generateAccessToken } from '../../domain/deviceToken.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../../services/password.js';
import { badRequest, conflict, forbidden, notFound } from '../../utils/errors.js';
import { iso, ORG_CODE_RE } from '../../utils/http.js';

export function serializeOrg(o: Organization) {
  return {
    id: o.id,
    code: o.code,
    name: o.name,
    status: o.status,
    phone: o.phone,
    has_registration_token: o.registrationTokenHash !== null,
    has_access_token: o.accessTokenHash !== null,
    /** false for tokens generated before they were stored encrypted (rotate once). */
    access_token_copyable: o.accessTokenHash !== null && o.accessTokenEnc !== null,
    created_at: iso(o.createdAt),
    updated_at: iso(o.updatedAt),
  };
}

const phone = z.string().trim().regex(/^\d{11}$/, 'Must be exactly 11 digits');

/** Creating an organization also creates its first ORGANIZATION_ADMIN (admin_email / admin_password). */
export const createOrgBody = z
  .object({
    code: z.string().trim().toUpperCase().regex(ORG_CODE_RE, 'Must match ^[A-Z0-9][A-Z0-9-]{1,31}$'),
    name: z.string().trim().min(1).max(200),
    phone,
    admin_email: z.string().trim().toLowerCase().email().max(254),
    admin_password: z.string().min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`).max(1024),
  })
  .strict();

export const updateOrgBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    phone: phone.optional(),
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
  if (await ctx.prisma.user.findUnique({ where: { email: body.admin_email } })) {
    throw conflict('EMAIL_IN_USE', 'A user with this email already exists');
  }
  const passwordHash = await hashPassword(body.admin_password);
  const { org, admin } = await ctx.prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({ data: { code: body.code, name: body.name, phone: body.phone } });
    const admin = await tx.user.create({
      data: { email: body.admin_email, passwordHash, role: 'ORGANIZATION_ADMIN', organizationId: org.id, name: 'Organization Admin' },
    });
    await writeAudit(tx, {
      organizationId: org.id,
      actorType: 'USER',
      actorId: p.userId,
      action: AuditAction.ORGANIZATION_CREATED,
      targetType: 'Organization',
      targetId: org.id,
      metadata: { code: org.code, name: org.name, phone: org.phone },
      ip,
    });
    await writeAudit(tx, {
      organizationId: org.id,
      actorType: 'USER',
      actorId: p.userId,
      action: AuditAction.ADMIN_CREATED,
      targetType: 'User',
      targetId: admin.id,
      metadata: { email: admin.email, role: admin.role },
      ip,
    });
    return { org, admin };
  });
  return { ...serializeOrg(org), admin: { id: admin.id, email: admin.email } };
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
  // The hash authenticates services; the sealed copy lets admins copy the token again later.
  const org = await ctx.prisma.organization.update({
    where: { id },
    data: { accessTokenHash: tokenHash, accessTokenEnc: sealSecret(token, ctx.config.tokenEncryptionKey) },
  });
  await writeAudit(ctx.prisma, { organizationId: id, actorType: 'USER', actorId: p.userId, action: AuditAction.ACCESS_TOKEN_SET, targetType: 'Organization', targetId: id, ip });
  return { organization: serializeOrg(org), access_token: token };
}

export async function clearAccessToken(ctx: AppContext, p: AdminPrincipal, id: string, ip: string) {
  await loadOrg(ctx, p, id);
  const org = await ctx.prisma.organization.update({ where: { id }, data: { accessTokenHash: null, accessTokenEnc: null } });
  await writeAudit(ctx.prisma, { organizationId: id, actorType: 'USER', actorId: p.userId, action: AuditAction.ACCESS_TOKEN_CLEARED, targetType: 'Organization', targetId: id, ip });
  return serializeOrg(org);
}

/** The current access token in clear ("Copy token"). Same permission as rotating it; audited. */
export async function revealAccessToken(ctx: AppContext, p: AdminPrincipal, id: string, ip: string) {
  const org = await loadOrg(ctx, p, id);
  if (!org.accessTokenHash) throw notFound('This organization has no access token. Generate one first.');
  const token = org.accessTokenEnc ? openSecret(org.accessTokenEnc, ctx.config.tokenEncryptionKey) : null;
  if (!token) {
    // Generated before tokens were stored encrypted, or TOKEN_ENCRYPTION_KEY / JWT_SECRET changed.
    throw conflict('ACCESS_TOKEN_NOT_RETRIEVABLE', 'This token cannot be copied (it was generated before copying was supported or the server key changed). Rotate it once to enable Copy token.');
  }
  await writeAudit(ctx.prisma, { organizationId: id, actorType: 'USER', actorId: p.userId, action: AuditAction.ACCESS_TOKEN_REVEALED, targetType: 'Organization', targetId: id, ip });
  return { access_token: token };
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
 * Permanently delete an organization and everything in it, including its organization admins.
 * SUPER_ADMIN only; the organization must be **disabled** first (so its admins and services are
 * already locked out), and the caller must repeat the organization code. ALLOW_ORGANIZATION_DELETE=false
 * switches deletion off for the whole server. Audit history is kept (detached from the organization).
 */
export async function deleteOrg(ctx: AppContext, p: AdminPrincipal, id: string, confirm: string, ip: string) {
  requireSuperAdmin(p);
  if (!ctx.config.allowOrganizationDelete) throw forbidden('ORGANIZATION_DELETE_DISABLED', 'Deleting organizations is disabled on this server');
  const org = await loadOrg(ctx, p, id);
  if (org.status === 'ACTIVE') throw conflict('ORGANIZATION_ACTIVE', 'Disable the organization before deleting it');
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
  // The audit entry is detached from the organization, so close its live service streams here.
  agentEvents.disconnectOrg(org.id);
  return counts;
}
