import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

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
