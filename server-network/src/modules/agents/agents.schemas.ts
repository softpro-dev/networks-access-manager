/** Zod schemas for the agent wire contract (docs/api-contract.md). Unknown body keys are stripped, never stored. */
import { z } from 'zod';
import { isIP, isIPv4, isIPv6 } from 'node:net';
import { ORG_CODE_RE, POLICY_CODE_RE } from '../../utils/http.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = z.string().trim().toLowerCase().regex(UUID_RE, 'Must be a UUID');
const hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'Must be 64 lowercase hex characters');
const MAC_RE = /^[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}$/;

const ipv6WithOptionalZone = z.string().max(64).refine((s) => isIPv6(s.split('%')[0]!), 'Must be an IPv6 address');

export const interfaceSchema = z.object({
  name: z.string().min(1).max(256),
  mac: z.string().regex(MAC_RE, 'Must be a MAC address').nullish(),
  ipv4: z.array(z.string().refine((s) => isIPv4(s), 'Must be an IPv4 address')).max(16).default([]),
  ipv6: z.array(ipv6WithOptionalZone).max(16).default([]),
  type: z.enum(['ethernet', 'wifi', 'virtual', 'vpn', 'loopback', 'other']),
  is_primary: z.boolean().default(false),
});

export const registerBody = z.object({
  organization_id: z.string().regex(ORG_CODE_RE, 'Must match ^[A-Z0-9][A-Z0-9-]{1,31}$'),
  device_uuid: uuid,
  hostname: z.string().trim().min(1).max(255),
  windows_version: z.string().trim().min(1).max(200),
  agent_version: z.string().trim().min(1).max(50),
  enrollment_secret_hash: hex64,
  interfaces: z.array(interfaceSchema).max(32).default([]),
});
export type RegisterBody = z.infer<typeof registerBody>;

export const registrationStatusHeaders = z.object({
  'x-device-uuid': uuid,
  'x-enrollment-secret': z.string().min(16).max(256),
});

export const heartbeatBody = z.object({
  device_uuid: uuid,
  agent_version: z.string().trim().min(1).max(50),
  current_policy_version: z.number().int().min(0),
  current_ip: z
    .string()
    .max(64)
    .refine((s) => isIP(s.split('%')[0]!) !== 0, 'Must be an IP address')
    .nullable(),
  status: z.enum(['HEALTHY', 'DEGRADED', 'ENFORCEMENT_ERROR', 'STARTING']),
});

export const policyStatusBody = z.object({
  policy_id: z.string().regex(POLICY_CODE_RE),
  version: z.number().int().min(0),
  status: z.enum(['DOWNLOADED', 'VALIDATION_FAILED', 'APPLYING', 'APPLIED', 'FAILED', 'ROLLED_BACK']),
  error_code: z
    .enum(['policy_validation_failed', 'policy_apply_failed', 'enforcement_verify_failed', 'management_unreachable', 'rollback_failed'])
    .nullish(),
  message: z.string().max(1000).nullish(),
  active_policy_id: z.string().regex(POLICY_CODE_RE).nullish(),
  active_version: z.number().int().min(0).nullish(),
});

export const ackBody = z.object({
  policy_id: z.string().regex(POLICY_CODE_RE),
  version: z.number().int().min(1),
  content_sha256: hex64,
});
