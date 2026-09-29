export function absTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function relTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.round((now - t) / 1000);
  const future = s < 0;
  const a = Math.abs(s);
  let v: string;
  if (a < 45) v = `${a}s`;
  else if (a < 3600) v = `${Math.round(a / 60)}m`;
  else if (a < 86_400) v = `${Math.round(a / 3600)}h`;
  else v = `${Math.round(a / 86_400)}d`;
  return future ? `in ${v}` : `${v} ago`;
}

/** Title given by an admin, else the agent-reported hostname, else the MAC (pre-registered computers). */
export function deviceName(d: { display_name: string | null; hostname: string | null; mac_address?: string | null }): string {
  return d.display_name || d.hostname || d.mac_address || 'Unnamed computer';
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
