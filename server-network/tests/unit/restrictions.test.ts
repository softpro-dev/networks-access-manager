import { describe, expect, it } from 'vitest';
import { mergeRestrictions, type RestrictionInput } from '../../src/domain/mergeRestrictions.js';
import { validatePolicyContent } from '../../src/domain/policyContent.js';
import { canonicalSha256 } from '../../src/domain/canonicalJson.js';
import { decide } from '../../src/domain/domainPattern.js';
import { normalizeMac } from '../../src/domain/mac.js';

const content = (input: Record<string, unknown>) => {
  const r = validatePolicyContent(input);
  if (!r.content) throw new Error(JSON.stringify(r.errors));
  return r.content;
};

const r = (code: string, kind: RestrictionInput['kind'], c: Record<string, unknown>, via: RestrictionInput['via'] = 'DEVICE'): RestrictionInput => ({
  policy_id: `id-${code}`,
  code,
  kind,
  version: 1,
  via,
  content: content(c),
});

describe('normalizeMac', () => {
  it('accepts common notations', () => {
    expect(normalizeMac('aa-bb-cc-dd-ee-ff')).toBe('AA:BB:CC:DD:EE:FF');
    expect(normalizeMac('aabb.ccdd.eeff')).toBe('AA:BB:CC:DD:EE:FF');
    expect(normalizeMac(' 00:1a:2b:3c:4d:5e ')).toBe('00:1A:2B:3C:4D:5E');
  });
  it('rejects junk, all-zero and broadcast', () => {
    for (const bad of ['', 'zz:bb:cc:dd:ee:ff', 'AA:BB:CC', '00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff']) expect(normalizeMac(bad)).toBeNull();
  });
});

describe('redirect_rules content', () => {
  it('is omitted when empty, so the contract §4 hash vector is unchanged', () => {
    const c = content({
      allowed_domains: ['company.com', '*.company.com'],
      blocked_domains: ['example.com', '*.example.com'],
      blocked_ips: ['203.0.113.0/24', '2001:db8::/32'],
      redirect_rules: [],
    });
    expect('redirect_rules' in c).toBe(false);
    expect(canonicalSha256(c)).toBe('0587ffd890ccf836680f39fafb4740e3bf94185e7b8d8f26c6502560e14775cf');
  });
  it('normalizes and validates rules', () => {
    expect(content({ redirect_rules: [{ from: 'Games.Example.COM.', to: 'intranet.company.com' }] }).redirect_rules).toEqual([
      { from: 'games.example.com', to: 'intranet.company.com' },
    ]);
    for (const bad of [
      [{ from: 'a.com', to: '*.b.com' }],
      [{ from: 'a.com', to: 'a.com' }],
      [{ from: 'a.com' }],
      [{ from: 'a.com', to: 'b.com', extra: 1 }],
    ]) {
      expect(validatePolicyContent({ redirect_rules: bad }).valid).toBe(false);
    }
  });
  it('decide(): redirect wins on specificity, loses a tie to block, beats allow', () => {
    const c = content({
      allowed_domains: ['*.example.com'],
      blocked_domains: ['bad.example.com'],
      redirect_rules: [
        { from: 'games.example.com', to: 'intranet.company.com' },
        { from: 'bad.example.com', to: 'intranet.company.com' },
      ],
    });
    expect(decide('games.example.com', c)).toMatchObject({ action: 'redirect', target: 'intranet.company.com' });
    expect(decide('bad.example.com', c)).toMatchObject({ action: 'block', reason: 'tie' });
    expect(decide('news.example.com', c)).toMatchObject({ action: 'allow' });
    expect(decide('intranet.company.com', { ...c, default_action: 'block' })).toMatchObject({ action: 'allow' });
  });
});

describe('mergeRestrictions', () => {
  it('returns null when nothing (enabled) applies', () => {
    expect(mergeRestrictions([])).toBeNull();
    expect(mergeRestrictions([r('A', 'BLACKLIST', { enabled: false, blocked_domains: ['x.com'] })])).toBeNull();
  });

  it('blacklists only → default allow with the union of blocked lists, sorted and de-duplicated', () => {
    const m = mergeRestrictions([
      r('B', 'BLACKLIST', { blocked_domains: ['z.com', 'a.com'], blocked_ips: ['203.0.113.0/24'] }, 'GROUP'),
      r('A', 'BLACKLIST', { blocked_domains: ['a.com', 'm.com'] }, 'ORGANIZATION'),
    ])!;
    expect(m.content.default_action).toBe('allow');
    expect(m.content.blocked_domains).toEqual(['a.com', 'm.com', 'z.com']);
    expect(m.content.blocked_ips).toEqual(['203.0.113.0/24']);
    expect(m.sources.map((s) => s.code)).toEqual(['A', 'B']);
  });

  it('any Allow Only switches to allowlist mode and allows redirect targets', () => {
    const m = mergeRestrictions([
      r('ALLOW', 'ALLOW_ONLY', { allowed_domains: ['company.com', '*.company.com'] }),
      r('BLOCK', 'BLACKLIST', { blocked_domains: ['bad.company.com'] }),
      r('REDIR', 'REDIRECT', { redirect_rules: [{ from: 'games.com', to: 'learn.school.org' }] }),
    ])!;
    expect(m.content.default_action).toBe('block');
    expect(m.content.allowed_domains).toEqual(['*.company.com', 'company.com', 'learn.school.org']);
    expect(m.content.redirect_rules).toEqual([{ from: 'games.com', to: 'learn.school.org' }]);
    expect(decide('bad.company.com', m.content)).toMatchObject({ action: 'block' });
    expect(decide('games.com', m.content)).toMatchObject({ action: 'redirect' });
    expect(decide('other.org', m.content)).toMatchObject({ action: 'block', reason: 'default' });
  });

  it('same redirect source in two restrictions → lowest code wins', () => {
    const m = mergeRestrictions([
      r('R2', 'REDIRECT', { redirect_rules: [{ from: 'x.com', to: 'two.com' }] }),
      r('R1', 'REDIRECT', { redirect_rules: [{ from: 'x.com', to: 'one.com' }] }),
    ])!;
    expect(m.content.redirect_rules).toEqual([{ from: 'x.com', to: 'one.com' }]);
  });

  it('a restriction reaching the device several ways counts once and lists every path', () => {
    const m = mergeRestrictions([
      r('A', 'BLACKLIST', { blocked_domains: ['a.com'] }, 'DEVICE'),
      r('A', 'BLACKLIST', { blocked_domains: ['a.com'] }, 'GROUP'),
    ])!;
    expect(m.sources).toEqual([{ policy_id: 'id-A', code: 'A', kind: 'BLACKLIST', version: 1, via: ['DEVICE', 'GROUP'] }]);
  });

  it('is deterministic regardless of input order (stable hash)', () => {
    const a = r('A', 'BLACKLIST', { blocked_domains: ['a.com'], block_quic: false });
    const b = r('B', 'ALLOW_ONLY', { allowed_domains: ['b.com'], block_quic: false });
    const c = r('C', 'REDIRECT', { redirect_rules: [{ from: 'c.com', to: 'd.com' }], block_quic: true });
    const h1 = canonicalSha256(mergeRestrictions([a, b, c])!.content);
    const h2 = canonicalSha256(mergeRestrictions([c, a, b])!.content);
    expect(h1).toBe(h2);
    expect(mergeRestrictions([a, b])!.content.block_quic).toBe(false);
    expect(mergeRestrictions([a, b, c])!.content.block_quic).toBe(true);
  });
});
