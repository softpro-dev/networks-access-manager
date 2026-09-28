import { execSync } from 'node:child_process';

/** When TEST_DATABASE_URL is set, rebuild that (disposable!) database from the migrations once per run. */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    console.warn('\n[integration] TEST_DATABASE_URL not set: integration tests are SKIPPED (see docs/testing.md).\n');
    return;
  }
  execSync('npx prisma migrate reset --force --skip-seed --skip-generate', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
}
