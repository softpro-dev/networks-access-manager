/**
 * Resets an administrator's password directly in the database (for lost passwords / first setup).
 *
 *   npm run admin:reset-password -- <email>
 *
 * Password source, in order: RESET_PASSWORD env var; SEED_SUPER_ADMIN_PASSWORD when <email> is
 * SEED_SUPER_ADMIN_EMAIL; otherwise an interactive hidden prompt. Also clears the lockout counter,
 * revokes every existing session of that user, and writes an audit entry (never the password).
 */
import { createInterface } from 'node:readline';
import { PrismaClient } from '@prisma/client';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../src/services/password.js';

try {
  process.loadEnvFile('.env');
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let muted = false;
    out._writeToOutput = (s: string) => {
      if (!muted || s.includes('\n')) out.output.write(muted ? '\n' : s);
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

async function resolvePassword(email: string): Promise<string> {
  if (process.env.RESET_PASSWORD) return process.env.RESET_PASSWORD;
  const seedEmail = process.env.SEED_SUPER_ADMIN_EMAIL?.toLowerCase();
  if (seedEmail === email && process.env.SEED_SUPER_ADMIN_PASSWORD) {
    console.log('Using SEED_SUPER_ADMIN_PASSWORD from .env');
    return process.env.SEED_SUPER_ADMIN_PASSWORD;
  }
  if (!process.stdin.isTTY) throw new Error('No password given: set RESET_PASSWORD or run in a terminal');
  const first = await promptHidden('New password: ');
  const second = await promptHidden('Repeat password: ');
  if (first !== second) throw new Error('Passwords do not match');
  return first;
}

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) throw new Error('Usage: npm run admin:reset-password -- <email>');

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw new Error(`No user with email ${email}`);

    const password = await resolvePassword(email);
    if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    const passwordHash = await hashPassword(password);

    const now = new Date();
    const [, revoked] = await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null } }),
      prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } }),
      prisma.auditLog.create({
        data: {
          organizationId: user.organizationId,
          actorType: 'SYSTEM',
          action: 'user.password_reset',
          targetType: 'User',
          targetId: user.id,
          metadata: { via: 'cli' },
        },
      }),
    ]);
    console.log(`Password reset for ${email} (${user.role}); ${revoked.count} session(s) revoked.`);
    if (user.status !== 'ACTIVE') console.log(`Note: account status is ${user.status}; login stays blocked until it is ACTIVE.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
