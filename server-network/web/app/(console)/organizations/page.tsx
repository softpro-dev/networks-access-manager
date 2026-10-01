'use client';
import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { useOrganizations } from '@/lib/queries';
import type { Organization } from '@/lib/types';
import { Alert, Button, Empty, ErrorBox, PageHeader, Spinner, StatusBadge } from '@/components/ui';
import { DeleteOrgDialog, LoginLinkButton, OrgFormDialog, OrgPasswordDialog, OrgStatusDialog, AccessTokenControls } from '@/components/OrgDialogs';

function OrganizationsInner() {
  const { isSuper, user, features } = useAuth();
  const orgs = useOrganizations();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Organization | null>(null);
  const [toggling, setToggling] = useState<Organization | null>(null);
  const [passwordOrg, setPasswordOrg] = useState<Organization | null>(null);
  const [deleting, setDeleting] = useState<Organization | null>(null);
  // Only when the server allows it (ALLOW_ORGANIZATION_DELETE; on by default outside production).
  const canDelete = features?.organization_delete === true;

  if (!isSuper) {
    return (
      <Alert tone="info">
        Organization administrators manage only their own organization. <Link href={`/organizations/${user?.organization_id}`}>Open it</Link>.
      </Alert>
    );
  }

  return (
    <>
      <PageHeader title="Organizations" subtitle="Tenants: every computer, restriction and group belongs to exactly one." actions={<Button variant="primary" onClick={() => setCreating(true)}>New organization</Button>} />
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
                <th>Access token</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
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
                      <AccessTokenControls org={o} short />
                    </div>
                  </td>
                  <td className="cell-actions">
                    <div className="btn-row">
                      <LoginLinkButton org={o} />
                      <Button size="sm" onClick={() => setEditing(o)}>
                        Edit
                      </Button>
                      <Button size="sm" onClick={() => setPasswordOrg(o)}>
                        Update password
                      </Button>
                      <Button size="sm" variant={o.status === 'ACTIVE' ? 'danger' : 'secondary'} onClick={() => setToggling(o)}>
                        {o.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                      </Button>
                      {canDelete && (
                        <Button size="sm" variant="danger" onClick={() => setDeleting(o)}>
                          Delete
                        </Button>
                      )}
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
      <OrgPasswordDialog org={passwordOrg} onClose={() => setPasswordOrg(null)} />
      {canDelete && <DeleteOrgDialog org={deleting} onClose={() => setDeleting(null)} />}
    </>
  );
}

export default function OrganizationsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <OrganizationsInner />
    </Suspense>
  );
}
