import type { FastifyInstance } from 'fastify';
import { adminAuth, getAdmin } from '../../middleware/adminAuth.js';
import { parse } from '../../utils/validation.js';
import { idParam } from '../../utils/http.js';
import { listScope } from '../../domain/rbac.js';
import * as svc from './policies.service.js';

/** Policy bodies can be large (2 × 5000 domains + 1000 IPs). */
const LARGE_BODY = 8 * 1024 * 1024;

export async function policyRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  app.addHook('preHandler', adminAuth(ctx));
  const id = (p: unknown) => parse(idParam, p, 'Params').id;
  const vp = (p: unknown) => parse(svc.versionParams, p, 'Params');

  app.get('/api/policies', async (req) => svc.listPolicies(ctx, getAdmin(req), parse(svc.listPoliciesQuery, req.query, 'Query')));
  app.post('/api/policies', { bodyLimit: LARGE_BODY }, async (req, reply) =>
    reply.code(201).send(await svc.createPolicy(ctx, getAdmin(req), parse(svc.createPolicyBody, req.body), req.ip)),
  );
  app.post('/api/policies/validate', { bodyLimit: LARGE_BODY }, async (req) => {
    const body = parse(svc.validateBody, req.body);
    listScope(getAdmin(req), body.organization_id);
    return svc.validateAdhoc(ctx, body);
  });
  app.get('/api/policies/:id', async (req) => svc.getPolicy(ctx, getAdmin(req), id(req.params)));
  app.patch('/api/policies/:id', async (req) => svc.updatePolicy(ctx, getAdmin(req), id(req.params), parse(svc.updatePolicyBody, req.body), req.ip));
  app.post('/api/policies/:id/activate', async (req) => svc.setPolicyActive(ctx, getAdmin(req), id(req.params), true, req.ip));
  app.post('/api/policies/:id/deactivate', async (req) => svc.setPolicyActive(ctx, getAdmin(req), id(req.params), false, req.ip));
  app.post('/api/policies/:id/rollback', async (req) =>
    svc.rollbackPolicy(ctx, getAdmin(req), id(req.params), parse(svc.rollbackBody, req.body).version, req.ip),
  );

  app.get('/api/policies/:id/versions', async (req) => svc.listVersions(ctx, getAdmin(req), id(req.params)));
  app.post('/api/policies/:id/versions', async (req, reply) =>
    reply.code(201).send(await svc.createDraftVersion(ctx, getAdmin(req), id(req.params), parse(svc.newVersionBody, req.body ?? {}), req.ip)),
  );
  app.get('/api/policies/:id/versions/:version', async (req) => {
    const p = vp(req.params);
    return svc.getVersion(ctx, getAdmin(req), p.id, p.version);
  });
  app.put('/api/policies/:id/versions/:version', { bodyLimit: LARGE_BODY }, async (req) => {
    const p = vp(req.params);
    return svc.updateDraft(ctx, getAdmin(req), p.id, p.version, parse(svc.draftBody, req.body).content, req.ip);
  });
  app.post('/api/policies/:id/versions/:version/validate', async (req) => {
    const p = vp(req.params);
    return svc.validateVersion(ctx, getAdmin(req), p.id, p.version);
  });
  app.post('/api/policies/:id/versions/:version/publish', async (req) => {
    const p = vp(req.params);
    return svc.publishVersion(ctx, getAdmin(req), p.id, p.version, req.ip);
  });
  app.post('/api/policies/:id/versions/:version/archive', async (req) => {
    const p = vp(req.params);
    return svc.archiveVersion(ctx, getAdmin(req), p.id, p.version, req.ip);
  });

  app.get('/api/policies/:id/assignments', async (req) => svc.listAssignments(ctx, getAdmin(req), id(req.params)));
  app.post('/api/policies/:id/assignments', async (req, reply) =>
    reply.code(201).send(await svc.createAssignment(ctx, getAdmin(req), id(req.params), parse(svc.createAssignmentBody, req.body), req.ip)),
  );
  app.delete('/api/policies/:id/assignments/:assignmentId', async (req, reply) => {
    const p = parse(svc.assignmentParams, req.params, 'Params');
    await svc.deleteAssignment(ctx, getAdmin(req), p.id, p.assignmentId, req.ip);
    return reply.code(204).send();
  });
}
