import type { Organization, Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AppContext } from '../../types.js';
import type { AdminPrincipal } from '../../domain/rbac.js';
import { assertOrgAccess, isSuperAdmin, requireSuperAdmin } from '../../domain/rbac.js';
import { AuditAction, writeAudit } from '../../services/audit.js';
import { randomSecret, sha256Hex } from '../../utils/crypto.js';
import { conflict, notFound } from '../../utils/errors.js';
import { iso, ORG_CODE_RE } from '../../utils/http.js';

export function serializeOrg(o: Organization) {
  return {
    id: o.id,
    code: o.code,
    name: o.name,
    status: o.status,
    has_registration_token: o.registrationTokenHash !== null,
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
