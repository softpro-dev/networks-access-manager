'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { del, patch, post } from '@/lib/api';
import { useAction } from '@/lib/queries';
import { useOrgScope } from '@/lib/orgScope';
import { absTime } from '@/lib/format';
import type { DeviceGroup } from '@/lib/types';
import { Button, ConfirmDialog, Empty, ErrorBox, Field, Modal, Spinner } from './ui';
import { COMPUTER_KEYS, useAfterDelete, useGroups } from './ComputerDialogs';

export function GroupFormDialog({ open, group, orgId, onClose }: { open: boolean; group?: DeviceGroup | null; orgId: string; onClose: () => void }) {
  const { isSuper, orgs } = useOrgScope();
  const [f, setF] = useState({ name: '', description: '', organization_id: '' });
  useEffect(() => {
    if (open) setF({ name: group?.name ?? '', description: group?.description ?? '', organization_id: group?.organization_id ?? orgId });
  }, [open, group, orgId]);
  const save = useAction(
    () => {
      const description = f.description.trim() || null;
      if (group) return patch<DeviceGroup>(`/device-groups/${group.id}`, { name: f.name.trim(), description });
      return post<DeviceGroup>('/device-groups', { name: f.name.trim(), ...(description ? { description } : {}), ...(isSuper ? { organization_id: f.organization_id } : {}) });
    },
    { success: group ? 'Group updated' : 'Group created', invalidate: COMPUTER_KEYS, onSuccess: onClose },
  );
  useEffect(() => {
    if (open) save.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const valid = !!f.name.trim() && (!isSuper || !!f.organization_id);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={group ? `Edit ${group.name}` : 'New group'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={save.isPending} disabled={!valid} onClick={() => save.mutate(undefined)}>
            {group ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate(undefined);
        }}
      >
        {isSuper && !group && (
          <Field label="Organization">
            <select value={f.organization_id} onChange={(e) => setF({ ...f, organization_id: e.target.value })}>
              <option value="">Select…</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.code} · {o.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Name">
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={200} autoFocus />
        </Field>
        <Field label="Description (optional)">
          <textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={1000} />
        </Field>
        <ErrorBox error={save.error} />
      </form>
    </Modal>
  );
}

export function DeleteGroupDialog({ group, onClose, onDeleted }: { group: DeviceGroup | null; onClose: () => void; onDeleted?: () => void }) {
  const afterDelete = useAfterDelete();
  const m = useAction(() => del(`/device-groups/${group!.id}`), {
    success: 'Group deleted',
    onSuccess: () => {
      const id = group!.id;
      onClose();
      onDeleted?.();
      afterDelete(['group', id]);
    },
  });
  useEffect(() => {
    if (group) m.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group]);
  return (
    <ConfirmDialog open={!!group} title="Delete group" confirmLabel="Delete group" destructive busy={m.isPending} error={m.error} onClose={onClose} onConfirm={() => m.mutate(undefined)}>
      <p>
        Delete <strong>{group?.name}</strong>? Its computers are not affected, but restrictions assigned to this group stop applying to them.
      </p>
    </ConfirmDialog>
  );
}

/** Groups tab of the Computers page: CRUD; membership is managed on the group page or in each computer's edit dialog. */
export function GroupsPanel() {
  const { orgId, isSuper, orgs } = useOrgScope();
  const groups = useGroups(orgId);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<DeviceGroup | null>(null);
  const [deleting, setDeleting] = useState<DeviceGroup | null>(null);
  const orgCode = (id: string) => orgs.find((o) => o.id === id)?.code ?? '—';
  return (
    <>
      <div className="toolbar">
        <p className="muted grow">Groups collect computers so a restriction can be assigned to all of them at once (see Set access).</p>
        <Button variant="primary" onClick={() => setCreating(true)}>
          New group
        </Button>
      </div>
      {groups.error && <ErrorBox error={groups.error} />}
      {groups.isLoading ? (
        <Spinner />
      ) : !groups.data?.items.length ? (
        <Empty>No groups yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                {isSuper && !orgId && <th>Organization</th>}
                <th>Description</th>
                <th className="num">Computers</th>
                <th>Created</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {groups.data.items.map((g) => (
                <tr key={g.id}>
                  <td>
                    <Link href={`/computers/groups/${g.id}`} className="strong">
                      {g.name}
                    </Link>
                  </td>
                  {isSuper && !orgId && <td>{orgCode(g.organization_id)}</td>}
                  <td>{g.description ?? <span className="muted">—</span>}</td>
                  <td className="num">{g.member_count ?? 0}</td>
                  <td>{absTime(g.created_at)}</td>
                  <td className="cell-actions">
                    <div className="btn-row">
                      <Link href={`/computers/groups/${g.id}`} className="btn btn-secondary btn-sm">
                        Members
                      </Link>
                      <Button size="sm" onClick={() => setEditing(g)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" className="text-danger" onClick={() => setDeleting(g)}>
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
      <GroupFormDialog open={creating} orgId={orgId} onClose={() => setCreating(false)} />
      <GroupFormDialog open={!!editing} group={editing} orgId={orgId} onClose={() => setEditing(null)} />
      <DeleteGroupDialog group={deleting} onClose={() => setDeleting(null)} />
    </>
  );
}
