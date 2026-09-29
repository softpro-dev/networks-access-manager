'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { absTime, deviceName, relTime } from '@/lib/format';
import type { DeviceDetail } from '@/lib/types';
import { Alert, Badge, Button, Card, Empty, ErrorBox, KeyValue, Mono, PageHeader, Spinner, StatusBadge } from '@/components/ui';
import { DeviceActions } from '@/components/DeviceActions';
import { ComputerFormDialog, DeleteComputerDialog } from '@/components/ComputerDialogs';
import { EffectiveRules } from '@/components/EffectiveRules';

export default function ComputerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { isSuper } = useAuth();
  const q = useQuery({ queryKey: ['device', id], queryFn: () => get<DeviceDetail>(`/devices/${id}`), refetchInterval: 30_000 });
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorBox error={q.error ?? new Error('Computer not found')} title="Could not load computer" />;
  const d = q.data;
  const ps = d.policy_status;
  const failed = ps && ['FAILED', 'VALIDATION_FAILED', 'ROLLED_BACK'].includes(ps.status);
  const eff = d.effective_policy;
  const agentVersion = d.current_policy?.version ?? null;
  const pre = d.status === 'PRE_REGISTERED';

  return (
    <>
      <nav className="breadcrumb">
        <Link href="/computers">Computers</Link> / {deviceName(d)}
      </nav>
      <PageHeader
        title={
          <>
            {deviceName(d)} <StatusBadge status={d.status} />
          </>
        }
        subtitle={
          <>
            {d.hostname ?? 'Agent not registered yet'}
            {d.mac_address && <> · {d.mac_address}</>}
            {isSuper && ` · ${d.organization.code} · ${d.organization.name}`}
          </>
        }
        actions={
          <>
            <Button onClick={() => setEditing(true)}>Edit</Button>
            <DeviceActions device={d} />
            <Button variant="danger" onClick={() => setDeleting(true)}>
              Delete
            </Button>
          </>
        }
      />
      {pre && (
        <Alert tone="info" title="Pre-registered — waiting for the agent">
          This computer was added by MAC address. When the Windows agent on the machine with adapter <Mono>{d.mac_address}</Mono> registers with organization <Mono>{d.organization.code}</Mono>, it is linked to
          this entry and moves to <em>Pending approval</em>. Approve it then; its groups and restrictions are already in place.
        </Alert>
      )}
      {d.status === 'PENDING' && (
        <Alert tone="warn" title="Awaiting approval">
          This computer registered and is waiting for an administrator. Verify the hostname, MAC and UUID match the machine before approving.
        </Alert>
      )}
      {failed && (
        <Alert tone="error" title={`Rules ${ps!.status.replace(/_/g, ' ').toLowerCase()} on the computer`}>
          {ps!.error_code && <Mono>{ps!.error_code}</Mono>} {ps!.message}
        </Alert>
      )}

      <div className="grid-2">
        <Card title="Computer" actions={<Button size="sm" onClick={() => setEditing(true)}>Edit</Button>}>
          <KeyValue
            rows={[
              ['Title', d.title ?? d.display_name],
              ['Serial number', d.serial_number],
              ['MAC address', d.mac_address ? <Mono key="m">{d.mac_address}</Mono> : null],
              [
                'Groups',
                d.groups.length ? (
                  <span key="g" className="chips">
                    {d.groups.map((g) => (
                      <Link key={g.id} href={`/computers/groups/${g.id}`} className="chip">
                        {g.name}
                      </Link>
                    ))}
                  </span>
                ) : (
                  <span key="g" className="muted">
                    None
                  </span>
                ),
              ],
              ['Organization', `${d.organization.code} · ${d.organization.name}`],
              ['Status', <StatusBadge key="s" status={d.status} />],
              [
                'Approval',
                d.approval.approved_at ? `${absTime(d.approval.approved_at)}${d.approval.approved_by ? ` by ${d.approval.approved_by.email}` : ''}` : d.status === 'PENDING' ? 'Awaiting approval' : null,
              ],
              ['Added', absTime(d.created_at)],
            ]}
          />
        </Card>

        <Card title="Agent">
          {pre ? (
            <Empty>No agent has registered for this computer yet.</Empty>
          ) : (
            <KeyValue
              rows={[
                ['Hostname', d.hostname],
                ['Device UUID', d.device_uuid ? <Mono key="u">{d.device_uuid}</Mono> : null],
                [
                  'Last heartbeat',
                  <span key="h">
                    <span className={`dot ${d.online ? 'dot-on' : 'dot-off'}`} aria-hidden /> {d.online ? 'Online' : 'Offline'} · {relTime(d.last_heartbeat_at)}{' '}
                    <span className="muted">({absTime(d.last_heartbeat_at)})</span>
                  </span>,
                ],
                ['Current IP', d.current_ip ? <Mono key="ip">{d.current_ip}</Mono> : null],
                ['Last request IP', d.last_request_ip ? <Mono key="rip">{d.last_request_ip}</Mono> : null],
                ['Agent version', d.agent_version],
                ['Windows version', d.windows_version],
                ['Reported status', d.reported_status ? <StatusBadge key="r" status={d.reported_status} /> : null],
                ['Rules applied', agentVersion ? <Badge key="a">v{agentVersion}</Badge> : null],
                ['Rules status', ps ? <StatusBadge key="p" status={ps.status} /> : null],
                ['Error', ps?.error_code ? <Mono key="er">{ps.error_code}</Mono> : null],
                ['Message', ps?.message],
                ['Status updated', ps?.updated_at ? absTime(ps.updated_at) : null],
              ]}
            />
          )}
        </Card>
      </div>

      <Card
        title={
          <>
            Effective rules {eff && <Badge tone="violet">v{eff.version}</Badge>}
            {eff && agentVersion !== null && agentVersion !== eff.version && !pre && <Badge tone="amber">agent has v{agentVersion}</Badge>}
          </>
        }
        actions={<Link href="/access">Set access</Link>}
      >
        <EffectiveRules effective={eff} />
        {eff && !pre && d.status !== 'APPROVED' && <p className="muted small">The agent receives these rules only while the computer is approved.</p>}
      </Card>

      {!pre && (
        <Card title="Network interfaces">
          {!d.interfaces?.length ? (
            <Empty>No interfaces reported.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>MAC</th>
                    <th>IPv4</th>
                    <th>IPv6</th>
                    <th>Primary</th>
                  </tr>
                </thead>
                <tbody>
                  {d.interfaces.map((i, n) => (
                    <tr key={n}>
                      <td>{i.name}</td>
                      <td>{i.type}</td>
                      <td>{i.mac ? <Mono>{i.mac}</Mono> : '—'}</td>
                      <td>{i.ipv4?.length ? i.ipv4.map((a) => <div key={a}><Mono>{a}</Mono></div>) : '—'}</td>
                      <td>{i.ipv6?.length ? i.ipv6.map((a) => <div key={a}><Mono>{a}</Mono></div>) : '—'}</td>
                      <td>{i.is_primary ? <Badge tone="green">primary</Badge> : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <Card title="Credentials">
        <p className="muted small">Metadata only — credential secrets are never stored in readable form or shown.</p>
        {!d.credentials.length ? (
          <Empty>No credentials issued.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Credential ID</th>
                  <th>State</th>
                  <th>Created</th>
                  <th>Claimed</th>
                  <th>Expires</th>
                  <th>Last used</th>
                  <th>Revoked</th>
                </tr>
              </thead>
              <tbody>
                {d.credentials.map((c) => {
                  const expired = c.expires_at && new Date(c.expires_at).getTime() < Date.now();
                  const state = c.revoked_at ? 'REVOKED' : expired ? 'EXPIRED' : c.claimed_at ? 'ACTIVE' : 'UNCLAIMED';
                  return (
                    <tr key={c.credential_id}>
                      <td>
                        <Mono>{c.credential_id}</Mono>
                      </td>
                      <td>
                        <Badge tone={state === 'ACTIVE' ? 'green' : state === 'UNCLAIMED' ? 'amber' : 'gray'}>{state}</Badge>
                      </td>
                      <td>{absTime(c.created_at)}</td>
                      <td>{absTime(c.claimed_at)}</td>
                      <td>{c.expires_at ? absTime(c.expires_at) : 'never'}</td>
                      <td title={absTime(c.last_used_at)}>{relTime(c.last_used_at)}</td>
                      <td>{absTime(c.revoked_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ComputerFormDialog open={editing} device={d} defaultOrgId={d.organization.id} onClose={() => setEditing(false)} />
      <DeleteComputerDialog device={deleting ? d : null} onClose={() => setDeleting(false)} onDeleted={() => router.push('/computers')} />
    </>
  );
}
