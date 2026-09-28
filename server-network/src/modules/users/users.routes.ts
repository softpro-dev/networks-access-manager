import type { FastifyInstance } from 'fastify';
import { adminAuth, getAdmin } from '../../middleware/adminAuth.js';
import { parse } from '../../utils/validation.js';
import { idParam } from '../../utils/http.js';
import { createUser, createUserBody, getUser, listUsers, listUsersQuery, updateUser, updateUserBody } from './users.service.js';

export async function userRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  app.addHook('preHandler', adminAuth(ctx));

  app.get('/api/users', async (req) => listUsers(ctx, getAdmin(req), parse(listUsersQuery, req.query, 'Query')));
  app.post('/api/users', async (req, reply) => {
    const u = await createUser(ctx, getAdmin(req), parse(createUserBody, req.body), req.ip);
    return reply.code(201).send(u);
  });
  app.get('/api/users/:id', async (req) => getUser(ctx, getAdmin(req), parse(idParam, req.params, 'Params').id));
  app.patch('/api/users/:id', async (req) =>
    updateUser(ctx, getAdmin(req), parse(idParam, req.params, 'Params').id, parse(updateUserBody, req.body), req.ip),
  );
}
