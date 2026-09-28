// Client-side PREVIEW of the server's domain-pattern normalization (contract §5): trim, lowercase,
// drop one trailing dot, IDNA → A-labels, keep a leading "*.". The server validator is authoritative;
// this only gives immediate feedback while typing.

export interface LinePreview {
  line: number;
  input: string;
  normalized: string | null;
  changed: boolean;
  error: string | null;
}

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

function toAscii(host: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7f]/.test(host)) return host;
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function previewDomain(raw: string): { normalized: string | null; error: string | null } {
  const s0 = raw.trim();
  if (s0.includes('://')) return { normalized: null, error: 'must not contain a scheme' };
  if (IPV4_RE.test(s0) || s0.includes('::') || (s0.startsWith('[') && s0.endsWith(']'))) return { normalized: null, error: 'IP literals belong in blocked IPs' };
  if (/[/?#]/.test(s0)) return { normalized: null, error: 'must not contain a path, query or fragment' };
  if (s0.includes('@')) return { normalized: null, error: 'must not contain "@"' };
  if (s0.includes(':')) return { normalized: null, error: 'must not contain a port' };
  if (/\s/.test(s0)) return { normalized: null, error: 'must not contain whitespace' };
  let s = s0.toLowerCase();
  if (s.endsWith('.')) s = s.slice(0, -1);
  const wildcard = s.startsWith('*.');
  const body = wildcard ? s.slice(2) : s;
  if (body.includes('*')) return { normalized: null, error: 'only a leading "*." wildcard is allowed' };
  const ascii = toAscii(body);
  if (!ascii) return { normalized: null, error: 'invalid internationalized name' };
  const labels = ascii.split('.');
  if (labels.length < 2) return { normalized: null, error: 'needs at least two labels' };
  for (const l of labels) {
    if (!LABEL_RE.test(l)) return { normalized: null, error: `invalid label "${l}"` };
  }
  const normalized = (wildcard ? '*.' : '') + ascii;
  if (normalized.length > 253) return { normalized: null, error: 'longer than 253 characters' };
  return { normalized, error: null };
}

export function previewDomains(text: string): LinePreview[] {
  return splitLines(text).map((input, i) => {
    const r = previewDomain(input);
    return { line: i + 1, input, normalized: r.normalized, changed: r.normalized !== null && r.normalized !== input, error: r.error };
  });
}

export function previewIps(text: string): LinePreview[] {
  return splitLines(text).map((input, i) => {
    const v = input.toLowerCase();
    const ok = /^[0-9a-f:.]+(\/\d{1,3})?$/.test(v) && (v.includes('.') || v.includes(':'));
    return { line: i + 1, input, normalized: ok ? v : null, changed: ok && v !== input, error: ok ? null : 'not an IP address or CIDR' };
  });
}
