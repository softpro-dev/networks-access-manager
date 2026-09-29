'use client';
import { useMemo, useState } from 'react';
import { previewDomain, previewDomains, previewIps, splitLines, type LinePreview } from '@/lib/domains';
import { DEFAULT_CONTENT, KIND_INFO, PROTOCOL_TOGGLES } from '@/lib/restrictions';
import type { Issue, PolicyContent, RestrictionKind } from '@/lib/types';
import { Badge, Button } from './ui';

type Flag = (typeof PROTOCOL_TOGGLES)[number]['key'];

export interface RedirectRow {
  key: number;
  from: string;
  to: string;
}

/** Editable form state for one restriction's content. Only the fields of its kind are sent. */
export interface RestrictionForm {
  enabled: boolean;
  default_action: 'allow' | 'block';
  allowed: string;
  blocked: string;
  ips: string;
  redirects: RedirectRow[];
  flags: Record<Flag, boolean>;
}

let rowSeq = 0;
export const newRow = (from = '', to = ''): RedirectRow => ({ key: ++rowSeq, from, to });

export function toForm(kind: RestrictionKind, c: Partial<PolicyContent> | null | undefined): RestrictionForm {
  const v = { ...DEFAULT_CONTENT, ...(kind === 'ALLOW_ONLY' ? { default_action: 'block' as const } : {}), ...(c ?? {}) };
  const redirects = (v.redirect_rules ?? []).map((r) => newRow(r.from, r.to));
  return {
    enabled: v.enabled,
    default_action: v.default_action,
    allowed: v.allowed_domains.join('\n'),
    blocked: v.blocked_domains.join('\n'),
    ips: v.blocked_ips.join('\n'),
    redirects: kind === 'REDIRECT' && !redirects.length ? [newRow()] : redirects,
    flags: { block_quic: v.block_quic, block_dot: v.block_dot, block_doh: v.block_doh, enforce_browser_policies: v.enforce_browser_policies },
  };
}

/** Raw lines are sent as typed (trimmed); the server normalizes and is authoritative. */
export function toContent(kind: RestrictionKind, f: RestrictionForm): PolicyContent {
  const redirects = f.redirects.map((r) => ({ from: r.from.trim(), to: r.to.trim() })).filter((r) => r.from || r.to);
  return {
    enabled: f.enabled,
    default_action: f.default_action,
    allowed_domains: kind === 'ALLOW_ONLY' ? splitLines(f.allowed) : [],
    blocked_domains: kind === 'BLACKLIST' ? splitLines(f.blocked) : [],
    blocked_ips: kind === 'BLACKLIST' ? splitLines(f.ips) : [],
    ...f.flags,
    ...(kind === 'REDIRECT' && redirects.length ? { redirect_rules: redirects } : {}),
  };
}

/** Client-side problems that would make the API reject the content (the API re-checks everything). */
export function clientErrors(kind: RestrictionKind, f: RestrictionForm): number {
  if (kind === 'ALLOW_ONLY') return previewDomains(f.allowed).filter((i) => i.error).length;
  if (kind === 'BLACKLIST') return previewDomains(f.blocked).filter((i) => i.error).length + previewIps(f.ips).filter((i) => i.error).length;
  return f.redirects.filter((r) => (r.from.trim() || r.to.trim()) && redirectErrors(r).any).length;
}

function redirectErrors(r: { from: string; to: string }) {
  const from = r.from.trim() ? previewDomain(r.from) : { normalized: null, error: 'required' };
  let to = r.to.trim() ? previewDomain(r.to) : { normalized: null, error: 'required' };
  if (to.normalized?.startsWith('*.')) to = { normalized: null, error: 'must be an exact host, not a wildcard' };
  const self = !!from.normalized && from.normalized === to.normalized;
  return { from, to, self, any: !!from.error || !!to.error || self };
}

/** Field-level server errors ("allowed_domains.3", "redirect_rules.2.to") mapped by list + index. */
function indexErrors(errors: Issue[], field: string): Map<number, string> {
  const m = new Map<number, string>();
  for (const e of errors) {
    const match = new RegExp(`^${field}\\.(\\d+)(?:\\.\\w+)?$`).exec(e.path);
    if (match) m.set(Number(match[1]), m.has(Number(match[1])) ? `${m.get(Number(match[1]))}; ${e.message}` : e.message);
  }
  return m;
}

