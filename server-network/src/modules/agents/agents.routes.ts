import type { FastifyInstance, FastifyRequest } from 'fastify';
import { deviceAuth, getDevice } from '../../middleware/deviceAuth.js';
import { makeLimiter } from '../../services/rateLimit.js';
import { parseBearer } from '../../domain/deviceToken.js';
import { ifNoneMatchSatisfied } from '../../domain/etag.js';
import { AppError } from '../../utils/errors.js';
import { parse } from '../../utils/validation.js';
import { ackBody, heartbeatBody, policyStatusBody, registerBody, registrationStatusHeaders } from './agents.schemas.js';
import * as svc from './agents.service.js';

const credentialKey = (req: FastifyRequest) => {
  const t = parseBearer(req.headers.authorization);
  return t ? `cred:${t.credentialId}` : `ip:${req.ip}`;
};

export async function agentRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const enabled = ctx.config.rateLimitEnabled;
  const registerLimit = makeLimiter(app, enabled, { name: 'agent-register', max: 10, windowMs: 60_000, key: (r) => r.ip });
  const statusLimit = makeLimiter(app, enabled, { name: 'agent-regstatus', max: 30, windowMs: 60_000, key: (r) => r.ip });
  const authedLimit = makeLimiter(app, enabled, { name: 'agent-authed', max: 120, windowMs: 60_000, key: credentialKey });
  const auth = deviceAuth(ctx);

  app.post('/api/agent/register', { onRequest: registerLimit }, async (req, reply) => {
    const body = parse(registerBody, req.body);
    const header = req.headers['x-registration-token'];
    const token = typeof header === 'string' && header.length > 0 && header.length <= 512 ? header : undefined;
    const r = await svc.registerDevice(ctx, token, body, req.ip);
    return reply.code(r.code).send(r.body);
  });

  app.get('/api/agent/registration-status', { onRequest: statusLimit }, async (req) => {
    const h = parse(registrationStatusHeaders, req.headers, 'Headers');
    return svc.registrationStatus(ctx, h['x-device-uuid'], h['x-enrollment-secret'], req.ip);
  });

  app.register(async (authed) => {
    authed.addHook('onRequest', authedLimit);
    authed.addHook('preHandler', auth);

    authed.post('/api/agent/heartbeat', async (req) => svc.heartbeat(ctx, getDevice(req), parse(heartbeatBody, req.body), req.ip));

    authed.get('/api/agent/policy/version', async (req) => svc.policyVersion(ctx, getDevice(req)));

    authed.get('/api/agent/policy', async (req, reply) => {
      const r = await svc.policyDocument(ctx, getDevice(req));
      if (!r) throw new AppError(404, 'NO_POLICY_ASSIGNED', 'No policy is assigned to this device');
      reply.header('etag', r.etag).header('cache-control', 'no-cache, private');
      if (ifNoneMatchSatisfied(req.headers['if-none-match'], r.etag)) return reply.code(304).send();
      return r.document;
    });

    authed.post('/api/agent/policy/status', async (req, reply) => {
      await svc.reportPolicyStatus(ctx, getDevice(req), parse(policyStatusBody, req.body), req.ip);
      return reply.code(204).send();
    });

    authed.post('/api/agent/policy/ack', async (req, reply) => {
      await svc.ackPolicy(ctx, getDevice(req), parse(ackBody, req.body), req.ip);
      return reply.code(204).send();
    });
  });
}
