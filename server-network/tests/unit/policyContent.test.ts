import { describe, expect, it } from 'vitest';
import { MAX_DOMAIN_ENTRIES, MAX_IP_ENTRIES, validatePolicyContent } from '../../src/domain/policyContent.js';
import { validateIpOrCidr } from '../../src/domain/ipCidr.js';

describe('policy content schema', () => {
  it('fills all 9 fields with defaults', () => {
    const r = validatePolicyContent({ blocked_domains: ['Example.com.'] });
    expect(r.valid).toBe(true);
    expect(Object.keys(r.content!).sort()).toEqual(
      ['allowed_domains', 'block_doh', 'block_dot', 'block_quic', 'blocked_domains', 'blocked_ips', 'default_action', 'enabled', 'enforce_browser_policies'],
    );
    expect(r.content!.blocked_domains).toEqual(['example.com']);
  });
  it('rejects unknown keys', () => {
    const r = validatePolicyContent({ enabled: true, block_http3: true });
    expect(r.valid).toBe(false);
    expect(r.errors[0]!.message).toMatch(/unrecognized/i);
  });
  it('rejects wrong types and invalid enum', () => {
    expect(validatePolicyContent({ enabled: 'yes' }).valid).toBe(false);
    expect(validatePolicyContent({ default_action: 'deny' }).valid).toBe(false);
    expect(validatePolicyContent([]).valid).toBe(false);
    expect(validatePolicyContent('x').valid).toBe(false);
  });
  it('reports invalid domain entries with their index', () => {
    const r = validatePolicyContent({ blocked_domains: ['ok.com', '1.2.3.4', 'x.com:443'] });
    expect(r.valid).toBe(false);
    expect(r.errors.map((e) => e.path)).toEqual(['blocked_domains.1', 'blocked_domains.2']);
  });
  it('stores IDN patterns as A-labels', () => {
    expect(validatePolicyContent({ allowed_domains: ['bücher.de'] }).content!.allowed_domains).toEqual(['xn--bcher-kva.de']);
  });
  it('enforces list limits', () => {
    const many = Array.from({ length: MAX_DOMAIN_ENTRIES + 1 }, (_, i) => `d${i}.example.com`);
    expect(validatePolicyContent({ blocked_domains: many }).valid).toBe(false);
    expect(validatePolicyContent({ blocked_domains: many.slice(0, MAX_DOMAIN_ENTRIES) }).valid).toBe(true);
    const ips = Array.from({ length: MAX_IP_ENTRIES + 1 }, (_, i) => `10.0.${i >> 8}.${i & 255}`);
    expect(validatePolicyContent({ blocked_ips: ips }).valid).toBe(false);
  });
  it('warns on duplicates, allow/block conflicts, and blocking the management host', () => {
    const r = validatePolicyContent(
      { allowed_domains: ['a.com', 'a.com'], blocked_domains: ['a.com', '*.example.com'] },
      ['mgmt.example.com'],
    );
    expect(r.valid).toBe(true);
    const msgs = r.warnings.map((w) => w.message).join('\n');
    expect(msgs).toMatch(/duplicate/);
    expect(msgs).toMatch(/both allowed_domains and blocked_domains/);
    expect(msgs).toMatch(/management host "mgmt.example.com"/);
  });
  it('warns when default block would hit the management host', () => {
    const r = validatePolicyContent({ default_action: 'block', allowed_domains: ['company.com'] }, ['mgmt.example.com']);
    expect(r.warnings.some((w) => w.path === 'default_action')).toBe(true);
  });
});

describe('blocked_ips', () => {
  it.each(['203.0.113.0/24', '203.0.113.7', '2001:db8::/32', '2001:db8::1', '::/0', '0.0.0.0/0', '::ffff:1.2.3.4', '10.0.0.0/8'])('accepts %s', (s) => {
    expect(validateIpOrCidr(s).ok).toBe(true);
  });
  it.each(['203.0.113.5/24', '2001:db8::1/32', '1.2.3.4/33', '::/129', '010.0.0.1', 'fe80::1%eth0', 'example.com', '1.2.3', '1.2.3.4/', '1.2.3.4/08', ''])('rejects %s', (s) => {
    expect(validateIpOrCidr(s).ok).toBe(false);
  });
  it('lowercases IPv6', () => {
    expect(validateIpOrCidr('2001:DB8::/32')).toEqual({ ok: true, value: '2001:db8::/32' });
  });
});
