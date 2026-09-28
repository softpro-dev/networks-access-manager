import type { Prisma, PrismaClient } from '@prisma/client';

export type ActorType = 'USER' | 'DEVICE' | 'SYSTEM';

/** Canonical audit action names. */
export const AuditAction = {
  LOGIN_SUCCESS: 'LOGIN_SUCCESS',
  LOGIN_FAILURE: 'LOGIN_FAILURE',
  LOGOUT: 'LOGOUT',
  ORGANIZATION_CREATED: 'ORGANIZATION_CREATED',
  ORGANIZATION_UPDATED: 'ORGANIZATION_UPDATED',
  REGISTRATION_TOKEN_SET: 'REGISTRATION_TOKEN_SET',
  REGISTRATION_TOKEN_CLEARED: 'REGISTRATION_TOKEN_CLEARED',
  ADMIN_CREATED: 'ADMIN_CREATED',
  ADMIN_UPDATED: 'ADMIN_UPDATED',
  DEVICE_REGISTERED: 'DEVICE_REGISTERED',
  DEVICE_APPROVED: 'DEVICE_APPROVED',
  DEVICE_REJECTED: 'DEVICE_REJECTED',
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  DEVICE_RE_ENROLL: 'DEVICE_RE_ENROLL',
  DEVICE_UPDATED: 'DEVICE_UPDATED',
  CREDENTIAL_CLAIMED: 'CREDENTIAL_CLAIMED',
  GROUP_CREATED: 'GROUP_CREATED',
  GROUP_UPDATED: 'GROUP_UPDATED',
  GROUP_DELETED: 'GROUP_DELETED',
  GROUP_MEMBERS_CHANGED: 'GROUP_MEMBERS_CHANGED',
  POLICY_CREATED: 'POLICY_CREATED',
  POLICY_UPDATED: 'POLICY_UPDATED',
  POLICY_DRAFT_CREATED: 'POLICY_DRAFT_CREATED',
  POLICY_DRAFT_UPDATED: 'POLICY_DRAFT_UPDATED',
  POLICY_PUBLISHED: 'POLICY_PUBLISHED',
  POLICY_VERSION_ARCHIVED: 'POLICY_VERSION_ARCHIVED',
  POLICY_ROLLED_BACK: 'POLICY_ROLLED_BACK',
  POLICY_ACTIVATED: 'POLICY_ACTIVATED',
  POLICY_DEACTIVATED: 'POLICY_DEACTIVATED',
  POLICY_ASSIGNED: 'POLICY_ASSIGNED',
  POLICY_UNASSIGNED: 'POLICY_UNASSIGNED',
  POLICY_APPLIED: 'POLICY_APPLIED',
  POLICY_APPLICATION_FAILED: 'POLICY_APPLICATION_FAILED',
} as const;
export type AuditActionName = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEntry {
  organizationId?: string | null;
  actorType: ActorType;
  actorId?: string | null;
  action: AuditActionName;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
}

type Client = PrismaClient | Prisma.TransactionClient;

const SECRET_KEY_RE = /pass|secret|token|hash|authorization|credential/i;

/** Defensive scrub: audit metadata must never carry secrets even if a caller slips. */
export function scrubMetadata(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined) continue;
    if (SECRET_KEY_RE.test(k) && k !== 'credential_id') continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? scrubMetadata(v as Record<string, unknown>) : v;
  }
  return out;
}

export async function writeAudit(db: Client, e: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      organizationId: e.organizationId ?? null,
      actorType: e.actorType,
      actorId: e.actorId ?? null,
      action: e.action,
      targetType: e.targetType ?? null,
      targetId: e.targetId ?? null,
      metadata: e.metadata ? (scrubMetadata(e.metadata) as Prisma.InputJsonValue) : undefined,
      ip: e.ip ? e.ip.slice(0, 45) : null,
    },
  });
}
