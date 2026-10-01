import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

const SEAL_PREFIX = 'v1';

function sealKey(keyMaterial: string): Buffer {
  return Buffer.from(hkdfSync('sha256', keyMaterial, 'nam-secret-seal', 'nam-secret-seal:aes-256-gcm:v1', 32));
}

/**
 * Encrypt a secret for storage (AES-256-GCM, key derived with HKDF from `keyMaterial`).
 * Format: `v1.<iv>.<tag>.<ciphertext>` (base64url). Used for values that must be shown again
 * later (organization access tokens); lookups still use the separate sha256 hash.
 */
export function sealSecret(plaintext: string, keyMaterial: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(keyMaterial), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [SEAL_PREFIX, iv, cipher.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

/** Decrypt a `sealSecret` value; null when malformed, tampered with, or sealed under another key. */
export function openSecret(sealed: string, keyMaterial: string): string | null {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== SEAL_PREFIX) return null;
  try {
    const [iv, tag, ct] = parts.slice(1).map((p) => Buffer.from(p, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', sealKey(keyMaterial), iv!);
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(ct!), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** 32 random bytes, base64url (no padding). */
export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time comparison of two hex digests (or any equal-length ASCII strings). */
export function safeEqualHex(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    // still spend comparable time
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** Constant-time comparison of two arbitrary strings by comparing their SHA-256 digests. */
export function safeEqualString(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
