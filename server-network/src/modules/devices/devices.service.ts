import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AppContext } from '../../types.js';
import type { AdminPrincipal } from '../../domain/rbac.js';
import { assertOrgAccess, listScope } from '../../domain/rbac.js';
import { AuditAction, writeAudit } from '../../services/audit.js';
import { resolveEffectivePolicy } from '../../services/policyResolution.js';
import { conflict } from '../../utils/errors.js';
import { iso, pageArgs, pageBody } from '../../utils/http.js';
import { makePolicyEtag } from '../../domain/etag.js';

const deviceInclude = {
  organization: true,
  approvedBy: { select: { id: true, email: true } },
  currentPolicy: { select: { id: true, code: true, name: true } },
  policyStatus: true,
} satisfies Prisma.DeviceInclude;

type DeviceRow = Prisma.DeviceGetPayload<{ include: typeof deviceInclude }>;

export function serializeDevice(d: DeviceRow, heartbeatIntervalSeconds: number) {
  const online = d.lastHeartbeatAt ? Date.now() - d.lastHeartbeatAt.getTime() < heartbeatIntervalSeconds * 3 * 1000 : false;
  return {
    id: d.id,
    display_name: d.displayName,
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
    created_at: iso(d.createdAt),
    updated_at: iso(d.updatedAt),
  };
}

export const listDevicesQuery = z.object({
  organization_id: z.string().max(64).optional(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'REVOKED']).optional(),
  group_id: z.string().max(64).optional(),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
});

export const updateDeviceBody = z.object({ display_name: z.string().trim().min(1).max(200).nullable() }).strict();

export async function listDevices(ctx: AppContext, p: AdminPrincipal, q: z.infer<typeof listDevicesQuery>) {
  const orgId = listScope(p, q.organization_id);
  const where: Prisma.DeviceWhereInput = {
    ...(orgId ? { organizationId: orgId } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.group_id ? { memberships: { some: { groupId: q.group_id } } } : {}),
    ...(q.q
      ? { OR: [{ hostname: { contains: q.q } }, { displayName: { contains: q.q } }, { deviceUuid: { contains: q.q.toLowerCase() } }, { lastIp: { contains: q.q } }] }
      : {}),
  };
  const [items, total] = await Promise.all([
    ctx.prisma.device.findMany({ where, include: deviceInclude, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
    ctx.prisma.device.count({ where }),
  ]);
  return pageBody(items.map((d) => serializeDevice(d, ctx.config.heartbeatIntervalSeconds)), total, q);
}

async function loadDevice(ctx: AppContext, p: AdminPrincipal, id: string) {
  const d = await ctx.prisma.device.findUnique({ where: { id }, include: deviceInclude });
  return assertOrgAccess(p, d, 'Device');
}

export async function getDevice(ctx: AppContext, p: AdminPrincipal, id: string) {
  const d = await loadDevice(ctx, p, id);
  const [credentials, groups, effective] = await Promise.all([
    ctx.prisma.deviceCredential.findMany({ where: { deviceId: d.id }, orderBy: { createdAt: 'desc' } }),
    ctx.prisma.deviceGroupMember.findMany({ where: { deviceId: d.id }, include: { group: true } }),
    resolveEffectivePolicy(ctx.prisma, d),
  ]);
  return {
    ...serializeDevice(d, ctx.config.heartbeatIntervalSeconds),
    interfaces: d.interfaces,
    groups: groups.map((g) => ({ id: g.group.id, name: g.group.name })),
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
          id: effective.policy.id,
          policy_id: effective.policy.code,
          version: effective.version.version,
          assignment_scope: effective.assignment.scope,
          assignment_id: effective.assignment.id,
          etag: makePolicyEtag(effective.policy.code, effective.version.version, effective.version.contentSha256!),
        }
      : null,
  };
}

export async function updateDevice(ctx: AppContext, p: AdminPrincipal, id: string, body: z.infer<typeof updateDeviceBody>, ip: string) {
  const d = await loadDevice(ctx, p, id);
  await ctx.prisma.device.update({ where: { id: d.id }, data: { displayName: body.display_name } });
  await audit(ctx, p, d, AuditAction.DEVICE_UPDATED, ip, { display_name: body.display_name });
  return getDevice(ctx, p, id);
}

async function audit(ctx: AppContext, p: AdminPrincipal, d: { id: string; organizationId: string; deviceUuid: string; hostname: string }, action: Parameters<typeof writeAudit>[1]['action'], ip: string, extra: Record<string, unknown> = {}) {
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
