import { describe, expect, it } from 'vitest';
import { generateDeviceToken, hashDeviceSecret, hashEnrollmentSecret, parseBearer, parseDeviceToken, verifyDeviceSecret } from '../../src/domain/deviceToken.js';
import { safeEqualHex, sha256Hex } from '../../src/utils/crypto.js';

describe('device token', () => {
  it('generates ndc_<id>.<43-char base64url secret> and stores only sha256(secret)', () => {
    const t = generateDeviceToken('clx2k9abc0000abcdefghijk');
    expect(t.token).toMatch(/^ndc_clx2k9abc0000abcdefghijk\.[A-Za-z0-9_-]{43}$/);
    expect(t.secretHash).toBe(sha256Hex(t.secret));
    expect(t.secretHash).toMatch(/^[0-9a-f]{64}$/);
    const parsed = parseDeviceToken(t.token)!;
    expect(parsed.credentialId).toBe('clx2k9abc0000abcdefghijk');
    expect(verifyDeviceSecret(parsed.secret, t.secretHash)).toBe(true);
    expect(verifyDeviceSecret(parsed.secret.replace(/.$/, parsed.secret.endsWith('A') ? 'B' : 'A'), t.secretHash)).toBe(false);
    expect(verifyDeviceSecret(parsed.secret, null)).toBe(false);
  });
  it('secrets are unique', () => {
    expect(generateDeviceToken('abcdefgh1').secret).not.toBe(generateDeviceToken('abcdefgh1').secret);
  });
  it('rejects malformed tokens', () => {
    for (const bad of ['', 'ndc_', 'ndc_abc', 'ndc_abcdefgh.short', 'xyz_abcdefgh.' + 'a'.repeat(43), 'ndc_ABCDEFGH.' + 'a'.repeat(43), 'ndc_abcdefgh.' + 'a'.repeat(42) + '=']) {
      expect(parseDeviceToken(bad), bad).toBeNull();
    }
  });
  it('parses Bearer headers', () => {
    const t = generateDeviceToken('abcdefgh12');
    expect(parseBearer(`Bearer ${t.token}`)?.credentialId).toBe('abcdefgh12');
    expect(parseBearer(`bearer ${t.token}`)?.credentialId).toBe('abcdefgh12');
    expect(parseBearer(t.token)).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
  });
  it('enrollment secret hash is sha256 hex of the raw secret', () => {
    expect(hashEnrollmentSecret('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashDeviceSecret('abc')).toBe(hashEnrollmentSecret('abc'));
  });
  it('safeEqualHex handles length mismatch and nulls', () => {
    expect(safeEqualHex('ab', 'ab')).toBe(true);
    expect(safeEqualHex('ab', 'abc')).toBe(false);
    expect(safeEqualHex(null, 'ab')).toBe(false);
  });
});
