import type { Policy, PolicyAssignment, PolicyVersion, Prisma, PrismaClient } from '@prisma/client';
import { resolveAssignment } from '../domain/assignment.js';

type Client = PrismaClient | Prisma.TransactionClient;

export interface EffectivePolicy {
  policy: Policy;
  version: PolicyVersion;
  assignment: PolicyAssignment;
}

/**
 * Which policy version applies to a device. Everything is filtered by the device's organization
 * (taken from the DB row by the caller), and the pure resolver re-checks org equality.
 */
export async function resolveEffectivePolicy(db: Client, device: { id: string; organizationId: string }): Promise<EffectivePolicy | null> {
  const memberships = await db.deviceGroupMember.findMany({
    where: { deviceId: device.id, group: { organizationId: device.organizationId } },
    select: { groupId: true },
  });
  const groupIds = memberships.map((m) => m.groupId);
  const assignments = await db.policyAssignment.findMany({
    where: {
      organizationId: device.organizationId,
      policy: { organizationId: device.organizationId, isActive: true, activeVersionId: { not: null } },
      OR: [
        { scope: 'ORGANIZATION' },
        { scope: 'GROUP', targetGroupId: { in: groupIds.length ? groupIds : ['__none__'] } },
        { scope: 'DEVICE', targetDeviceId: device.id },
      ],
    },
    include: { policy: { include: { activeVersion: true } } },
  });
  const winner = resolveAssignment({ id: device.id, organizationId: device.organizationId, groupIds }, assignments);
  if (!winner) return null;
  const version = winner.policy.activeVersion;
  if (!version || version.status !== 'PUBLISHED' || !version.contentSha256) return null;
  const { activeVersion: _av, ...policy } = winner.policy;
  const { policy: _p, ...assignment } = winner;
  return { policy, version, assignment };
}
