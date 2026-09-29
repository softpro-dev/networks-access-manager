'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { absTime } from '@/lib/format';
import type { Organization } from '@/lib/types';
import { Badge, Button, Card, ErrorBox, KeyValue, Mono, PageHeader, Spinner, StatusBadge } from '@/components/ui';
import { LoginLinkButton, OrgFormDialog, OrgStatusDialog, RegistrationTokenControls } from '@/components/OrgDialogs';
import { setScopedOrg } from '@/lib/orgScope';

export default function OrganizationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { isSuper } = useAuth();
  const q = useQuery({ queryKey: ['organization', id], queryFn: () => get<Organization>(`/organizations/${id}`) });
  const [editing, setEditing] = useState(false);
  const [toggling, setToggling] = useState(false);

  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorBox error={q.error} title="Could not load organization" />;
  const o = q.data;
  return (
    <>
      {isSuper && (
        <nav className="breadcrumb">
          <Link href="/organizations">Organizations</Link> / {o.code}
        </nav>
      )}
      <PageHeader
        title={
          <>
            {o.name} <StatusBadge status={o.status} />
          </>
        }
        subtitle={<Mono>{o.code}</Mono>}
        actions={
          isSuper && (
            <>
              <LoginLinkButton org={o} />
              <Button onClick={() => setEditing(true)}>Edit</Button>
              <Button variant={o.status === 'ACTIVE' ? 'danger' : 'secondary'} onClick={() => setToggling(true)}>
                {o.status === 'ACTIVE' ? 'Disable' : 'Enable'}
              </Button>
            </>
          )
        }
      />
      <div className="stat-grid">
        <Link className="stat" href={isSuper ? `/computers?organization_id=${o.id}` : '/computers'}>
          <span className="stat-label">Computers</span>
          <span className="stat-value">{o.stats?.devices ?? '—'}</span>
        </Link>
        <Link className="stat stat-pending" href={isSuper ? `/computers?organization_id=${o.id}&status=PENDING` : '/computers?status=PENDING'}>
          <span className="stat-label">Pending approval</span>
          <span className="stat-value">{o.stats?.pending_devices ?? '—'}</span>
        </Link>
        <Link className="stat" href="/restrictions" onClick={() => isSuper && setScopedOrg(o.id)}>
          <span className="stat-label">Restrictions</span>
          <span className="stat-value">{o.stats?.policies ?? '—'}</span>
        </Link>
      </div>
      <div className="grid-2">
        <Card title="Details">
          <KeyValue
            rows={[
              ['Code', <Mono key="c">{o.code}</Mono>],
              ['Name', o.name],
              ['Status', <StatusBadge key="s" status={o.status} />],
              ['Created', absTime(o.created_at)],
              ['Updated', absTime(o.updated_at)],
            ]}
          />
        </Card>
        <Card title="Agent registration token">
          <p>
            {o.has_registration_token ? (
              <Badge tone="green">Per-organization token set</Badge>
            ) : (
              <Badge tone="gray">No per-organization token — the server&apos;s global token (if configured) applies</Badge>
            )}
          </p>
          <p className="muted small">
            Agents send this token once when registering with organization code <Mono>{o.code}</Mono>. Registered devices still need approval. The raw value is shown only when generated.
          </p>
          <RegistrationTokenControls org={o} />
        </Card>
      </div>
      {isSuper && (
        <>
          <OrgFormDialog open={editing} org={o} onClose={() => setEditing(false)} />
          <OrgStatusDialog org={toggling ? o : null} onClose={() => setToggling(false)} />
        </>
      )}
    </>
  );
}
