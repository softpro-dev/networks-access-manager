import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { adminAuth, getAdmin } from '../../middleware/adminAuth.js';
import { listScope } from '../../domain/rbac.js';
import { parse } from '../../utils/validation.js';

const overviewQuery = z.object({ organization_id: z.string().max(64).optional() });
const DEVICE_STATUSES = ['PRE_REGISTERED', 'PENDING', 'APPROVED', 'REJECTED', 'REVOKED'] as const;
const KINDS = ['ALLOW_ONLY', 'BLACKLIST', 'REDIRECT'] as const;
const FAILURE_STATES = ['VALIDATION_FAILED', 'FAILED', 'ROLLED_BACK'] as const;

/**
 * Aggregate counts only (no user activity is collected). SUPER_ADMIN sees every organization, or one
 * via ?organization_id; ORGANIZATION_ADMIN always gets only their own organization.
 */
export async function analyticsRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  app.addHook('preHandler', adminAuth(ctx));

  app.get('/api/analytics/overview', async (req) => {
    const orgId = listScope(getAdmin(req), parse(overviewQuery, req.query, 'Query').organization_id);
    const onlineSince = new Date(Date.now() - ctx.config.heartbeatIntervalSeconds * 3 * 1000);
    const orgWhere = orgId ? { organizationId: orgId } : {};
    const [orgs, deviceGroups, online, kindGroups, activeRestrictions, assignmentGroups, failures, groupSizes] = await Promise.all([
      ctx.prisma.organization.findMany({ where: orgId ? { id: orgId } : {}, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true, status: true } }),
      ctx.prisma.device.groupBy({ by: ['organizationId', 'status'], where: orgWhere, _count: { _all: true } }),
      ctx.prisma.device.groupBy({ by: ['organizationId'], where: { ...orgWhere, status: 'APPROVED', lastHeartbeatAt: { gte: onlineSince } }, _count: { _all: true } }),
      ctx.prisma.policy.groupBy({ by: ['organizationId', 'kind'], where: orgWhere, _count: { _all: true } }),
      ctx.prisma.policy.groupBy({ by: ['organizationId'], where: { ...orgWhere, isActive: true, activeVersionId: { not: null } }, _count: { _all: true } }),
      ctx.prisma.policyAssignment.groupBy({ by: ['organizationId', 'scope'], where: orgWhere, _count: { _all: true } }),
      ctx.prisma.devicePolicyStatus.findMany({
        where: { status: { in: [...FAILURE_STATES] }, device: orgWhere },
        select: { status: true, errorCode: true, updatedAt: true, device: { select: { id: true, organizationId: true, displayName: true, hostname: true } } },
        orderBy: { updatedAt: 'desc' },
        take: 20,
      }),
      ctx.prisma.deviceGroup.findMany({ where: orgWhere, select: { id: true, name: true, organizationId: true, _count: { select: { members: true } } }, orderBy: { name: 'asc' } }),
    ]);

    const perOrg = orgs.map((o) => {
      const byStatus = Object.fromEntries(DEVICE_STATUSES.map((s) => [s, 0])) as Record<(typeof DEVICE_STATUSES)[number], number>;
      for (const g of deviceGroups) if (g.organizationId === o.id) byStatus[g.status] = g._count._all;
      const byKind = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<(typeof KINDS)[number], number>;
      for (const g of kindGroups) if (g.organizationId === o.id) byKind[g.kind] = g._count._all;
      const assignments = { ORGANIZATION: 0, GROUP: 0, DEVICE: 0 };
      for (const g of assignmentGroups) if (g.organizationId === o.id) assignments[g.scope] = g._count._all;
      return {
        organization: o,
        computers: { total: Object.values(byStatus).reduce((a, b) => a + b, 0), by_status: byStatus, online: online.find((x) => x.organizationId === o.id)?._count._all ?? 0 },
        restrictions: { total: Object.values(byKind).reduce((a, b) => a + b, 0), active: activeRestrictions.find((x) => x.organizationId === o.id)?._count._all ?? 0, by_kind: byKind },
        assignments,
        failing_computers: failures.filter((f) => f.device.organizationId === o.id).length,
      };
    });

    const sum = (pick: (r: (typeof perOrg)[number]) => number) => perOrg.reduce((a, r) => a + pick(r), 0);
    return {
      generated_at: new Date().toISOString(),
      totals: {
        organizations: perOrg.length,
        computers: sum((r) => r.computers.total),
        online: sum((r) => r.computers.online),
        approved: sum((r) => r.computers.by_status.APPROVED),
        pending: sum((r) => r.computers.by_status.PENDING),
        pre_registered: sum((r) => r.computers.by_status.PRE_REGISTERED),
        restrictions: sum((r) => r.restrictions.total),
        failing_computers: failures.length,
      },
      organizations: perOrg,
      groups: groupSizes.map((g) => ({ id: g.id, name: g.name, organization_id: g.organizationId, members: g._count.members })),
      recent_failures: failures.map((f) => ({
        device_id: f.device.id,
        organization_id: f.device.organizationId,
        title: f.device.displayName ?? f.device.hostname,
        status: f.status,
        error_code: f.errorCode,
        updated_at: f.updatedAt.toISOString(),
      })),
    };
  });
}
