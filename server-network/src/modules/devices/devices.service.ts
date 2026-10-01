import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AppContext } from '../../types.js';
import type { AdminPrincipal } from '../../domain/rbac.js';
import { assertOrgAccess, listScope } from '../../domain/rbac.js';
import { AuditAction, writeAudit } from '../../services/audit.js';
import { currentDeviceSha, currentOrgSha, EFFECTIVE_POLICY_ID, resolveEffectivePolicy } from '../../services/policyResolution.js';
import { badRequest, conflict } from '../../utils/errors.js';
import { iso, pageArgs, pageBody } from '../../utils/http.js';
import { makePolicyEtag } from '../../domain/etag.js';
import { createScope } from '../../domain/rbac.js';
import { normalizeMac } from '../../domain/mac.js';

const deviceInclude = {
  organization: true,
  approvedBy: { select: { id: true, email: true } },
  currentPolicy: { select: { id: true, code: true, name: true } },
  policyStatus: true,
  memberships: { include: { group: { select: { id: true, name: true } } } },
  effectivePolicy: { select: { version: true, contentSha256: true } },
} satisfies Prisma.DeviceInclude;

type DeviceRow = Prisma.DeviceGetPayload<{ include: typeof deviceInclude }>;

/**
 * Synced = the restrictions this computer's service last fetched equal what it should have now
 * (null = it never fetched). The org-wide target is computed once per organization.
 */
async function syncStatus(ctx: AppContext, rows: DeviceRow[]): Promise<Map<string, boolean | null>> {
  const orgTargets = new Map<string, Promise<string>>();
  const out = new Map<string, boolean | null>();
  await Promise.all(
    rows.map(async (d) => {
      if (!d.syncedSha256) return void out.set(d.id, null);
      let target: string;
      if (d.syncedVia === 'ORG') {
        if (!orgTargets.has(d.organizationId)) orgTargets.set(d.organizationId, currentOrgSha(ctx.prisma, d.organizationId));
        target = await orgTargets.get(d.organizationId)!;
      } else {
        target = await currentDeviceSha(ctx.prisma, d);
      }
      out.set(d.id, target === d.syncedSha256);
    }),
  );
  return out;
}

export function serializeDevice(d: DeviceRow, heartbeatIntervalSeconds: number, synced: boolean | null = null) {
  const online = d.lastHeartbeatAt ? Date.now() - d.lastHeartbeatAt.getTime() < heartbeatIntervalSeconds * 3 * 1000 : false;
  return {
    id: d.id,
    /** has the latest restrictions (null = its service never fetched) */
    synced,
    synced_at: iso(d.syncedAt),
    synced_via: d.syncedVia,
    display_name: d.displayName,
    title: d.displayName,
    serial_number: d.serialNumber,
    mac_address: d.macAddress,
    groups: d.memberships.map((m) => ({ id: m.group.id, name: m.group.name })),
    organization: { id: d.organization.id, code: d.organization.code, name: d.organization.name },
    hostname: d.hostname,
    device_uuid: d.deviceUuid,
    status: d.status,
    approval: { approved_at: iso(d.approvedAt), approved_by: d.approvedBy ? { id: d.approvedBy.id, email: d.approvedBy.email } : null },
    last_heartbeat_at: iso(d.lastHeartbeatAt),
    online,
    current_ip: d.lastIp,
    last_request_ip: d.lastRequestIp,
    agent_version: d.agentVersion,
    windows_version: d.windowsVersion,
    reported_status: d.reportedStatus,
    current_policy: d.currentPolicy
      ? { id: d.currentPolicy.id, policy_id: d.currentPolicy.code, name: d.currentPolicy.name, version: d.currentPolicyVersion }
      : d.currentPolicyVersion
        ? { id: null, policy_id: null, name: null, version: d.currentPolicyVersion }
        : null,
    policy_status: d.policyStatus
      ? {
          policy_id: d.policyStatus.policyCode,
          version: d.policyStatus.version,
          status: d.policyStatus.status,
          error_code: d.policyStatus.errorCode,
          message: d.policyStatus.message,
          active_policy_id: d.policyStatus.activePolicyCode,
          active_version: d.policyStatus.activeVersion,
          updated_at: iso(d.policyStatus.updatedAt),
        }
      : null,
    effective_policy_version: d.effectivePolicy?.version ?? null,
    created_at: iso(d.createdAt),
    updated_at: iso(d.updatedAt),
  };
}

