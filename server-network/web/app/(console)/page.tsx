'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import { useOrgScope } from '@/lib/orgScope';
import { useOrgMap } from '@/lib/queries';
import { absTime, deviceName, relTime } from '@/lib/format';
import { KIND_INFO, KINDS, VIA_LABEL } from '@/lib/restrictions';
import { DEVICE_STATUSES, type AnalyticsOrgRow, type AnalyticsOverview, type AssignmentScope, type AuditEntry, type Device, type DeviceStatus, type Page } from '@/lib/types';
import { Badge, Button, Card, Empty, ErrorBox, Mono, PageHeader, Spinner, StatusBadge } from '@/components/ui';
import { DeviceActions } from '@/components/DeviceActions';
import { AuditSummary } from '@/components/AuditSummary';
import { BarList, StackedBar } from '@/components/Charts';

const STATUS_TONE: Record<DeviceStatus, string> = {
  PRE_REGISTERED: 'tone-accent',
  PENDING: 'tone-warn',
  APPROVED: 'tone-ok',
  REJECTED: 'tone-muted',
  REVOKED: 'tone-danger',
};
const STATUS_LABEL: Record<DeviceStatus, string> = { PRE_REGISTERED: 'Pre-registered', PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected', REVOKED: 'Revoked' };
const KIND_TONE = { ALLOW_ONLY: 'tone-ok', BLACKLIST: 'tone-danger', REDIRECT: 'tone-violet' } as const;
const SCOPES: AssignmentScope[] = ['ORGANIZATION', 'GROUP', 'DEVICE'];

function Tile({ label, value, href, tone }: { label: string; value: number | string; href: string; tone?: string }) {
  return (
    <Link href={href} className={`stat ${tone ?? ''}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </Link>
  );
}

function OrgCharts({ row, groups }: { row: AnalyticsOrgRow; groups: AnalyticsOverview['groups'] }) {
  const sizes = [...groups].sort((a, b) => b.members - a.members).slice(0, 10);
  return (
    <div className="grid-2">
      <Card title="Computers by status" actions={<Link href="/computers">Computers</Link>}>
        <StackedBar label="Computers by status" segments={DEVICE_STATUSES.map((s) => ({ key: s, label: STATUS_LABEL[s], value: row.computers.by_status[s], tone: STATUS_TONE[s] }))} />
        <p className="muted small">
          {row.computers.online} of {row.computers.by_status.APPROVED} approved computers are online (heartbeat within 3 × the interval).
        </p>
      </Card>
      <Card title="Restrictions by type" actions={<Link href="/restrictions">Restrictions</Link>}>
        <BarList bars={KINDS.map((k) => ({ key: k, label: KIND_INFO[k].label, value: row.restrictions.by_kind[k], tone: KIND_TONE[k] }))} />
        <p className="muted small">
          {row.restrictions.active} of {row.restrictions.total} are active and published.
        </p>
      </Card>
      <Card title="Assignments by scope" actions={<Link href="/access">Set access</Link>}>
        <BarList bars={SCOPES.map((s) => ({ key: s, label: s === 'DEVICE' ? 'Single computers' : s === 'GROUP' ? 'Groups' : VIA_LABEL[s], value: row.assignments[s], tone: 'tone-accent' }))} />
      </Card>
      <Card title="Group sizes" actions={<Link href="/computers?tab=groups">Groups</Link>}>
        <BarList bars={sizes.map((g) => ({ key: g.id, label: <Link href={`/computers?group_id=${g.id}`}>{g.name}</Link>, value: g.members, tone: 'tone-violet' }))} empty="No groups yet." />
        {groups.length > sizes.length && <p className="muted small">Largest 10 of {groups.length} groups.</p>}
      </Card>
    </div>
  );
}

function AllOrgs({ data, onPick }: { data: AnalyticsOverview; onPick: (id: string) => void }) {
  const rows = data.organizations;
  return (
    <>
      <Card title="Organizations" actions={<span className="muted small">Click a row to focus on that organization</span>}>
        {!rows.length ? (
          <Empty>No organizations yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table table-click">
              <thead>
                <tr>
                  <th>Organization</th>
                  <th className="num">Computers</th>
                  <th className="num">Online</th>
                  <th className="num">Pending</th>
                  <th className="num">Pre-registered</th>
                  <th className="num">Restrictions</th>
                  <th className="num">Assignments</th>
                  <th className="num">Failing</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.organization.id} onClick={() => onPick(r.organization.id)}>
                    <td>
                      <button type="button" className="link-btn strong" onClick={() => onPick(r.organization.id)}>
                        {r.organization.code}
                      </button>{' '}
                      <span className="muted">{r.organization.name}</span> {r.organization.status !== 'ACTIVE' && <StatusBadge status={r.organization.status} />}
                    </td>
                    <td className="num">{r.computers.total}</td>
                    <td className="num">{r.computers.online}</td>
                    <td className="num">{r.computers.by_status.PENDING || <span className="muted">0</span>}</td>
                    <td className="num">{r.computers.by_status.PRE_REGISTERED}</td>
                    <td className="num">
                      {r.restrictions.active}/{r.restrictions.total}
                    </td>
                    <td className="num">{r.assignments.ORGANIZATION + r.assignments.GROUP + r.assignments.DEVICE}</td>
                    <td className="num">{r.failing_computers ? <Badge tone="red">{r.failing_computers}</Badge> : <span className="muted">0</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="grid-2">
        <Card title="Computers per organization">
          <BarList bars={rows.map((r) => ({ key: r.organization.id, label: r.organization.code, value: r.computers.total, tone: 'tone-accent', onClick: () => onPick(r.organization.id) }))} />
        </Card>
        <Card title="Online computers per organization">
          <BarList bars={rows.map((r) => ({ key: r.organization.id, label: r.organization.code, value: r.computers.online, tone: 'tone-ok', onClick: () => onPick(r.organization.id) }))} />
        </Card>
        <Card title="Restrictions per organization">
          <BarList bars={rows.map((r) => ({ key: r.organization.id, label: r.organization.code, value: r.restrictions.total, tone: 'tone-violet', onClick: () => onPick(r.organization.id) }))} />
        </Card>
        <Card title="Restrictions by type (all organizations)">
          <BarList bars={KINDS.map((k) => ({ key: k, label: KIND_INFO[k].label, value: rows.reduce((a, r) => a + r.restrictions.by_kind[k], 0), tone: KIND_TONE[k] }))} />
        </Card>
      </div>
    </>
  );
}

export default function DashboardPage() {
  const { orgId, org, isSuper, setOrgId } = useOrgScope();
  const orgMap = useOrgMap();
  const scope = (isSuper && orgId) || undefined;
  const overview = useQuery({
    queryKey: ['analytics', { org: orgId }],
    queryFn: () => get<AnalyticsOverview>('/analytics/overview', { organization_id: scope }),
    refetchInterval: 30_000,
  });
  const pendingQuery = { status: 'PENDING', organization_id: scope, page_size: 10 };
  const pending = useQuery({ queryKey: ['devices', { dashboard: true, ...pendingQuery }], queryFn: () => get<Page<Device>>('/devices', pendingQuery), refetchInterval: 30_000 });
  const recent = useQuery({
    queryKey: ['audit', { dashboard: true, org: orgId }],
    queryFn: () => get<Page<AuditEntry>>('/audit-logs', { organization_id: scope, page_size: 8 }),
    refetchInterval: 30_000,
  });

  const d = overview.data;
  const t = d?.totals;
  const allOrgs = isSuper && !orgId;
  const row = !allOrgs ? d?.organizations[0] : undefined;
  const v = (n: number | undefined) => (overview.isLoading ? '…' : overview.isError ? '!' : (n ?? 0));

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={isSuper ? (org ? `${org.code} · ${org.name}` : 'All organizations') : undefined}
        actions={
          isSuper &&
          orgId && (
            <Button size="sm" onClick={() => setOrgId('')}>
              Show all organizations
            </Button>
          )
        }
      />
      {overview.error && <ErrorBox error={overview.error} title="Could not load statistics" />}
      <div className="stat-grid">
        {allOrgs && <Tile label="Organizations" value={v(t?.organizations)} href="/organizations" />}
        <Tile label="Computers" value={v(t?.computers)} href="/computers" />
        <Tile label="Online" value={v(t?.online)} href="/computers?status=APPROVED" tone="stat-approved" />
        <Tile label="Pending approval" value={v(t?.pending)} href="/computers?status=PENDING" tone="stat-pending" />
        <Tile label="Pre-registered" value={v(t?.pre_registered)} href="/computers?status=PRE_REGISTERED" tone="stat-pre" />
        <Tile label="Restrictions" value={v(t?.restrictions)} href="/restrictions" tone="stat-restrictions" />
        <Tile label="Failing" value={v(t?.failing_computers)} href="/audit?action=POLICY_APPLICATION_FAILED" tone="stat-revoked" />
      </div>

      {overview.isLoading ? <Spinner /> : d && (allOrgs ? <AllOrgs data={d} onPick={setOrgId} /> : row && <OrgCharts row={row} groups={d.groups} />)}

      <div className="grid-2">
        <Card title={`Pending approvals${pending.data ? ` (${pending.data.total})` : ''}`} actions={<Link href="/computers?status=PENDING">View all</Link>}>
          {pending.isLoading ? (
            <Spinner />
          ) : pending.error ? (
            <ErrorBox error={pending.error} />
          ) : !pending.data?.items.length ? (
            <Empty>No computers are waiting for approval.</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Computer</th>
                  {allOrgs && <th>Org</th>}
                  <th>Registered</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {pending.data.items.map((x) => (
                  <tr key={x.id}>
                    <td>
                      <Link href={`/computers/${x.id}`}>{deviceName(x)}</Link>
                      <div className="muted small">
                        {[x.hostname, x.mac_address, x.current_ip ?? x.last_request_ip].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    {allOrgs && <td>{x.organization.code}</td>}
                    <td title={absTime(x.created_at)}>{relTime(x.created_at)}</td>
                    <td className="cell-actions">
                      <DeviceActions device={x} only={['approve', 'reject']} size="sm" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Recent failures" actions={<Link href="/audit?action=POLICY_APPLICATION_FAILED">Audit log</Link>}>
          {!d ? (
            overview.isLoading ? <Spinner /> : null
          ) : !d.recent_failures.length ? (
            <Empty>No computer currently reports a failure applying its rules.</Empty>
          ) : (
            <ul className="event-list">
              {d.recent_failures.slice(0, 10).map((f) => (
                <li key={f.device_id}>
                  <div className="event-main">
                    <StatusBadge status={f.status} />
                    <Link href={`/computers/${f.device_id}`}>{f.title ?? 'Computer'}</Link>
                    {allOrgs && <span className="muted small">{orgMap.get(f.organization_id)?.code ?? ''}</span>}
                  </div>
                  <div className="muted small">
                    {f.error_code && <Mono>{f.error_code}</Mono>} <span title={absTime(f.updated_at)}>{relTime(f.updated_at)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

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
                  {allOrgs && e.organization_id && <span className="muted small">{orgMap.get(e.organization_id)?.code ?? ''}</span>}
                </div>
                <div className="muted small">
                  <AuditSummary entry={e} /> · <span title={absTime(e.created_at)}>{relTime(e.created_at)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {d && <p className="muted small">Statistics generated {relTime(d.generated_at)} · aggregate counts only.</p>}
    </>
  );
}
