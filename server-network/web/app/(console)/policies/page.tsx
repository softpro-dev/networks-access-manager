'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useOrganizations } from '@/lib/queries';
import { absTime } from '@/lib/format';
import type { List, Policy, PolicyDetail } from '@/lib/types';
import { Badge, Button, Empty, ErrorBox, Field, Modal, Mono, PageHeader, Spinner } from '@/components/ui';

export default function PoliciesPage() {
  const { isSuper } = useAuth();
  const router = useRouter();
  const orgs = useOrganizations();
  const [org, setOrg] = useState('');
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState({ name: '', code: '', description: '', organization_id: '' });
  const policies = useQuery({ queryKey: ['policies', { org }], queryFn: () => get<List<Policy>>('/policies', { organization_id: (isSuper && org) || undefined }) });
  const create = useAction(
    () =>
      post<PolicyDetail & { warnings: unknown[] }>('/policies', {
        name: f.name.trim(),
        ...(f.code.trim() ? { code: f.code.trim().toUpperCase() } : {}),
        ...(f.description.trim() ? { description: f.description.trim() } : {}),
        ...(isSuper ? { organization_id: f.organization_id } : {}),
      }),
    { success: (p) => `Policy ${p.code} created with draft v1`, invalidate: [['policies']], onSuccess: (p) => router.push(`/policies/${p.id}`) },
  );
  useEffect(() => {
    if (creating) {
      setF({ name: '', code: '', description: '', organization_id: org });
      create.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creating]);
  const codeOk = !f.code.trim() || /^[A-Z0-9][A-Z0-9-]{1,31}$/.test(f.code.trim().toUpperCase());
  const valid = !!f.name.trim() && codeOk && (!isSuper || !!f.organization_id);

  return (
    <>
      <PageHeader
        title="Policies"
        subtitle="Versioned network policies. Published versions are immutable; edit a new draft to change them."
        actions={<Button variant="primary" onClick={() => setCreating(true)}>New policy</Button>}
      />
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
      {policies.error && <ErrorBox error={policies.error} />}
      {policies.isLoading ? (
        <Spinner />
      ) : !policies.data?.items.length ? (
        <Empty>No policies yet. Create one, publish it and assign it to the organization, a group or a device.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                {isSuper && <th>Organization</th>}
                <th>State</th>
                <th>Active version</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {policies.data.items.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link href={`/policies/${p.id}`} className="strong">
                      <Mono>{p.code}</Mono>
                    </Link>
                  </td>
                  <td>
                    <Link href={`/policies/${p.id}`}>{p.name}</Link>
                    {p.description && <div className="muted small">{p.description}</div>}
                  </td>
                  {isSuper && <td>{p.organization_code}</td>}
                  <td>{p.is_active ? <Badge tone="green">active</Badge> : <Badge tone="gray">inactive</Badge>}</td>
                  <td>{p.active_version ? <Badge tone="green">v{p.active_version}</Badge> : <span className="muted">not published</span>}</td>
                  <td>{absTime(p.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="New policy"
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Cancel</Button>
            <Button variant="primary" busy={create.isPending} disabled={!valid} onClick={() => create.mutate(undefined)}>
              Create draft
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
          <Field label="Code (optional)" hint="Leave empty to auto-assign POL-NNN." error={codeOk ? null : 'Uppercase letters, digits and "-", 2–32 characters'}>
            <input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} maxLength={32} />
          </Field>
          <Field label="Description (optional)">
            <textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={2000} />
          </Field>
          <p className="muted small">The policy starts as draft v1 with default content; edit, validate and publish it on the next page.</p>
          <ErrorBox error={create.error} />
        </form>
      </Modal>
    </>
  );
}
