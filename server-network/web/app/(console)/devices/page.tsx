'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useOrganizations } from '@/lib/queries';
import { absTime, deviceName, relTime } from '@/lib/format';
import type { Device, DeviceGroup, DeviceStatus, List, Page } from '@/lib/types';
import { Badge, Empty, ErrorBox, Mono, PageHeader, Pagination, SortTh, Spinner, StatusBadge } from '@/components/ui';

type SortKey = 'name' | 'org' | 'hostname' | 'status' | 'heartbeat' | 'ip' | 'agent' | 'policy' | 'policy_status';

function sortValue(d: Device, k: SortKey): string | number {
  switch (k) {
    case 'name':
      return deviceName(d).toLowerCase();
    case 'org':
      return d.organization.code;
    case 'hostname':
      return d.hostname.toLowerCase();
    case 'status':
      return d.status;
    case 'heartbeat':
      return d.last_heartbeat_at ? new Date(d.last_heartbeat_at).getTime() : 0;
    case 'ip':
      return d.current_ip ?? '';
    case 'agent':
      return d.agent_version ?? '';
    case 'policy':
      return `${d.current_policy?.policy_id ?? ''}#${String(d.current_policy?.version ?? 0).padStart(8, '0')}`;
    case 'policy_status':
      return d.policy_status?.status ?? '';
  }
}

function useDebounced<T>(v: T, ms = 300): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

function DevicesInner() {
  const { isSuper } = useAuth();
  const params = useSearchParams();
  const orgs = useOrganizations();
  const [status, setStatus] = useState<DeviceStatus | ''>((params.get('status') as DeviceStatus) ?? '');
  const [org, setOrg] = useState(params.get('organization_id') ?? '');
  const [group, setGroup] = useState(params.get('group_id') ?? '');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null);
  const dq = useDebounced(q.trim());

  useEffect(() => setPage(1), [status, org, group, dq, pageSize]);

  const groups = useQuery({
    queryKey: ['groups', { org }],
    queryFn: () => get<List<DeviceGroup>>('/device-groups', { organization_id: org || undefined }),
  });

  const query = { status: status || undefined, organization_id: (isSuper && org) || undefined, group_id: group || undefined, q: dq || undefined, page, page_size: pageSize };
  const devices = useQuery({
    queryKey: ['devices', query],
    queryFn: () => get<Page<Device>>('/devices', query),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

  const rows = useMemo(() => {
    const items = devices.data?.items ?? [];
    if (!sort) return items;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...items].sort((a, b) => {
      const x = sortValue(a, sort.key);
      const y = sortValue(b, sort.key);
      return x < y ? -dir : x > y ? dir : 0;
    });
  }, [devices.data, sort]);

  const onSort = (k: SortKey) => setSort((s) => (s?.key === k ? (s.dir === 'asc' ? { key: k, dir: 'desc' } : null) : { key: k, dir: 'asc' }));
  const orgName = (id: string) => orgs.data?.items.find((o) => o.id === id)?.code;

  return (
    <>
      <PageHeader title="Devices" subtitle="Devices register themselves via the Windows agent; approve them here." />
      <div className="toolbar">
        <input type="search" placeholder="Search hostname, name, UUID, IP…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search devices" className="grow" />
        {isSuper && (
          <select
            value={org}
            onChange={(e) => {
              setOrg(e.target.value);
              setGroup('');
            }}
            aria-label="Organization"
          >
            <option value="">All organizations</option>
            {orgs.data?.items.map((o) => (
              <option key={o.id} value={o.id}>
                {o.code} · {o.name}
              </option>
            ))}
          </select>
        )}
        <select value={status} onChange={(e) => setStatus(e.target.value as DeviceStatus | '')} aria-label="Status">
          <option value="">All statuses</option>
          {(['PENDING', 'APPROVED', 'REJECTED', 'REVOKED'] as const).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Group">
          <option value="">All groups</option>
          {groups.data?.items.map((g) => (
            <option key={g.id} value={g.id}>
              {isSuper && !org ? `${orgName(g.organization_id) ?? ''} · ` : ''}
              {g.name}
            </option>
          ))}
        </select>
      </div>

      {devices.error && <ErrorBox error={devices.error} />}
      {devices.isLoading ? (
        <Spinner />
      ) : !rows.length ? (
        <Empty>{dq || status || org || group ? 'No devices match these filters.' : 'No devices have registered yet.'}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table table-dense">
            <thead>
              <tr>
                <SortTh label="Device" k="name" sort={sort} onSort={onSort} />
                {isSuper && <SortTh label="Organization" k="org" sort={sort} onSort={onSort} />}
                <SortTh label="Hostname" k="hostname" sort={sort} onSort={onSort} />
                <th>UUID</th>
                <SortTh label="Status" k="status" sort={sort} onSort={onSort} />
                <th>Approval</th>
                <SortTh label="Last heartbeat" k="heartbeat" sort={sort} onSort={onSort} />
                <SortTh label="Current IP" k="ip" sort={sort} onSort={onSort} />
                <SortTh label="Agent" k="agent" sort={sort} onSort={onSort} />
                <SortTh label="Current policy" k="policy" sort={sort} onSort={onSort} />
                <SortTh label="Policy status" k="policy_status" sort={sort} onSort={onSort} />
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td>
                    <Link href={`/devices/${d.id}`} className="strong">
                      {deviceName(d)}
                    </Link>
                  </td>
                  {isSuper && <td title={d.organization.name}>{d.organization.code}</td>}
                  <td>{d.hostname}</td>
                  <td>
                    <Mono title={d.device_uuid}>{d.device_uuid.slice(0, 8)}…</Mono>
                  </td>
                  <td>
                    <StatusBadge status={d.status} />
                  </td>
                  <td className="small">
                    {d.approval.approved_at ? (
                      <span title={`${absTime(d.approval.approved_at)}${d.approval.approved_by ? ` by ${d.approval.approved_by.email}` : ''}`}>
                        Approved {relTime(d.approval.approved_at)}
                      </span>
                    ) : d.status === 'PENDING' ? (
                      <span className="muted">Awaiting approval</span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="nowrap">
                    <span className={`dot ${d.online ? 'dot-on' : 'dot-off'}`} aria-label={d.online ? 'online' : 'offline'} />
                    <span title={absTime(d.last_heartbeat_at)}>{relTime(d.last_heartbeat_at)}</span>
                    <div className="muted small">{absTime(d.last_heartbeat_at)}</div>
                  </td>
                  <td>{d.current_ip ? <Mono>{d.current_ip}</Mono> : <span className="muted">—</span>}</td>
                  <td>{d.agent_version ?? <span className="muted">—</span>}</td>
                  <td>
                    {d.current_policy ? (
                      <span title={d.current_policy.name ?? undefined}>
                        {d.current_policy.id ? <Link href={`/policies/${d.current_policy.id}`}>{d.current_policy.policy_id}</Link> : <span className="muted">unknown</span>}{' '}
                        <Badge>v{d.current_policy.version}</Badge>
                      </span>
                    ) : (
                      <span className="muted">none</span>
                    )}
                  </td>
                  <td>
                    <StatusBadge status={d.policy_status?.status} />
                    {d.policy_status?.error_code && <div className="small text-danger">{d.policy_status.error_code}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {devices.data && devices.data.total > 0 && (
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
          <Pagination page={page} pageSize={pageSize} total={devices.data.total} onPage={setPage} />
        </div>
      )}
      {sort && <p className="muted small">Sorting applies to the current page; the API returns newest registrations first.</p>}
    </>
  );
}

export default function DevicesPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <DevicesInner />
    </Suspense>
  );
}
