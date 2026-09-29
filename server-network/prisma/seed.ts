/**
 * Development seed: 3 organizations, one SUPER_ADMIN, one ORGANIZATION_ADMIN per org, and per org a
 * "Lab computers" group with two pre-added computers plus one restriction of each type (Black List
 * org-wide, Redirection on the group, Allow Only unassigned). Idempotent.
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

/** Create a published restriction once (idempotent by code). */
async function restriction(organizationId: string, userId: string, code: string, name: string, kind: 'ALLOW_ONLY' | 'BLACKLIST' | 'REDIRECT', input: object) {
  const existing = await prisma.policy.findUnique({ where: { organizationId_code: { organizationId, code } } });
  if (existing) return existing;
  const v = validatePolicyContent(input);
  if (!v.content || !v.content_sha256) throw new Error(`seed restriction ${code} invalid: ${JSON.stringify(v.errors)}`);
  return prisma.$transaction(async (tx) => {
    const policy = await tx.policy.create({ data: { organizationId, code, name, kind, description: 'Sample restriction created by the seed script' } });
    const v1 = await tx.policyVersion.create({
      data: { policyId: policy.id, version: 1, status: 'PUBLISHED', content: v.content as unknown as Prisma.InputJsonValue, contentSha256: v.content_sha256, publishedAt: new Date(), publishedById: userId },
    });
    return tx.policy.update({ where: { id: policy.id }, data: { activeVersionId: v1.id } });
  });
}

async function assignOnce(policyId: string, organizationId: string, scope: 'ORGANIZATION' | 'GROUP', targetGroupId: string | null, userId: string) {
  const exists = await prisma.policyAssignment.findFirst({ where: { policyId, scope, targetGroupId } });
  if (!exists) await prisma.policyAssignment.create({ data: { policyId, organizationId, scope, targetGroupId, priority: 0, createdById: userId } });
}

/**
 * Older seeds created POL-001 with both allowed and blocked domains. Restrictions now have one type,
 * so publish a new Black List version of it without the allowed list (history is kept).
 */
async function upgradeLegacyPolicy(organizationId: string, userId: string) {
  const legacy = await prisma.policy.findUnique({ where: { organizationId_code: { organizationId, code: 'POL-001' } }, include: { activeVersion: true } });
  const c = legacy?.activeVersion?.content as { allowed_domains?: string[] } | undefined;
  if (!legacy || legacy.kind !== 'BLACKLIST' || !c?.allowed_domains?.length) return;
  const v = validatePolicyContent({ ...c, allowed_domains: [] });
  if (!v.content || !v.content_sha256) return;
  const latest = await prisma.policyVersion.findFirst({ where: { policyId: legacy.id }, orderBy: { version: 'desc' } });
  await prisma.$transaction(async (tx) => {
    const nv = await tx.policyVersion.create({
      data: { policyId: legacy.id, version: (latest?.version ?? 0) + 1, status: 'PUBLISHED', content: v.content as unknown as Prisma.InputJsonValue, contentSha256: v.content_sha256, publishedAt: new Date(), publishedById: userId },
    });
    await tx.policy.update({ where: { id: legacy.id }, data: { activeVersionId: nv.id, name: 'Baseline black list' } });
  });
}

async function main() {
  const superEmail = (process.env.SEED_SUPER_ADMIN_EMAIL ?? 'superadmin@example.com').toLowerCase();
  const superAdmin = await upsertUser(superEmail, 'SUPER_ADMIN', null, () => passwordFor('SEED_SUPER_ADMIN_PASSWORD', superEmail));

  for (const o of ORGS) {
    const org = await prisma.organization.upsert({ where: { code: o.code }, update: {}, create: { code: o.code, name: o.name } });
    // Per-org env var, else SEED_ORG_ADMIN_PASSWORD, else random.
    await upsertUser(o.admin, 'ORGANIZATION_ADMIN', org.id, () =>
      passwordFor(process.env[o.env] ? o.env : 'SEED_ORG_ADMIN_PASSWORD', o.admin),
    );
    await upgradeLegacyPolicy(org.id, superAdmin.id);

    const group = await prisma.deviceGroup.upsert({
      where: { organizationId_name: { organizationId: org.id, name: 'Lab computers' } },
      update: {},
      create: { organizationId: org.id, name: 'Lab computers', description: 'Sample group created by the seed script' },
    });
    // Locally administered (02:…) sample MACs: pre-added computers waiting for their agent.
    for (const [i, title] of ['Lab PC 01', 'Lab PC 02'].entries()) {
      const mac = `02:00:00:${o.code.slice(0, 2).toUpperCase().charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()}:00:0${i + 1}`;
      const exists = await prisma.device.findFirst({ where: { organizationId: org.id, macAddress: mac } });
      if (!exists) {
        await prisma.device.create({
          data: { organizationId: org.id, status: 'PRE_REGISTERED', macAddress: mac, displayName: title, serialNumber: `SN-${o.code}-${i + 1}`, memberships: { create: { groupId: group.id } } },
        });
      }
    }

    const social = await restriction(org.id, superAdmin.id, 'RST-001', 'Social media & games', 'BLACKLIST', {
      blocked_domains: ['facebook.com', '*.facebook.com', 'tiktok.com', '*.tiktok.com', 'example-games.com', '*.example-games.com'],
    });
    await restriction(org.id, superAdmin.id, 'RST-002', 'Exam mode (allow only)', 'ALLOW_ONLY', {
      allowed_domains: ['company.com', '*.company.com', 'wikipedia.org', '*.wikipedia.org'],
    });
    const redirect = await restriction(org.id, superAdmin.id, 'RST-003', 'Games → learning portal', 'REDIRECT', {
      redirect_rules: [{ from: '*.example-games.net', to: 'learn.company.com' }],
    });
    await assignOnce(social.id, org.id, 'ORGANIZATION', null, superAdmin.id);
    await assignOnce(redirect.id, org.id, 'GROUP', group.id, superAdmin.id);
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
