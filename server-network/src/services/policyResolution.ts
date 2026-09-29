import { Prisma, type PrismaClient } from '@prisma/client';
import { canonicalSha256 } from '../domain/canonicalJson.js';
import { mergeRestrictions, type EffectiveSource, type RestrictionInput } from '../domain/mergeRestrictions.js';
import type { PolicyContent } from '../domain/policyContent.js';

type Client = PrismaClient | Prisma.TransactionClient;

/** Wire policy_id of the merged per-device policy. */
export const EFFECTIVE_POLICY_ID = 'EFFECTIVE';

export interface EffectivePolicy {
  version: number;
  content: PolicyContent;
  contentSha256: string;
  sources: EffectiveSource[];
  updatedAt: Date;
}

/**
 * Every active, published restriction reaching the device (organization-wide, via its groups, or
 * directly). Everything is filtered by the device's organization, taken from the DB row by the caller.
 */
export async function collectRestrictions(db: Client, device: { id: string; organizationId: string }): Promise<RestrictionInput[]> {
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
        ...(groupIds.length ? [{ scope: 'GROUP' as const, targetGroupId: { in: groupIds } }] : []),
        { scope: 'DEVICE', targetDeviceId: device.id },
      ],
    },
    include: { policy: { include: { activeVersion: true } } },
  });
  const out: RestrictionInput[] = [];
  for (const a of assignments) {
    const v = a.policy.activeVersion;
    if (a.policy.organizationId !== device.organizationId || !v || v.status !== 'PUBLISHED' || !v.contentSha256) continue;
    out.push({ policy_id: a.policy.id, code: a.policy.code, kind: a.policy.kind, version: v.version, via: a.scope, content: v.content as unknown as PolicyContent });
  }
  return out;
}

function toEffective(row: { version: number; content: Prisma.JsonValue; contentSha256: string; sources: Prisma.JsonValue; updatedAt: Date }): EffectivePolicy {
  return {
    version: row.version,
    content: row.content as unknown as PolicyContent,
    contentSha256: row.contentSha256,
    sources: row.sources as unknown as EffectiveSource[],
    updatedAt: row.updatedAt,
  };
}

/**
 * The merged policy for a device, or null when no restriction applies. The stored row keeps a
 * per-device version counter that increases whenever the merged content hash changes; the counter
 * survives periods with no restrictions, so versions never repeat for different content.
 */
export async function resolveEffectivePolicy(db: PrismaClient, device: { id: string; organizationId: string }): Promise<EffectivePolicy | null> {
  const merged = mergeRestrictions(await collectRestrictions(db, device));
  if (!merged) return null;
  const sha = canonicalSha256(merged.content);
  const content = merged.content as unknown as Prisma.InputJsonValue;
  const sources = merged.sources as unknown as Prisma.InputJsonValue;

  for (let attempt = 0; attempt < 3; attempt++) {
    const stored = await db.deviceEffectivePolicy.findUnique({ where: { deviceId: device.id } });
    if (stored && stored.contentSha256 === sha) {
      // Same rules; refresh the source list (e.g. restriction versions) without bumping the version.
      if (JSON.stringify(stored.sources) !== JSON.stringify(merged.sources)) {
        return toEffective(await db.deviceEffectivePolicy.update({ where: { id: stored.id }, data: { sources } }));
      }
      return toEffective(stored);
    }
    if (!stored) {
      try {
        return toEffective(await db.deviceEffectivePolicy.create({ data: { deviceId: device.id, version: 1, content, contentSha256: sha, sources } }));
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue; // concurrent create
        throw e;
      }
    }
    // Conditional on the old hash so concurrent resolvers bump the version exactly once.
    const r = await db.deviceEffectivePolicy.updateMany({
      where: { id: stored.id, contentSha256: stored.contentSha256 },
      data: { version: stored.version + 1, content, contentSha256: sha, sources },
    });
    if (r.count === 1) return toEffective((await db.deviceEffectivePolicy.findUniqueOrThrow({ where: { id: stored.id } })));
  }
  throw new Error('Could not resolve the effective policy (concurrent updates)');
}
