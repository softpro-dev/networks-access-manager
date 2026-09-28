'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { del, get, post } from '@/lib/api';
import { useAction } from '@/lib/queries';
import { deviceName } from '@/lib/format';
import type { Assignment, AssignmentScope, Device, DeviceDetail, DeviceGroup, List, Page, PolicyDetail } from '@/lib/types';
import { Badge, Button, Card, ConfirmDialog, Empty, ErrorBox, Field, Modal } from '../ui';

function AddAssignmentDialog({ policy, open, onClose }: { policy: PolicyDetail; open: boolean; onClose: () => void }) {
  const [scope, setScope] = useState<AssignmentScope>('ORGANIZATION');
  const [groupId, setGroupId] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [q, setQ] = useState('');
  const [priority, setPriority] = useState('0');
  useEffect(() => {
    if (open) {
      setScope('ORGANIZATION');
      setGroupId('');
      setDeviceId('');
      setQ('');
      setPriority('0');
    }
  }, [open]);
  const groups = useQuery({
    queryKey: ['groups', { org: policy.organization_id }],
    queryFn: () => get<List<DeviceGroup>>('/device-groups', { organization_id: policy.organization_id }),
    enabled: open && scope === 'GROUP',
  });
  const devices = useQuery({
    queryKey: ['devices', { organization_id: policy.organization_id, q, page_size: 50, picker: true }],
    queryFn: () => get<Page<Device>>('/devices', { organization_id: policy.organization_id, q: q.trim() || undefined, page_size: 50 }),
    enabled: open && scope === 'DEVICE',
  });
  const prio = Number(priority);
  const prioOk = Number.isInteger(prio) && prio >= -1000 && prio <= 1000;
  const add = useAction(
    () =>
      post<Assignment>(`/policies/${policy.id}/assignments`, {
        scope,
        priority: prio,
        ...(scope === 'GROUP' ? { target_group_id: groupId } : {}),
        ...(scope === 'DEVICE' ? { target_device_id: deviceId } : {}),
      }),
    { success: 'Assignment added', invalidate: [['policy', policy.id], ['device'], ['devices']], onSuccess: onClose },
  );
  useEffect(() => {
    if (open) add.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const valid = prioOk && (scope === 'ORGANIZATION' || (scope === 'GROUP' && groupId) || (scope === 'DEVICE' && deviceId));
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Assign ${policy.code}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={add.isPending} disabled={!valid} onClick={() => add.mutate(undefined)}>
            Assign
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Scope">
          <select value={scope} onChange={(e) => setScope(e.target.value as AssignmentScope)}>
            <option value="ORGANIZATION">Organization — every device in {policy.organization_code ?? 'the organization'}</option>
            <option value="GROUP">Device group</option>
            <option value="DEVICE">Single device</option>
          </select>
        </Field>
        {scope === 'GROUP' && (
          <Field label="Group">
            <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">{groups.isLoading ? 'Loading…' : groups.data?.items.length ? 'Select…' : 'No groups in this organization'}</option>
              {groups.data?.items.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.member_count ?? 0})
                </option>
              ))}
            </select>
          </Field>
        )}
        {scope === 'DEVICE' && (
          <>
            <Field label="Find device">
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Hostname, name, UUID, IP…" />
            </Field>
            <Field label="Device">
              <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} size={6}>
                {devices.data?.items.map((d) => (
                  <option key={d.id} value={d.id}>
                    {deviceName(d)} — {d.hostname} ({d.status})
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
        <Field label="Priority" hint="Winner per device: DEVICE > GROUP > ORGANIZATION scope, then higher priority, then newest." error={prioOk ? null : 'Integer between -1000 and 1000'}>
          <input type="number" min={-1000} max={1000} step={1} value={priority} onChange={(e) => setPriority(e.target.value)} />
        </Field>
        {!policy.is_active && <p className="muted small">This policy is inactive: its assignments are skipped until it is activated.</p>}
        {!policy.active_version && <p className="muted small">No version is published yet: assignments take effect after publishing.</p>}
        <ErrorBox error={add.error} />
      </div>
    </Modal>
  );
}

export function AssignmentsCard({ policy }: { policy: PolicyDetail }) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Assignment | null>(null);
  const groupIds = policy.assignments.some((a) => a.scope === 'GROUP');
  const groups = useQuery({
    queryKey: ['groups', { org: policy.organization_id }],
    queryFn: () => get<List<DeviceGroup>>('/device-groups', { organization_id: policy.organization_id }),
    enabled: groupIds,
  });
  const deviceIds = [...new Set(policy.assignments.filter((a) => a.target_device_id).map((a) => a.target_device_id!))];
  const devices = useQueries({ queries: deviceIds.map((id) => ({ queryKey: ['device', id], queryFn: () => get<DeviceDetail>(`/devices/${id}`), staleTime: 60_000 })) });
  const deviceById = new Map(devices.filter((d) => d.data).map((d) => [d.data!.id, d.data!]));
  const remove = useAction((a: Assignment) => del(`/policies/${policy.id}/assignments/${a.id}`), {
    success: 'Assignment removed',
    invalidate: [['policy', policy.id], ['device'], ['devices']],
    onSuccess: () => setRemoving(null),
  });
  const target = (a: Assignment) => {
    if (a.scope === 'ORGANIZATION') return <span>Whole organization</span>;
    if (a.scope === 'GROUP') {
      const g = groups.data?.items.find((x) => x.id === a.target_group_id);
      return <Link href={`/groups/${a.target_group_id}`}>{g?.name ?? a.target_group_id}</Link>;
    }
    const d = deviceById.get(a.target_device_id!);
    return <Link href={`/devices/${a.target_device_id}`}>{d ? deviceName(d) : a.target_device_id}</Link>;
  };
  return (
    <Card title={`Assignments (${policy.assignments.length})`} actions={<Button size="sm" variant="primary" onClick={() => setAdding(true)}>Add assignment</Button>}>
      {!policy.assignments.length ? (
        <Empty>Not assigned. Assign it to the organization, a device group or a single device.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Scope</th>
                <th>Target</th>
                <th className="num">Priority</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {policy.assignments.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Badge tone={a.scope === 'DEVICE' ? 'violet' : a.scope === 'GROUP' ? 'blue' : 'neutral'}>{a.scope}</Badge>
                  </td>
                  <td>{target(a)}</td>
                  <td className="num">{a.priority}</td>
                  <td className="cell-actions">
                    <Button
                      size="sm"
                      onClick={() => {
                        remove.reset();
                        setRemoving(a);
                      }}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <AddAssignmentDialog policy={policy} open={adding} onClose={() => setAdding(false)} />
      <ConfirmDialog
        open={!!removing}
        title="Remove assignment"
        confirmLabel="Remove"
        destructive
        busy={remove.isPending}
        error={remove.error}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing)}
      >
        <p>Remove this {removing?.scope.toLowerCase()} assignment? Affected devices fall back to their next matching assignment (or no policy) on their next heartbeat.</p>
      </ConfirmDialog>
    </Card>
  );
}
