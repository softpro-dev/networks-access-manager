import { PrismaClient } from '@prisma/client';

export type Db = PrismaClient;

export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } }, log: ['warn', 'error'] });
}
