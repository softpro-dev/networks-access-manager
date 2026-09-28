import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext, DeviceIdentity } from '../types.js';
import { parseBearer, verifyDeviceSecret } from '../domain/deviceToken.js';
import { AppError } from '../utils/errors.js';

const invalid = () => new AppError(401, 'INVALID_CREDENTIAL', 'Invalid device credential');
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

/** Contract §3 device authentication. No caching: revocation is effective on the next request. */
export function deviceAuth(ctx: AppContext) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const parsed = parseBearer(req.headers.authorization);
    if (!parsed) throw invalid();
    const cred = await ctx.prisma.deviceCredential.findUnique({
      where: { id: parsed.credentialId },
      include: { device: { include: { organization: true } } },
    });
    if (!cred || !cred.secretHash || !cred.claimedAt) throw invalid();
    if (!verifyDeviceSecret(parsed.secret, cred.secretHash)) throw invalid();
    if (cred.revokedAt) throw new AppError(403, 'CREDENTIAL_REVOKED', 'Device credential has been revoked');
    const now = new Date();
    if (cred.expiresAt && cred.expiresAt <= now) throw invalid();
    const device = cred.device;
    if (cred.organizationId !== device.organizationId) throw invalid();
    if (device.status !== 'APPROVED') throw new AppError(403, 'DEVICE_NOT_APPROVED', 'Device is not approved');
    if (device.organization.status !== 'ACTIVE') throw new AppError(403, 'DEVICE_NOT_APPROVED', 'Organization is not active');

    if (!cred.lastUsedAt || now.getTime() - cred.lastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS) {
      await ctx.prisma.deviceCredential.update({ where: { id: cred.id }, data: { lastUsedAt: now } });
    }
    const identity: DeviceIdentity = {
      deviceId: device.id,
      organizationId: device.organizationId,
      organizationCode: device.organization.code,
      deviceUuid: device.deviceUuid,
      credentialId: cred.id,
    };
    req.device = identity;
  };
}

export function getDevice(req: FastifyRequest): DeviceIdentity {
  if (!req.device) throw invalid();
  return req.device;
}