export const listDevicesQuery = z.object({
  organization_id: z.string().max(64).optional(),
  status: z.enum(['PRE_REGISTERED', 'PENDING', 'APPROVED', 'REJECTED', 'REVOKED']).optional(),
  group_id: z.string().max(64).optional(),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
});

const macField = z.string().transform((v, c) => {
  const m = normalizeMac(v);
  if (!m) {
    c.addIssue({ code: 'custom', message: 'Must be a MAC address like AA:BB:CC:DD:EE:FF' });
    return z.NEVER;
  }
  return m;
});
const groupIdsField = z.array(z.string().min(1).max(64)).max(100);

export const createDeviceBody = z
  .object({
    organization_id: z.string().max(64).optional(),
    mac_address: macField,
    title: z.string().trim().min(1).max(200),
    serial_number: z.string().trim().max(100).nullish(),
    group_ids: groupIdsField.default([]),
  })
  .strict();

export const updateDeviceBody = z
  .object({
    display_name: z.string().trim().min(1).max(200).nullable().optional(),
    title: z.string().trim().min(1).max(200).optional(),
    serial_number: z.string().trim().max(100).nullable().optional(),
    mac_address: macField.nullable().optional(),
    group_ids: groupIdsField.optional(),
  })
  .strict();

export async function listDevices(ctx: AppContext, p: AdminPrincipal, q: z.infer<typeof listDevicesQuery>) {
  const orgId = listScope(p, q.organization_id);
  const where: Prisma.DeviceWhereInput = {
    ...(orgId ? { organizationId: orgId } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.group_id ? { memberships: { some: { groupId: q.group_id } } } : {}),
    ...(q.q
      ? {
          OR: [
            { hostname: { contains: q.q } },
            { displayName: { contains: q.q } },
            { serialNumber: { contains: q.q } },
            { macAddress: { contains: q.q.toUpperCase() } },
            { deviceUuid: { contains: q.q.toLowerCase() } },
            { lastIp: { contains: q.q } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    ctx.prisma.device.findMany({ where, include: deviceInclude, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
    ctx.prisma.device.count({ where }),
  ]);
  const synced = await syncStatus(ctx, items);
  return pageBody(items.map((d) => serializeDevice(d, ctx.config.heartbeatIntervalSeconds, synced.get(d.id) ?? null)), total, q);
}

async function loadDevice(ctx: AppContext, p: AdminPrincipal, id: string) {
  const d = await ctx.prisma.device.findUnique({ where: { id }, include: deviceInclude });
  return assertOrgAccess(p, d, 'Device');
}

export async function getDevice(ctx: AppContext, p: AdminPrincipal, id: string) {
  const d = await loadDevice(ctx, p, id);
  const [credentials, effective, synced] = await Promise.all([
    ctx.prisma.deviceCredential.findMany({ where: { deviceId: d.id }, orderBy: { createdAt: 'desc' } }),
    resolveEffectivePolicy(ctx.prisma, d),
    syncStatus(ctx, [d]),
  ]);
  return {
    ...serializeDevice(d, ctx.config.heartbeatIntervalSeconds, synced.get(d.id) ?? null),
    interfaces: d.interfaces,
    credentials: credentials.map((c) => ({
      credential_id: c.id,
      created_at: iso(c.createdAt),
      claimed_at: iso(c.claimedAt),
      issued_at: iso(c.issuedAt),
      expires_at: iso(c.expiresAt),
      revoked_at: iso(c.revokedAt),
      last_used_at: iso(c.lastUsedAt),
    })),
    effective_policy: effective
      ? {
          policy_id: EFFECTIVE_POLICY_ID,
          version: effective.version,
          content_sha256: effective.contentSha256,
          etag: makePolicyEtag(EFFECTIVE_POLICY_ID, effective.version, effective.contentSha256),
          updated_at: iso(effective.updatedAt),
          sources: effective.sources,
          content: effective.content,
        }
      : null,
  };
}

/** Groups must belong to the device's organization (cross-org ids are rejected). */
async function checkGroups(ctx: AppContext, organizationId: string, groupIds: string[]) {
  const unique = [...new Set(groupIds)];
  if (!unique.length) return unique;
  const found = await ctx.prisma.deviceGroup.count({ where: { id: { in: unique }, organizationId } });
  if (found !== unique.length) throw badRequest('Unknown group', [{ path: 'group_ids', message: 'One or more groups do not exist in this organization' }]);
  return unique;
}

async function macInUse(ctx: AppContext, organizationId: string, mac: string, exceptId?: string) {
  const other = await ctx.prisma.device.findFirst({ where: { organizationId, macAddress: mac, ...(exceptId ? { id: { not: exceptId } } : {}) } });
  if (other) throw conflict('MAC_IN_USE', 'Another computer in this organization already has this MAC address');
}

/** Pre-add a computer by MAC. It stays PRE_REGISTERED until the agent on that machine registers. */
export async function createDevice(ctx: AppContext, p: AdminPrincipal, body: z.infer<typeof createDeviceBody>, ip: string) {
  const orgId = createScope(p, body.organization_id);
  if (!(await ctx.prisma.organization.findUnique({ where: { id: orgId } }))) throw badRequest('Unknown organization');
  await macInUse(ctx, orgId, body.mac_address);
  const groupIds = await checkGroups(ctx, orgId, body.group_ids);
  const d = await ctx.prisma.device.create({
    data: {
      organizationId: orgId,
      status: 'PRE_REGISTERED',
      macAddress: body.mac_address,
      displayName: body.title,
      serialNumber: body.serial_number ?? null,
      memberships: { create: groupIds.map((groupId) => ({ groupId })) },
    },
  });
  await audit(ctx, p, d, AuditAction.DEVICE_CREATED, ip, { mac_address: d.macAddress, title: d.displayName, group_ids: groupIds });
  return getDevice(ctx, p, d.id);
}

export async function updateDevice(ctx: AppContext, p: AdminPrincipal, id: string, body: z.infer<typeof updateDeviceBody>, ip: string) {
  const d = await loadDevice(ctx, p, id);
  const title = body.title ?? body.display_name;
  if (body.mac_address !== undefined && body.mac_address !== d.macAddress) {
    if (d.status === 'PRE_REGISTERED' && body.mac_address === null) throw badRequest('A pre-registered computer needs a MAC address');
    if (body.mac_address) await macInUse(ctx, d.organizationId, body.mac_address, d.id);
  }
  const groupIds = body.group_ids ? await checkGroups(ctx, d.organizationId, body.group_ids) : undefined;
  await ctx.prisma.$transaction(async (tx) => {
    await tx.device.update({
      where: { id: d.id },
      data: {
        ...(title !== undefined ? { displayName: title } : {}),
        ...(body.serial_number !== undefined ? { serialNumber: body.serial_number } : {}),
        ...(body.mac_address !== undefined ? { macAddress: body.mac_address } : {}),
      },
    });
    if (groupIds) {
      await tx.deviceGroupMember.deleteMany({ where: { deviceId: d.id, groupId: { notIn: groupIds } } });
      await tx.deviceGroupMember.createMany({ data: groupIds.map((groupId) => ({ groupId, deviceId: d.id })), skipDuplicates: true });
    }
  });
  await audit(ctx, p, d, AuditAction.DEVICE_UPDATED, ip, { changed: Object.keys(body) });
  return getDevice(ctx, p, id);
}

/** Delete a computer: credentials are revoked first (in the same transaction), then the row is removed. */
export async function deleteDevice(ctx: AppContext, p: AdminPrincipal, id: string, ip: string) {
  const d = await loadDevice(ctx, p, id);
  await ctx.prisma.$transaction(async (tx) => {
    await tx.deviceCredential.updateMany({ where: { deviceId: d.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.device.delete({ where: { id: d.id } });
  });
  await audit(ctx, p, d, AuditAction.DEVICE_DELETED, ip, { title: d.displayName, mac_address: d.macAddress, previous_status: d.status });
}

async function audit(ctx: AppContext, p: AdminPrincipal, d: { id: string; organizationId: string; deviceUuid: string | null; hostname: string | null }, action: Parameters<typeof writeAudit>[1]['action'], ip: string, extra: Record<string, unknown> = {}) {
  await writeAudit(ctx.prisma, {
    organizationId: d.organizationId,
    actorType: 'USER',
    actorId: p.userId,
    action,
    targetType: 'Device',
    targetId: d.id,
    metadata: { device_uuid: d.deviceUuid, hostname: d.hostname, ...extra },
    ip,
  });
}

/** Approve a PENDING device: creates an UNCLAIMED credential row; the raw token is minted at claim time. */
export async function approveDevice(ctx: AppContext, p: AdminPrincipal, id: string, ip: string) {
  const d = await loadDevice(ctx, p, id);
  if (d.status !== 'PENDING') throw conflict('INVALID_DEVICE_STATE', `Device is ${d.status}; only PENDING devices can be approved`);
  if (!d.enrollmentSecretHash) throw conflict('INVALID_DEVICE_STATE', 'Device has no pending enrollment; the agent must register again');
  const now = new Date();
  await ctx.prisma.$transaction(async (tx) => {
    const r = await tx.device.updateMany({ where: { id: d.id, status: 'PENDING' }, data: { status: 'APPROVED', approvedAt: now, approvedById: p.userId } });
    if (r.count !== 1) throw conflict('INVALID_DEVICE_STATE', 'Device state changed concurrently');
    await tx.deviceCredential.updateMany({ where: { deviceId: d.id, revokedAt: null }, data: { revokedAt: now } });
    await tx.deviceCredential.create({ data: { deviceId: d.id, organizationId: d.organizationId } });
  });
  await audit(ctx, p, d, AuditAction.DEVICE_APPROVED, ip);
  return getDevice(ctx, p, id);
}

export async function rejectDevice(ctx: AppContext, p: AdminPrincipal, id: string, ip: string) {
  const d = await loadDevice(ctx, p, id);
  if (d.status !== 'PENDING') throw conflict('INVALID_DEVICE_STATE', `Device is ${d.status}; only PENDING devices can be rejected`);
  await ctx.prisma.device.update({ where: { id: d.id }, data: { status: 'REJECTED' } });
  await audit(ctx, p, d, AuditAction.DEVICE_REJECTED, ip);
  return getDevice(ctx, p, id);
}

/**
 * Forget what this computer's service last fetched, so the console shows "Never" until its next
 * check-in — a quick way to confirm the service is still connecting.
 */
export async function resetDeviceSync(ctx: AppContext, p: AdminPrincipal, id: string, ip: string) {
  const d = await loadDevice(ctx, p, id);
  await ctx.prisma.device.update({ where: { id: d.id }, data: { syncedSha256: null, syncedAt: null, syncedVia: null } });
  await audit(ctx, p, d, AuditAction.DEVICE_SYNC_RESET, ip);
  return getDevice(ctx, p, id);
}

/** Revoke: device → REVOKED and every credential revoked immediately (checked on every agent request). */
export async function revokeDevice(ctx: AppContext, p: AdminPrincipal, id: string, ip: string) {
  const d = await loadDevice(ctx, p, id);
  if (d.status === 'REVOKED') throw conflict('INVALID_DEVICE_STATE', 'Device is already revoked');
  const now = new Date();
  const revoked = await ctx.prisma.$transaction(async (tx) => {
    await tx.device.update({ where: { id: d.id }, data: { status: 'REVOKED' } });
    return (await tx.deviceCredential.updateMany({ where: { deviceId: d.id, revokedAt: null }, data: { revokedAt: now } })).count;
  });
  await audit(ctx, p, d, AuditAction.DEVICE_REVOKED, ip, { credentials_revoked: revoked, previous_status: d.status });
  return getDevice(ctx, p, id);
}

/**
 * Re-enroll / reset: revoke credentials, back to PENDING and forget the enrollment secret. The agent
 * registers again (same device_uuid, new enrollment secret) and an admin approves again.
 */
export async function reenrollDevice(ctx: AppContext, p: AdminPrincipal, id: string, ip: string) {
  const d = await loadDevice(ctx, p, id);
  const now = new Date();
  await ctx.prisma.$transaction(async (tx) => {
    await tx.deviceCredential.updateMany({ where: { deviceId: d.id, revokedAt: null }, data: { revokedAt: now } });
    await tx.device.update({
      where: { id: d.id },
      data: { status: 'PENDING', enrollmentSecretHash: null, approvedAt: null, approvedById: null },
    });
  });
  await audit(ctx, p, d, AuditAction.DEVICE_RE_ENROLL, ip, { previous_status: d.status });
  return getDevice(ctx, p, id);
}
