import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AppConfig } from './config/index.js';
import type { AppContext } from './types.js';
import { JwtService } from './services/jwt.js';
import { AppError, errorBody } from './utils/errors.js';
import { registerRoutes } from './routes/index.js';
import { agentEvents } from './services/agentEvents.js';
import './types.js';

export interface AppDeps {
  config: AppConfig;
  prisma: PrismaClient;
  /** Extra Fastify options (e.g. `https` from server.ts). */
  fastifyOptions?: Partial<FastifyServerOptions> & Record<string, unknown>;
  /** Optional handler for non-API requests (the production entry point uses Next.js). */
  notFoundHandler?: (req: FastifyRequest, reply: FastifyReply) => unknown;
}

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-registration-token"]',
  'req.headers["x-enrollment-secret"]',
  'req.headers.cookie',
  'password',
  'token',
  '*.password',
  '*.token',
  '*.access_token',
  'body.password',
  'body.token',
];

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, prisma } = deps;
  const options: FastifyServerOptions = {
    logger:
      config.logLevel === 'silent'
        ? false
        : { level: config.logLevel, redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
    // proxy-addr accepts a hop count too; Fastify's typings omit number.
    trustProxy: config.trustProxy as FastifyServerOptions['trustProxy'],
    bodyLimit: 1024 * 1024,
    ...deps.fastifyOptions,
  };
  // `https` (set by server.ts) switches the raw server at runtime; routes are server-agnostic.
  const app = Fastify(options) as unknown as FastifyInstance;

  const ctx: AppContext = { config, prisma, jwt: new JwtService(config.jwtSecret, config.jwtTtlSeconds) };
  app.decorate('ctx', ctx);
  app.decorateRequest('admin', null);
  app.decorateRequest('device', null);

  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } });
  if (config.corsOrigins.length > 0) {
    await app.register(cors, { origin: config.corsOrigins, credentials: false, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });
  }
  // Limiters are created explicitly per route (see services/rateLimit.ts); no global limit.
  await app.register(rateLimit, { global: false });

  app.setNotFoundHandler(deps.notFoundHandler ?? ((_req, reply) => reply.code(404).send(errorBody('NOT_FOUND', 'Route not found'))));

  app.setErrorHandler((err: FastifyError | AppError | Error, req, reply) => {
    if (err instanceof AppError) {
      if (err.statusCode >= 500) req.log.error({ err }, 'application error');
      return reply.code(err.statusCode).send(errorBody(err.code, err.message, err.details));
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2002') return reply.code(409).send(errorBody('CONFLICT', 'Resource already exists'));
      if (err.code === 'P2025') return reply.code(404).send(errorBody('NOT_FOUND', 'Resource not found'));
      if (err.code === 'P2003') return reply.code(409).send(errorBody('CONFLICT', 'Resource is referenced by other records'));
    }
    const fe = err as FastifyError;
    const status = typeof fe.statusCode === 'number' ? fe.statusCode : 500;
    if (status === 429) return reply.code(429).send(errorBody('RATE_LIMITED', 'Too many requests; retry later'));
    if (status === 413) return reply.code(413).send(errorBody('PAYLOAD_TOO_LARGE', 'Request body too large'));
    if (status === 415) return reply.code(415).send(errorBody('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'));
    if (status >= 400 && status < 500) return reply.code(400).send(errorBody('VALIDATION_ERROR', fe.message || 'Invalid request'));
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send(errorBody('INTERNAL_ERROR', 'Internal server error'));
  });

  await registerRoutes(app);
  // Live agent event streams are hijacked responses; end them so close() does not wait on them.
  app.addHook('preClose', async () => agentEvents.closeAll());
  return app;
}
