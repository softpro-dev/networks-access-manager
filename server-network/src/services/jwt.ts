import { SignJWT, jwtVerify } from 'jose';
import type { Role } from '../domain/rbac.js';

const ISSUER = 'server-network';
const AUDIENCE = 'server-network-admin';

export interface AccessClaims {
  sub: string;
  role: Role;
  org: string | null;
  sid: string;
}

export class JwtService {
  private readonly key: Uint8Array;
  constructor(secret: string, private readonly ttlSeconds: number) {
    this.key = new TextEncoder().encode(secret);
  }

  get ttl(): number {
    return this.ttlSeconds;
  }

  async sign(claims: AccessClaims): Promise<string> {
    return new SignJWT({ role: claims.role, org: claims.org, sid: claims.sid })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(this.key);
  }

  async verify(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'] });
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
      if (payload.role !== 'SUPER_ADMIN' && payload.role !== 'ORGANIZATION_ADMIN') return null;
      const org = typeof payload.org === 'string' ? payload.org : null;
      return { sub: payload.sub, role: payload.role, org, sid: payload.sid };
    } catch {
      return null;
    }
  }
}
