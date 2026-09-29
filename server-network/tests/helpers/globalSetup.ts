import { execSync } from 'node:child_process';

/**
 * When TEST_DATABASE_URL is set, bring that (disposable!) database up to date with the migrations once
 * per run. Non-destructive by design (no `migrate reset`); each test empties the tables itself.
 */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    console.warn('\n[integration] TEST_DATABASE_URL not set: integration tests are SKIPPED (see docs/testing.md).\n');
    return;
  }
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
}
