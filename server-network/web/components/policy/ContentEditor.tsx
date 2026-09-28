'use client';
import { useMemo, useState } from 'react';
import { previewDomains, previewIps, splitLines, type LinePreview } from '@/lib/domains';
import type { PolicyContent } from '@/lib/types';
import { Badge } from '../ui';

export interface ContentForm {
  enabled: boolean;
  default_action: 'allow' | 'block';
  allowed_domains: string;
  blocked_domains: string;
  blocked_ips: string;
  block_quic: boolean;
  block_dot: boolean;
  block_doh: boolean;
  enforce_browser_policies: boolean;
}

export const DEFAULT_CONTENT: PolicyContent = {
  enabled: true,
  default_action: 'allow',
  allowed_domains: [],
  blocked_domains: [],
  blocked_ips: [],
  block_quic: true,
  block_dot: true,
  block_doh: true,
  enforce_browser_policies: true,
};

export function toForm(c: Partial<PolicyContent> | undefined | null): ContentForm {
  const v = { ...DEFAULT_CONTENT, ...(c ?? {}) };
  return {
    enabled: v.enabled,
    default_action: v.default_action,
    allowed_domains: v.allowed_domains.join('\n'),
    blocked_domains: v.blocked_domains.join('\n'),
    blocked_ips: v.blocked_ips.join('\n'),
    block_quic: v.block_quic,
    block_dot: v.block_dot,
    block_doh: v.block_doh,
    enforce_browser_policies: v.enforce_browser_policies,
  };
}

/** Raw lines are sent as typed (trimmed); the server normalizes and is authoritative. */
export function toContent(f: ContentForm): PolicyContent {
  return {
    enabled: f.enabled,
    default_action: f.default_action,
    allowed_domains: splitLines(f.allowed_domains),
    blocked_domains: splitLines(f.blocked_domains),
    blocked_ips: splitLines(f.blocked_ips),
    block_quic: f.block_quic,
    block_dot: f.block_dot,
    block_doh: f.block_doh,
    enforce_browser_policies: f.enforce_browser_policies,
  };
}

