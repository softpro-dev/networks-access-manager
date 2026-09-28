import type { FastifyInstance } from 'fastify';
import { adminAuth, getAdmin } from '../../middleware/adminAuth.js';
import { parse } from '../../utils/validation.js';
import { idParam } from '../../utils/http.js';
import {
  approveDevice,
  getDevice,
  listDevices,
  listDevicesQuery,
  reenrollDevice,
  rejectDevice,
  revokeDevice,
  updateDevice,
  updateDeviceBody,
} from './devices.service.js';

export async function deviceRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  app.addHook('preHandler', adminAuth(ctx));
  const id = (p: unknown) => parse(idParam, p, 'Params').id;

  app.get('/api/devices', async (req) => listDevices(ctx, getAdmin(req), parse(listDevicesQuery, req.query, 'Query')));
  app.get('/api/devices/:id', async (req) => getDevice(ctx, getAdmin(req), id(req.params)));
  app.patch('/api/devices/:id', async (req) => updateDevice(ctx, getAdmin(req), id(req.params), parse(updateDeviceBody, req.body), req.ip));
  app.post('/api/devices/:id/approve', async (req) => approveDevice(ctx, getAdmin(req), id(req.params), req.ip));
  app.post('/api/devices/:id/reject', async (req) => rejectDevice(ctx, getAdmin(req), id(req.params), req.ip));
  app.post('/api/devices/:id/revoke', async (req) => revokeDevice(ctx, getAdmin(req), id(req.params), req.ip));
  app.post('/api/devices/:id/re-enroll', async (req) => reenrollDevice(ctx, getAdmin(req), id(req.params), req.ip));
}
