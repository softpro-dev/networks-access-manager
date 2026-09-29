import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { scrubMetadata } from '../../src/services/audit.js';

const base = { DATABASE_URL: 'mysql://u:p@localhost:3306/db', JWT_SECRET: 'dev-secret', AGENT_REGISTRATION_TOKEN: 'CHANGE_ME' };

describe('config', () => {
  it('loads development defaults', () => {
    const c = loadConfig({ ...base });
    expect(c.port).toBe(3000);
    expect(c.jwtTtlSeconds).toBe(86_400);
    expect(c.heartbeatIntervalSeconds).toBe(60);
    expect(c.trustProxy).toBe(false);
    expect(c.corsOrigins).toEqual([]);
  });
  it('fails fast on weak JWT_SECRET in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), AGENT_REGISTRATION_TOKEN: 'CHANGE_ME' })).toThrow(/AGENT_REGISTRATION_TOKEN/);
    expect(loadConfig({ ...base, NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), AGENT_REGISTRATION_TOKEN: 'y'.repeat(32) }).nodeEnv).toBe('production');
  });
  it('requires DATABASE_URL and JWT_SECRET', () => {
    expect(() => loadConfig({ JWT_SECRET: 'x' })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: 'x' })).toThrow(/JWT_SECRET/);
  });
  it('parses TRUST_PROXY, lists and TLS pairing', () => {
    expect(loadConfig({ ...base, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ ...base, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(loadConfig({ ...base, TRUST_PROXY: '10.0.0.1, 10.0.0.2' }).trustProxy).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(loadConfig({ ...base, MANAGEMENT_HOSTNAMES: 'a.example.com, b.example.com' }).managementHostnames).toEqual(['a.example.com', 'b.example.com']);
    expect(() => loadConfig({ ...base, TLS_CERT_PATH: '/x' })).toThrow(/TLS/);
  });
});

describe('audit metadata scrubbing', () => {
  it('drops secret-looking keys recursively', () => {
    expect(scrubMetadata({ email: 'a', password: 'x', nested: { token: 't', ok: 1 }, credential_id: 'c', secret_hash: 'h' })).toEqual({
      email: 'a',
      nested: { ok: 1 },
      credential_id: 'c',
    });
  });
});
