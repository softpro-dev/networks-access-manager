/** IPv4/IPv6 address or CIDR validation for `blocked_ips`. Rejects zone ids, leading zeros and host bits. */
import { isIPv4, isIPv6 } from 'node:net';

function ipv4ToBytes(s: string): number[] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function ipv6ToBytes(s: string): number[] | null {
  if (!isIPv6(s) || s.includes('%')) return null;
  let head = s;
  let tailV4: number[] = [];
  const lastColon = s.lastIndexOf(':');
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const b = ipv4ToBytes(maybeV4);
    if (!b) return null;
    tailV4 = b;
    head = s[lastColon - 1] === ':' ? s.slice(0, lastColon + 1) : s.slice(0, lastColon);
  }
  const groupsNeeded = tailV4.length ? 6 : 8;
  let groups: string[];
  if (head.includes('::')) {
    const [l, r] = head.split('::') as [string, string];
    const left = l ? l.split(':') : [];
    const right = r ? r.split(':') : [];
    const fill = groupsNeeded - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...Array<string>(fill).fill('0'), ...right];
  } else {
    groups = head.split(':');
  }
  if (groups.length !== groupsNeeded) return null;
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const n = parseInt(g, 16);
    out.push(n >> 8, n & 0xff);
  }
  return [...out, ...tailV4];
}

export type IpResult = { ok: true; value: string } | { ok: false; error: string };

export function validateIpOrCidr(input: unknown): IpResult {
  if (typeof input !== 'string') return { ok: false, error: 'must be a string' };
  const s = input.trim().toLowerCase();
  if (s.length === 0 || s.length > 64) return { ok: false, error: 'invalid IP address or CIDR' };
  const [addr, prefix, extra] = s.split('/');
  if (extra !== undefined || !addr) return { ok: false, error: 'invalid IP address or CIDR' };
  let bytes: number[] | null = null;
  if (isIPv4(addr)) bytes = ipv4ToBytes(addr);
  else if (isIPv6(addr)) bytes = ipv6ToBytes(addr);
  if (!bytes) return { ok: false, error: 'invalid IP address (no zone ids or leading zeros)' };
  const bits = bytes.length * 8;
  if (prefix === undefined) return { ok: true, value: s };
  if (!/^(0|[1-9]\d{0,2})$/.test(prefix) || Number(prefix) > bits) {
    return { ok: false, error: `invalid prefix length (0-${bits})` };
  }
  const p = Number(prefix);
  for (let i = 0; i < bits; i++) {
    if (i < p) continue;
    const byte = bytes[i >> 3]!;
    if ((byte >> (7 - (i & 7))) & 1) return { ok: false, error: 'CIDR has host bits set; use the network address' };
  }
  return { ok: true, value: s };
}
