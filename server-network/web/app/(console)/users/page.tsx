'use client';
import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { get, patch, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useOrganizations } from '@/lib/queries';
import { absTime, relTime } from '@/lib/format';
import type { ActiveStatus, Page, Role, User } from '@/lib/types';
import { Alert, Badge, Button, ConfirmDialog, Empty, ErrorBox, Field, Modal, PageHeader, Pagination, Spinner, StatusBadge } from '@/components/ui';

const MIN_PASSWORD = 12;

function CreateUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const orgs = useOrganizations();
  const [f, setF] = useState({ email: '', name: '', password: '', role: 'ORGANIZATION_ADMIN' as Role, organization_id: '' });
  useEffect(() => {
    if (open) setF({ email: '', name: '', password: '', role: 'ORGANIZATION_ADMIN', organization_id: '' });
  }, [open]);
  const m = useAction(
    () =>
      post<User>('/users', {
        email: f.email.trim(),
        password: f.password,
        role: f.role,
        ...(f.name.trim() ? { name: f.name.trim() } : {}),
        ...(f.role === 'ORGANIZATION_ADMIN' ? { organization_id: f.organization_id } : {}),
      }),
    { success: 'Administrator created', invalidate: [['users']], onSuccess: onClose },
  );
  useEffect(() => {
    if (open) m.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const valid = f.email.includes('@') && f.password.length >= MIN_PASSWORD && (f.role === 'SUPER_ADMIN' || !!f.organization_id);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New administrator"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={m.isPending} disabled={!valid} onClick={() => m.mutate(undefined)}>
            Create
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) m.mutate(undefined);
        }}
      >
        <Field label="Email">
          <input type="email" autoComplete="off" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoFocus />
        </Field>
        <Field label="Name (optional)">
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={200} />
        </Field>
        <Field label="Role">
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>
            <option value="ORGANIZATION_ADMIN">Organization admin</option>
            <option value="SUPER_ADMIN">Super admin</option>
          </select>
        </Field>
        {f.role === 'ORGANIZATION_ADMIN' ? (
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
        ) : (
          <Alert tone="warn">Super admins can access and change every organization.</Alert>
        )}
        <Field label="Initial password" hint={`At least ${MIN_PASSWORD} characters. Share it over a secure channel.`} error={f.password && f.password.length < MIN_PASSWORD ? 'Too short' : null}>
          <input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        </Field>
        <ErrorBox error={m.error} />
      </form>
    </Modal>
  );
}

