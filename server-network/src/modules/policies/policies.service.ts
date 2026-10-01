import type { Policy, PolicyAssignment, PolicyVersion, Prisma, RestrictionKind } from '@prisma/client';
import { z } from 'zod';
import type { AppContext } from '../../types.js';
import type { AdminPrincipal } from '../../domain/rbac.js';
import { assertOrgAccess, createScope, listScope } from '../../domain/rbac.js';
import { type PolicyContent, validatePolicyContent } from '../../domain/policyContent.js';
import { canonicalSha256 } from '../../domain/canonicalJson.js';
import { decide } from '../../domain/domainPattern.js';
import { makePolicyEtag } from '../../domain/etag.js';
import { AuditAction, type AuditActionName, writeAudit } from '../../services/audit.js';
import { badRequest, conflict, notFound } from '../../utils/errors.js';
import { iso, POLICY_CODE_RE } from '../../utils/http.js';
import { markPolicyUnsynced } from '../../services/policyResolution.js';

// ---------- schemas ----------
export const createPolicyBody = z
  .object({
    organization_id: z.string().max(64).optional(),
    code: z.string().trim().toUpperCase().regex(POLICY_CODE_RE, 'Must match ^[A-Z0-9][A-Z0-9-]{1,31}$').optional(),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullish(),
    kind: z.enum(['ALLOW_ONLY', 'BLACKLIST', 'REDIRECT']).default('BLACKLIST'),
    content: z.unknown().optional(),
    /** Publish version 1 immediately (the console's simple "save" flow). */
    publish: z.boolean().default(false),
  })
  .strict();
export const saveContentBody = z.object({ content: z.unknown() }).strict();
export const orgAssignmentsQuery = z.object({ organization_id: z.string().max(64).optional() });
export const bulkAssignBody = z
  .object({
    policy_id: z.string().min(1).max(64),
    organization: z.boolean().default(false),
    group_ids: z.array(z.string().min(1).max(64)).max(500).default([]),
    device_ids: z.array(z.string().min(1).max(64)).max(1000).default([]),
  })
  .strict()
  .refine((b) => b.organization || b.group_ids.length > 0 || b.device_ids.length > 0, 'Nothing to assign');
export const updatePolicyBody = z
  .object({ name: z.string().trim().min(1).max(200).optional(), description: z.string().trim().max(2000).nullish() })
  .strict();
export const listPoliciesQuery = z.object({ organization_id: z.string().max(64).optional() });
export const versionParams = z.object({ id: z.string().min(1).max(64), version: z.coerce.number().int().min(1).max(1_000_000) });
export const draftBody = z.object({ content: z.unknown() }).strict();
export const newVersionBody = z.object({ from_version: z.number().int().min(1).optional() }).strict();
export const rollbackBody = z.object({ version: z.number().int().min(1) }).strict();
export const validateBody = z
  .object({ content: z.unknown(), names: z.array(z.string().max(300)).max(200).optional(), organization_id: z.string().max(64).optional() })
  .strict();
export const createAssignmentBody = z
  .object({
    scope: z.enum(['ORGANIZATION', 'GROUP', 'DEVICE']),
    target_group_id: z.string().min(1).max(64).nullish(),
    target_device_id: z.string().min(1).max(64).nullish(),
    priority: z.number().int().min(-1000).max(1000).default(0),
  })
  .strict();
export const assignmentParams = z.object({ id: z.string().min(1).max(64), assignmentId: z.string().min(1).max(64) });

// ---------- serialization ----------
type PolicyWithActive = Policy & { activeVersion: PolicyVersion | null; organization?: { code: string } };

export function serializeVersion(v: PolicyVersion, policy: Policy, includeContent = true) {
  return {
    id: v.id,
    version: v.version,
    status: v.status,
    is_active_version: policy.activeVersionId === v.id,
    ...(includeContent ? { content: v.content } : {}),
    content_sha256: v.contentSha256,
    etag: v.contentSha256 ? makePolicyEtag(policy.code, v.version, v.contentSha256) : null,
    published_at: iso(v.publishedAt),
    published_by_id: v.publishedById,
    created_at: iso(v.createdAt),
    updated_at: iso(v.updatedAt),
  };
}

