import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from './config/index.js';
import type { AdminPrincipal } from './domain/rbac.js';
import type { JwtService } from './services/jwt.js';

export interface DeviceIdentity {
  deviceId: string;
  organizationId: string;
  organizationCode: string;
  deviceUuid: string;
  credentialId: string;
}

export interface AppContext {
  config: AppConfig;
  prisma: PrismaClient;
  jwt: JwtService;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
  interface FastifyRequest {
    admin: AdminPrincipal | null;
    device: DeviceIdentity | null;
  }
}
