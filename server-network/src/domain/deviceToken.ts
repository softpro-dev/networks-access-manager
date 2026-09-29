/** Device credential token `ndc_<credential_id>.<secret>` (contract §1). */
import { randomSecret, safeEqualHex, sha256Hex } from '../utils/crypto.js';

const TOKEN_RE = /^ndc_([a-z0-9]{8,64})\.([A-Za-z0-9_-]{43})$/;

export interface ParsedDeviceToken {
  credentialId: string;
  secret: string;
}

export function parseDeviceToken(token: string | undefined | null): ParsedDeviceToken | null {
  if (typeof token !== 'string') return null;
  const m = TOKEN_RE.exec(token);
  if (!m) return null;
  return { credentialId: m[1]!, secret: m[2]! };
}

/** Parse an `Authorization: Bearer ndc_...` header value. */
export function parseBearer(header: string | undefined): ParsedDeviceToken | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? parseDeviceToken(m[1]) : null;
}

export function hashDeviceSecret(secret: string): string {
  return sha256Hex(Buffer.from(secret, 'utf8'));
}

export function verifyDeviceSecret(secret: string, storedHash: string | null): boolean {
  return safeEqualHex(hashDeviceSecret(secret), storedHash);
}

export function generateDeviceToken(credentialId: string): { token: string; secret: string; secretHash: string } {
  const secret = randomSecret(32);
  return { token: `ndc_${credentialId}.${secret}`, secret, secretHash: hashDeviceSecret(secret) };
}

/** Enrollment secret: agent sends sha256(secret) hex at register and the raw secret when polling. */
export function hashEnrollmentSecret(raw: string): string {
  return sha256Hex(Buffer.from(raw, 'utf8'));
}

/** Organization service access token `nat_<secret>` (contract: non-expiring, revoked by rotation). */
const ACCESS_TOKEN_RE = /^nat_([A-Za-z0-9_-]{43})$/;

export function generateAccessToken(): { token: string; tokenHash: string } {
  const secret = randomSecret(32);
  const token = `nat_${secret}`;
  return { token, tokenHash: sha256Hex(token) };
}

export function parseAccessTokenBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!m) return null;
  return ACCESS_TOKEN_RE.test(m[1]!) ? m[1]! : null;
}