export function serializePolicy(p: PolicyWithActive) {
  return {
    id: p.id,
    organization_id: p.organizationId,
    organization_code: p.organization?.code ?? undefined,
    code: p.code,
    name: p.name,
    description: p.description,
    kind: p.kind,
    is_active: p.isActive,
    active_version: p.activeVersion ? p.activeVersion.version : null,
    created_at: iso(p.createdAt),
    updated_at: iso(p.updatedAt),
  };
}

function serializeAssignment(a: PolicyAssignment) {
  return {
    id: a.id,
    policy_id: a.policyId,
    organization_id: a.organizationId,
    scope: a.scope,
    target_group_id: a.targetGroupId,
    target_device_id: a.targetDeviceId,
    priority: a.priority,
    /** a background service has fetched a policy containing this restriction since it last changed */
    synced: a.synced,
    created_by_id: a.createdById,
    created_at: iso(a.createdAt),
  };
}

// ---------- helpers ----------
/** Which content lists a restriction of each kind may use; the others must stay empty. */
const KIND_FIELDS: Record<RestrictionKind, { label: string; fields: ('allowed_domains' | 'blocked_domains' | 'blocked_ips' | 'redirect_rules')[] }> = {
  ALLOW_ONLY: { label: 'Allow Only', fields: ['allowed_domains'] },
  BLACKLIST: { label: 'Black List', fields: ['blocked_domains', 'blocked_ips'] },
  REDIRECT: { label: 'Redirection', fields: ['redirect_rules'] },
};

function validatedContentOrThrow(ctx: AppContext, input: unknown, kind: RestrictionKind) {
  const r = validatePolicyContent(input, ctx.config.managementHostnames);
  if (!r.valid || !r.content) throw badRequest('Restriction content is invalid', r.errors);
  const allowed = KIND_FIELDS[kind];
  const errors = (['allowed_domains', 'blocked_domains', 'blocked_ips', 'redirect_rules'] as const)
    .filter((f) => !allowed.fields.includes(f) && (r.content![f]?.length ?? 0) > 0)
    .map((f) => ({ path: f, message: `${allowed.label} restrictions cannot use ${f}` }));
  if (errors.length) throw badRequest('Restriction content does not match its type', errors);
  return r;
}

async function loadPolicy(ctx: AppContext, p: AdminPrincipal, id: string) {
  const policy = await ctx.prisma.policy.findUnique({ where: { id }, include: { activeVersion: true, organization: { select: { code: true } } } });
  return assertOrgAccess(p, policy, 'Policy');
}

async function loadVersion(ctx: AppContext, policyId: string, version: number) {
  const v = await ctx.prisma.policyVersion.findUnique({ where: { policyId_version: { policyId, version } } });
  if (!v) throw notFound('Policy version not found');
  return v;
}

async function audit(ctx: AppContext, p: AdminPrincipal, policy: Policy, action: AuditActionName, ip: string, meta: Record<string, unknown> = {}) {
  await writeAudit(ctx.prisma, {
    organizationId: policy.organizationId,
    actorType: 'USER',
    actorId: p.userId,
    action,
    targetType: 'Policy',
    targetId: policy.id,
    metadata: { policy_code: policy.code, ...meta },
    ip,
  });
}

