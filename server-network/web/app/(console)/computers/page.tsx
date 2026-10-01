'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import { useOrgScope, setScopedOrg } from '@/lib/orgScope';
import { absTime, deviceName, relTime } from '@/lib/format';
import { DEVICE_STATUSES, type Device, type DeviceStatus, type Page } from '@/lib/types';
import { Alert, Badge, Button, Empty, ErrorBox, Mono, PageHeader, Pagination, SortTh, Spinner, StatusBadge, Tabs } from '@/components/ui';
import { DeviceActions } from '@/components/DeviceActions';
import { ComputerFormDialog, DeleteComputerDialog, useGroups } from '@/components/ComputerDialogs';
import { GroupsPanel } from '@/components/GroupsPanel';
import { AddMyPcButton, BulkAddFromNetworkDialog } from '@/components/NetworkDevices';
import { useConnectedDevices } from '@/lib/connectedDevices';

type SortKey = 'name' | 'org' | 'serial' | 'mac' | 'hostname' | 'status' | 'synced' | 'heartbeat' | 'ip' | 'agent' | 'effective';

/** Whether this computer's service has the latest restrictions, and when it last checked in. */
function SyncedCell({ device: d }: { device: Device }) {
  if (d.synced === null) return <span className="muted" title="Its service has never fetched restrictions">Never</span>;
  const when = d.synced_at ? <span className="muted small" title={absTime(d.synced_at)}> · {relTime(d.synced_at)}</span> : null;
  return d.synced ? (
    <span title="Its service has the latest restrictions">
      <Badge tone="green">✓ Synced</Badge>
      {when}
    </span>
  ) : (
    <span title="Restrictions changed after its last fetch; it updates on its next check-in">
      <Badge tone="amber">Out of date</Badge>
      {when}
    </span>
  );
}

