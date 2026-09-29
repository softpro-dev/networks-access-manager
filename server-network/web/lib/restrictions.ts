// Restriction (= policy) kinds and the content fields each kind may use (mirrors KIND_FIELDS in
// src/modules/policies/policies.service.ts; the API rejects other fields).
import type { Tone } from '@/components/ui';
import type { AssignmentScope, PolicyContent, RestrictionKind } from './types';

export const KINDS: RestrictionKind[] = ['ALLOW_ONLY', 'BLACKLIST', 'REDIRECT'];

export const KIND_INFO: Record<RestrictionKind, { label: string; tone: Tone; css: string; description: string }> = {
  ALLOW_ONLY: {
    label: 'Allow Only',
    tone: 'green',
    css: 'kind-allow',
    description: 'Only the listed websites can be visited; everything else is blocked.',
  },
  BLACKLIST: {
    label: 'Black List',
    tone: 'red',
    css: 'kind-block',
    description: 'The listed websites (and optional IP ranges) are blocked; everything else is allowed.',
  },
  REDIRECT: {
    label: 'Redirection',
    tone: 'violet',
    css: 'kind-redirect',
    description: 'Visits to a website are sent to another host instead.',
  },
};

export const VIA_LABEL: Record<AssignmentScope, string> = {
  ORGANIZATION: 'Whole organization',
  GROUP: 'Group',
  DEVICE: 'Direct',
};

export const PROTOCOL_TOGGLES: { key: 'block_quic' | 'block_dot' | 'block_doh' | 'enforce_browser_policies'; label: string; hint: string }[] = [
  { key: 'block_quic', label: 'Block QUIC (UDP 443)', hint: 'Forces browsers back to TCP/TLS so website rules apply.' },
  { key: 'block_dot', label: 'Block DNS-over-TLS (853)', hint: 'Prevents bypassing the local resolver.' },
  { key: 'block_doh', label: 'Block DNS-over-HTTPS', hint: 'Blocks well-known DoH endpoints.' },
  { key: 'enforce_browser_policies', label: 'Enforce browser policies', hint: 'Applies managed browser settings (e.g. disable built-in DoH).' },
];

export const DEFAULT_CONTENT: PolicyContent = {
  enabled: true,
  default_action: 'allow',
  allowed_domains: [],
  blocked_domains: [],
  blocked_ips: [],
  block_quic: true,
  block_dot: true,
  block_doh: true,
  enforce_browser_policies: true,
};

/** Number of rules in a restriction's content (for list summaries). */
export function ruleCount(kind: RestrictionKind, c: Partial<PolicyContent> | undefined | null): number {
  if (!c) return 0;
  if (kind === 'ALLOW_ONLY') return c.allowed_domains?.length ?? 0;
  if (kind === 'BLACKLIST') return (c.blocked_domains?.length ?? 0) + (c.blocked_ips?.length ?? 0);
  return c.redirect_rules?.length ?? 0;
}
