'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { del, get, patch, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useOrgMap } from '@/lib/queries';
import { deviceName } from '@/lib/format';
import type { Device, DeviceGroupDetail, Page } from '@/lib/types';
import { Button, Card, ConfirmDialog, Empty, ErrorBox, Field, Modal, Mono, PageHeader, Spinner, StatusBadge } from '@/components/ui';

function AddMembersDialog({ group, open, onClose }: { group: DeviceGroupDetail; open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (open) {
      setQ('');
      setSelected(new Set());
    }
  }, [open]);
  const devices = useQuery({
    queryKey: ['devices', { organization_id: group.organization_id, q, page_size: 100, picker: true }],
    queryFn: () => get<Page<Device>>('/devices', { organization_id: group.organization_id, q: q.trim() || undefined, page_size: 100 }),
    enabled: open,
  });
  const add = useAction(() => post<DeviceGroupDetail>(`/device-groups/${group.id}/members`, { device_ids: [...selected] }), {
    success: (_r) => `Added ${selected.size} device(s)`,
    invalidate: [['group', group.id], ['groups'], ['device']],
    onSuccess: onClose,
  });
  useEffect(() => {
    if (open) add.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const members = new Set(group.members.map((m) => m.device_id));
  const candidates = (devices.data?.items ?? []).filter((d) => !members.has(d.id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={`Add devices to ${group.name}`}
      footer={
        <>
          <span className="muted grow">{selected.size} selected</span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!selected.size} busy={add.isPending} onClick={() => add.mutate(undefined)}>
            Add
          </Button>
        </>
      }
    >
      <div className="stack">
        <input type="search" placeholder="Search hostname, name, UUID, IP…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search devices" autoFocus />
        {devices.error && <ErrorBox error={devices.error} />}
        {devices.isLoading ? (
          <Spinner />
        ) : !candidates.length ? (
          <Empty>No more devices in this organization{q ? ' match' : ''}.</Empty>
        ) : (
          <div className="picker">
            {candidates.map((d) => (
              <label key={d.id} className="picker-row">
                <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggle(d.id)} />
                <span className="strong">{deviceName(d)}</span>
                <span className="muted small">{d.hostname}</span>
                <StatusBadge status={d.status} />
              </label>
            ))}
          </div>
        )}
        <ErrorBox error={add.error} />
      </div>
    </Modal>
  );
}

export default function GroupDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { isSuper } = useAuth();
  const orgMap = useOrgMap();
  const q = useQuery({ queryKey: ['group', id], queryFn: () => get<DeviceGroupDetail>(`/device-groups/${id}`) });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [removing, setRemoving] = useState<{ device_id: string; label: string } | null>(null);
  const [f, setF] = useState({ name: '', description: '' });

  const save = useAction(() => patch(`/device-groups/${id}`, { name: f.name.trim(), description: f.description.trim() ? f.description.trim() : null }), {
    success: 'Group updated',
    invalidate: [['group', id], ['groups']],
    onSuccess: () => setEditing(false),
  });
  const remove = useAction((deviceId: string) => del(`/device-groups/${id}/members/${deviceId}`), {
    success: 'Device removed from group',
    invalidate: [['group', id], ['groups'], ['device']],
    onSuccess: () => setRemoving(null),
  });
  const destroy = useAction(() => del(`/device-groups/${id}`), {
    success: 'Group deleted',
    invalidate: [['groups']],
    onSuccess: () => router.push('/groups'),
  });

  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorBox error={q.error} title="Could not load group" />;
  const g = q.data;
  return (
    <>
      <nav className="breadcrumb">
        <Link href="/groups">Device groups</Link> / {g.name}
      </nav>
      <PageHeader
        title={g.name}
        subtitle={
          <>
            {isSuper && `${orgMap.get(g.organization_id)?.code ?? ''} · `}
            {g.description ?? 'No description'}
          </>
        }
        actions={
          <>
            <Button
              onClick={() => {
                setF({ name: g.name, description: g.description ?? '' });
                save.reset();
                setEditing(true);
              }}
            >
              Edit
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                destroy.reset();
                setDeleting(true);
              }}
            >
              Delete
            </Button>
          </>
        }
      />
      <Card title={`Members (${g.members.length})`} actions={<Button variant="primary" size="sm" onClick={() => setAdding(true)}>Add devices</Button>}>
        {!g.members.length ? (
          <Empty>This group has no members.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Hostname</th>
                  <th>UUID</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {g.members.map((m) => (
                  <tr key={m.device_id}>
                    <td>
                      <Link href={`/devices/${m.device_id}`}>{m.display_name || m.hostname}</Link>
                    </td>
                    <td>{m.hostname}</td>
                    <td>
                      <Mono>{m.device_uuid}</Mono>
                    </td>
                    <td className="cell-actions">
                      <Button
                        size="sm"
                        onClick={() => {
                          remove.reset();
                          setRemoving({ device_id: m.device_id, label: m.display_name || m.hostname });
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
      </Card>

      <AddMembersDialog group={g} open={adding} onClose={() => setAdding(false)} />
      <ConfirmDialog
        open={!!removing}
        title="Remove member"
        confirmLabel="Remove"
        busy={remove.isPending}
        error={remove.error}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing.device_id)}
      >
        <p>Remove {removing?.label} from {g.name}? Group-scoped policy assignments stop applying to it.</p>
      </ConfirmDialog>
      <ConfirmDialog open={deleting} title="Delete group" confirmLabel="Delete group" destructive busy={destroy.isPending} error={destroy.error} onClose={() => setDeleting(false)} onConfirm={() => destroy.mutate(undefined)}>
        <p>Delete {g.name}? Devices are not affected, but policy assignments targeting this group are deleted with it.</p>
      </ConfirmDialog>
      <Modal
        open={editing}
        onClose={() => setEditing(false)}
        title="Edit group"
        footer={
          <>
            <Button onClick={() => setEditing(false)}>Cancel</Button>
            <Button variant="primary" busy={save.isPending} disabled={!f.name.trim()} onClick={() => save.mutate(undefined)}>
              Save
            </Button>
          </>
        }
      >
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (f.name.trim()) save.mutate(undefined);
          }}
        >
          <Field label="Name">
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={200} autoFocus />
          </Field>
          <Field label="Description">
            <textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={1000} />
          </Field>
          <ErrorBox error={save.error} />
        </form>
      </Modal>
    </>
  );
}
