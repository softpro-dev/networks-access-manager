'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useOrgAssignments, useRestrictions } from '@/lib/queries';
import { useOrgScope } from '@/lib/orgScope';
import { absTime } from '@/lib/format';
import { KIND_INFO, KINDS } from '@/lib/restrictions';
import type { RestrictionKind } from '@/lib/types';
import { Badge, Empty, ErrorBox, Mono, PageHeader, Spinner } from '@/components/ui';
import { KindBadge } from '@/components/EffectiveRules';

export default function RestrictionsPage() {
  const { orgId, isSuper } = useOrgScope();
  const policies = useRestrictions(orgId);
  const assignments = useOrgAssignments(orgId);
  const [kind, setKind] = useState<RestrictionKind | ''>('');
  const [q, setQ] = useState('');

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of assignments.data?.items ?? []) m.set(a.policy_id, (m.get(a.policy_id) ?? 0) + 1);
    return m;
  }, [assignments.data]);
  const all = policies.data?.items ?? [];
  const byKind = (k: RestrictionKind) => all.filter((p) => p.kind === k).length;
  const needle = q.trim().toLowerCase();
  const rows = all.filter((p) => (!kind || p.kind === kind) && (!needle || p.name.toLowerCase().includes(needle) || p.code.toLowerCase().includes(needle)));

  return (
    <>
      <PageHeader
        title="Restrictions"
        subtitle="Visiting rules of websites. Assign them to the whole organization, groups or single computers on Set access; every restriction reaching a computer is merged."
        actions={
          <Link className="btn btn-primary" href="/restrictions/new">
            New restriction
          </Link>
        }
      />
      <div className="kind-cards">
        {KINDS.map((k) => (
          <button key={k} type="button" className={`kind-card ${KIND_INFO[k].css} ${kind === k ? 'selected' : ''}`} aria-pressed={kind === k} onClick={() => setKind(kind === k ? '' : k)}>
            <span className="kind-card-head">
              <KindBadge kind={k} />
              <span className="kind-card-count">{policies.data ? byKind(k) : '…'}</span>
            </span>
            <span className="muted small">{KIND_INFO[k].description}</span>
          </button>
        ))}
      </div>
      <div className="toolbar">
        <input type="search" placeholder="Search name or code…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search restrictions" className="grow" />
        <select value={kind} onChange={(e) => setKind(e.target.value as RestrictionKind | '')} aria-label="Type">
          <option value="">All types</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_INFO[k].label}
            </option>
          ))}
        </select>
      </div>
      {policies.error && <ErrorBox error={policies.error} />}
      {policies.isLoading ? (
        <Spinner />
      ) : !rows.length ? (
        <Empty>{all.length ? 'No restrictions match.' : 'No restrictions yet. Create an Allow Only list, a Black List or a Redirection, then assign it on Set access.'}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                {isSuper && !orgId && <th>Organization</th>}
                <th>Status</th>
                <th>Version</th>
                <th className="num">Assignments</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link href={`/restrictions/${p.id}`} className="strong">
                      {p.name}
                    </Link>
                    <div className="muted small">
                      <Mono>{p.code}</Mono>
                      {p.description && ` · ${p.description}`}
                    </div>
                  </td>
                  <td>
                    <KindBadge kind={p.kind} />
                  </td>
                  {isSuper && !orgId && <td>{p.organization_code}</td>}
                  <td>{!p.active_version ? <Badge tone="amber">not published</Badge> : p.is_active ? <Badge tone="green">active</Badge> : <Badge tone="gray">inactive</Badge>}</td>
                  <td>{p.active_version ? `v${p.active_version}` : <span className="muted">—</span>}</td>
                  <td className="num">
                    {assignments.data ? (
                      counts.get(p.id) ? (
                        <Link href="/access">{counts.get(p.id)}</Link>
                      ) : (
                        <span className="muted">0</span>
                      )
                    ) : (
                      '…'
                    )}
                  </td>
                  <td>{absTime(p.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">Restrictions cannot be deleted (their history is kept); deactivate one to stop it applying everywhere.</p>
    </>
  );
}
