import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import type { AppContext, DeviceIdentity } from '../../types.js';
import { AuditAction, writeAudit } from '../../services/audit.js';
import { EFFECTIVE_POLICY_ID, markDeviceAssignmentsSynced, recordDeviceSync, resolveEffectivePolicy, type EffectivePolicy } from '../../services/policyResolution.js';
import { normalizeMac } from '../../domain/mac.js';
import { generateDeviceToken, hashEnrollmentSecret } from '../../domain/deviceToken.js';
import { canonicalSha256 } from '../../domain/canonicalJson.js';
import { makePolicyEtag } from '../../domain/etag.js';
import { safeEqualHex, sha256Hex } from '../../utils/crypto.js';
import { AppError, conflict } from '../../utils/errors.js';
import type { ackBody, heartbeatBody, policyStatusBody, RegisterBody } from './agents.schemas.js';

const invalidRegistration = () => new AppError(401, 'INVALID_REGISTRATION_TOKEN', 'Invalid registration token');
const invalidEnrollment = () => new AppError(401, 'INVALID_ENROLLMENT', 'Unknown device or invalid enrollment secret');
const alreadyRegistered = () => new AppError(409, 'DEVICE_ALREADY_REGISTERED', 'device_uuid is already registered with a different enrollment secret or organization');
const deviceMismatch = () => new AppError(403, 'DEVICE_MISMATCH', 'device_uuid does not match the authenticated device');

// Placeholder compared against when the org is unknown / has no token, to keep timing uniform.
const NO_TOKEN_HASH = sha256Hex('no-registration-token-configured');

// ---------------- registration ----------------
export async function registerDevice(ctx: AppContext, token: string | undefined, body: RegisterBody, ip: string) {
  const { prisma, config } = ctx;
  const org = await prisma.organization.findUnique({ where: { code: body.organization_id } });
  const expected = org?.registrationTokenHash ?? (config.agentRegistrationToken ? sha256Hex(config.agentRegistrationToken) : null);
  const tokenOk = safeEqualHex(sha256Hex(token ?? ''), expected ?? NO_TOKEN_HASH);
  if (!token || !org || org.status !== 'ACTIVE' || !expected || !tokenOk) throw invalidRegistration();

  const facts = {
    hostname: body.hostname,
    windowsVersion: body.windows_version,
    agentVersion: body.agent_version,
    interfaces: body.interfaces as unknown as Prisma.InputJsonValue,
  };

  const existing = await prisma.device.findUnique({ where: { deviceUuid: body.device_uuid } });
  if (!existing) {
    // A computer an admin pre-added by MAC in the same organization picks up this registration.
    // The MAC is only an identifier: the device still goes to PENDING and needs admin approval.
    const macs = [...new Set(body.interfaces.map((i) => normalizeMac(i.mac ?? '')).filter((m): m is string => m !== null))];
    const pre = macs.length
      ? await prisma.device.findFirst({ where: { organizationId: org.id, status: 'PRE_REGISTERED', deviceUuid: null, macAddress: { in: macs } } })
      : null;
    if (pre) {
      const r = await prisma.device.updateMany({
        where: { id: pre.id, status: 'PRE_REGISTERED', deviceUuid: null },
        data: { deviceUuid: body.device_uuid, enrollmentSecretHash: body.enrollment_secret_hash, status: 'PENDING', ...facts },
      });
      if (r.count === 1) {
        await writeAudit(prisma, {
          organizationId: org.id,
          actorType: 'DEVICE',
          actorId: pre.id,
          action: AuditAction.DEVICE_REGISTERED,
          targetType: 'Device',
          targetId: pre.id,
          metadata: { device_uuid: body.device_uuid, hostname: body.hostname, agent_version: body.agent_version, matched_pre_registered_mac: pre.macAddress },
          ip,
        });
        return { code: 201, body: { device_id: pre.id, status: 'PENDING' } };
      }
    }
    try {
      const device = await prisma.device.create({
        data: { organizationId: org.id, deviceUuid: body.device_uuid, enrollmentSecretHash: body.enrollment_secret_hash, status: 'PENDING', ...facts },
      });
      await writeAudit(prisma, {
        organizationId: org.id,
        actorType: 'DEVICE',
        actorId: device.id,
        action: AuditAction.DEVICE_REGISTERED,
        targetType: 'Device',
        targetId: device.id,
        metadata: { device_uuid: device.deviceUuid, hostname: device.hostname, agent_version: device.agentVersion },
        ip,
      });
      return { code: 201, body: { device_id: device.id, status: device.status } };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw alreadyRegistered();
      throw e;
    }
  }

  if (existing.organizationId !== org.id) throw alreadyRegistered();

  if (existing.enrollmentSecretHash === null) {
    // Only a device that an admin reset via "re-enroll" (PENDING, no secret) may bind a new enrollment secret.
    if (existing.status !== 'PENDING') throw alreadyRegistered();
    const r = await prisma.device.updateMany({
      where: { id: existing.id, status: 'PENDING', enrollmentSecretHash: null },
      data: { enrollmentSecretHash: body.enrollment_secret_hash, ...facts },
    });
    if (r.count !== 1) throw alreadyRegistered();
    await writeAudit(prisma, {
      organizationId: org.id,
      actorType: 'DEVICE',
      actorId: existing.id,
      action: AuditAction.DEVICE_REGISTERED,
      targetType: 'Device',
      targetId: existing.id,
      metadata: { device_uuid: existing.deviceUuid, hostname: body.hostname, agent_version: body.agent_version, re_enrollment: true },
      ip,
    });
    return { code: 200, body: { device_id: existing.id, status: 'PENDING' } };
  }

  if (!safeEqualHex(existing.enrollmentSecretHash, body.enrollment_secret_hash)) throw alreadyRegistered();
  await prisma.device.update({ where: { id: existing.id }, data: facts });
  return { code: 200, body: { device_id: existing.id, status: existing.status } };
}

