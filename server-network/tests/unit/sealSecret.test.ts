import { describe, expect, it } from 'vitest';
import { openSecret, sealSecret } from '../../src/utils/crypto.js';

const KEY = 'k'.repeat(40);
const TOKEN = 'nat_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

describe('sealSecret / openSecret', () => {
  it('round-trips and never contains the plaintext', () => {
    const sealed = sealSecret(TOKEN, KEY);
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(sealed).not.toContain(TOKEN);
    expect(sealed.length).toBeLessThanOrEqual(255); // fits Organization.accessTokenEnc
    expect(openSecret(sealed, KEY)).toBe(TOKEN);
  });

  it('uses a fresh IV each time', () => {
    expect(sealSecret(TOKEN, KEY)).not.toBe(sealSecret(TOKEN, KEY));
  });

  it('returns null for another key, tampering or garbage', () => {
    const sealed = sealSecret(TOKEN, KEY);
    expect(openSecret(sealed, 'other-key-'.repeat(4))).toBeNull();
    const parts = sealed.split('.');
    const flipped = parts[3]!.startsWith('A') ? `B${parts[3]!.slice(1)}` : `A${parts[3]!.slice(1)}`;
    expect(openSecret([parts[0], parts[1], parts[2], flipped].join('.'), KEY)).toBeNull();
    expect(openSecret('not-sealed', KEY)).toBeNull();
    expect(openSecret('v2.a.b.c', KEY)).toBeNull();
  });
});