function Preview({ items, serverErrors }: { items: LinePreview[]; serverErrors: Map<number, string> }) {
  const invalid = items.filter((i) => i.error).length;
  const changed = items.filter((i) => i.changed).length;
  const dupes = items.length - new Set(items.map((i) => i.normalized ?? i.input)).size;
  const interesting = items.filter((i, idx) => i.error || i.changed || serverErrors.has(idx));
  const [open, setOpen] = useState(false);
  const show = open || invalid > 0 || serverErrors.size > 0;
  return (
    <div className="preview" aria-live="polite">
      <div className="preview-summary">
        <span>{items.length} entries</span>
        {changed > 0 && <Badge tone="blue">{changed} will be normalized</Badge>}
        {invalid > 0 && <Badge tone="red">{invalid} invalid</Badge>}
        {dupes > 0 && <Badge tone="amber">{dupes} duplicate</Badge>}
        {interesting.length > 0 && !invalid && !serverErrors.size && (
          <button type="button" className="link-btn" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide' : 'Show'} details
          </button>
        )}
      </div>
      {show && interesting.length > 0 && (
        <ul className="preview-list">
          {items.map((i, idx) =>
            i.error || i.changed || serverErrors.has(idx) ? (
              <li key={idx} className={i.error || serverErrors.has(idx) ? 'bad' : ''}>
                <span className="muted">#{i.line}</span> <code>{i.input}</code>
                {i.changed && (
                  <>
                    {' → '}
                    <code>{i.normalized}</code>
                  </>
                )}
                {i.error && <span className="text-danger"> {i.error}</span>}
                {serverErrors.has(idx) && <span className="text-danger"> (server) {serverErrors.get(idx)}</span>}
              </li>
            ) : null,
          )}
        </ul>
      )}
    </div>
  );
}

function DomainList({ label, hint, value, onChange, field, serverErrors, placeholder }: { label: string; hint: string; value: string; onChange: (v: string) => void; field: string; serverErrors: Issue[]; placeholder: string }) {
  const items = useMemo(() => previewDomains(value), [value]);
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <textarea aria-label={label} rows={12} spellCheck={false} className="mono" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
      <span className="field-hint">{hint}</span>
      <Preview items={items} serverErrors={indexErrors(serverErrors, field)} />
    </div>
  );
}

