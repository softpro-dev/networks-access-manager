/** ETag format (contract §3): `"<policy_id>:<version>:<first 8 hex of content_sha256>"`, quotes included. */
export function makePolicyEtag(policyCode: string, version: number, contentSha256: string): string {
  return `"${policyCode}:${version}:${contentSha256.slice(0, 8)}"`;
}

/** RFC 9110 weak comparison for If-None-Match (handles lists, `*` and `W/`). */
export function ifNoneMatchSatisfied(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (raw.trim() === '*') return true;
  const strip = (t: string) => t.trim().replace(/^W\//, '');
  const target = strip(etag);
  return raw.split(',').some((t) => strip(t) === target);
}
