'use client';
import Link from 'next/link';
import { useState } from 'react';
import { KIND_INFO, PROTOCOL_TOGGLES, VIA_LABEL } from '@/lib/restrictions';
import type { EffectivePolicy, PolicyContent, RestrictionKind } from '@/lib/types';
import { Badge, Empty, Mono } from './ui';

export function KindBadge({ kind }: { kind: RestrictionKind }) {
  return <Badge tone={KIND_INFO[kind].tone}>{KIND_INFO[kind].label}</Badge>;
}

function RuleList({ title, items, empty, limit = 25 }: { title: string; items: string[]; empty: string; limit?: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, limit);
  return (
    <div className="rule-list">
      <div className="rule-list-title">
        {title} <span className="muted">({items.length})</span>
      </div>
      {!items.length ? (
        <span className="muted small">{empty}</span>
      ) : (
        <>
          <ul>
            {shown.map((d) => (
              <li key={d}>
                <Mono>{d}</Mono>
              </li>
            ))}
          </ul>
          {items.length > limit && (
            <button type="button" className="link-btn" onClick={() => setAll((v) => !v)}>
              {all ? 'Show fewer' : `Show all ${items.length}`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Read-only rendering of (merged or single-restriction) content. */
export function ContentSummary({ content, kind }: { content: PolicyContent; kind?: RestrictionKind }) {
  const redirects = content.redirect_rules ?? [];
  const show = (k: RestrictionKind) => !kind || kind === k;
  return (
    <div className="stack">
      {!kind && (
        <p>
          {content.default_action === 'block' ? (
            <>
              <Badge tone="green">Allow-only mode</Badge> Only the allowed websites (and redirect targets) can be visited; everything else is blocked.
            </>
          ) : (
            <>
              <Badge>Open mode</Badge> Every website is allowed except the blocked ones.
            </>
          )}
          {!content.enabled && <Badge tone="gray">disabled</Badge>}
        </p>
      )}
      <div className="rule-grid">
        {show('ALLOW_ONLY') && (
          <RuleList title="Allowed websites" items={content.allowed_domains} empty={kind ? 'None' : 'None (no Allow Only restriction applies)'} />
        )}
        {show('BLACKLIST') && <RuleList title="Blocked websites" items={content.blocked_domains} empty="None" />}
        {show('BLACKLIST') && (kind === 'BLACKLIST' || content.blocked_ips.length > 0) && <RuleList title="Blocked IPs / CIDRs" items={content.blocked_ips} empty="None" />}
        {show('REDIRECT') && (
          <div className="rule-list">
            <div className="rule-list-title">
              Redirections <span className="muted">({redirects.length})</span>
            </div>
            {!redirects.length ? (
              <span className="muted small">None</span>
            ) : (
              <ul>
                {redirects.map((r) => (
                  <li key={r.from}>
                    <Mono>{r.from}</Mono> → <Mono>{r.to}</Mono>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      <div className="chips">
        {PROTOCOL_TOGGLES.map((t) => (
          <Badge key={t.key} tone={content[t.key] ? 'blue' : 'gray'} title={t.hint}>
            {content[t.key] ? '✓' : '✗'} {t.label}
          </Badge>
        ))}
      </div>
    </div>
  );
}

/** The merged EFFECTIVE policy of one computer and the restrictions that produced it. */
export function EffectiveRules({ effective, compact }: { effective: EffectivePolicy | null; compact?: boolean }) {
  if (!effective) return <Empty>No active restriction reaches this computer, so it has no rules (everything is allowed).</Empty>;
  return (
    <div className="stack">
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Restriction</th>
              <th>Type</th>
              <th>Version</th>
              <th>Applies via</th>
            </tr>
          </thead>
          <tbody>
            {effective.sources.map((s) => (
              <tr key={s.policy_id}>
                <td>
                  <Link href={`/restrictions/${s.policy_id}`}>
                    <Mono>{s.code}</Mono>
                  </Link>
                </td>
                <td>
                  <KindBadge kind={s.kind} />
                </td>
                <td>v{s.version}</td>
                <td>
                  <span className="chips">
                    {s.via.map((v) => (
                      <span key={v} className="chip">
                        {VIA_LABEL[v]}
                      </span>
                    ))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ContentSummary content={effective.content} />
      {!compact && (
        <p className="muted small">
          Effective version v{effective.version} · sha256 <Mono>{effective.content_sha256.slice(0, 16)}…</Mono> · ETag <Mono>{effective.etag}</Mono>. All assigned restrictions are merged: any Allow Only
          switches the computer to allow-only mode; black lists and redirections are combined.
        </p>
      )}
    </div>
  );
}
