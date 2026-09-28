import { z } from 'zod';

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

const WEAK_SECRETS = new Set(['change_me', 'changeme', 'secret', 'password']);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
    JWT_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
    AGENT_REGISTRATION_TOKEN: z.string().optional().default(''),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    TRUST_PROXY: z.string().optional().default('false'),
    TLS_CERT_PATH: z.string().optional(),
    TLS_KEY_PATH: z.string().optional(),
    CORS_ORIGIN: csv,
    HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
    MANAGEMENT_HOSTNAMES: csv,
    DEVICE_CREDENTIAL_TTL_DAYS: z.coerce.number().int().min(0).max(3650).default(0),
    LOGIN_LOCKOUT_THRESHOLD: z.coerce.number().int().min(0).max(1000).default(10),
    LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
    RATE_LIMIT_ENABLED: boolish.default(true),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (env.JWT_SECRET.length < 32 || WEAK_SECRETS.has(env.JWT_SECRET.toLowerCase())) {
        ctx.addIssue({ code: 'custom', path: ['JWT_SECRET'], message: 'JWT_SECRET must be at least 32 characters in production' });
      }
      if (env.AGENT_REGISTRATION_TOKEN && (env.AGENT_REGISTRATION_TOKEN.length < 16 || WEAK_SECRETS.has(env.AGENT_REGISTRATION_TOKEN.toLowerCase()))) {
        ctx.addIssue({ code: 'custom', path: ['AGENT_REGISTRATION_TOKEN'], message: 'AGENT_REGISTRATION_TOKEN must be at least 16 characters in production (or empty to require per-organization tokens)' });
      }
    }
    if (Boolean(env.TLS_CERT_PATH) !== Boolean(env.TLS_KEY_PATH)) {
      ctx.addIssue({ code: 'custom', path: ['TLS_CERT_PATH'], message: 'TLS_CERT_PATH and TLS_KEY_PATH must be set together' });
    }
  });

export type TrustProxy = boolean | number | string[];

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  host: string;
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  jwtTtlSeconds: number;
  agentRegistrationToken: string;
  logLevel: string;
  trustProxy: TrustProxy;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  corsOrigins: string[];
  heartbeatIntervalSeconds: number;
  managementHostnames: string[];
  deviceCredentialTtlDays: number;
  loginLockoutThreshold: number;
  loginLockoutMinutes: number;
  rateLimitEnabled: boolean;
}

function parseTrustProxy(raw: string): TrustProxy {
  const v = raw.trim().toLowerCase();
  if (v === '' || v === 'false' || v === '0') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export class ConfigError extends Error {}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    jwtSecret: e.JWT_SECRET,
    jwtTtlSeconds: e.JWT_TTL_SECONDS,
    agentRegistrationToken: e.AGENT_REGISTRATION_TOKEN,
    logLevel: e.LOG_LEVEL,
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    ...(e.TLS_CERT_PATH ? { tlsCertPath: e.TLS_CERT_PATH } : {}),
    ...(e.TLS_KEY_PATH ? { tlsKeyPath: e.TLS_KEY_PATH } : {}),
    corsOrigins: e.CORS_ORIGIN,
    heartbeatIntervalSeconds: e.HEARTBEAT_INTERVAL_SECONDS,
    managementHostnames: e.MANAGEMENT_HOSTNAMES,
    deviceCredentialTtlDays: e.DEVICE_CREDENTIAL_TTL_DAYS,
    loginLockoutThreshold: e.LOGIN_LOCKOUT_THRESHOLD,
    loginLockoutMinutes: e.LOGIN_LOCKOUT_MINUTES,
    rateLimitEnabled: e.RATE_LIMIT_ENABLED,
  };
}
