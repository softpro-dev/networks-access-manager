import { describe, expect, it } from 'vitest';
import { decide, normalizeDomain, patternMatches, specificity, validateDomainPattern } from '../../src/domain/domainPattern.js';

const content = (allowed: string[], blocked: string[], default_action: 'allow' | 'block' = 'allow') => ({
  enabled: true,
  default_action,
  allowed_domains: allowed,
  blocked_domains: blocked,
});

describe('normalization (§5)', () => {
  it('trims, lowercases and removes exactly one trailing dot', () => {
    expect(normalizeDomain('  Example.COM.  ')).toBe('example.com');
    expect(normalizeDomain('example.com..')).toBe('example.com.');
  });
  it('converts IDN labels to A-labels', () => {
    expect(normalizeDomain('bücher.de')).toBe('xn--bcher-kva.de');
    expect(normalizeDomain('BÜCHER.de.')).toBe('xn--bcher-kva.de');
    expect(normalizeDomain('*.bücher.de')).toBe('*.xn--bcher-kva.de');
  });
});

describe('pattern validation (§5 syntax)', () => {
  const ok = (s: string, v: string) => {
    const r = validateDomainPattern(s);
    expect(r.ok, s).toBe(true);
    if (r.ok) expect(r.value).toBe(v);
  };
  const bad = (s: string) => expect(validateDomainPattern(s).ok, s).toBe(false);

  it('accepts and normalizes valid patterns', () => {
    ok('example.com', 'example.com');
    ok('Example.com.', 'example.com');
    ok('*.example.com', '*.example.com');
    ok('bücher.de', 'xn--bcher-kva.de');
    ok('a-b.example.co.uk', 'a-b.example.co.uk');
    ok('xn--bcher-kva.de', 'xn--bcher-kva.de');
  });
  it('rejects single labels', () => {
    bad('com');
    bad('localhost');
    bad('*.com');
  });
  it('rejects misplaced wildcards', () => {
    bad('*');
    bad('*example.com');
    bad('ex*.com');
    bad('a.*.example.com');
    bad('*.*.example.com');
    bad('example.*');
  });
  it('rejects IP literals', () => {
    bad('192.168.1.1');
    bad('2001:db8::1');
    bad('[2001:db8::1]');
    bad('::1');
  });
  it('rejects scheme, port, path and @', () => {
    bad('https://x.com/');
    bad('http://x.com');
    bad('x.com:443');
    bad('x.com/path');
    bad('user@x.com');
    bad('x.com?q=1');
  });
  it('enforces label and length rules', () => {
    bad('-a.com');
    bad('a-.com');
    bad('a..com');
    bad('a_b.com');
    bad('a b.com');
    bad('');
    bad('   ');
    bad(`${'a'.repeat(64)}.com`);
    ok(`${'a'.repeat(63)}.com`, `${'a'.repeat(63)}.com`);
    const max = Array.from({ length: 50 }, () => 'abcd').join('.') + '.com';
    expect(max.length).toBe(253);
    ok(max, max);
    bad('x' + max); // 254 chars
  });
});

describe('matching (§5)', () => {
  it('exact matches only itself', () => {
    expect(patternMatches('example.com', 'example.com')).toBe(true);
    expect(patternMatches('example.com', 'a.example.com')).toBe(false);
  });
  it('wildcard matches one or more extra labels but not the apex', () => {
    expect(patternMatches('*.example.com', 'a.example.com')).toBe(true);
    expect(patternMatches('*.example.com', 'a.b.example.com')).toBe(true);
    expect(patternMatches('*.example.com', 'example.com')).toBe(false);
  });
  it('matches whole labels only', () => {
    expect(patternMatches('*.example.com', 'badexample.com')).toBe(false);
    expect(patternMatches('example.com', 'badexample.com')).toBe(false);
  });
  it('specificity counts * as a label', () => {
    expect(specificity('*.example.com')).toEqual([3, 0]);
    expect(specificity('a.example.com')).toEqual([3, 1]);
    expect(specificity('example.com')).toEqual([2, 1]);
  });
});

describe('decide (§5 decision)', () => {
  it('contract example: exact a.example.com (3,1) beats *.example.com (3,0)', () => {
    expect(decide('a.example.com', content(['a.example.com'], ['*.example.com'])).action).toBe('allow');
    expect(decide('a.example.com', content(['*.example.com'], ['a.example.com'])).action).toBe('block');
  });
  it('contract example: *.b.example.com (4,0) beats *.example.com (3,0)', () => {
    const d = decide('x.b.example.com', content(['*.b.example.com'], ['*.example.com']));
    expect(d).toMatchObject({ action: 'allow', pattern: '*.b.example.com' });
    expect(decide('x.b.example.com', content(['*.example.com'], ['*.b.example.com'])).action).toBe('block');
  });
  it('tie between allow and block of equal specificity → BLOCK', () => {
    expect(decide('example.com', content(['example.com'], ['example.com']))).toMatchObject({ action: 'block', reason: 'tie' });
    expect(decide('a.example.com', content(['*.example.com'], ['*.example.com'])).action).toBe('block');
  });
  it('no match → default_action', () => {
    expect(decide('other.org', content([], ['example.com'])).action).toBe('allow');
    expect(decide('other.org', content(['company.com'], [], 'block'))).toMatchObject({ action: 'block', reason: 'default' });
  });
  it('contract policy example', () => {
    const c = content(['company.com', '*.company.com'], ['example.com', '*.example.com']);
    expect(decide('example.com', c).action).toBe('block');
    expect(decide('www.example.com', c).action).toBe('block');
    expect(decide('badexample.com', c).action).toBe('allow');
    expect(decide('mail.company.com', c).action).toBe('allow');
  });
  it('normalizes the queried name (case, trailing dot, IDN)', () => {
    expect(decide('WWW.Example.COM.', content([], ['*.example.com'])).action).toBe('block');
    expect(decide('shop.bücher.de', content([], ['*.xn--bcher-kva.de'])).action).toBe('block');
  });
  it('management host (and subdomains) always allowed, cannot be overridden', () => {
    const c = content([], ['*.example.com', 'example.com'], 'block');
    const mgmt = ['mgmt.example.com'];
    expect(decide('mgmt.example.com', c, mgmt)).toMatchObject({ action: 'allow', reason: 'management' });
    expect(decide('api.mgmt.example.com', c, mgmt)).toMatchObject({ action: 'allow', reason: 'management' });
    expect(decide('other.example.com', c, mgmt).action).toBe('block');
    expect(decide('xmgmt.example.com', c, mgmt).action).toBe('block');
  });
  it('disabled policy allows everything', () => {
    expect(decide('example.com', { ...content([], ['example.com']), enabled: false })).toMatchObject({ action: 'allow', reason: 'disabled' });
  });
});
