/** Policy content schema (contract §4) and validator. */
import { z } from 'zod';
import { decide, validateDomainPattern } from './domainPattern.js';
import { validateIpOrCidr } from './ipCidr.js';
import { canonicalSha256 } from './canonicalJson.js';

export const MAX_DOMAIN_ENTRIES = 5000;
export const MAX_IP_ENTRIES = 1000;

export interface PolicyContent {
  enabled: boolean;
  default_action: 'allow' | 'block';
  allowed_domains: string[];
  blocked_domains: string[];
  blocked_ips: string[];
  block_quic: boolean;
  block_dot: boolean;
  block_doh: boolean;
  enforce_browser_policies: boolean;
}

export const DEFAULT_POLICY_CONTENT: Readonly<PolicyContent> = Object.freeze({
  enabled: true,
  default_action: 'allow',
  allowed_domains: [],
  blocked_domains: [],
  blocked_ips: [],
  block_quic: true,
  block_dot: true,
  block_doh: true,
  enforce_browser_policies: true,
});

const domainEntry = z.string().transform((s, ctx) => {
  const r = validateDomainPattern(s);
  if (!r.ok) {
    ctx.addIssue({ code: 'custom', message: `"${s.slice(0, 80)}": ${r.error}` });
    return z.NEVER;
  }
  return r.value;
});

const ipEntry = z.string().transform((s, ctx) => {
  const r = validateIpOrCidr(s);
  if (!r.ok) {
    ctx.addIssue({ code: 'custom', message: `"${s.slice(0, 80)}": ${r.error}` });
    return z.NEVER;
  }
  return r.value;
});

/**
 * Input schema: unknown keys rejected, every field optional with the contract default.
 * Output is the full 9-field, normalized (A-label) content object that gets stored and hashed.
 */
export const policyContentSchema = z
  .object({
    enabled: z.boolean().default(true),
    default_action: z.enum(['allow', 'block']).default('allow'),
    allowed_domains: z.array(domainEntry).max(MAX_DOMAIN_ENTRIES).default([]),
    blocked_domains: z.array(domainEntry).max(MAX_DOMAIN_ENTRIES).default([]),
    blocked_ips: z.array(ipEntry).max(MAX_IP_ENTRIES).default([]),
    block_quic: z.boolean().default(true),
    block_dot: z.boolean().default(true),
    block_doh: z.boolean().default(true),
    enforce_browser_policies: z.boolean().default(true),
  })
  .strict();

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface PolicyValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  content: PolicyContent | null;
  content_sha256: string | null;
}

/** Order the object's keys deterministically (cosmetic; hashing canonicalizes anyway). */
export function orderContent(c: PolicyContent): PolicyContent {
  return {
    enabled: c.enabled,
    default_action: c.default_action,
    allowed_domains: [...c.allowed_domains],
    blocked_domains: [...c.blocked_domains],
    blocked_ips: [...c.blocked_ips],
    block_quic: c.block_quic,
    block_dot: c.block_dot,
    block_doh: c.block_doh,
    enforce_browser_policies: c.enforce_browser_policies,
  };
}

export function computeWarnings(c: PolicyContent, managementHosts: readonly string[]): ValidationIssue[] {
  const warnings: ValidationIssue[] = [];
  const dupes = (list: string[], field: string) => {
    const seen = new Set<string>();
    list.forEach((v, i) => {
      if (seen.has(v)) warnings.push({ path: `${field}.${i}`, message: `duplicate entry "${v}"` });
      seen.add(v);
    });
  };
  dupes(c.allowed_domains, 'allowed_domains');
  dupes(c.blocked_domains, 'blocked_domains');
  dupes(c.blocked_ips, 'blocked_ips');

  const allowed = new Set(c.allowed_domains);
  c.blocked_domains.forEach((v, i) => {
    if (allowed.has(v)) {
      warnings.push({ path: `blocked_domains.${i}`, message: `"${v}" is in both allowed_domains and blocked_domains; equal specificity resolves to BLOCK` });
    }
  });

  for (const host of managementHosts) {
    const policyWithoutException = decide(host, c, []);
    if (policyWithoutException.action === 'block' && policyWithoutException.reason !== 'invalid_name') {
      warnings.push({
        path: policyWithoutException.pattern ? 'blocked_domains' : 'default_action',
        message: `this policy would block management host "${host}"${policyWithoutException.pattern ? ` (pattern "${policyWithoutException.pattern}")` : ''}; the management exception overrides it on the agent`,
      });
    }
  }
  if (c.default_action === 'block' && c.allowed_domains.length === 0 && c.enabled) {
    warnings.push({ path: 'default_action', message: 'default_action "block" with no allowed_domains blocks every name except the management host' });
  }
  return warnings;
}

export function validatePolicyContent(input: unknown, managementHosts: readonly string[] = []): PolicyValidationResult {
  const r = policyContentSchema.safeParse(input ?? {});
  if (!r.success) {
    return {
      valid: false,
      errors: r.error.issues.slice(0, 200).map((i) => ({ path: i.path.join('.'), message: i.message })),
      warnings: [],
      content: null,
      content_sha256: null,
    };
  }
  const content = orderContent(r.data);
  return { valid: true, errors: [], warnings: computeWarnings(content, managementHosts), content, content_sha256: canonicalSha256(content) };
}