function sortValue(d: Device, k: SortKey): string | number {
  switch (k) {
    case 'name':
      return deviceName(d).toLowerCase();
    case 'org':
      return d.organization.code;
    case 'serial':
      return d.serial_number ?? '';
    case 'mac':
      return d.mac_address ?? '';
    case 'hostname':
      return (d.hostname ?? '').toLowerCase();
    case 'status':
      return d.status;
    case 'synced':
      return d.synced === true ? 0 : d.synced === false ? 1 : 2;
    case 'heartbeat':
      return d.last_heartbeat_at ? new Date(d.last_heartbeat_at).getTime() : 0;
    case 'ip':
      return d.current_ip ?? '';
    case 'agent':
      return d.agent_version ?? '';
    case 'effective':
      return d.effective_policy_version ?? -1;
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

const STATUS_LABEL: Record<DeviceStatus, string> = {
  PRE_REGISTERED: 'Pre-registered',
  PENDING: 'Pending approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  REVOKED: 'Revoked',
};

function ComputersTable() {
  const params = useSearchParams();
  const { orgId, isSuper } = useOrgScope();
  const [status, setStatus] = useState<DeviceStatus | ''>((params.get('status') as DeviceStatus) ?? '');
  const [group, setGroup] = useState(params.get('group_id') ?? '');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null);
  const [adding, setAdding] = useState(false);
  const [bulkAdding, setBulkAdding] = useState(false);
  const connected = useConnectedDevices();
  const [editing, setEditing] = useState<Device | null>(null);
  const [deleting, setDeleting] = useState<Device | null>(null);
  const dq = useDebounced(q.trim());

  useEffect(() => setPage(1), [status, orgId, group, dq, pageSize]);
  // A group from another organization cannot match: clear it when the scope changes.
  const groups = useGroups(orgId);
  useEffect(() => {
    if (group && groups.data && !groups.data.items.some((g) => g.id === group)) setGroup('');
  }, [group, groups.data]);

  const query = { status: status || undefined, organization_id: (isSuper && orgId) || undefined, group_id: group || undefined, q: dq || undefined, page, page_size: pageSize };
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

  return (
    <>
      <div className="toolbar">
        <input type="search" placeholder="Search title, serial, MAC, hostname, UUID, IP…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search computers" className="grow" />
        <select value={status} onChange={(e) => setStatus(e.target.value as DeviceStatus | '')} aria-label="Status">
          <option value="">All statuses</option>
          {DEVICE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <select value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Group">
          <option value="">All groups</option>
          {groups.data?.items.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} ({g.member_count ?? 0})
            </option>
          ))}
        </select>
        <AddMyPcButton isSuper={isSuper} orgId={orgId} />
        <Button onClick={() => setBulkAdding(true)} disabled={!connected} title={connected ? `Add computers found on the local network (${connected.devices.length})` : 'Open the console from the SoftProIt Network Admin desktop app to scan the network.'}>
          Add from network{connected ? ` (${connected.devices.length})` : ''}
        </Button>
        <Button variant="primary" onClick={() => setAdding(true)}>
          Add computer
        </Button>
      </div>

      {devices.error && <ErrorBox error={devices.error} />}
      {devices.isLoading ? (
        <Spinner />
      ) : !rows.length ? (
        <Empty>{dq || status || group ? 'No computers match these filters.' : 'No computers yet. Add one by MAC address, or install the agent and let it register.'}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table table-dense">
            <thead>
              <tr>
                <SortTh label="Title" k="name" sort={sort} onSort={onSort} />
                {isSuper && !orgId && <SortTh label="Org" k="org" sort={sort} onSort={onSort} />}
                <SortTh label="Serial" k="serial" sort={sort} onSort={onSort} />
                <SortTh label="MAC" k="mac" sort={sort} onSort={onSort} />
                <th>Groups</th>
                <SortTh label="Status" k="status" sort={sort} onSort={onSort} />
                <SortTh label="Synced" k="synced" sort={sort} onSort={onSort} />
                <SortTh label="Hostname" k="hostname" sort={sort} onSort={onSort} />
                <SortTh label="Last heartbeat" k="heartbeat" sort={sort} onSort={onSort} />
                <SortTh label="IP" k="ip" sort={sort} onSort={onSort} />
                <SortTh label="Agent" k="agent" sort={sort} onSort={onSort} />
                <SortTh label="Rules" k="effective" sort={sort} onSort={onSort} />
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td>
                    <Link href={`/computers/${d.id}`} className="strong">
                      {deviceName(d)}
                    </Link>
                  </td>
                  {isSuper && !orgId && (
                    <td title={d.organization.name}>
                      <button type="button" className="link-btn" onClick={() => setScopedOrg(d.organization.id)} title="Show only this organization">
                        {d.organization.code}
                      </button>
                    </td>
                  )}
                  <td>{d.serial_number ?? <span className="muted">—</span>}</td>
                  <td className="nowrap">{d.mac_address ? <Mono>{d.mac_address}</Mono> : <span className="muted">—</span>}</td>
                  <td>
                    {d.groups.length ? (
                      <span className="chips">
                        {d.groups.map((g) => (
                          <span key={g.id} className="chip">
                            {g.name}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <StatusBadge status={d.status} />
                    {d.policy_status?.error_code && <div className="small text-danger">{d.policy_status.error_code}</div>}
                  </td>
                  <td className="nowrap">
                    <SyncedCell device={d} />
                  </td>
                  <td>{d.hostname ?? <span className="muted">not registered</span>}</td>
                  <td className="nowrap">
                    {d.status === 'PRE_REGISTERED' ? (
                      <span className="muted">—</span>
                    ) : (
                      <>
                        <span className={`dot ${d.online ? 'dot-on' : 'dot-off'}`} aria-hidden />
                        <span className="sr-only">{d.online ? 'online' : 'offline'} · </span>
                        <span title={absTime(d.last_heartbeat_at)}>{relTime(d.last_heartbeat_at)}</span>
                      </>
                    )}
                  </td>
                  <td>{d.current_ip ? <Mono>{d.current_ip}</Mono> : <span className="muted">—</span>}</td>
                  <td>{d.agent_version ?? <span className="muted">—</span>}</td>
                  <td>
                    {d.effective_policy_version ? (
                      <Badge tone={d.current_policy?.version === d.effective_policy_version ? 'green' : 'neutral'} title={d.current_policy?.version === d.effective_policy_version ? 'Applied by the agent' : 'Served by the server; not yet confirmed by the agent'}>
                        v{d.effective_policy_version}
                      </Badge>
                    ) : (
                      <span className="muted">none</span>
                    )}
                  </td>
                  <td className="cell-actions">
                    <div className="btn-row">
                      <DeviceActions device={d} only={['approve', 'reject']} size="sm" />
                      <Button size="sm" onClick={() => setEditing(d)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" className="text-danger" onClick={() => setDeleting(d)}>
                        Delete
                      </Button>
                    </div>
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
      {sort && <p className="muted small">Sorting applies to the current page; the API returns the newest computers first.</p>}

      <ComputerFormDialog open={adding} defaultOrgId={orgId} onClose={() => setAdding(false)} />
      <BulkAddFromNetworkDialog open={bulkAdding} isSuper={isSuper} orgId={orgId} onClose={() => setBulkAdding(false)} />
      <ComputerFormDialog open={!!editing} device={editing} defaultOrgId={orgId} onClose={() => setEditing(null)} />
      <DeleteComputerDialog device={deleting} onClose={() => setDeleting(null)} />
    </>
  );
}

type Tab = 'computers' | 'groups';

function ComputersInner() {
  const params = useSearchParams();
  const router = useRouter();
  const tab: Tab = params.get('tab') === 'groups' ? 'groups' : 'computers';
  // Links from an organization page carry ?organization_id=… : adopt it as the working organization.
  const linkedOrg = params.get('organization_id');
  useEffect(() => {
    if (linkedOrg) setScopedOrg(linkedOrg);
  }, [linkedOrg]);
  const setTab = (t: Tab) => {
    const p = new URLSearchParams(params.toString());
    if (t === 'groups') p.set('tab', 'groups');
    else p.delete('tab');
    const s = p.toString();
    router.replace(`/computers${s ? `?${s}` : ''}`);
  };
  return (
    <>
      <PageHeader title="Computers" subtitle="Every computer of the organization — pre-added by MAC address or registered by the Windows agent." />
      <Alert tone="info">
        <strong>How pre-added computers link:</strong> when the agent on a computer registers and reports a network adapter with the same MAC address, it is linked to the pre-added entry (title, serial and
        groups are kept) and moves to <em>Pending approval</em>. It still has to be approved before it receives restrictions.
      </Alert>
      <Tabs
        label="Computers sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'computers', label: 'Computers' },
          { key: 'groups', label: 'Groups' },
        ]}
      />
      {tab === 'computers' ? <ComputersTable /> : <GroupsPanel />}
    </>
  );
}

export default function ComputersPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <ComputersInner />
    </Suspense>
  );
}
