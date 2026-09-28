/**
 * Domain-pattern normalization, validation and matching (wire contract §5).
 * Pure module: no I/O. The Windows agent implements the same rules independently.
 */
import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';

export const MAX_DOMAIN_LENGTH = 253;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// eslint-disable-next-line no-control-regex
const NON_ASCII_RE = /[^\x00-\x7f]/;

/**
 * Contract §5 normalization: trim, lowercase, drop ONE trailing dot, IDNA → A-labels.
 * A leading `*.` wildcard prefix is preserved verbatim. Returns null if IDNA conversion fails.
 */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (s.endsWith('.')) s = s.slice(0, -1);
  if (!NON_ASCII_RE.test(s)) return s;
  const wildcard = s.startsWith('*.');
  const body = wildcard ? s.slice(2) : s;
  const ascii = domainToASCII(body);
  if (!ascii) return null;
  return (wildcard ? '*.' : '') + ascii.toLowerCase();
}

export type PatternResult =
  | { ok: true; value: string; wildcard: boolean }
  | { ok: false; error: string };

function checkHostname(host: string, minLabels: number): string | null {
  const labels = host.split('.');
  if (labels.length < minLabels) return 'must contain at least two labels';
  for (const label of labels) {
    if (label.length === 0) return 'empty label';
    if (label.length > 63) return 'label longer than 63 characters';
    if (!LABEL_RE.test(label)) return `invalid label "${label}" (allowed: a-z, 0-9, "-", not leading/trailing)`;
  }
  return null;
}

function looksLikeIp(s: string): boolean {
  const unbracketed = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
  return isIP(unbracketed) !== 0;
}

/** Validate + normalize a domain pattern for allowed_domains / blocked_domains. */
export function validateDomainPattern(input: unknown): PatternResult {
  if (typeof input !== 'string') return { ok: false, error: 'must be a string' };
  const raw = input.trim();
  if (raw.length === 0) return { ok: false, error: 'must not be empty' };
  if (raw.length > 1024) return { ok: false, error: 'too long' };
  if (raw.includes('://')) return { ok: false, error: 'must not contain a scheme' };
  if (looksLikeIp(raw)) return { ok: false, error: 'IP literals are not allowed in domain lists (use blocked_ips)' };
  if (/[/?#]/.test(raw)) return { ok: false, error: 'must not contain a path, query or fragment' };
  if (raw.includes('@')) return { ok: false, error: 'must not contain "@"' };
  if (raw.includes(':')) return { ok: false, error: 'must not contain a port' };
  if (/\s/.test(raw)) return { ok: false, error: 'must not contain whitespace' };

  const value = normalizeDomain(raw);
  if (value === null || value.length === 0) return { ok: false, error: 'invalid internationalized domain name' };
  if (looksLikeIp(value)) return { ok: false, error: 'IP literals are not allowed in domain lists (use blocked_ips)' };
  if (value.length > MAX_DOMAIN_LENGTH) return { ok: false, error: `longer than ${MAX_DOMAIN_LENGTH} characters` };

  let wildcard = false;
  let host = value;
  if (value.includes('*')) {
    if (!value.startsWith('*.') || value.indexOf('*', 1) !== -1) {
      return { ok: false, error: 'the only allowed wildcard form is a leading "*."' };
    }
    wildcard = true;
    host = value.slice(2);
  }
  const hostErr = checkHostname(host, 2);
  if (hostErr) return { ok: false, error: hostErr };
  return { ok: true, value, wildcard };
}

/** Normalize a queried name (no wildcards allowed). Returns null if it is not a valid hostname. */
export function normalizeQueryName(input: string): string | null {
  const v = normalizeDomain(input);
  if (!v || v.includes('*') || v.length > MAX_DOMAIN_LENGTH || looksLikeIp(v)) return null;
  return checkHostname(v, 1) === null ? v : null;
}

/** Does an already-normalized pattern match an already-normalized name? (whole-label semantics) */
export function patternMatches(pattern: string, name: string): boolean {
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    return name.length > base.length + 1 && name.endsWith('.' + base);
  }
  return pattern === name;
}

/** Specificity key (label_count, is_exact); `*` counts as a label. */
export function specificity(pattern: string): [number, number] {
  return [pattern.split('.').length, pattern.startsWith('*.') ? 0 : 1];
}

function compareSpec(a: [number, number], b: [number, number]): number {
  return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];
}

export function isManagementHost(name: string, managementHosts: readonly string[]): boolean {
  for (const h of managementHosts) {
    const host = normalizeDomain(h);
    if (!host) continue;
    if (name === host || name.endsWith('.' + host)) return true;
  }
  return false;
}

export interface DecisionContent {
  enabled?: boolean;
  default_action: 'allow' | 'block';
  allowed_domains: readonly string[];
  blocked_domains: readonly string[];
}

export interface Decision {
  action: 'allow' | 'block';
  reason: 'management' | 'rule' | 'tie' | 'default' | 'disabled' | 'invalid_name';
  pattern?: string;
  list?: 'allowed' | 'blocked';
}

/**
 * Decision for a queried name (contract §5). Patterns are assumed normalized (as stored).
 * The server never filters traffic; this powers the validator and the preview endpoint.
 */
export function decide(nameInput: string, content: DecisionContent, managementHosts: readonly string[] = []): Decision {
  const name = normalizeQueryName(nameInput);
  if (name === null) return { action: content.default_action, reason: 'invalid_name' };
  if (isManagementHost(name, managementHosts)) return { action: 'allow', reason: 'management' };
  if (content.enabled === false) return { action: 'allow', reason: 'disabled' };

  let bestAllow: { p: string; s: [number, number] } | null = null;
  let bestBlock: { p: string; s: [number, number] } | null = null;
  for (const p of content.allowed_domains) {
    if (patternMatches(p, name)) {
      const s = specificity(p);
      if (!bestAllow || compareSpec(s, bestAllow.s) > 0) bestAllow = { p, s };
    }
  }
  for (const p of content.blocked_domains) {
    if (patternMatches(p, name)) {
      const s = specificity(p);
      if (!bestBlock || compareSpec(s, bestBlock.s) > 0) bestBlock = { p, s };
    }
  }
  if (!bestAllow && !bestBlock) return { action: content.default_action, reason: 'default' };
  if (bestAllow && !bestBlock) return { action: 'allow', reason: 'rule', pattern: bestAllow.p, list: 'allowed' };
  if (bestBlock && !bestAllow) return { action: 'block', reason: 'rule', pattern: bestBlock.p, list: 'blocked' };
  const cmp = compareSpec(bestAllow!.s, bestBlock!.s);
  if (cmp > 0) return { action: 'allow', reason: 'rule', pattern: bestAllow!.p, list: 'allowed' };
  if (cmp < 0) return { action: 'block', reason: 'rule', pattern: bestBlock!.p, list: 'blocked' };
  return { action: 'block', reason: 'tie', pattern: bestBlock!.p, list: 'blocked' };
}
