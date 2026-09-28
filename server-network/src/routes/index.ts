import type { FastifyInstance } from 'fastify';
import { authRoutes } from '../modules/auth/auth.routes.js';
import { organizationRoutes } from '../modules/organizations/organizations.routes.js';
import { userRoutes } from '../modules/users/users.routes.js';
import { deviceRoutes } from '../modules/devices/devices.routes.js';
import { groupRoutes } from '../modules/groups/groups.routes.js';
import { policyRoutes } from '../modules/policies/policies.routes.js';
import { auditRoutes } from '../modules/audit/audit.routes.js';
import { agentRoutes } from '../modules/agents/agents.routes.js';

export async function registerRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => ({ status: 'ok', time: new Date().toISOString() }));
  // Each module is an encapsulated plugin so its auth hooks apply only to its own routes.
  await app.register(authRoutes);
  await app.register(organizationRoutes);
  await app.register(userRoutes);
  await app.register(deviceRoutes);
  await app.register(groupRoutes);
  await app.register(policyRoutes);
  await app.register(auditRoutes);
  await app.register(agentRoutes);
}
