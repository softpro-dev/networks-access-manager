/** Prints the canonical-JSON / sha256 / ETag test vectors shared with the Windows agent. */
import { canonicalJson, canonicalSha256 } from '../src/domain/canonicalJson.js';
import { validatePolicyContent } from '../src/domain/policyContent.js';
import { makePolicyEtag } from '../src/domain/etag.js';

const contractExample = {
  enabled: true,
  default_action: 'allow',
  allowed_domains: ['company.com', '*.company.com'],
  blocked_domains: ['example.com', '*.example.com'],
  blocked_ips: ['203.0.113.0/24', '2001:db8::/32'],
  block_quic: true,
  block_dot: true,
  block_doh: true,
  enforce_browser_policies: true,
};

for (const [label, input] of [
  ['contract §4 example content', contractExample],
  ['all defaults (input {})', {}],
] as const) {
  const r = validatePolicyContent(input);
  if (!r.content) throw new Error('invalid');
  const sha = canonicalSha256(r.content);
  console.log(`# ${label}`);
  console.log(canonicalJson(r.content));
  console.log(`sha256 = ${sha}`);
  console.log(`etag(POL-001, 7) = ${makePolicyEtag('POL-001', 7, sha)}\n`);
}
