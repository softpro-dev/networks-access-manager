'use client';
import Link from 'next/link';
import { useQueries, useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useOrgMap } from '@/lib/queries';
import { absTime, deviceName, relTime } from '@/lib/format';
import type { AuditEntry, Device, DeviceStatus, Page } from '@/lib/types';
import { Card, Empty, ErrorBox, Mono, PageHeader, Spinner, StatusBadge } from '@/components/ui';
import { DeviceActions } from '@/components/DeviceActions';
import { AuditSummary } from '@/components/AuditSummary';

const STATUSES: DeviceStatus[] = ['PENDING', 'APPROVED', 'REJECTED', 'REVOKED'];

export default function DashboardPage() {
  const { isSuper } = useAuth();
  const orgMap = useOrgMap();

  const counts = useQueries({
    queries: STATUSES.map((s) => ({
      queryKey: ['dashboard', 'count', s],
      queryFn: () => get<Page<Device>>('/devices', { status: s, page_size: 1 }),
      refetchInterval: 30_000,
    })),
  });
  const pending = useQuery({
    queryKey: ['dashboard', 'pending'],
    queryFn: () => get<Page<Device>>('/devices', { status: 'PENDING', page_size: 10 }),
    refetchInterval: 30_000,
  });
  const approved = useQuery({
    queryKey: ['dashboard', 'approved'],
    queryFn: () => get<Page<Device>>('/devices', { status: 'APPROVED', page_size: 200 }),
    refetchInterval: 30_000,
  });
  const failures = useQuery({
    queryKey: ['dashboard', 'failures'],
    queryFn: () => get<Page<AuditEntry>>('/audit-logs', { action: 'POLICY_APPLICATION_FAILED', page_size: 8 }),
    refetchInterval: 30_000,
  });
  const recent = useQuery({
    queryKey: ['dashboard', 'recent'],
    queryFn: () => get<Page<AuditEntry>>('/audit-logs', { page_size: 10 }),
    refetchInterval: 30_000,
  });

  // The API computes `online` as "heartbeat within 3 × HEARTBEAT_INTERVAL_SECONDS".
  const stale = (approved.data?.items ?? []).filter((d) => !d.online);

  return (
    <>
      <PageHeader title="Dashboard" subtitle={isSuper ? 'All organizations' : undefined} />
      <div className="stat-grid">
        {STATUSES.map((s, i) => {
          const q = counts[i]!;
          return (
            <Link key={s} href={`/devices?status=${s}`} className={`stat stat-${s.toLowerCase()}`}>
              <span className="stat-label">{s.charAt(0) + s.slice(1).toLowerCase()}</span>
              <span className="stat-value">{q.isLoading ? '…' : q.isError ? '!' : q.data?.total ?? 0}</span>
            </Link>
          );
        })}
      </div>

      <div className="grid-2">
        <Card title={`Pending approvals${pending.data ? ` (${pending.data.total})` : ''}`} actions={<Link href="/devices?status=PENDING">View all</Link>}>
          {pending.isLoading ? (
            <Spinner />
          ) : pending.error ? (
            <ErrorBox error={pending.error} />
          ) : !pending.data?.items.length ? (
            <Empty>No devices are waiting for approval.</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Device</th>
                  {isSuper && <th>Org</th>}
                  <th>Registered</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pending.data.items.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <Link href={`/devices/${d.id}`}>{deviceName(d)}</Link>
                      <div className="muted small">{d.current_ip ?? d.last_request_ip ?? ''}</div>
                    </td>
                    {isSuper && <td>{d.organization.code}</td>}
                    <td title={absTime(d.created_at)}>{relTime(d.created_at)}</td>
                    <td className="cell-actions">
                      <DeviceActions device={d} only={['approve', 'reject']} size="sm" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title={`Stale heartbeat${approved.data ? ` (${stale.length})` : ''}`}>
          {approved.isLoading ? (
            <Spinner />
          ) : approved.error ? (
            <ErrorBox error={approved.error} />
          ) : stale.length === 0 ? (
            <Empty>All approved devices reported within 3 × the heartbeat interval.</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Device</th>
                  {isSuper && <th>Org</th>}
                  <th>Last heartbeat</th>
                  <th>Last IP</th>
                </tr>
              </thead>
              <tbody>
                {stale.slice(0, 12).map((d) => (
                  <tr key={d.id}>
                    <td>
                      <Link href={`/devices/${d.id}`}>{deviceName(d)}</Link>
                    </td>
                    {isSuper && <td>{d.organization.code}</td>}
                    <td title={absTime(d.last_heartbeat_at)}>{relTime(d.last_heartbeat_at)}</td>
                    <td>{d.current_ip ? <Mono>{d.current_ip}</Mono> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {approved.data && approved.data.total > approved.data.items.length && (
            <p className="muted small">Checked the {approved.data.items.length} most recently registered of {approved.data.total} approved devices.</p>
          )}
          {stale.length > 12 && <p className="muted small">+ {stale.length - 12} more</p>}
        </Card>

        <Card title="Recent policy failures" actions={<Link href="/audit?action=POLICY_APPLICATION_FAILED">Audit log</Link>}>
          {failures.isLoading ? (
            <Spinner />
          ) : failures.error ? (
            <ErrorBox error={failures.error} />
          ) : !failures.data?.items.length ? (
            <Empty>No policy application failures reported.</Empty>
          ) : (
            <ul className="event-list">
              {failures.data.items.map((e) => (
                <li key={e.id}>
                  <div className="event-main">
                    <StatusBadge status={String((e.metadata?.status as string) ?? 'FAILED')} />
                    <span>
                      {e.target_type === 'Device' && e.target_id ? <Link href={`/devices/${e.target_id}`}>{String(e.metadata?.device_uuid ?? 'device').slice(0, 13)}</Link> : 'device'}
                      {e.metadata?.policy_code ? (
                        <>
                          {' · '}
                          <Mono>
                            {String(e.metadata.policy_code)} v{String(e.metadata.version ?? '?')}
                          </Mono>
                        </>
                      ) : null}
                    </span>
                  </div>
                  <div className="muted small">
                    {e.metadata?.error_code ? <Mono>{String(e.metadata.error_code)}</Mono> : null} {e.metadata?.message ? String(e.metadata.message) : ''}
                    {' · '}
                    <span title={absTime(e.created_at)}>{relTime(e.created_at)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Recent audit events" actions={<Link href="/audit">View all</Link>}>
          {recent.isLoading ? (
            <Spinner />
          ) : recent.error ? (
            <ErrorBox error={recent.error} />
          ) : !recent.data?.items.length ? (
            <Empty>No audit events yet.</Empty>
          ) : (
            <ul className="event-list">
              {recent.data.items.map((e) => (
                <li key={e.id}>
                  <div className="event-main">
                    <code className="action-code">{e.action}</code>
                    {isSuper && e.organization_id && <span className="muted small">{orgMap.get(e.organization_id)?.code ?? ''}</span>}
                  </div>
                  <div className="muted small">
                    <AuditSummary entry={e} /> · <span title={absTime(e.created_at)}>{relTime(e.created_at)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
