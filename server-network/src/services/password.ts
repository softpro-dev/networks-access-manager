import { hash, verify } from '@node-rs/argon2';

// Algorithm.Argon2id (the package exports it as an ambient const enum, unusable with isolatedModules).
const ARGON2ID = 2;

// OWASP-recommended argon2id parameters (m=19 MiB, t=2, p=1).
const OPTIONS = { algorithm: ARGON2ID, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const MIN_PASSWORD_LENGTH = 12;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;
/** Hash used to equalize timing when the user does not exist. */
export function getDummyHash(): Promise<string> {
  dummyHash ??= hash('dummy-password-for-timing-equalization', OPTIONS);
  return dummyHash;
}