async function nextPolicyCode(ctx: AppContext, organizationId: string): Promise<string> {
  const codes = await ctx.prisma.policy.findMany({ where: { organizationId }, select: { code: true } });
  let max = 0;
  for (const { code } of codes) {
    const m = /^POL-(\d+)$/.exec(code);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `POL-${String(max + 1).padStart(3, '0')}`;
}

// ---------- policies ----------
export async function listPolicies(ctx: AppContext, p: AdminPrincipal, q: z.infer<typeof listPoliciesQuery>) {
  const orgId = listScope(p, q.organization_id);
  const items = await ctx.prisma.policy.findMany({
    where: orgId ? { organizationId: orgId } : {},
    include: { activeVersion: true, organization: { select: { code: true } } },
    orderBy: [{ organizationId: 'asc' }, { code: 'asc' }],
  });
  return { items: items.map(serializePolicy) };
}

export async function getPolicy(ctx: AppContext, p: AdminPrincipal, id: string) {
  const policy = await loadPolicy(ctx, p, id);
  const [versions, assignments] = await Promise.all([
    ctx.prisma.policyVersion.findMany({ where: { policyId: id }, orderBy: { version: 'desc' } }),
    ctx.prisma.policyAssignment.findMany({ where: { policyId: id }, orderBy: { createdAt: 'desc' } }),
  ]);
  return {
    ...serializePolicy(policy),
    versions: versions.map((v) => serializeVersion(v, policy, false)),
    assignments: assignments.map(serializeAssignment),
  };
}

export async function createPolicy(ctx: AppContext, p: AdminPrincipal, body: z.infer<typeof createPolicyBody>, ip: string) {
  const orgId = createScope(p, body.organization_id);
  if (!(await ctx.prisma.organization.findUnique({ where: { id: orgId } }))) throw notFound('Organization not found');
  const validated = validatedContentOrThrow(ctx, body.content ?? {}, body.kind);
  const code = body.code ?? (await nextPolicyCode(ctx, orgId));
  if (await ctx.prisma.policy.findUnique({ where: { organizationId_code: { organizationId: orgId, code } } })) {
    throw conflict('POLICY_CODE_IN_USE', 'A policy with this code already exists in the organization');
  }
  const policy = await ctx.prisma.$transaction(async (tx) => {
    const created = await tx.policy.create({ data: { organizationId: orgId, code, name: body.name, description: body.description ?? null, kind: body.kind } });
    const content = validated.content as unknown as Prisma.InputJsonValue;
    const v = await tx.policyVersion.create({
      data: body.publish
        ? { policyId: created.id, version: 1, status: 'PUBLISHED', content, contentSha256: validated.content_sha256, publishedAt: new Date(), publishedById: p.userId }
        : { policyId: created.id, version: 1, status: 'DRAFT', content },
    });
    if (body.publish) await tx.policy.update({ where: { id: created.id }, data: { activeVersionId: v.id } });
    return created;
  });
  await audit(ctx, p, policy, AuditAction.POLICY_CREATED, ip, { name: policy.name, kind: policy.kind });
  if (body.publish) await audit(ctx, p, policy, AuditAction.POLICY_PUBLISHED, ip, { version: 1, content_sha256: validated.content_sha256 });
  return { ...(await getPolicy(ctx, p, policy.id)), warnings: validated.warnings };
}

export async function updatePolicy(ctx: AppContext, p: AdminPrincipal, id: string, body: z.infer<typeof updatePolicyBody>, ip: string) {
  const policy = await loadPolicy(ctx, p, id);
  await ctx.prisma.policy.update({ where: { id: policy.id }, data: { name: body.name, description: body.description } });
  await audit(ctx, p, policy, AuditAction.POLICY_UPDATED, ip, { changed: Object.keys(body) });
  return getPolicy(ctx, p, id);
}

export async function setPolicyActive(ctx: AppContext, p: AdminPrincipal, id: string, active: boolean, ip: string) {
  const policy = await loadPolicy(ctx, p, id);
  await ctx.prisma.policy.update({ where: { id: policy.id }, data: { isActive: active } });
  await markPolicyUnsynced(ctx.prisma, policy.id); // agents must pick up the (de)activation
  await audit(ctx, p, policy, active ? AuditAction.POLICY_ACTIVATED : AuditAction.POLICY_DEACTIVATED, ip);
  return getPolicy(ctx, p, id);
}

// ---------- versions ----------
export async function listVersions(ctx: AppContext, p: AdminPrincipal, id: string) {
  const policy = await loadPolicy(ctx, p, id);
  const versions = await ctx.prisma.policyVersion.findMany({ where: { policyId: id }, orderBy: { version: 'desc' } });
  return { items: versions.map((v) => serializeVersion(v, policy, false)) };
}

export async function getVersion(ctx: AppContext, p: AdminPrincipal, id: string, version: number) {
  const policy = await loadPolicy(ctx, p, id);
  return serializeVersion(await loadVersion(ctx, id, version), policy);
}

/** New version = copy of the latest (or `from_version`) as DRAFT with version = max + 1. One draft at a time. */
export async function createDraftVersion(ctx: AppContext, p: AdminPrincipal, id: string, body: z.infer<typeof newVersionBody>, ip: string) {
  const policy = await loadPolicy(ctx, p, id);
  const existingDraft = await ctx.prisma.policyVersion.findFirst({ where: { policyId: id, status: 'DRAFT' } });
  if (existingDraft) throw conflict('DRAFT_EXISTS', `Version ${existingDraft.version} is already a draft; edit or publish it first`);
  const latest = await ctx.prisma.policyVersion.findFirst({ where: { policyId: id }, orderBy: { version: 'desc' } });
  const source = body.from_version ? await loadVersion(ctx, id, body.from_version) : latest;
  const nextVersion = (latest?.version ?? 0) + 1;
  const v = await ctx.prisma.policyVersion.create({
    data: { policyId: id, version: nextVersion, status: 'DRAFT', content: (source?.content ?? validatedContentOrThrow(ctx, {}, policy.kind).content) as Prisma.InputJsonValue },
  });
  await audit(ctx, p, policy, AuditAction.POLICY_DRAFT_CREATED, ip, { version: nextVersion, from_version: source?.version ?? null });
  return serializeVersion(v, policy);
}

/** Only DRAFT versions are editable; PUBLISHED/ARCHIVED are immutable (enforced here and by a conditional update). */
export async function updateDraft(ctx: AppContext, p: AdminPrincipal, id: string, version: number, content: unknown, ip: string) {
  const policy = await loadPolicy(ctx, p, id);
  const v = await loadVersion(ctx, id, version);
  if (v.status !== 'DRAFT') throw conflict('POLICY_VERSION_IMMUTABLE', `Version ${version} is ${v.status} and cannot be modified; create a new version`);
  const validated = validatedContentOrThrow(ctx, content, policy.kind);
  const r = await ctx.prisma.policyVersion.updateMany({
    where: { id: v.id, status: 'DRAFT' },
    data: { content: validated.content as unknown as Prisma.InputJsonValue },
  });
  if (r.count !== 1) throw conflict('POLICY_VERSION_IMMUTABLE', 'Version is no longer a draft');
  await audit(ctx, p, policy, AuditAction.POLICY_DRAFT_UPDATED, ip, { version });
  return { ...serializeVersion(await loadVersion(ctx, id, version), policy), warnings: validated.warnings };
}

export async function validateVersion(ctx: AppContext, p: AdminPrincipal, id: string, version: number) {
  await loadPolicy(ctx, p, id);
  const v = await loadVersion(ctx, id, version);
  return validatePolicyContent(v.content, ctx.config.managementHostnames);
}

/** Ad-hoc validation + decision preview for arbitrary names (no persistence). */
export function validateAdhoc(ctx: AppContext, body: z.infer<typeof validateBody>) {
  const r = validatePolicyContent(body.content, ctx.config.managementHostnames);
  const decisions = r.content && body.names ? body.names.map((name) => ({ name, ...decide(name, r.content as PolicyContent, ctx.config.managementHostnames) })) : undefined;
  return { ...r, ...(decisions ? { decisions } : {}) };
}

export async function publishVersion(ctx: AppContext, p: AdminPrincipal, id: string, version: number, ip: string) {
  const policy = await loadPolicy(ctx, p, id);
  const v = await loadVersion(ctx, id, version);
  if (v.status !== 'DRAFT') throw conflict('POLICY_VERSION_IMMUTABLE', `Version ${version} is ${v.status}; only drafts can be published`);
  const validated = validatedContentOrThrow(ctx, v.content, policy.kind);
  const content = validated.content!;
  const sha = canonicalSha256(content);
  const now = new Date();
  await ctx.prisma.$transaction(async (tx) => {
    const r = await tx.policyVersion.updateMany({
      where: { id: v.id, status: 'DRAFT' },
      data: { status: 'PUBLISHED', content: content as unknown as Prisma.InputJsonValue, contentSha256: sha, publishedAt: now, publishedById: p.userId },
    });
    if (r.count !== 1) throw conflict('POLICY_VERSION_IMMUTABLE', 'Version is no longer a draft');
    await tx.policy.update({ where: { id: policy.id }, data: { activeVersionId: v.id } });
    await markPolicyUnsynced(tx, policy.id); // agents must fetch the new version
  });
  await audit(ctx, p, policy, AuditAction.POLICY_PUBLISHED, ip, { version, content_sha256: sha, previous_active_version: policy.activeVersion?.version ?? null });
  return { ...serializeVersion(await loadVersion(ctx, id, version), { ...policy, activeVersionId: v.id }), warnings: validated.warnings };
}

export async function archiveVersion(ctx: AppContext, p: AdminPrincipal, id: string, version: number, ip: string) {
  const policy = await loadPolicy(ctx, p, id);
  const v = await loadVersion(ctx, id, version);
  if (policy.activeVersionId === v.id) throw conflict('VERSION_IS_ACTIVE', 'The active version cannot be archived; roll back or publish another version first');
  if (v.status === 'ARCHIVED') throw conflict('INVALID_VERSION_STATE', 'Version is already archived');
  await ctx.prisma.policyVersion.update({ where: { id: v.id }, data: { status: 'ARCHIVED' } });
  await audit(ctx, p, policy, AuditAction.POLICY_VERSION_ARCHIVED, ip, { version });
  return serializeVersion(await loadVersion(ctx, id, version), policy);
}

/** Rollback: point activeVersionId at another (earlier) PUBLISHED version. Agents accept lower versions. */
/**
 * Permanently delete a restriction with all its versions and assignments (same permission as editing
 * it). Device status rows keep their history with the policy link cleared (SetNull). Agents get the
 * re-merged policy on their next fetch; the audit log keeps the deletion with code/name/counts.
 */
export async function deletePolicy(ctx: AppContext, p: AdminPrincipal, id: string, ip: string) {
  const policy = await loadPolicy(ctx, p, id);
  const counts = await ctx.prisma.$transaction(async (tx) => {
    const assignments = await tx.policyAssignment.deleteMany({ where: { policyId: policy.id } });
    // Versions are Restrict-protected and one is referenced as active: unlink it first.
    await tx.policy.update({ where: { id: policy.id }, data: { activeVersionId: null } });
    const versions = await tx.policyVersion.deleteMany({ where: { policyId: policy.id } });
    await tx.policy.delete({ where: { id: policy.id } });
    return { assignments: assignments.count, versions: versions.count };
  });
  await audit(ctx, p, policy, AuditAction.POLICY_DELETED, ip, { name: policy.name, kind: policy.kind, ...counts });
  return { id: policy.id, code: policy.code, ...counts };
}

export async function rollbackPolicy(ctx: AppContext, p: AdminPrincipal, id: string, targetVersion: number, ip: string) {
  const policy = await loadPolicy(ctx, p, id);
  const target = await loadVersion(ctx, id, targetVersion);
  if (target.status !== 'PUBLISHED') throw conflict('INVALID_VERSION_STATE', `Version ${targetVersion} is ${target.status}; only PUBLISHED versions can be activated`);
  if (policy.activeVersionId === target.id) throw conflict('VERSION_IS_ACTIVE', `Version ${targetVersion} is already active`);
  if (policy.activeVersion && target.version > policy.activeVersion.version) {
    throw conflict('INVALID_VERSION_STATE', 'Rollback target must be earlier than the active version');
  }
  await ctx.prisma.policy.update({ where: { id: policy.id }, data: { activeVersionId: target.id } });
  await markPolicyUnsynced(ctx.prisma, policy.id); // agents must fetch the rolled-back version
  await audit(ctx, p, policy, AuditAction.POLICY_ROLLED_BACK, ip, { from_version: policy.activeVersion?.version ?? null, to_version: targetVersion });
  return getPolicy(ctx, p, id);
}

/**
 * Simple "save" for the console: the content becomes a new PUBLISHED version and is activated at
 * once (published versions stay immutable; history is kept). An open draft is replaced.
 */
export async function saveAndPublish(ctx: AppContext, p: AdminPrincipal, id: string, input: unknown, ip: string) {
  const policy = await loadPolicy(ctx, p, id);
  const validated = validatedContentOrThrow(ctx, input, policy.kind);
  if (policy.activeVersion?.contentSha256 === validated.content_sha256) return { ...(await getPolicy(ctx, p, id)), warnings: validated.warnings, unchanged: true };
  const now = new Date();
  const version = await ctx.prisma.$transaction(async (tx) => {
    await tx.policyVersion.deleteMany({ where: { policyId: policy.id, status: 'DRAFT' } });
    const latest = await tx.policyVersion.findFirst({ where: { policyId: policy.id }, orderBy: { version: 'desc' } });
    const v = await tx.policyVersion.create({
      data: {
        policyId: policy.id,
        version: (latest?.version ?? 0) + 1,
        status: 'PUBLISHED',
        content: validated.content as unknown as Prisma.InputJsonValue,
        contentSha256: validated.content_sha256,
        publishedAt: now,
        publishedById: p.userId,
      },
    });
    await tx.policy.update({ where: { id: policy.id }, data: { activeVersionId: v.id } });
    await markPolicyUnsynced(tx, policy.id); // agents must fetch the new version
    return v.version;
  });
  await audit(ctx, p, policy, AuditAction.POLICY_PUBLISHED, ip, { version, content_sha256: validated.content_sha256, previous_active_version: policy.activeVersion?.version ?? null });
  return { ...(await getPolicy(ctx, p, id)), warnings: validated.warnings, unchanged: false };
}

// ---------- assignments ----------
/** Every assignment in the organization (Set access page), with its restriction and target names. */
export async function listOrgAssignments(ctx: AppContext, p: AdminPrincipal, q: z.infer<typeof orgAssignmentsQuery>) {
  const orgId = listScope(p, q.organization_id);
  const items = await ctx.prisma.policyAssignment.findMany({
    where: orgId ? { organizationId: orgId } : {},
    include: {
      policy: { select: { id: true, code: true, name: true, kind: true, isActive: true } },
      targetGroup: { select: { id: true, name: true } },
      targetDevice: { select: { id: true, displayName: true, hostname: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  return {
    items: items.map((a) => ({
      ...serializeAssignment(a),
      policy: { id: a.policy.id, code: a.policy.code, name: a.policy.name, kind: a.policy.kind, is_active: a.policy.isActive },
      target_name: a.scope === 'GROUP' ? a.targetGroup?.name : a.scope === 'DEVICE' ? (a.targetDevice?.displayName ?? a.targetDevice?.hostname ?? null) : null,
    })),
  };
}

/** Drag-and-drop target: assign one restriction to the organization, groups and/or computers. Idempotent. */
export async function bulkAssign(ctx: AppContext, p: AdminPrincipal, body: z.infer<typeof bulkAssignBody>, ip: string) {
  const policy = await loadPolicy(ctx, p, body.policy_id);
  const created: PolicyAssignment[] = [];
  const add = async (scope: 'ORGANIZATION' | 'GROUP' | 'DEVICE', target: { target_group_id?: string; target_device_id?: string }) => {
    const exists = await ctx.prisma.policyAssignment.findFirst({
      where: { policyId: policy.id, scope, targetGroupId: target.target_group_id ?? null, targetDeviceId: target.target_device_id ?? null },
    });
    if (!exists) created.push(await createAssignmentRow(ctx, p, policy, { scope, ...target, priority: 0 }, ip));
  };
  if (body.organization) await add('ORGANIZATION', {});
  for (const g of new Set(body.group_ids)) await add('GROUP', { target_group_id: g });
  for (const d of new Set(body.device_ids)) await add('DEVICE', { target_device_id: d });
  return { created: created.map(serializeAssignment) };
}

export async function listAssignments(ctx: AppContext, p: AdminPrincipal, id: string) {
  await loadPolicy(ctx, p, id);
  const items = await ctx.prisma.policyAssignment.findMany({ where: { policyId: id }, orderBy: { createdAt: 'desc' } });
  return { items: items.map(serializeAssignment) };
}

/** Targets must belong to the policy's organization; anything else is rejected (cross-org). */
export async function createAssignment(ctx: AppContext, p: AdminPrincipal, id: string, body: z.infer<typeof createAssignmentBody>, ip: string) {
  const policy = await loadPolicy(ctx, p, id);
  const dup = await ctx.prisma.policyAssignment.findFirst({
    where: { policyId: policy.id, scope: body.scope, targetGroupId: body.target_group_id ?? null, targetDeviceId: body.target_device_id ?? null },
  });
  if (dup) throw conflict('ALREADY_ASSIGNED', 'This restriction is already assigned to that target');
  return serializeAssignment(await createAssignmentRow(ctx, p, policy, body, ip));
}

async function createAssignmentRow(
  ctx: AppContext,
  p: AdminPrincipal,
  policy: Policy,
  body: { scope: 'ORGANIZATION' | 'GROUP' | 'DEVICE'; target_group_id?: string | null; target_device_id?: string | null; priority: number },
  ip: string,
) {
  let targetGroupId: string | null = null;
  let targetDeviceId: string | null = null;
  if (body.scope === 'ORGANIZATION') {
    if (body.target_group_id || body.target_device_id) throw badRequest('ORGANIZATION assignments take no target');
  } else if (body.scope === 'GROUP') {
    if (!body.target_group_id || body.target_device_id) throw badRequest('GROUP assignments require target_group_id only', [{ path: 'target_group_id', message: 'Required' }]);
    const g = await ctx.prisma.deviceGroup.findFirst({ where: { id: body.target_group_id, organizationId: policy.organizationId } });
    if (!g) throw badRequest('Target group not found in the policy organization', [{ path: 'target_group_id', message: 'Unknown group' }]);
    targetGroupId = g.id;
  } else {
    if (!body.target_device_id || body.target_group_id) throw badRequest('DEVICE assignments require target_device_id only', [{ path: 'target_device_id', message: 'Required' }]);
    const d = await ctx.prisma.device.findFirst({ where: { id: body.target_device_id, organizationId: policy.organizationId } });
    if (!d) throw badRequest('Target device not found in the policy organization', [{ path: 'target_device_id', message: 'Unknown device' }]);
    targetDeviceId = d.id;
  }
  const a = await ctx.prisma.policyAssignment.create({
    data: { policyId: policy.id, organizationId: policy.organizationId, scope: body.scope, targetGroupId, targetDeviceId, priority: body.priority, createdById: p.userId },
  });
  await audit(ctx, p, policy, AuditAction.POLICY_ASSIGNED, ip, { assignment_id: a.id, scope: a.scope, target_group_id: targetGroupId, target_device_id: targetDeviceId, priority: a.priority });
  return a;
}

export async function deleteAssignment(ctx: AppContext, p: AdminPrincipal, id: string, assignmentId: string, ip: string) {
  const policy = await loadPolicy(ctx, p, id);
  const a = await ctx.prisma.policyAssignment.findFirst({ where: { id: assignmentId, policyId: policy.id } });
  if (!a) throw notFound('Assignment not found');
  await ctx.prisma.policyAssignment.delete({ where: { id: a.id } });
  await audit(ctx, p, policy, AuditAction.POLICY_UNASSIGNED, ip, { assignment_id: a.id, scope: a.scope });
}