// ---------------- registration status / one-time credential claim ----------------
export async function registrationStatus(ctx: AppContext, deviceUuid: string, rawSecret: string, ip: string) {
  const { prisma, config } = ctx;
  const device = await prisma.device.findUnique({ where: { deviceUuid }, include: { organization: true } });
  const presented = hashEnrollmentSecret(rawSecret);
  const ok = safeEqualHex(presented, device?.enrollmentSecretHash ?? NO_TOKEN_HASH);
  if (!device || !device.enrollmentSecretHash || !ok) throw invalidEnrollment();
  if (device.organization.status !== 'ACTIVE') throw invalidEnrollment();

  if (device.status !== 'APPROVED') return { status: device.status };

  const now = new Date();
  const expiresAt = config.deviceCredentialTtlDays > 0 ? new Date(now.getTime() + config.deviceCredentialTtlDays * 86_400_000) : null;
  const claimed = await prisma.$transaction(async (tx) => {
    // Consume the enrollment secret first (conditional → exactly one concurrent poller wins).
    const consumed = await tx.device.updateMany({
      where: { id: device.id, status: 'APPROVED', enrollmentSecretHash: device.enrollmentSecretHash },
      data: { enrollmentSecretHash: null },
    });
    if (consumed.count !== 1) return null;
    let cred = await tx.deviceCredential.findFirst({
      where: { deviceId: device.id, claimedAt: null, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    cred ??= await tx.deviceCredential.create({ data: { deviceId: device.id, organizationId: device.organizationId } });
    const minted = generateDeviceToken(cred.id);
    const r = await tx.deviceCredential.updateMany({
      where: { id: cred.id, claimedAt: null, revokedAt: null },
      data: { secretHash: minted.secretHash, claimedAt: now, issuedAt: now, expiresAt },
    });
    if (r.count !== 1) return null;
    return { credentialId: cred.id, token: minted.token };
  });
  if (!claimed) throw invalidEnrollment();

  await writeAudit(prisma, {
    organizationId: device.organizationId,
    actorType: 'DEVICE',
    actorId: device.id,
    action: AuditAction.CREDENTIAL_CLAIMED,
    targetType: 'DeviceCredential',
    targetId: claimed.credentialId,
    metadata: { device_uuid: device.deviceUuid, credential_id: claimed.credentialId },
    ip,
  });
  return {
    status: 'APPROVED' as const,
    credential: {
      token: claimed.token,
      credential_id: claimed.credentialId,
      issued_at: now.toISOString(),
      expires_at: expiresAt ? expiresAt.toISOString() : null,
    },
  };
}

// ---------------- policy helpers ----------------
function policyRef(e: EffectivePolicy | null) {
  if (!e) return null;
  return { policy_id: EFFECTIVE_POLICY_ID, version: e.version, etag: makePolicyEtag(EFFECTIVE_POLICY_ID, e.version, e.contentSha256) };
}

export async function effectiveFor(ctx: AppContext, dev: DeviceIdentity) {
  return resolveEffectivePolicy(ctx.prisma, { id: dev.deviceId, organizationId: dev.organizationId });
}

// ---------------- heartbeat ----------------
export async function heartbeat(ctx: AppContext, dev: DeviceIdentity, body: z.infer<typeof heartbeatBody>, requestIp: string) {
  if (body.device_uuid !== dev.deviceUuid) throw deviceMismatch();
  const now = new Date();
  await ctx.prisma.device.update({
    where: { id: dev.deviceId },
    data: {
      lastHeartbeatAt: now,
      lastIp: body.current_ip,
      lastRequestIp: requestIp.slice(0, 45),
      agentVersion: body.agent_version,
      reportedStatus: body.status,
      currentPolicyVersion: body.current_policy_version,
      ...(body.current_policy_version === 0 ? { currentPolicyId: null } : {}),
    },
  });
  const effective = await effectiveFor(ctx, dev);
  return { server_time: now.toISOString(), heartbeat_interval_seconds: ctx.config.heartbeatIntervalSeconds, policy: policyRef(effective) };
}

export async function policyVersion(ctx: AppContext, dev: DeviceIdentity) {
  const e = await effectiveFor(ctx, dev);
  // The version check is how an up-to-date agent "checks in": record it for the console's Synced column.
  await recordDeviceSync(ctx.prisma, dev.deviceId, e?.contentSha256 ?? null);
  return policyRef(e) ?? { policy_id: null, version: 0, etag: null };
}

/** Build the §4 Policy Document for the authenticated device. Returns null when nothing applies. */
export async function policyDocument(ctx: AppContext, dev: DeviceIdentity) {
  const e = await effectiveFor(ctx, dev);
  await recordDeviceSync(ctx.prisma, dev.deviceId, e?.contentSha256 ?? null);
  if (!e) return null;
  const sha = e.contentSha256;
  if (canonicalSha256(e.content) !== sha) {
    // Stored content no longer hashes to its digest: never ship it.
    throw new AppError(500, 'INTERNAL_ERROR', 'Policy integrity check failed');
  }
  // Served either in full or as 304 (the device already has it): both mean it is synced.
  await markDeviceAssignmentsSynced(ctx.prisma, { id: dev.deviceId, organizationId: dev.organizationId }, e.sources.map((s) => s.policy_id));
  const etag = makePolicyEtag(EFFECTIVE_POLICY_ID, e.version, sha);
  return {
    etag,
    document: {
      schema_version: 1,
      policy_id: EFFECTIVE_POLICY_ID,
      version: e.version,
      organization_id: dev.organizationCode,
      device_uuid: dev.deviceUuid,
      assignment_scope: 'MERGED',
      published_at: e.updatedAt.toISOString(),
      content_sha256: sha,
      sources: e.sources.map((src) => ({ code: src.code, kind: src.kind, version: src.version, via: src.via })),
      content: e.content,
    },
  };
}

const FAILURE_STATES = new Set(['VALIDATION_FAILED', 'FAILED', 'ROLLED_BACK']);

export async function reportPolicyStatus(ctx: AppContext, dev: DeviceIdentity, body: z.infer<typeof policyStatusBody>, ip: string) {
  // Look up the reported policy strictly inside the device's own organization.
  const policy =
    body.policy_id === EFFECTIVE_POLICY_ID
      ? null
      : await ctx.prisma.policy.findUnique({ where: { organizationId_code: { organizationId: dev.organizationId, code: body.policy_id } } });
  const version = policy
    ? await ctx.prisma.policyVersion.findUnique({ where: { policyId_version: { policyId: policy.id, version: body.version } } })
    : null;
  const data = {
    policyCode: body.policy_id,
    policyId: policy?.id ?? null,
    policyVersionId: version?.id ?? null,
    version: body.version,
    status: body.status,
    errorCode: body.error_code ?? null,
    message: body.message ?? null,
    activePolicyCode: body.active_policy_id ?? null,
    activeVersion: body.active_version ?? null,
  };
  await ctx.prisma.devicePolicyStatus.upsert({ where: { deviceId: dev.deviceId }, create: { deviceId: dev.deviceId, ...data }, update: data });
  if (FAILURE_STATES.has(body.status) || body.error_code) {
    await writeAudit(ctx.prisma, {
      organizationId: dev.organizationId,
      actorType: 'DEVICE',
      actorId: dev.deviceId,
      action: AuditAction.POLICY_APPLICATION_FAILED,
      targetType: 'Device',
      targetId: dev.deviceId,
      metadata: {
        device_uuid: dev.deviceUuid,
        policy_code: body.policy_id,
        version: body.version,
        status: body.status,
        error_code: body.error_code ?? null,
        message: body.message ? body.message.slice(0, 300) : null,
        active_policy_code: body.active_policy_id ?? null,
        active_version: body.active_version ?? null,
      },
      ip,
    });
  }
}

export async function ackPolicy(ctx: AppContext, dev: DeviceIdentity, body: z.infer<typeof ackBody>, ip: string) {
  const e = await effectiveFor(ctx, dev);
  if (!e || body.policy_id !== EFFECTIVE_POLICY_ID || e.version !== body.version || !safeEqualHex(e.contentSha256, body.content_sha256)) {
    throw conflict('POLICY_MISMATCH', 'The acknowledged policy version is not the one currently assigned to this device');
  }
  const data = {
    policyCode: EFFECTIVE_POLICY_ID,
    policyId: null,
    policyVersionId: null,
    version: e.version,
    status: 'APPLIED' as const,
    errorCode: null,
    message: null,
    activePolicyCode: EFFECTIVE_POLICY_ID,
    activeVersion: e.version,
  };
  await ctx.prisma.$transaction([
    ctx.prisma.devicePolicyStatus.upsert({ where: { deviceId: dev.deviceId }, create: { deviceId: dev.deviceId, ...data }, update: data }),
    ctx.prisma.device.update({ where: { id: dev.deviceId }, data: { currentPolicyId: null, currentPolicyVersion: e.version } }),
  ]);
  await writeAudit(ctx.prisma, {
    organizationId: dev.organizationId,
    actorType: 'DEVICE',
    actorId: dev.deviceId,
    action: AuditAction.POLICY_APPLIED,
    targetType: 'Device',
    targetId: dev.deviceId,
    metadata: { device_uuid: dev.deviceUuid, policy_code: EFFECTIVE_POLICY_ID, version: e.version, sources: e.sources.map((x) => `${x.code}@${x.version}`) },
    ip,
  });
}

// ---------------- organization service (access-token) policy ----------------
import { markOrgAssignmentsSynced, resolveOrgEffectivePolicy } from '../../services/policyResolution.js';
import { parseAccessTokenBearer } from '../../domain/deviceToken.js';

const invalidAccess = () => new AppError(401, 'INVALID_ACCESS_TOKEN', 'Invalid or revoked organization access token');

/** Resolve the organization for a service access token (Bearer nat_...). Rotating the token revokes it. */
export async function authOrgAccessToken(ctx: AppContext, authorization: string | undefined) {
  const token = parseAccessTokenBearer(authorization);
  if (!token) throw invalidAccess();
  const org = await ctx.prisma.organization.findUnique({ where: { accessTokenHash: sha256Hex(token) } });
  if (!org || org.status !== 'ACTIVE') throw invalidAccess();
  return org;
}

/** Merged organization-wide policy document for a token-authenticated service (SoftProIt.network.conducted). */
export async function orgPolicyDocument(ctx: AppContext, org: { id: string; code: string }) {
  const e = await resolveOrgEffectivePolicy(ctx.prisma, org.id);
  if (!e) return null;
  if (canonicalSha256(e.content) !== e.contentSha256) throw new AppError(500, 'INTERNAL_ERROR', 'Policy integrity check failed');
  // Served either in full or as 304 (the service already has it): both mean it is synced.
  await markOrgAssignmentsSynced(ctx.prisma, org.id, e.sources.map((s) => s.policy_id));
  const etag = makePolicyEtag(EFFECTIVE_POLICY_ID, e.version, e.contentSha256);
  return {
    etag,
    document: {
      schema_version: 1,
      policy_id: EFFECTIVE_POLICY_ID,
      version: e.version,
      organization_id: org.code,
      assignment_scope: 'ORGANIZATION',
      published_at: e.updatedAt.toISOString(),
      content_sha256: e.contentSha256,
      sources: e.sources.map((s) => ({ code: s.code, kind: s.kind, version: s.version, via: s.via })),
      content: e.content,
    },
  };
}
