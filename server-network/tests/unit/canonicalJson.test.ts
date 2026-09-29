import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalSha256 } from '../../src/domain/canonicalJson.js';
import { DEFAULT_POLICY_CONTENT, validatePolicyContent } from '../../src/domain/policyContent.js';
import { ifNoneMatchSatisfied, makePolicyEtag } from '../../src/domain/etag.js';

// Shared cross-implementation vector (os-apps must produce the same digest).
const CONTRACT_CONTENT = {
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
const CONTRACT_CANONICAL =
  '{"allowed_domains":["company.com","*.company.com"],"block_doh":true,"block_dot":true,"block_quic":true,"blocked_domains":["example.com","*.example.com"],"blocked_ips":["203.0.113.0/24","2001:db8::/32"],"default_action":"allow","enabled":true,"enforce_browser_policies":true}';
const CONTRACT_SHA = '0587ffd890ccf836680f39fafb4740e3bf94185e7b8d8f26c6502560e14775cf';
const DEFAULTS_SHA = 'b45d676bdcb5b8b2ff0ccc8ccaab1ff54c3214c6d694642f659db69e80b293b9';

describe('canonical JSON (§4)', () => {
  it('sorts keys recursively, no whitespace, keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,1,2]},"b":1}');
    expect(canonicalJson([{ z: null, y: false }])).toBe('[{"y":false,"z":null}]');
  });
  it('emits non-ASCII as raw UTF-8 like Python ensure_ascii=False', () => {
    expect(canonicalJson({ k: 'bücher' })).toBe('{"k":"bücher"}');
    expect(canonicalJson({ k: 'a"b\\c\n' })).toBe('{"k":"a\\"b\\\\c\\n"}');
  });
  it('sorts keys by code point', () => {
    expect(canonicalJson({ b: 1, B: 2, a: 3, '\u{1F600}': 4, '￿': 5 })).toBe('{"B":2,"a":3,"b":1,"￿":5,"\u{1F600}":4}');
  });
  it('rejects floats and non-finite numbers', () => {
    expect(() => canonicalJson({ a: 1.5 })).toThrow();
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });
  it('fixed test vector: contract §4 example content', () => {
    const r = validatePolicyContent(CONTRACT_CONTENT);
    expect(r.valid).toBe(true);
    expect(canonicalJson(r.content)).toBe(CONTRACT_CANONICAL);
    expect(canonicalSha256(r.content)).toBe(CONTRACT_SHA);
    expect(r.content_sha256).toBe(CONTRACT_SHA);
  });
  it('fixed test vector: all-defaults content', () => {
    const r = validatePolicyContent({});
    expect(r.content).toEqual(DEFAULT_POLICY_CONTENT);
    expect(canonicalSha256(r.content)).toBe(DEFAULTS_SHA);
  });
  it('hash is independent of input key order and defaults are filled before hashing', () => {
    const shuffled = Object.fromEntries(Object.entries(CONTRACT_CONTENT).reverse());
    expect(validatePolicyContent(shuffled).content_sha256).toBe(CONTRACT_SHA);
    // Omitting fields that equal defaults yields the same stored content + hash.
    const { block_quic: _a, block_dot: _b, enabled: _c, ...partial } = CONTRACT_CONTENT;
    expect(validatePolicyContent(partial).content_sha256).toBe(CONTRACT_SHA);
  });
});

describe('ETag (§3)', () => {
  it('formats "<policy_id>:<version>:<sha8>" with quotes', () => {
    expect(makePolicyEtag('POL-001', 7, CONTRACT_SHA)).toBe('"POL-001:7:0587ffd8"');
    expect(makePolicyEtag('POL-001', 7, '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')).toBe('"POL-001:7:9f86d081"');
  });
  it('If-None-Match comparison', () => {
    const e = '"POL-001:7:9f86d081"';
    expect(ifNoneMatchSatisfied(e, e)).toBe(true);
    expect(ifNoneMatchSatisfied(`W/${e}`, e)).toBe(true);
    expect(ifNoneMatchSatisfied(`"x", ${e}`, e)).toBe(true);
    expect(ifNoneMatchSatisfied('*', e)).toBe(true);
    expect(ifNoneMatchSatisfied('"POL-001:6:9f86d081"', e)).toBe(false);
    expect(ifNoneMatchSatisfied('POL-001:7:9f86d081', e)).toBe(false);
    expect(ifNoneMatchSatisfied(undefined, e)).toBe(false);
  });
});
