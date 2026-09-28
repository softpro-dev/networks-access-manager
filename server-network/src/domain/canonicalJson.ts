/**
 * Canonical JSON (contract §4): keys sorted by Unicode code point at every level, no insignificant
 * whitespace, arrays in stored order, UTF-8. Equivalent to Python
 * `json.dumps(c, sort_keys=True, separators=(",", ":"), ensure_ascii=False)` for the value space used
 * in policy content (objects, arrays, strings, booleans, null, integers).
 */
import { sha256Hex } from '../utils/crypto.js';

function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0)!;
    const cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx - cy;
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('Non-finite numbers are not allowed in canonical JSON');
      if (!Number.isInteger(value)) throw new TypeError('Non-integer numbers are not allowed in canonical JSON (float formatting differs across languages)');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort(compareCodePoints);
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
    }
    default:
      throw new TypeError(`Unsupported type in canonical JSON: ${typeof value}`);
  }
}

export function canonicalSha256(value: unknown): string {
  return sha256Hex(Buffer.from(canonicalJson(value), 'utf8'));
}
