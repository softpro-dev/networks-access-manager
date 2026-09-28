import type { Policy, PolicyAssignment, PolicyVersion, Prisma } from '@prisma/client';
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

// ---------- schemas ----------
export const createPolicyBody = z
  .object({
    organization_id: z.string().max(64).optional(),
    code: z.string().trim().toUpperCase().regex(POLICY_CODE_RE, 'Must match ^[A-Z0-9][A-Z0-9-]{1,31}$').optional(),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullish(),
    content: z.unknown().optional(),
  })
  .strict();
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
    created_by_id: a.createdById,
    created_at: iso(a.createdAt),
  };
}

// ---------- helpers ----------
function validatedContentOrThrow(ctx: AppContext, input: unknown) {
  const r = validatePolicyContent(input, ctx.config.managementHostnames);
  if (!r.valid || !r.content) throw badRequest('Policy content is invalid', r.errors);
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
  const validated = validatedContentOrThrow(ctx, body.content ?? {});
  const code = body.code ?? (await nextPolicyCode(ctx, orgId));
  if (await ctx.prisma.policy.findUnique({ where: { organizationId_code: { organizationId: orgId, code } } })) {
    throw conflict('POLICY_CODE_IN_USE', 'A policy with this code already exists in the organization');
  }
  const policy = await ctx.prisma.$transaction(async (tx) => {
    const created = await tx.policy.create({ data: { organizationId: orgId, code, name: body.name, description: body.description ?? null } });
    await tx.policyVersion.create({ data: { policyId: created.id, version: 1, status: 'DRAFT', content: validated.content as unknown as Prisma.InputJsonValue } });
    return created;
  });
  await audit(ctx, p, policy, AuditAction.POLICY_CREATED, ip, { name: policy.name });
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
    data: { policyId: id, version: nextVersion, status: 'DRAFT', content: (source?.content ?? validatedContentOrThrow(ctx, {}).content) as Prisma.InputJsonValue },
  });
  await audit(ctx, p, policy, AuditAction.POLICY_DRAFT_CREATED, ip, { version: nextVersion, from_version: source?.version ?? null });
  return serializeVersion(v, policy);
}

/** Only DRAFT versions are editable; PUBLISHED/ARCHIVED are immutable (enforced here and by a conditional update). */
export async function updateDraft(ctx: AppContext, p: AdminPrincipal, id: string, version: number, content: unknown, ip: string) {
  const policy = await loadPolicy(ctx, p, id);
  const v = await loadVersion(ctx, id, version);
  if (v.status !== 'DRAFT') throw conflict('POLICY_VERSION_IMMUTABLE', `Version ${version} is ${v.status} and cannot be modified; create a new version`);
  const validated = validatedContentOrThrow(ctx, content);
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
  const validated = validatedContentOrThrow(ctx, v.content);
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
export async function rollbackPolicy(ctx: AppContext, p: AdminPrincipal, id: string, targetVersion: number, ip: string) {
  const policy = await loadPolicy(ctx, p, id);
  const target = await loadVersion(ctx, id, targetVersion);
  if (target.status !== 'PUBLISHED') throw conflict('INVALID_VERSION_STATE', `Version ${targetVersion} is ${target.status}; only PUBLISHED versions can be activated`);
  if (policy.activeVersionId === target.id) throw conflict('VERSION_IS_ACTIVE', `Version ${targetVersion} is already active`);
  if (policy.activeVersion && target.version > policy.activeVersion.version) {
    throw conflict('INVALID_VERSION_STATE', 'Rollback target must be earlier than the active version');
  }
  await ctx.prisma.policy.update({ where: { id: policy.id }, data: { activeVersionId: target.id } });
  await audit(ctx, p, policy, AuditAction.POLICY_ROLLED_BACK, ip, { from_version: policy.activeVersion?.version ?? null, to_version: targetVersion });
  return getPolicy(ctx, p, id);
}

// ---------- assignments ----------
export async function listAssignments(ctx: AppContext, p: AdminPrincipal, id: string) {
  await loadPolicy(ctx, p, id);
  const items = await ctx.prisma.policyAssignment.findMany({ where: { policyId: id }, orderBy: { createdAt: 'desc' } });
  return { items: items.map(serializeAssignment) };
}

/** Targets must belong to the policy's organization; anything else is rejected (cross-org). */
export async function createAssignment(ctx: AppContext, p: AdminPrincipal, id: string, body: z.infer<typeof createAssignmentBody>, ip: string) {
  const policy = await loadPolicy(ctx, p, id);
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
  return serializeAssignment(a);
}

export async function deleteAssignment(ctx: AppContext, p: AdminPrincipal, id: string, assignmentId: string, ip: string) {
  const policy = await loadPolicy(ctx, p, id);
  const a = await ctx.prisma.policyAssignment.findFirst({ where: { id: assignmentId, policyId: policy.id } });
  if (!a) throw notFound('Assignment not found');
  await ctx.prisma.policyAssignment.delete({ where: { id: a.id } });
  await audit(ctx, p, policy, AuditAction.POLICY_UNASSIGNED, ip, { assignment_id: a.id, scope: a.scope });
}

