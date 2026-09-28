import type { DeviceGroup } from '@prisma/client';
import { z } from 'zod';
import type { AppContext } from '../../types.js';
import type { AdminPrincipal } from '../../domain/rbac.js';
import { assertOrgAccess, createScope, listScope } from '../../domain/rbac.js';
import { AuditAction, writeAudit } from '../../services/audit.js';
import { badRequest, conflict, notFound } from '../../utils/errors.js';
import { iso } from '../../utils/http.js';

export const createGroupBody = z
  .object({
    organization_id: z.string().max(64).optional(),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1000).nullish(),
  })
  .strict();
export const updateGroupBody = z
  .object({ name: z.string().trim().min(1).max(200).optional(), description: z.string().trim().max(1000).nullish() })
  .strict();
export const membersBody = z.object({ device_ids: z.array(z.string().min(1).max(64)).min(1).max(1000) }).strict();
export const listGroupsQuery = z.object({ organization_id: z.string().max(64).optional() });

const serialize = (g: DeviceGroup & { _count?: { members: number } }) => ({
  id: g.id,
  organization_id: g.organizationId,
  name: g.name,
  description: g.description,
  member_count: g._count?.members ?? undefined,
  created_at: iso(g.createdAt),
  updated_at: iso(g.updatedAt),
});

async function loadGroup(ctx: AppContext, p: AdminPrincipal, id: string) {
  return assertOrgAccess(p, await ctx.prisma.deviceGroup.findUnique({ where: { id } }), 'Device group');
}

async function audit(ctx: AppContext, p: AdminPrincipal, g: DeviceGroup, action: Parameters<typeof writeAudit>[1]['action'], ip: string, meta: Record<string, unknown> = {}) {
  await writeAudit(ctx.prisma, { organizationId: g.organizationId, actorType: 'USER', actorId: p.userId, action, targetType: 'DeviceGroup', targetId: g.id, metadata: { name: g.name, ...meta }, ip });
}

export async function listGroups(ctx: AppContext, p: AdminPrincipal, q: z.infer<typeof listGroupsQuery>) {
  const orgId = listScope(p, q.organization_id);
  const items = await ctx.prisma.deviceGroup.findMany({
    where: orgId ? { organizationId: orgId } : {},
    include: { _count: { select: { members: true } } },
    orderBy: { name: 'asc' },
  });
  return { items: items.map(serialize) };
}

export async function getGroup(ctx: AppContext, p: AdminPrincipal, id: string) {
  const g = await loadGroup(ctx, p, id);
  const members = await ctx.prisma.deviceGroupMember.findMany({ where: { groupId: g.id }, include: { device: true } });
  return {
    ...serialize(g),
    members: members.map((m) => ({ device_id: m.deviceId, hostname: m.device.hostname, display_name: m.device.displayName, device_uuid: m.device.deviceUuid })),
  };
}

export async function createGroup(ctx: AppContext, p: AdminPrincipal, body: z.infer<typeof createGroupBody>, ip: string) {
  const orgId = createScope(p, body.organization_id);
  if (!(await ctx.prisma.organization.findUnique({ where: { id: orgId } }))) throw notFound('Organization not found');
  if (await ctx.prisma.deviceGroup.findUnique({ where: { organizationId_name: { organizationId: orgId, name: body.name } } })) {
    throw conflict('GROUP_NAME_IN_USE', 'A group with this name already exists in the organization');
  }
  const g = await ctx.prisma.deviceGroup.create({ data: { organizationId: orgId, name: body.name, description: body.description ?? null } });
  await audit(ctx, p, g, AuditAction.GROUP_CREATED, ip);
  return serialize(g);
}

export async function updateGroup(ctx: AppContext, p: AdminPrincipal, id: string, body: z.infer<typeof updateGroupBody>, ip: string) {
  const g = await loadGroup(ctx, p, id);
  const updated = await ctx.prisma.deviceGroup.update({ where: { id: g.id }, data: { name: body.name, description: body.description } });
  await audit(ctx, p, updated, AuditAction.GROUP_UPDATED, ip);
  return serialize(updated);
}

export async function deleteGroup(ctx: AppContext, p: AdminPrincipal, id: string, ip: string) {
  const g = await loadGroup(ctx, p, id);
  await ctx.prisma.deviceGroup.delete({ where: { id: g.id } });
  await audit(ctx, p, g, AuditAction.GROUP_DELETED, ip);
}

/** Adds devices; every device must belong to the group's organization (cross-org rejected). */
export async function addMembers(ctx: AppContext, p: AdminPrincipal, id: string, body: z.infer<typeof membersBody>, ip: string) {
  const g = await loadGroup(ctx, p, id);
  const ids = [...new Set(body.device_ids)];
  const devices = await ctx.prisma.device.findMany({ where: { id: { in: ids }, organizationId: g.organizationId }, select: { id: true } });
  if (devices.length !== ids.length) {
    const found = new Set(devices.map((d) => d.id));
    throw badRequest('Some devices do not exist in this organization', ids.filter((i) => !found.has(i)).map((i) => ({ path: 'device_ids', message: `unknown device ${i}` })));
  }
  await ctx.prisma.deviceGroupMember.createMany({ data: ids.map((deviceId) => ({ groupId: g.id, deviceId })), skipDuplicates: true });
  await audit(ctx, p, g, AuditAction.GROUP_MEMBERS_CHANGED, ip, { added: ids });
  return getGroup(ctx, p, id);
}

export async function removeMember(ctx: AppContext, p: AdminPrincipal, id: string, deviceId: string, ip: string) {
  const g = await loadGroup(ctx, p, id);
  const r = await ctx.prisma.deviceGroupMember.deleteMany({ where: { groupId: g.id, deviceId } });
  if (r.count === 0) throw notFound('Member not found');
  await audit(ctx, p, g, AuditAction.GROUP_MEMBERS_CHANGED, ip, { removed: [deviceId] });
}
