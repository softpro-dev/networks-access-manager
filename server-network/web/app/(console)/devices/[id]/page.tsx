'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, patch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/queries';
import { absTime, deviceName, relTime } from '@/lib/format';
import type { DeviceDetail } from '@/lib/types';
import { Alert, Badge, Button, Card, Empty, ErrorBox, Field, KeyValue, Modal, Mono, PageHeader, Spinner, StatusBadge } from '@/components/ui';
import { DeviceActions } from '@/components/DeviceActions';

export default function DeviceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { isSuper } = useAuth();
  const q = useQuery({ queryKey: ['device', id], queryFn: () => get<DeviceDetail>(`/devices/${id}`), refetchInterval: 30_000 });
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const rename = useAction((display_name: string | null) => patch<DeviceDetail>(`/devices/${id}`, { display_name }), {
    success: 'Device renamed',
    invalidate: [['device', id], ['devices']],
    onSuccess: () => setRenaming(false),
  });

  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorBox error={q.error ?? new Error('Device not found')} title="Could not load device" />;
  const d = q.data;
  const ps = d.policy_status;
  const failed = ps && ['FAILED', 'VALIDATION_FAILED', 'ROLLED_BACK'].includes(ps.status);

  return (
    <>
      <nav className="breadcrumb">
        <Link href="/devices">Devices</Link> / {deviceName(d)}
      </nav>
      <PageHeader
        title={
          <>
            {deviceName(d)} <StatusBadge status={d.status} />
          </>
        }
        subtitle={
          <>
            {d.hostname}
            {isSuper && ` · ${d.organization.code} · ${d.organization.name}`}
          </>
        }
        actions={
          <>
            <Button
              onClick={() => {
                setName(d.display_name ?? '');
                rename.reset();
                setRenaming(true);
              }}
            >
              Rename
            </Button>
            <DeviceActions device={d} />
          </>
        }
      />
      {d.status === 'PENDING' && (
        <Alert tone="warn" title="Awaiting approval">
          This device registered and is waiting for an administrator. Verify the hostname and UUID match the machine before approving.
        </Alert>
      )}
      {failed && (
        <Alert tone="error" title={`Policy ${ps!.status.replace(/_/g, ' ').toLowerCase()}`}>
          {ps!.error_code && <Mono>{ps!.error_code}</Mono>} {ps!.message}
        </Alert>
      )}

      <div className="grid-2">
        <Card title="Device">
          <KeyValue
            rows={[
              ['Display name', d.display_name],
              ['Hostname', d.hostname],
              ['Device UUID', <Mono key="u">{d.device_uuid}</Mono>],
              ['Organization', `${d.organization.code} · ${d.organization.name}`],
              ['Status', <StatusBadge key="s" status={d.status} />],
              [
                'Approval',
                d.approval.approved_at ? `${absTime(d.approval.approved_at)}${d.approval.approved_by ? ` by ${d.approval.approved_by.email}` : ''}` : d.status === 'PENDING' ? 'Awaiting approval' : null,
              ],
              [
                'Last heartbeat',
                <span key="h">
                  <span className={`dot ${d.online ? 'dot-on' : 'dot-off'}`} /> {relTime(d.last_heartbeat_at)} <span className="muted">({absTime(d.last_heartbeat_at)})</span>
                </span>,
              ],
              ['Current IP', d.current_ip ? <Mono key="ip">{d.current_ip}</Mono> : null],
              ['Last request IP', d.last_request_ip ? <Mono key="rip">{d.last_request_ip}</Mono> : null],
              ['Agent version', d.agent_version],
              ['Windows version', d.windows_version],
              ['Reported status', d.reported_status ? <StatusBadge key="r" status={d.reported_status} /> : null],
              ['Registered', absTime(d.created_at)],
              [
                'Groups',
                d.groups.length ? (
                  <span key="g" className="chips">
                    {d.groups.map((g) => (
                      <Link key={g.id} href={`/groups/${g.id}`} className="chip">
                        {g.name}
                      </Link>
                    ))}
                  </span>
                ) : null,
              ],
            ]}
          />
        </Card>

        <Card title="Policy">
          <KeyValue
            rows={[
              [
                'Effective (server)',
                d.effective_policy ? (
                  <span key="e">
                    <Link href={`/policies/${d.effective_policy.id}`}>{d.effective_policy.policy_id}</Link> <Badge>v{d.effective_policy.version}</Badge>{' '}
                    <span className="muted small">via {d.effective_policy.assignment_scope.toLowerCase()} assignment</span>
                  </span>
                ) : (
                  <span key="e" className="muted">
                    No active policy assigned
                  </span>
                ),
              ],
              ['ETag', d.effective_policy ? <Mono key="t">{d.effective_policy.etag}</Mono> : null],
              [
                'Current (agent)',
                d.current_policy ? (
                  <span key="c">
                    {d.current_policy.id ? <Link href={`/policies/${d.current_policy.id}`}>{d.current_policy.policy_id}</Link> : 'unknown policy'} <Badge>v{d.current_policy.version}</Badge>
                  </span>
                ) : null,
              ],
              ['Policy status', ps ? <StatusBadge key="p" status={ps.status} /> : null],
              ['Reported for', ps?.policy_id ? `${ps.policy_id} v${ps.version ?? '?'}` : null],
              ['Active on agent', ps?.active_policy_id ? `${ps.active_policy_id} v${ps.active_version ?? '?'}` : null],
              ['Error', ps?.error_code ? <Mono key="er">{ps.error_code}</Mono> : null],
              ['Message', ps?.message],
              ['Status updated', ps?.updated_at ? absTime(ps.updated_at) : null],
            ]}
          />
          {d.effective_policy && d.current_policy && (d.effective_policy.policy_id !== d.current_policy.policy_id || d.effective_policy.version !== d.current_policy.version) && (
            <Alert tone="info">The agent has not yet applied the effective policy; it will pick it up on its next heartbeat.</Alert>
          )}
        </Card>
      </div>

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

      <Modal
        open={renaming}
        onClose={() => setRenaming(false)}
        title="Rename device"
        footer={
          <>
            <Button onClick={() => setRenaming(false)}>Cancel</Button>
            {d.display_name && (
              <Button busy={rename.isPending} onClick={() => rename.mutate(null)}>
                Clear name
              </Button>
            )}
            <Button variant="primary" busy={rename.isPending} disabled={!name.trim()} onClick={() => rename.mutate(name.trim())}>
              Save
            </Button>
          </>
        }
      >
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) rename.mutate(name.trim());
          }}
        >
          <Field label="Display name" hint={`Shown instead of the hostname (${d.hostname}).`}>
            <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <ErrorBox error={rename.error} />
        </form>
      </Modal>
    </>
  );
}
