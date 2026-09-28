import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AppError } from '../utils/errors.js';

export interface LimiterSpec {
  name: string;
  max: number;
  windowMs: number;
  key: (req: FastifyRequest) => string;
}

export type Limiter = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** Build a named limiter on top of @fastify/rate-limit's store. Several can be combined per route. */
export function makeLimiter(app: FastifyInstance, enabled: boolean, spec: LimiterSpec): Limiter {
  if (!enabled) return async () => {};
  const check = app.createRateLimit({
    max: spec.max,
    timeWindow: spec.windowMs,
    keyGenerator: (req) => `${spec.name}:${spec.key(req)}`,
  });
  return async (req, reply) => {
    const r = await check(req);
    if (!r.isAllowed && r.isExceeded) {
      reply.header('retry-after', String(r.ttlInSeconds));
      throw new AppError(429, 'RATE_LIMITED', 'Too many requests; retry later');
    }
  };
}
