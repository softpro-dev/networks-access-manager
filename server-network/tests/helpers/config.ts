import { loadConfig, type AppConfig } from '../../src/config/index.js';

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'mysql://nobody:nothing@127.0.0.1:1/none',
    JWT_SECRET: 'test-secret-test-secret-test-secret-123',
    AGENT_REGISTRATION_TOKEN: 'global-registration-token-for-tests',
    LOG_LEVEL: 'silent',
    MANAGEMENT_HOSTNAMES: 'mgmt.example.com',
    RATE_LIMIT_ENABLED: 'false',
    ...overrides,
  });
}
