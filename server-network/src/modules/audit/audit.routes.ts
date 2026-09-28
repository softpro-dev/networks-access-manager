import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { adminAuth, getAdmin } from '../../middleware/adminAuth.js';
import { isSuperAdmin, listScope } from '../../domain/rbac.js';
import { parse } from '../../utils/validation.js';
import { iso, pageArgs, pageBody } from '../../utils/http.js';

const query = z.object({
  organization_id: z.string().max(64).optional(),
  action: z.string().max(64).optional(),
  actor_type: z.enum(['USER', 'DEVICE', 'SYSTEM']).optional(),
  target_type: z.string().max(64).optional(),
  target_id: z.string().max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
});

/** SUPER_ADMIN: all entries (incl. system-level ones without an org). ORGANIZATION_ADMIN: own org only. */
export async function auditRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  app.addHook('preHandler', adminAuth(ctx));

  app.get('/api/audit-logs', async (req) => {
    const a = getAdmin(req);
    const q = parse(query, req.query, 'Query');
    const orgId = listScope(a, q.organization_id);
    const where: Prisma.AuditLogWhereInput = {
      ...(orgId ? { organizationId: orgId } : isSuperAdmin(a) ? {} : { organizationId: '__none__' }),
      ...(q.action ? { action: q.action } : {}),
      ...(q.actor_type ? { actorType: q.actor_type } : {}),
      ...(q.target_type ? { targetType: q.target_type } : {}),
      ...(q.target_id ? { targetId: q.target_id } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    };
    const [items, total] = await Promise.all([
      ctx.prisma.auditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], ...pageArgs(q) }),
      ctx.prisma.auditLog.count({ where }),
    ]);
    return pageBody(
      items.map((l) => ({
        id: l.id,
        organization_id: l.organizationId,
        actor_type: l.actorType,
        actor_id: l.actorId,
        action: l.action,
        target_type: l.targetType,
        target_id: l.targetId,
        metadata: l.metadata,
        ip: l.ip,
        created_at: iso(l.createdAt),
      })),
      total,
      q,
    );
  });
}
