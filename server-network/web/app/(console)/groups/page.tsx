'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useOrganizations } from '@/lib/queries';
import { absTime } from '@/lib/format';
import type { DeviceGroup, List } from '@/lib/types';
import { Button, Empty, ErrorBox, Field, Modal, PageHeader, Spinner } from '@/components/ui';

export default function GroupsPage() {
  const { isSuper } = useAuth();
  const orgs = useOrganizations();
  const [org, setOrg] = useState('');
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState({ name: '', description: '', organization_id: '' });
  const groups = useQuery({ queryKey: ['groups', { org }], queryFn: () => get<List<DeviceGroup>>('/device-groups', { organization_id: (isSuper && org) || undefined }) });
  const create = useAction(
    () => post<DeviceGroup>('/device-groups', { name: f.name.trim(), ...(f.description.trim() ? { description: f.description.trim() } : {}), ...(isSuper ? { organization_id: f.organization_id } : {}) }),
    { success: 'Group created', invalidate: [['groups']], onSuccess: () => setCreating(false) },
  );
  useEffect(() => {
    if (creating) {
      setF({ name: '', description: '', organization_id: org });
      create.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creating]);
  const orgCode = (id: string) => orgs.data?.items.find((o) => o.id === id)?.code ?? '—';
  const valid = f.name.trim() && (!isSuper || f.organization_id);

  return (
    <>
      <PageHeader title="Device groups" subtitle="Group devices to target policy assignments." actions={<Button variant="primary" onClick={() => setCreating(true)}>New group</Button>} />
      {isSuper && (
        <div className="toolbar">
          <select value={org} onChange={(e) => setOrg(e.target.value)} aria-label="Organization">
            <option value="">All organizations</option>
            {orgs.data?.items.map((o) => (
              <option key={o.id} value={o.id}>
                {o.code} · {o.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {groups.error && <ErrorBox error={groups.error} />}
      {groups.isLoading ? (
        <Spinner />
      ) : !groups.data?.items.length ? (
        <Empty>No device groups yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                {isSuper && <th>Organization</th>}
                <th>Description</th>
                <th className="num">Members</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {groups.data.items.map((g) => (
                <tr key={g.id}>
                  <td>
                    <Link href={`/groups/${g.id}`} className="strong">
                      {g.name}
                    </Link>
                  </td>
                  {isSuper && <td>{orgCode(g.organization_id)}</td>}
                  <td>{g.description ?? <span className="muted">—</span>}</td>
                  <td className="num">{g.member_count ?? 0}</td>
                  <td>{absTime(g.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="New device group"
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Cancel</Button>
            <Button variant="primary" busy={create.isPending} disabled={!valid} onClick={() => create.mutate(undefined)}>
              Create
            </Button>
          </>
        }
      >
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) create.mutate(undefined);
          }}
        >
          {isSuper && (
            <Field label="Organization">
              <select value={f.organization_id} onChange={(e) => setF({ ...f, organization_id: e.target.value })}>
                <option value="">Select…</option>
                {orgs.data?.items.map((o) => (
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
          <ErrorBox error={create.error} />
        </form>
      </Modal>
    </>
  );
}
