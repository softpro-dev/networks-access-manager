import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { adminAuth, getAdmin } from '../../middleware/adminAuth.js';
import { parse } from '../../utils/validation.js';
import { idParam } from '../../utils/http.js';
import { addMembers, createGroup, createGroupBody, deleteGroup, getGroup, listGroups, listGroupsQuery, membersBody, removeMember, updateGroup, updateGroupBody } from './groups.service.js';

const memberParams = z.object({ id: z.string().min(1).max(64), deviceId: z.string().min(1).max(64) });

export async function groupRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  app.addHook('preHandler', adminAuth(ctx));
  const id = (p: unknown) => parse(idParam, p, 'Params').id;

  app.get('/api/device-groups', async (req) => listGroups(ctx, getAdmin(req), parse(listGroupsQuery, req.query, 'Query')));
  app.post('/api/device-groups', async (req, reply) => reply.code(201).send(await createGroup(ctx, getAdmin(req), parse(createGroupBody, req.body), req.ip)));
  app.get('/api/device-groups/:id', async (req) => getGroup(ctx, getAdmin(req), id(req.params)));
  app.patch('/api/device-groups/:id', async (req) => updateGroup(ctx, getAdmin(req), id(req.params), parse(updateGroupBody, req.body), req.ip));
  app.delete('/api/device-groups/:id', async (req, reply) => {
    await deleteGroup(ctx, getAdmin(req), id(req.params), req.ip);
    return reply.code(204).send();
  });
  app.post('/api/device-groups/:id/members', async (req) => addMembers(ctx, getAdmin(req), id(req.params), parse(membersBody, req.body), req.ip));
  app.delete('/api/device-groups/:id/members/:deviceId', async (req, reply) => {
    const prm = parse(memberParams, req.params, 'Params');
    await removeMember(ctx, getAdmin(req), prm.id, prm.deviceId, req.ip);
    return reply.code(204).send();
  });
}