export function RestrictionEditor({ kind, form, onChange, serverErrors = [] }: { kind: RestrictionKind; form: RestrictionForm; onChange: (f: RestrictionForm) => void; serverErrors?: Issue[] }) {
  const ips = useMemo(() => previewIps(form.ips), [form.ips]);
  const set = (patch: Partial<RestrictionForm>) => onChange({ ...form, ...patch });
  const redirectServer = indexErrors(serverErrors, 'redirect_rules');
  const topErrors = serverErrors.filter((e) => !/^(allowed_domains|blocked_domains|blocked_ips|redirect_rules)\.\d+/.test(e.path));
  // Server indexes count only the non-blank rows that were sent.
  const sentIndex = new Map<number, number>();
  form.redirects.filter((r) => r.from.trim() || r.to.trim()).forEach((r, i) => sentIndex.set(r.key, i));
  const setRow = (key: number, patch: Partial<RedirectRow>) => set({ redirects: form.redirects.map((r) => (r.key === key ? { ...r, ...patch } : r)) });

  return (
    <div className="stack">
      {topErrors.length > 0 && (
        <ul className="alert alert-error alert-details">
          {topErrors.map((e, i) => (
            <li key={i}>
              {e.path && <code>{e.path}</code>} {e.message}
            </li>
          ))}
        </ul>
      )}

      {kind === 'ALLOW_ONLY' && (
        <DomainList
          label="Allowed websites"
          hint='One domain per line. "*.example.com" matches subdomains only — list "example.com" too for the site itself. Everything not listed is blocked on computers this restriction reaches.'
          value={form.allowed}
          onChange={(allowed) => set({ allowed })}
          field="allowed_domains"
          serverErrors={serverErrors}
          placeholder={'school.example\n*.school.example\nwikipedia.org'}
        />
      )}

      {kind === 'BLACKLIST' && (
        <div className="editor-lists editor-lists-2">
          <DomainList
            label="Blocked websites"
            hint='One domain per line. "*.example.com" matches subdomains only; list the apex separately.'
            value={form.blocked}
            onChange={(blocked) => set({ blocked })}
            field="blocked_domains"
            serverErrors={serverErrors}
            placeholder={'games.example\n*.games.example'}
          />
          <div className="field">
            <span className="field-label">Blocked IPs / CIDRs (optional)</span>
            <textarea aria-label="Blocked IPs / CIDRs" rows={12} spellCheck={false} className="mono" placeholder={'203.0.113.0/24\n2001:db8::/32'} value={form.ips} onChange={(e) => set({ ips: e.target.value })} />
            <span className="field-hint">IPv4/IPv6 addresses or CIDRs without host bits.</span>
            <Preview items={ips} serverErrors={indexErrors(serverErrors, 'blocked_ips')} />
          </div>
        </div>
      )}

      {kind === 'REDIRECT' && (
        <div className="field">
          <span className="field-label">Redirections</span>
          <span className="field-hint">
            Visits to a website matching <strong>From</strong> (a domain or &quot;*.domain&quot; pattern) are sent to the exact host in <strong>To</strong>. Redirect targets are always allowed.
          </span>
          <div className="redirect-rows">
            {form.redirects.map((r, i) => {
              const e = redirectErrors(r);
              const blank = !r.from.trim() && !r.to.trim();
              const sent = sentIndex.get(r.key);
              const server = sent === undefined ? undefined : redirectServer.get(sent);
              return (
                <div key={r.key} className="redirect-row">
                  <div className="redirect-cell">
                    <input aria-label={`Rule ${i + 1}: from`} className="mono" spellCheck={false} placeholder="video.example or *.video.example" value={r.from} onChange={(ev) => setRow(r.key, { from: ev.target.value })} />
                    {!blank && e.from.error && r.from.trim() && <span className="field-error">{e.from.error}</span>}
                    {e.from.normalized && e.from.normalized !== r.from.trim() && <span className="field-hint">→ {e.from.normalized}</span>}
                  </div>
                  <span className="redirect-arrow" aria-hidden>
                    →
                  </span>
                  <div className="redirect-cell">
                    <input aria-label={`Rule ${i + 1}: to`} className="mono" spellCheck={false} placeholder="learning.example" value={r.to} onChange={(ev) => setRow(r.key, { to: ev.target.value })} />
                    {!blank && e.to.error && (r.to.trim() || r.from.trim()) && <span className="field-error">{e.to.error}</span>}
                    {e.self && <span className="field-error">cannot redirect to itself</span>}
                    {e.to.normalized && e.to.normalized !== r.to.trim() && <span className="field-hint">→ {e.to.normalized}</span>}
                    {server && <span className="field-error">(server) {server}</span>}
                  </div>
                  <button type="button" className="icon-btn" aria-label={`Remove rule ${i + 1}`} onClick={() => set({ redirects: form.redirects.filter((x) => x.key !== r.key) })}>
                    ×
                  </button>
                </div>
              );
            })}
          </div>
          <div>
            <Button size="sm" onClick={() => set({ redirects: [...form.redirects, newRow()] })}>
              + Add redirection
            </Button>
          </div>
        </div>
      )}

      <details className="advanced">
        <summary>Advanced: protocol settings</summary>
        <p className="muted small">
          When several restrictions reach one computer, a protection is on if <em>any</em> of them turns it on.
        </p>
        <div className="editor-toggles">
          {PROTOCOL_TOGGLES.map((t) => (
            <label key={t.key} className="check">
              <input type="checkbox" checked={form.flags[t.key]} onChange={(e) => set({ flags: { ...form.flags, [t.key]: e.target.checked } })} />
              <span>
                <strong>{t.label}</strong>
                <span className="field-hint">{t.hint}</span>
              </span>
            </label>
          ))}
          <label className="check">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
            <span>
              <strong>Rules enabled</strong>
              <span className="field-hint">When off, this restriction contributes nothing while staying assigned. To pause it everywhere use Deactivate instead.</span>
            </span>
          </label>
        </div>
      </details>
      <p className="muted small">{KIND_INFO[kind].description}</p>
    </div>
  );
}
