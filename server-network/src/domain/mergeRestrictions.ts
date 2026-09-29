/**
 * Merge every restriction that reaches a device into the one effective policy content the agent
 * receives (policy_id "EFFECTIVE"). Pure and deterministic: the same inputs always produce the same
 * content (sorted, de-duplicated lists), so the content hash only changes when the rules change.
 *
 * - ALLOW_ONLY  → contributes allowed_domains; any ALLOW_ONLY switches default_action to "block".
 * - BLACKLIST   → contributes blocked_domains and blocked_ips.
 * - REDIRECT    → contributes redirect_rules; for the same `from`, the restriction with the lowest
 *                 code wins. In allow-only mode redirect targets are added to allowed_domains.
 * - The four protocol flags are OR-ed across the contributing restrictions.
 */
import type { RestrictionKind } from '@prisma/client';
import type { RedirectRule } from './domainPattern.js';
import { orderContent, type PolicyContent } from './policyContent.js';

export type AssignmentVia = 'ORGANIZATION' | 'GROUP' | 'DEVICE';

export interface RestrictionInput {
  policy_id: string;
  code: string;
  kind: RestrictionKind;
  version: number;
  via: AssignmentVia;
  content: PolicyContent;
}

export interface EffectiveSource {
  policy_id: string;
  code: string;
  kind: RestrictionKind;
  version: number;
  via: AssignmentVia[];
}

export interface MergedPolicy {
  content: PolicyContent;
  sources: EffectiveSource[];
}

const sortedUnique = (values: Iterable<string>) => [...new Set(values)].sort();

export function mergeRestrictions(inputs: readonly RestrictionInput[]): MergedPolicy | null {
  // One entry per restriction (it can reach the device through several assignments).
  const byPolicy = new Map<string, { input: RestrictionInput; via: Set<AssignmentVia> }>();
  for (const i of inputs) {
    if (!i.content.enabled) continue;
    const e = byPolicy.get(i.policy_id);
    if (e) e.via.add(i.via);
    else byPolicy.set(i.policy_id, { input: i, via: new Set([i.via]) });
  }
  if (byPolicy.size === 0) return null;

  const entries = [...byPolicy.values()].sort((a, b) => a.input.code.localeCompare(b.input.code));
  const allowed: string[] = [];
  const blocked: string[] = [];
  const ips: string[] = [];
  const redirects = new Map<string, string>();
  let allowOnly = false;
  const flags = { block_quic: false, block_dot: false, block_doh: false, enforce_browser_policies: false };

  for (const { input } of entries) {
    const c = input.content;
    if (input.kind === 'ALLOW_ONLY') {
      allowOnly = true;
      allowed.push(...c.allowed_domains);
    } else if (input.kind === 'BLACKLIST') {
      blocked.push(...c.blocked_domains);
      ips.push(...c.blocked_ips);
    } else {
      for (const r of c.redirect_rules ?? []) if (!redirects.has(r.from)) redirects.set(r.from, r.to);
    }
    flags.block_quic ||= c.block_quic;
    flags.block_dot ||= c.block_dot;
    flags.block_doh ||= c.block_doh;
    flags.enforce_browser_policies ||= c.enforce_browser_policies;
  }

  const redirectRules: RedirectRule[] = [...redirects.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([from, to]) => ({ from, to }));
  if (allowOnly) allowed.push(...redirectRules.map((r) => r.to));

  const content = orderContent({
    enabled: true,
    default_action: allowOnly ? 'block' : 'allow',
    allowed_domains: sortedUnique(allowed),
    blocked_domains: sortedUnique(blocked),
    blocked_ips: sortedUnique(ips),
    ...flags,
    redirect_rules: redirectRules,
  });
  const sources = entries.map(({ input, via }) => ({
    policy_id: input.policy_id,
    code: input.code,
    kind: input.kind,
    version: input.version,
    via: [...via].sort(),
  }));
  return { content, sources };
}
