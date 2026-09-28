'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { useOrganizations } from '@/lib/queries';
import { absTime } from '@/lib/format';
import type { Organization } from '@/lib/types';
import { Alert, Badge, Button, Empty, ErrorBox, PageHeader, Spinner, StatusBadge } from '@/components/ui';
import { OrgFormDialog, OrgStatusDialog, RegistrationTokenControls } from '@/components/OrgDialogs';

export default function OrganizationsPage() {
  const { isSuper, user } = useAuth();
  const orgs = useOrganizations();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Organization | null>(null);
  const [toggling, setToggling] = useState<Organization | null>(null);

  if (!isSuper) {
    return (
      <Alert tone="info">
        Organization administrators manage only their own organization. <Link href={`/organizations/${user?.organization_id}`}>Open it</Link>.
      </Alert>
    );
  }

  return (
    <>
      <PageHeader title="Organizations" subtitle="Tenants: every device, policy and group belongs to exactly one." actions={<Button variant="primary" onClick={() => setCreating(true)}>New organization</Button>} />
      {orgs.error && <ErrorBox error={orgs.error} />}
      {orgs.isLoading ? (
        <Spinner />
      ) : !orgs.data?.items.length ? (
        <Empty>No organizations yet. Create one, then generate a registration token for its agents.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Status</th>
                <th>Registration token</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {orgs.data.items.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link href={`/organizations/${o.id}`} className="strong">
                      {o.code}
                    </Link>
                  </td>
                  <td>{o.name}</td>
                  <td>
                    <StatusBadge status={o.status} />
                  </td>
                  <td>
                    <div className="cell-inline">
                      {o.has_registration_token ? <Badge tone="green">set</Badge> : <Badge tone="gray">global / none</Badge>}
                      <RegistrationTokenControls org={o} />
                    </div>
                  </td>
                  <td>{absTime(o.created_at)}</td>
                  <td className="cell-actions">
                    <div className="btn-row">
                      <Button size="sm" onClick={() => setEditing(o)}>
                        Edit
                      </Button>
                      <Button size="sm" variant={o.status === 'ACTIVE' ? 'danger' : 'secondary'} onClick={() => setToggling(o)}>
                        {o.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <OrgFormDialog open={creating} onClose={() => setCreating(false)} />
      <OrgFormDialog open={!!editing} org={editing} onClose={() => setEditing(null)} />
      <OrgStatusDialog org={toggling} onClose={() => setToggling(null)} />
    </>
  );
}
