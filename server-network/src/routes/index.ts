import type { FastifyInstance } from 'fastify';
import { authRoutes } from '../modules/auth/auth.routes.js';
import { organizationRoutes } from '../modules/organizations/organizations.routes.js';
import { userRoutes } from '../modules/users/users.routes.js';
import { deviceRoutes } from '../modules/devices/devices.routes.js';
import { groupRoutes } from '../modules/groups/groups.routes.js';
import { policyRoutes } from '../modules/policies/policies.routes.js';
import { auditRoutes } from '../modules/audit/audit.routes.js';
import { agentRoutes } from '../modules/agents/agents.routes.js';
import { analyticsRoutes } from '../modules/analytics/analytics.routes.js';

const escapeHtml = (v: string) =>
  v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Tiny landing page for browsers hitting the API origin; the admin console is the separate Next.js app (web/). */
export function landingPage(webUrl: string): string {
  const url = escapeHtml(webUrl);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Network Access Manager API</title></head>
<body><h1>Network Access Manager API</h1>
<p>This origin serves the JSON API under <code>/api/*</code>.</p>
<p>Open the admin console: <a href="${url}">${url}</a></p>
<p>Not running? Start it with <code>npm run dev</code> (development) or <code>npm run build &amp;&amp; npm start</code>.</p>
</body></html>
`;
}

export async function registerRoutes(app: FastifyInstance) {
  const landing = landingPage(app.ctx.config.webPublicUrl);
  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(landing));
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
  await app.register(analyticsRoutes);
}