function EditUserDialog({ user, onClose }: { user: User | null; onClose: () => void }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  useEffect(() => {
    setName(user?.name ?? '');
    setPassword('');
  }, [user]);
  const m = useAction(
    () => patch<User>(`/users/${user!.id}`, { name: name.trim() ? name.trim() : null, ...(password ? { password } : {}) }),
    { success: password ? 'Administrator updated; their sessions were revoked' : 'Administrator updated', invalidate: [['users']], onSuccess: onClose },
  );
  useEffect(() => {
    if (user) m.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);
  const pwBad = password.length > 0 && password.length < MIN_PASSWORD;
  return (
    <Modal
      open={!!user}
      onClose={onClose}
      title={`Edit ${user?.email ?? ''}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={m.isPending} disabled={pwBad} onClick={() => m.mutate(undefined)}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!pwBad) m.mutate(undefined);
        }}
      >
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
        </Field>
        <Field label="New password (optional)" hint="Setting a password unlocks the account and signs the user out everywhere." error={pwBad ? `At least ${MIN_PASSWORD} characters` : null}>
          <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <ErrorBox error={m.error} />
      </form>
    </Modal>
  );
}

export default function UsersPage() {
  const { isSuper, user: me } = useAuth();
  const orgs = useOrganizations();
  const [org, setOrg] = useState('');
  const [role, setRole] = useState<Role | ''>('');
  const [status, setStatus] = useState<ActiveStatus | ''>('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [toggling, setToggling] = useState<User | null>(null);
  useEffect(() => setPage(1), [org, role, status]);

  const query = { organization_id: (isSuper && org) || undefined, role: role || undefined, status: status || undefined, page, page_size: 50 };
  const users = useQuery({ queryKey: ['users', query], queryFn: () => get<Page<User>>('/users', query), placeholderData: keepPreviousData });
  const toggle = useAction(() => patch<User>(`/users/${toggling!.id}`, { status: toggling!.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' }), {
    success: (u) => (u.status === 'DISABLED' ? 'Administrator disabled; sessions revoked' : 'Administrator enabled'),
    invalidate: [['users']],
    onSuccess: () => setToggling(null),
  });
  const orgLabel = (id: string | null) => (id ? orgs.data?.items.find((o) => o.id === id)?.code ?? id : '—');

  return (
    <>
      <PageHeader
        title="Administrators"
        subtitle={isSuper ? 'Super admins manage everything; organization admins are confined to one organization.' : 'Administrators of your organization (read-only; ask a super admin for changes).'}
        actions={isSuper && <Button variant="primary" onClick={() => setCreating(true)}>New administrator</Button>}
      />
      <div className="toolbar">
        {isSuper && (
          <select value={org} onChange={(e) => setOrg(e.target.value)} aria-label="Organization">
            <option value="">All organizations</option>
            {orgs.data?.items.map((o) => (
              <option key={o.id} value={o.id}>
                {o.code} · {o.name}
              </option>
            ))}
          </select>
        )}
        {isSuper && (
          <select value={role} onChange={(e) => setRole(e.target.value as Role | '')} aria-label="Role">
            <option value="">All roles</option>
            <option value="SUPER_ADMIN">Super admin</option>
            <option value="ORGANIZATION_ADMIN">Organization admin</option>
          </select>
        )}
        <select value={status} onChange={(e) => setStatus(e.target.value as ActiveStatus | '')} aria-label="Status">
          <option value="">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="DISABLED">Disabled</option>
        </select>
      </div>
      {users.error && <ErrorBox error={users.error} />}
      {users.isLoading ? (
        <Spinner />
      ) : !users.data?.items.length ? (
        <Empty>No administrators match.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Role</th>
                {isSuper && <th>Organization</th>}
                <th>Status</th>
                <th>Last login</th>
                <th>Created</th>
                {isSuper && <th />}
              </tr>
            </thead>
            <tbody>
              {users.data.items.map((u) => {
                const locked = u.locked_until && new Date(u.locked_until).getTime() > Date.now();
                return (
                  <tr key={u.id}>
                    <td className="strong">
                      {u.email} {u.id === me?.id && <Badge>you</Badge>}
                    </td>
                    <td>{u.name ?? <span className="muted">—</span>}</td>
                    <td>
                      <Badge tone={u.role === 'SUPER_ADMIN' ? 'violet' : 'blue'}>{u.role === 'SUPER_ADMIN' ? 'Super admin' : 'Org admin'}</Badge>
                    </td>
                    {isSuper && <td>{u.organization_code ?? orgLabel(u.organization_id)}</td>}
                    <td>
                      <StatusBadge status={u.status} /> {locked && <Badge tone="amber" title={`Locked until ${absTime(u.locked_until)}`}>locked</Badge>}
                    </td>
                    <td title={absTime(u.last_login_at)}>{relTime(u.last_login_at)}</td>
                    <td>{absTime(u.created_at)}</td>
                    {isSuper && (
                      <td className="cell-actions">
                        <div className="btn-row">
                          <Button size="sm" onClick={() => setEditing(u)}>
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant={u.status === 'ACTIVE' ? 'danger' : 'secondary'}
                            disabled={u.id === me?.id}
                            title={u.id === me?.id ? 'You cannot disable your own account' : undefined}
                            onClick={() => {
                              toggle.reset();
                              setToggling(u);
                            }}
                          >
                            {u.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {users.data && users.data.total > users.data.page_size && <Pagination page={page} pageSize={users.data.page_size} total={users.data.total} onPage={setPage} />}
      {isSuper && (
        <>
          <CreateUserDialog open={creating} onClose={() => setCreating(false)} />
          <EditUserDialog user={editing} onClose={() => setEditing(null)} />
          <ConfirmDialog
            open={!!toggling}
            title={toggling?.status === 'ACTIVE' ? 'Disable administrator' : 'Enable administrator'}
            confirmLabel={toggling?.status === 'ACTIVE' ? 'Disable' : 'Enable'}
            destructive={toggling?.status === 'ACTIVE'}
            busy={toggle.isPending}
            error={toggle.error}
            onClose={() => setToggling(null)}
            onConfirm={() => toggle.mutate(undefined)}
          >
            <p>{toggling?.status === 'ACTIVE' ? `Disable ${toggling?.email}? They are signed out immediately and cannot sign in.` : `Allow ${toggling?.email} to sign in again?`}</p>
          </ConfirmDialog>
        </>
      )}
    </>
  );
}
