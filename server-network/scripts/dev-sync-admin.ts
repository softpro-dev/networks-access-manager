/**
 * Development convenience, run automatically before `npm run dev` (npm "predev" hook).
 *
 * Makes the seed super admin's stored password follow SEED_SUPER_ADMIN_PASSWORD in .env, so editing
 * .env and restarting `npm run dev` is enough to log in with the new password. Does nothing unless
 * NODE_ENV=development. Never fails the dev start: problems are printed and skipped.
 */
import { PrismaClient } from '@prisma/client';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from '../src/services/password.js';

try {
  process.loadEnvFile('.env');
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}

async function main() {
  if (process.env.NODE_ENV !== 'development') return;
  const email = process.env.SEED_SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD;
  if (!email || !password) return;
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.warn(`[dev-sync-admin] SEED_SUPER_ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters; not synced.`);
    return;
  }

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      console.warn(`[dev-sync-admin] ${email} does not exist yet; run "npm run db:seed" to create it.`);
      return;
    }
    if (await verifyPassword(user.passwordHash, password)) return; // already in sync

    const passwordHash = await hashPassword(password);
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null } }),
      prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
      prisma.auditLog.create({
        data: {
          organizationId: user.organizationId,
          actorType: 'SYSTEM',
          action: 'user.password_reset',
          targetType: 'User',
          targetId: user.id,
          metadata: { via: 'dev-sync' },
        },
      }),
    ]);
    console.log(`[dev-sync-admin] Password for ${email} updated from .env.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: Error) => {
  console.warn(`[dev-sync-admin] skipped: ${err.message}`);
});
