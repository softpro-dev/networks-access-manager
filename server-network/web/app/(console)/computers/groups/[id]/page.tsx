'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { del, get, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useOrgMap } from '@/lib/queries';
import { deviceName } from '@/lib/format';
import type { Device, DeviceGroupDetail, Page } from '@/lib/types';
import { Button, Card, ConfirmDialog, Empty, ErrorBox, Modal, Mono, PageHeader, Spinner, StatusBadge } from '@/components/ui';
import { COMPUTER_KEYS } from '@/components/ComputerDialogs';
import { DeleteGroupDialog, GroupFormDialog } from '@/components/GroupsPanel';

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
    success: () => `Added ${selected.size} computer(s)`,
    invalidate: COMPUTER_KEYS,
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
      title={`Add computers to ${group.name}`}
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
        <input type="search" placeholder="Search title, serial, MAC, hostname, IP…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search computers" autoFocus />
        {devices.error && <ErrorBox error={devices.error} />}
        {devices.isLoading ? (
          <Spinner />
        ) : !candidates.length ? (
          <Empty>No more computers in this organization{q ? ' match' : ''}.</Empty>
        ) : (
          <div className="picker">
            {candidates.map((d) => (
              <label key={d.id} className="picker-row">
                <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggle(d.id)} />
                <span className="strong">{deviceName(d)}</span>
                <span className="muted small">{d.mac_address ?? d.hostname ?? ''}</span>
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

  const remove = useAction((deviceId: string) => del(`/device-groups/${id}/members/${deviceId}`), {
    success: 'Computer removed from group',
    invalidate: COMPUTER_KEYS,
    onSuccess: () => setRemoving(null),
  });

  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorBox error={q.error} title="Could not load group" />;
  const g = q.data;
  const label = (m: DeviceGroupDetail['members'][number]) => m.display_name || m.hostname || 'Unnamed computer';
  return (
    <>
      <nav className="breadcrumb">
        <Link href="/computers">Computers</Link> / <Link href="/computers?tab=groups">Groups</Link> / {g.name}
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
            <Button onClick={() => setEditing(true)}>Edit</Button>
            <Button variant="danger" onClick={() => setDeleting(true)}>
              Delete
            </Button>
          </>
        }
      />
      <Card title={`Members (${g.members.length})`} actions={<Button variant="primary" size="sm" onClick={() => setAdding(true)}>Add computers</Button>}>
        {!g.members.length ? (
          <Empty>This group has no computers.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Computer</th>
                  <th>Hostname</th>
                  <th>UUID</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {g.members.map((m) => (
                  <tr key={m.device_id}>
                    <td>
                      <Link href={`/computers/${m.device_id}`}>{label(m)}</Link>
                    </td>
                    <td>{m.hostname ?? <span className="muted">not registered</span>}</td>
                    <td>{m.device_uuid ? <Mono>{m.device_uuid}</Mono> : <span className="muted">—</span>}</td>
                    <td className="cell-actions">
                      <Button
                        size="sm"
                        onClick={() => {
                          remove.reset();
                          setRemoving({ device_id: m.device_id, label: label(m) });
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
        <p>Remove {removing?.label} from {g.name}? Restrictions assigned to this group stop applying to it.</p>
      </ConfirmDialog>
      <GroupFormDialog open={editing} group={g} orgId={g.organization_id} onClose={() => setEditing(false)} />
      <DeleteGroupDialog group={deleting ? g : null} onClose={() => setDeleting(false)} onDeleted={() => router.push('/computers?tab=groups')} />
    </>
  );
}
