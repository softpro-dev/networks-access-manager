import type { FastifyInstance, FastifyRequest } from 'fastify';
import { deviceAuth, getDevice } from '../../middleware/deviceAuth.js';
import { makeLimiter } from '../../services/rateLimit.js';
import { parseBearer } from '../../domain/deviceToken.js';
import { ifNoneMatchSatisfied } from '../../domain/etag.js';
import { AppError } from '../../utils/errors.js';
import { parse } from '../../utils/validation.js';
import { ackBody, heartbeatBody, policyStatusBody, registerBody, registrationStatusHeaders } from './agents.schemas.js';
import * as svc from './agents.service.js';
import { normalizeMac } from '../../domain/mac.js';
import { agentEvents } from '../../services/agentEvents.js';

/** Keep-alive comment interval on event streams; agents treat ~3 missed pings as a dead connection. */
export const EVENTS_PING_MS = 20_000;
const MAX_EVENT_STREAMS = 20_000;

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
  const orgTokenLimit = makeLimiter(app, enabled, { name: 'agent-org', max: 120, windowMs: 60_000, key: (r) => `nat:${(parseBearer(r.headers.authorization)?.credentialId) ?? r.ip}` });
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

  // Organization service policy: authenticated by the org access token (Bearer nat_...). No per-device
  // enrollment; the management server is always reachable (management exception) by design.
  app.get('/api/agent/org-policy', { onRequest: orgTokenLimit }, async (req, reply) => {
    const org = await svc.authOrgAccessToken(ctx, req.headers.authorization);
    // Optional X-Device-MAC (contract §4.2): selects that computer's own merged policy and records
    // its check-in for the console's Synced column.
    const mac = req.headers['x-device-mac'];
    const r = await svc.orgPolicyDocument(ctx, org, typeof mac === 'string' ? normalizeMac(mac) : null);
    if (!r) throw new AppError(404, 'NO_POLICY_ASSIGNED', 'No policy is assigned to this computer or organization');
    reply.header('etag', r.etag).header('cache-control', 'no-cache, private');
    if (ifNoneMatchSatisfied(req.headers['if-none-match'], r.etag)) return reply.code(304).send();
    return r.document;
  });

  // Live change notifications for org-token services (contract §4.3): a Server-Sent Events stream
  // that only says "re-fetch now". Plain HTTP response, so it works the same over http and https
  // and through reverse proxies that allow streaming. The service keeps polling as a fallback.
  const eventsLimit = makeLimiter(app, enabled, { name: 'agent-events', max: 30, windowMs: 60_000, key: (r) => r.ip });
  app.get('/api/agent/events', { onRequest: eventsLimit }, async (req, reply) => {
    const org = await svc.authOrgAccessToken(ctx, req.headers.authorization);
    if (agentEvents.size >= MAX_EVENT_STREAMS) throw new AppError(503, 'TOO_MANY_STREAMS', 'Too many live connections; poll instead');

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      // no-transform: compression middlewares/proxies must not buffer the stream.
      'cache-control': 'no-cache, no-transform, private',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // nginx
      'x-content-type-options': 'nosniff',
    });
    res.socket?.setNoDelay(true);
    res.socket?.setKeepAlive(true, 30_000);

    let closed = false;
    const write = (chunk: string) => {
      if (!closed && !res.writableEnded) res.write(chunk);
    };
    const stream = {
      send: (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
      close: () => {
        if (closed) return;
        closed = true;
        res.end();
      },
    };
    const unsubscribe = agentEvents.subscribe(org.id, stream);
    // Comment lines keep idle proxies/NATs from dropping the connection and let the client detect a dead one.
    const ping = setInterval(() => write(`: ping\n\n`), EVENTS_PING_MS);
    const cleanup = () => {
      clearInterval(ping);
      unsubscribe();
      closed = true;
    };
    req.raw.on('close', cleanup);
    res.on('close', cleanup);

    // `retry` = browser-style reconnect hint; `ready` confirms the subscription.
    write(`retry: 10000\nevent: ready\ndata: ${JSON.stringify({ organization_code: org.code, ping_seconds: EVENTS_PING_MS / 1000 })}\n\n`);
    req.log.info({ org: org.code, streams: agentEvents.connections(org.id) }, 'agent event stream opened');
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
