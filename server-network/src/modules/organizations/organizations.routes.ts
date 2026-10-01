import type { FastifyInstance } from 'fastify';
import { adminAuth, getAdmin } from '../../middleware/adminAuth.js';
import { parse } from '../../utils/validation.js';
import { idParam } from '../../utils/http.js';
import {
  clearRegistrationToken,
  createOrg,
  createOrgBody,
  createLoginLink,
  deleteOrg,
  deleteOrgQuery,
  loginLinkBody,
  getOrg,
  listOrgs,
  rotateAccessToken,
  clearAccessToken,
  revealAccessToken,
  rotateRegistrationToken,
  updateOrg,
  updateOrgBody,
} from './organizations.service.js';

export async function organizationRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  app.addHook('preHandler', adminAuth(ctx));
  const id = (p: unknown) => parse(idParam, p, 'Params').id;

  app.get('/api/organizations', async (req) => listOrgs(ctx, getAdmin(req)));
  app.post('/api/organizations', async (req, reply) =>
    reply.code(201).send(await createOrg(ctx, getAdmin(req), parse(createOrgBody, req.body), req.ip)),
  );
  app.get('/api/organizations/:id', async (req) => getOrg(ctx, getAdmin(req), id(req.params)));
  app.patch('/api/organizations/:id', async (req) => updateOrg(ctx, getAdmin(req), id(req.params), parse(updateOrgBody, req.body), req.ip));
  app.post('/api/organizations/:id/registration-token', async (req) => rotateRegistrationToken(ctx, getAdmin(req), id(req.params), req.ip));
  app.post('/api/organizations/:id/login-link', async (req) =>
    createLoginLink(ctx, getAdmin(req), id(req.params), parse(loginLinkBody, req.body ?? {}), req.ip),
  );
  app.delete('/api/organizations/:id', async (req) =>
    deleteOrg(ctx, getAdmin(req), id(req.params), parse(deleteOrgQuery, req.query, 'Query').confirm, req.ip),
  );
  app.delete('/api/organizations/:id/registration-token', async (req) => clearRegistrationToken(ctx, getAdmin(req), id(req.params), req.ip));
  app.post('/api/organizations/:id/access-token', async (req) => rotateAccessToken(ctx, getAdmin(req), id(req.params), req.ip));
  app.get('/api/organizations/:id/access-token', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return revealAccessToken(ctx, getAdmin(req), id(req.params), req.ip);
  });
  app.delete('/api/organizations/:id/access-token', async (req) => clearAccessToken(ctx, getAdmin(req), id(req.params), req.ip));
}
