'use client';
import { useSearchParams } from 'next/navigation';
import { Fragment, Suspense, useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useOrganizations } from '@/lib/queries';
import { absTime, relTime } from '@/lib/format';
import { AUDIT_ACTIONS, type AuditEntry, type Page } from '@/lib/types';
import { Button, Empty, ErrorBox, Mono, PageHeader, Pagination, Spinner } from '@/components/ui';
import { AuditSummary } from '@/components/AuditSummary';

/** datetime-local value (local time) → ISO-8601 for the API. */
const toIso = (v: string) => (v ? new Date(v).toISOString() : undefined);

function AuditInner() {
  const { isSuper } = useAuth();
  const params = useSearchParams();
  const orgs = useOrganizations();
  const [action, setAction] = useState(params.get('action') ?? '');
  const [actorType, setActorType] = useState('');
  const [org, setOrg] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [targetId, setTargetId] = useState(params.get('target_id') ?? '');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => setPage(1), [action, actorType, org, from, to, targetId, pageSize]);

  const query = {
    action: action || undefined,
    actor_type: actorType || undefined,
    organization_id: (isSuper && org) || undefined,
    target_id: targetId.trim() || undefined,
    from: toIso(from),
    to: toIso(to),
    page,
    page_size: pageSize,
  };
  const logs = useQuery({ queryKey: ['audit', query], queryFn: () => get<Page<AuditEntry>>('/audit-logs', query), placeholderData: keepPreviousData });
  const orgCode = (id: string | null) => (id ? orgs.data?.items.find((o) => o.id === id)?.code ?? id.slice(0, 8) : 'system');
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const hasFilters = action || actorType || org || from || to || targetId;

  return (
    <>
      <PageHeader title="Audit log" subtitle="Security-relevant events, newest first. Credentials and secrets are never recorded." />
      <div className="toolbar">
        <select value={action} onChange={(e) => setAction(e.target.value)} aria-label="Action">
          <option value="">All actions</option>
          {AUDIT_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select value={actorType} onChange={(e) => setActorType(e.target.value)} aria-label="Actor type">
          <option value="">Any actor</option>
          <option value="USER">User</option>
          <option value="DEVICE">Device</option>
          <option value="SYSTEM">System</option>
        </select>
        {isSuper && (
          <select value={org} onChange={(e) => setOrg(e.target.value)} aria-label="Organization">
            <option value="">All organizations</option>
            {orgs.data?.items.map((o) => (
              <option key={o.id} value={o.id}>
                {o.code} · {o.name}
              </option>
            ))}
          </select>
        )}
        <label className="inline-field">
          From
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="inline-field">
          To
          <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <input type="search" value={targetId} onChange={(e) => setTargetId(e.target.value)} placeholder="Target ID" aria-label="Target ID" />
        {hasFilters && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setAction('');
              setActorType('');
              setOrg('');
              setFrom('');
              setTo('');
              setTargetId('');
            }}
          >
            Clear filters
          </Button>
        )}
      </div>
      {logs.error && <ErrorBox error={logs.error} />}
      {logs.isLoading ? (
        <Spinner />
      ) : !logs.data?.items.length ? (
        <Empty>{hasFilters ? 'No events match these filters.' : 'No audit events yet.'}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table table-dense">
            <thead>
              <tr>
                <th>Time</th>
                <th>Action</th>
                {isSuper && <th>Org</th>}
                <th>Summary</th>
                <th>Actor ID</th>
                <th>IP</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {logs.data.items.map((e) => (
                <Fragment key={e.id}>
                  <tr className={e.action.includes('FAIL') ? 'row-warn' : undefined}>
                    <td className="nowrap" title={absTime(e.created_at)}>
                      {absTime(e.created_at)}
                      <div className="muted small">{relTime(e.created_at)}</div>
                    </td>
                    <td>
                      <code className="action-code">{e.action}</code>
                    </td>
                    {isSuper && <td>{orgCode(e.organization_id)}</td>}
                    <td>
                      <AuditSummary entry={e} />
                    </td>
                    <td>{e.actor_id ? <Mono title={e.actor_id}>{e.actor_id.slice(0, 10)}…</Mono> : <span className="muted">—</span>}</td>
                    <td>{e.ip ? <Mono>{e.ip}</Mono> : <span className="muted">—</span>}</td>
                    <td className="cell-actions">
                      {e.metadata && Object.keys(e.metadata).length > 0 && (
                        <Button size="sm" variant="ghost" aria-expanded={open.has(e.id)} onClick={() => toggle(e.id)}>
                          {open.has(e.id) ? 'Hide' : 'Details'}
                        </Button>
                      )}
                    </td>
                  </tr>
                  {open.has(e.id) && (
                    <tr className="row-detail">
                      <td colSpan={isSuper ? 7 : 6}>
                        <div className="detail-grid">
                          <div>
                            <div className="muted small">Target</div>
                            <Mono>
                              {e.target_type ?? '—'} {e.target_id ?? ''}
                            </Mono>
                          </div>
                          <div>
                            <div className="muted small">Actor</div>
                            <Mono>
                              {e.actor_type} {e.actor_id ?? ''}
                            </Mono>
                          </div>
                        </div>
                        <pre className="json">{JSON.stringify(e.metadata, null, 2)}</pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {logs.data && logs.data.total > 0 && (
        <div className="table-footer">
          <label className="inline-field">
            Rows
            <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
              {[25, 50, 100, 200].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <Pagination page={page} pageSize={pageSize} total={logs.data.total} onPage={setPage} />
        </div>
      )}
    </>
  );
}

export default function AuditPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <AuditInner />
    </Suspense>
  );
}