function Preview({ items, serverErrors }: { items: LinePreview[]; serverErrors: Map<number, string> }) {
  const [open, setOpen] = useState(false);
  const invalid = items.filter((i) => i.error).length;
  const changed = items.filter((i) => i.changed).length;
  const dupes = items.length - new Set(items.map((i) => i.normalized ?? i.input)).size;
  const interesting = items.filter((i, idx) => i.error || i.changed || serverErrors.has(idx));
  return (
    <div className="preview">
      <div className="preview-summary">
        <span>{items.length} entries</span>
        {changed > 0 && <Badge tone="blue">{changed} normalized</Badge>}
        {invalid > 0 && <Badge tone="red">{invalid} invalid</Badge>}
        {dupes > 0 && <Badge tone="amber">{dupes} duplicate</Badge>}
        {interesting.length > 0 && (
          <button type="button" className="link-btn" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide' : 'Show'} details
          </button>
        )}
      </div>
      {open && interesting.length > 0 && (
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

const TOGGLES: { key: 'block_quic' | 'block_dot' | 'block_doh' | 'enforce_browser_policies'; label: string; hint: string }[] = [
  { key: 'block_quic', label: 'Block QUIC (UDP 443)', hint: 'Forces browsers back to TCP/TLS so domain rules apply.' },
  { key: 'block_dot', label: 'Block DNS-over-TLS (853)', hint: 'Prevents bypassing the local resolver.' },
  { key: 'block_doh', label: 'Block DNS-over-HTTPS', hint: 'Blocks well-known DoH endpoints.' },
  { key: 'enforce_browser_policies', label: 'Enforce browser policies', hint: 'Applies managed browser settings (e.g. disable built-in DoH).' },
];

/** Field-level server errors ("allowed_domains.3") mapped by list + index. */
export function indexErrors(errors: { path: string; message: string }[] | undefined, field: string): Map<number, string> {
  const m = new Map<number, string>();
  for (const e of errors ?? []) {
    const match = new RegExp(`^${field}\\.(\\d+)$`).exec(e.path);
    if (match) m.set(Number(match[1]), e.message);
  }
  return m;
}

export function ContentEditor({
  form,
  onChange,
  readOnly,
  serverErrors,
}: {
  form: ContentForm;
  onChange: (f: ContentForm) => void;
  readOnly: boolean;
  serverErrors?: { path: string; message: string }[];
}) {
  const allowed = useMemo(() => previewDomains(form.allowed_domains), [form.allowed_domains]);
  const blocked = useMemo(() => previewDomains(form.blocked_domains), [form.blocked_domains]);
  const ips = useMemo(() => previewIps(form.blocked_ips), [form.blocked_ips]);
  const set = <K extends keyof ContentForm>(k: K, v: ContentForm[K]) => onChange({ ...form, [k]: v });
  const topErrors = (serverErrors ?? []).filter((e) => !/^(allowed_domains|blocked_domains|blocked_ips)\.\d+$/.test(e.path));

  return (
    <fieldset className="policy-editor" disabled={readOnly}>
      <div className="editor-row">
        <label className="check">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          <span>
            <strong>Enabled</strong>
            <span className="field-hint">When off, agents allow everything (policy stays assigned).</span>
          </span>
        </label>
        <label className="field field-inline">
          <span className="field-label">Default action</span>
          <select value={form.default_action} onChange={(e) => set('default_action', e.target.value as 'allow' | 'block')}>
            <option value="allow">allow — block only listed domains</option>
            <option value="block">block — allow only listed domains</option>
          </select>
        </label>
      </div>
      {topErrors.length > 0 && (
        <ul className="alert alert-error alert-details">
          {topErrors.map((e, i) => (
            <li key={i}>
              <code>{e.path}</code> {e.message}
            </li>
          ))}
        </ul>
      )}
      <div className="editor-lists">
        <div className="field">
          <span className="field-label">Allowed domains</span>
          <textarea aria-label="Allowed domains" rows={10} spellCheck={false} className="mono" placeholder={'company.com\n*.company.com'} value={form.allowed_domains} onChange={(e) => set('allowed_domains', e.target.value)} />
          <span className="field-hint">One per line. &quot;*.example.com&quot; matches subdomains only; list the apex separately.</span>
          <Preview items={allowed} serverErrors={indexErrors(serverErrors, 'allowed_domains')} />
        </div>
        <div className="field">
          <span className="field-label">Blocked domains</span>
          <textarea aria-label="Blocked domains" rows={10} spellCheck={false} className="mono" placeholder={'example.com\n*.example.com'} value={form.blocked_domains} onChange={(e) => set('blocked_domains', e.target.value)} />
          <span className="field-hint">One per line. The most specific match wins; ties resolve to block.</span>
          <Preview items={blocked} serverErrors={indexErrors(serverErrors, 'blocked_domains')} />
        </div>
        <div className="field">
          <span className="field-label">Blocked IPs / CIDRs</span>
          <textarea aria-label="Blocked IPs / CIDRs" rows={10} spellCheck={false} className="mono" placeholder={'203.0.113.0/24\n2001:db8::/32'} value={form.blocked_ips} onChange={(e) => set('blocked_ips', e.target.value)} />
          <span className="field-hint">IPv4/IPv6 addresses or CIDRs without host bits.</span>
          <Preview items={ips} serverErrors={indexErrors(serverErrors, 'blocked_ips')} />
        </div>
      </div>
      <div className="editor-toggles">
        {TOGGLES.map((t) => (
          <label key={t.key} className="check">
            <input type="checkbox" checked={form[t.key]} onChange={(e) => set(t.key, e.target.checked)} />
            <span>
              <strong>{t.label}</strong>
              <span className="field-hint">{t.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
