/**
 * Development seed: 3 organizations, one SUPER_ADMIN, one ORGANIZATION_ADMIN per org, and a sample
 * policy POL-001 per org (published v1 + ORGANIZATION assignment). Idempotent (upserts).
 * Passwords come from env or are generated randomly and printed ONCE to stdout.
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../src/services/password.js';
import { validatePolicyContent } from '../src/domain/policyContent.js';

// Run via tsx, which (unlike the Prisma CLI) does not load .env; real env vars still take precedence.
try {
  process.loadEnvFile('.env');
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}

const prisma = new PrismaClient();

const ORGS = [
  { code: 'INST-001', name: 'Organization A', admin: 'admin@inst-001.example.com', env: 'SEED_INST_001_ADMIN_PASSWORD' },
  { code: 'COMPANY-002', name: 'Organization B', admin: 'admin@company-002.example.com', env: 'SEED_COMPANY_002_ADMIN_PASSWORD' },
  { code: 'BRANCH-003', name: 'Organization C', admin: 'admin@branch-003.example.com', env: 'SEED_BRANCH_003_ADMIN_PASSWORD' },
];

const printed: string[] = [];

function passwordFor(envName: string, label: string): string {
  const v = process.env[envName];
  if (v) {
    if (v.length < MIN_PASSWORD_LENGTH) throw new Error(`${envName} must be at least ${MIN_PASSWORD_LENGTH} characters`);
    return v;
  }
  const generated = randomBytes(18).toString('base64url');
  printed.push(`${label}: ${generated}`);
  return generated;
}

async function upsertUser(email: string, role: 'SUPER_ADMIN' | 'ORGANIZATION_ADMIN', organizationId: string | null, password: () => string) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing; // never overwrite an existing password
  return prisma.user.create({ data: { email, role, organizationId, passwordHash: await hashPassword(password()), name: role === 'SUPER_ADMIN' ? 'Super Admin' : 'Organization Admin' } });
}

async function main() {
  const superEmail = (process.env.SEED_SUPER_ADMIN_EMAIL ?? 'superadmin@example.com').toLowerCase();
  const superAdmin = await upsertUser(superEmail, 'SUPER_ADMIN', null, () => passwordFor('SEED_SUPER_ADMIN_PASSWORD', superEmail));

  const content = validatePolicyContent({
    allowed_domains: ['company.com', '*.company.com'],
    blocked_domains: ['example.com', '*.example.com'],
    blocked_ips: ['203.0.113.0/24', '2001:db8::/32'],
  });
  if (!content.content || !content.content_sha256) throw new Error('seed policy invalid');

  for (const o of ORGS) {
    const org = await prisma.organization.upsert({ where: { code: o.code }, update: {}, create: { code: o.code, name: o.name } });
    // Per-org env var, else SEED_ORG_ADMIN_PASSWORD, else random.
    await upsertUser(o.admin, 'ORGANIZATION_ADMIN', org.id, () =>
      passwordFor(process.env[o.env] ? o.env : 'SEED_ORG_ADMIN_PASSWORD', o.admin),
    );

    const existing = await prisma.policy.findUnique({ where: { organizationId_code: { organizationId: org.id, code: 'POL-001' } } });
    if (existing) continue;
    await prisma.$transaction(async (tx) => {
      const policy = await tx.policy.create({ data: { organizationId: org.id, code: 'POL-001', name: 'Baseline policy', description: 'Sample policy created by the seed script' } });
      const v1 = await tx.policyVersion.create({
        data: {
          policyId: policy.id,
          version: 1,
          status: 'PUBLISHED',
          content: content.content as unknown as Prisma.InputJsonValue,
          contentSha256: content.content_sha256,
          publishedAt: new Date(),
          publishedById: superAdmin.id,
        },
      });
      await tx.policy.update({ where: { id: policy.id }, data: { activeVersionId: v1.id } });
      await tx.policyAssignment.create({ data: { policyId: policy.id, organizationId: org.id, scope: 'ORGANIZATION', priority: 0, createdById: superAdmin.id } });
    });
  }

  console.log('Seed complete: organizations', ORGS.map((o) => o.code).join(', '));
  if (printed.length) {
    console.log('\nGenerated passwords (shown ONCE; store them now):');
    for (const line of printed) console.log(`  ${line}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
