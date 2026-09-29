'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, del, get, patch, post, put } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useOrgAssignments } from '@/lib/queries';
import { absTime } from '@/lib/format';
import { KIND_INFO, VIA_LABEL } from '@/lib/restrictions';
import type { Issue, OrgAssignment, PolicyDetail, PolicyVersion, SavedPolicy } from '@/lib/types';
import { Alert, Badge, Button, Card, ConfirmDialog, Empty, ErrorBox, Field, Modal, Mono, PageHeader, Spinner, StatusBadge } from '@/components/ui';
import { useToast } from '@/components/toast';
import { ContentSummary, KindBadge } from '@/components/EffectiveRules';
import { clientErrors, RestrictionEditor, toContent, toForm, type RestrictionForm } from '@/components/RestrictionEditor';

const RESOLVE_KEYS = [['devices'], ['device'], ['assignments'], ['analytics'], ['audit']];

function IssueList({ title, items, tone }: { title: string; items: Issue[]; tone: 'error' | 'warn' }) {
  if (!items.length) return null;
  return (
    <Alert tone={tone} title={title}>
      <ul className="alert-details">
        {items.map((i, n) => (
          <li key={n}>
            {i.path && <code>{i.path}</code>} {i.message}
          </li>
        ))}
      </ul>
    </Alert>
  );
}

function VersionDialog({ policy, version, onClose }: { policy: PolicyDetail; version: number | null; onClose: () => void }) {
  const v = useQuery({
    queryKey: ['policy', policy.id, 'version', version],
    queryFn: () => get<PolicyVersion>(`/policies/${policy.id}/versions/${version}`),
    enabled: version !== null,
  });
  return (
    <Modal open={version !== null} onClose={onClose} wide title={`${policy.name} — version ${version ?? ''}`} footer={<Button onClick={onClose}>Close</Button>}>
      {v.isLoading ? (
        <Spinner />
      ) : v.error || !v.data?.content ? (
        <ErrorBox error={v.error ?? new Error('No content')} />
      ) : (
        <div className="stack">
          <p className="small">
            <StatusBadge status={v.data.status} /> {v.data.is_active_version && <Badge tone="violet">serving</Badge>} published {absTime(v.data.published_at)}
            {v.data.content_sha256 && (
              <>
                {' '}
                · sha256 <Mono>{v.data.content_sha256.slice(0, 16)}…</Mono>
              </>
            )}
          </p>
          <ContentSummary content={v.data.content} kind={policy.kind} />
        </div>
      )}
    </Modal>
  );
}

function AssignmentsCard({ policy }: { policy: PolicyDetail }) {
  const all = useOrgAssignments(policy.organization_id);
  const [removing, setRemoving] = useState<OrgAssignment | null>(null);
  const items = (all.data?.items ?? []).filter((a) => a.policy_id === policy.id);
  const remove = useAction((a: OrgAssignment) => del(`/policies/${policy.id}/assignments/${a.id}`), {
    success: 'Assignment removed',
    invalidate: [['policy', policy.id], ...RESOLVE_KEYS],
    onSuccess: () => setRemoving(null),
  });
  const target = (a: OrgAssignment) =>
    a.scope === 'ORGANIZATION' ? (
      'Whole organization'
    ) : a.scope === 'GROUP' ? (
      <Link href={`/computers/groups/${a.target_group_id}`}>{a.target_name ?? a.target_group_id}</Link>
    ) : (
      <Link href={`/computers/${a.target_device_id}`}>{a.target_name ?? 'Unnamed computer'}</Link>
    );
  return (
    <Card title={`Assigned to (${all.data ? items.length : '…'})`} actions={<Link href="/access">Change on Set access</Link>}>
      {all.error && <ErrorBox error={all.error} />}
      {all.isLoading ? (
        <Spinner />
      ) : !items.length ? (
        <Empty>Not assigned yet. Drag it onto the organization, a group or computers on Set access.</Empty>
      ) : (
        <ul className="assign-list">
          {items.map((a) => (
            <li key={a.id}>
              <span className="chip">{VIA_LABEL[a.scope]}</span> {target(a)}
              <button type="button" className="icon-btn" aria-label={`Unassign from ${a.target_name ?? 'organization'}`} onClick={() => setRemoving(a)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={!!removing}
        title="Remove assignment"
        confirmLabel="Unassign"
        destructive
        busy={remove.isPending}
        error={remove.error}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing)}
      >
        <p>
          Stop applying <strong>{policy.name}</strong> to {removing?.scope === 'ORGANIZATION' ? 'the whole organization' : <strong>{removing?.target_name}</strong>}? Affected computers get their updated merged rules on
          their next heartbeat.
        </p>
      </ConfirmDialog>
    </Card>
  );
}

export default function RestrictionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { isSuper } = useAuth();
  const toast = useToast();
  const policy = useQuery({ queryKey: ['policy', id], queryFn: () => get<PolicyDetail>(`/policies/${id}`) });
  const p = policy.data;
  // Edit what computers receive: the serving version (else the newest one, e.g. an unpublished legacy draft).
  const base = p ? (p.versions.find((v) => v.is_active_version) ?? p.versions[0]) : undefined;
  const version = useQuery({
    queryKey: ['policy', id, 'version', base?.version],
    queryFn: () => get<PolicyVersion>(`/policies/${id}/versions/${base!.version}`),
    enabled: !!base,
  });

  const [form, setForm] = useState<RestrictionForm | null>(null);
  const [meta, setMeta] = useState({ name: '', description: '' });
  const [baseline, setBaseline] = useState('');
  const [warnings, setWarnings] = useState<Issue[]>([]);
  const [serverErrors, setServerErrors] = useState<Issue[]>([]);
  const [confirm, setConfirm] = useState<{ kind: 'rollback'; version: number } | { kind: 'activate' | 'deactivate' } | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);

  // (Re)load the editor when another version becomes the base (after save / rollback).
  const loaded = useRef<string | null>(null);
  useEffect(() => {
    if (!p || !version.data || loaded.current === version.data.id) return;
    loaded.current = version.data.id;
    const f = toForm(p.kind, version.data.content);
    setForm(f);
    setMeta({ name: p.name, description: p.description ?? '' });
    setBaseline(JSON.stringify(toContent(p.kind, f)));
    setServerErrors([]);
  }, [p, version.data]);

  const contentDirty = !!form && !!p && JSON.stringify(toContent(p.kind, form)) !== baseline;
  const metaDirty = !!p && (meta.name.trim() !== p.name || (meta.description.trim() || null) !== (p.description ?? null));
  const dirty = contentDirty || metaDirty;

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const save = useAction(
    async () => {
      if (metaDirty) await patch<PolicyDetail>(`/policies/${id}`, { name: meta.name.trim(), description: meta.description.trim() || null });
      if (!contentDirty && base?.is_active_version) return null;
      return put<SavedPolicy>(`/policies/${id}/content`, { content: toContent(p!.kind, form!) });
    },
    {
      invalidate: [['policy', id], ['policies'], ...RESOLVE_KEYS],
      onSuccess: (r) => {
        setServerErrors([]);
        setWarnings(r?.warnings ?? []);
        if (!r) toast('Details saved', 'success');
        else if (r.unchanged) {
          toast(`No changes — the rules are already published as v${r.active_version}`, 'info');
          // Server-normalized text equals what is published: show the published form again.
          setForm(toForm(p!.kind, JSON.parse(baseline)));
        } else toast(`Saved and published as v${r.active_version}; computers update on their next heartbeat`, 'success');
      },
    },
  );
  useEffect(() => {
    if (save.error instanceof ApiError) setServerErrors(save.error.details);
  }, [save.error]);

  const rollback = useAction((v: number) => post<PolicyDetail>(`/policies/${id}/rollback`, { version: v }), {
    success: (_r, v) => `Rolled back: v${v} is serving again`,
    invalidate: [['policy', id], ['policies'], ...RESOLVE_KEYS],
    onSuccess: () => setConfirm(null),
  });
  const setActive = useAction((on: boolean) => post<PolicyDetail>(`/policies/${id}/${on ? 'activate' : 'deactivate'}`), {
    success: (_r, on) => (on ? 'Restriction activated' : 'Restriction deactivated'),
    invalidate: [['policy', id], ['policies'], ...RESOLVE_KEYS],
    onSuccess: () => setConfirm(null),
  });

  if (policy.isLoading) return <Spinner />;
  if (policy.error || !p) return <ErrorBox error={policy.error} title="Could not load restriction" />;
  const active = p.versions.find((v) => v.is_active_version);
  const canRollbackTo = (v: PolicyVersion) => v.status === 'PUBLISHED' && !v.is_active_version && (!active || v.version < active.version);
  const bad = form ? clientErrors(p.kind, form) : 0;
  const onSave = () => {
    if (!dirty && base?.is_active_version) {
      toast('No changes to save', 'info');
      return;
    }
    save.mutate(undefined);
  };
  const confirmBusy = confirm?.kind === 'rollback' ? rollback : setActive;

  return (
    <>
      <nav className="breadcrumb">
        <Link href="/restrictions">Restrictions</Link> / {p.name}
      </nav>
      <PageHeader
        title={
          <>
            {p.name} <KindBadge kind={p.kind} /> {p.is_active ? <Badge tone="green">active</Badge> : <Badge tone="gray">inactive</Badge>}
          </>
        }
        subtitle={
          <>
            <Mono>{p.code}</Mono>
            {isSuper && p.organization_code && ` · ${p.organization_code}`}
            {p.active_version ? ` · serving v${p.active_version}` : ' · not published'}
          </>
        }
        actions={
          <Button variant={p.is_active ? 'danger' : 'primary'} onClick={() => setConfirm({ kind: p.is_active ? 'deactivate' : 'activate' })}>
            {p.is_active ? 'Deactivate' : 'Activate'}
          </Button>
        }
      />
      {!p.is_active && <Alert tone="warn">This restriction is inactive: it is skipped for every computer it is assigned to until activated.</Alert>}
      {base && !base.is_active_version && <Alert tone="info">Version {base.version} is not published yet. Saving publishes it (as a new version) and computers start receiving it.</Alert>}

      <div className="restriction-layout">
        <div className="stack">
          <Card
            title={
              <>
                Rules {dirty && <Badge tone="amber">unsaved changes</Badge>}
              </>
            }
            actions={
              <>
                <Button
                  size="sm"
                  disabled={!dirty}
                  onClick={() => {
                    setForm(toForm(p.kind, JSON.parse(baseline)));
                    setMeta({ name: p.name, description: p.description ?? '' });
                    setServerErrors([]);
                  }}
                >
                  Discard
                </Button>
                <Button size="sm" variant="primary" busy={save.isPending} disabled={bad > 0 || !meta.name.trim()} onClick={onSave}>
                  Save &amp; publish
                </Button>
              </>
            }
          >
            {!form || version.isLoading ? (
              version.error ? <ErrorBox error={version.error} /> : <Spinner />
            ) : (
              <form
                className="stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  onSave();
                }}
              >
                <div className="form-row">
                  <Field label="Name">
                    <input value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} maxLength={200} />
                  </Field>
                  <Field label="Description (optional)">
                    <input value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} maxLength={2000} />
                  </Field>
                </div>
                <p className="muted small">
                  Type: <strong>{KIND_INFO[p.kind].label}</strong> (fixed once created).
                </p>
                <ErrorBox error={save.error} title="Save failed" />
                <IssueList title="Warnings from the last save" items={warnings} tone="warn" />
                <RestrictionEditor kind={p.kind} form={form} onChange={setForm} serverErrors={serverErrors} />
              </form>
            )}
          </Card>
          <AssignmentsCard policy={p} />
        </div>

        <Card title="Version history" className="versions-card">
          <ul className="version-list">
            {p.versions.map((x) => (
              <li key={x.id} className="version-row">
                <button type="button" className="version-item" onClick={() => setViewing(x.version)} title="View this version">
                  <span className="version-no">v{x.version}</span>
                  <StatusBadge status={x.status} />
                  {x.is_active_version && <Badge tone="violet">serving</Badge>}
                  <span className="muted small version-date">{absTime(x.published_at ?? x.updated_at)}</span>
                </button>
                {canRollbackTo(x) && (
                  <Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: 'rollback', version: x.version })}>
                    Roll back
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <p className="muted small">Every save publishes a new immutable version. Roll back to serve an earlier one again.</p>
        </Card>
      </div>

      <VersionDialog policy={p} version={viewing} onClose={() => setViewing(null)} />
      <ConfirmDialog
        open={!!confirm}
        title={confirm?.kind === 'rollback' ? `Roll back to version ${confirm.version}` : confirm?.kind === 'activate' ? 'Activate restriction' : 'Deactivate restriction'}
        confirmLabel={confirm?.kind === 'rollback' ? 'Roll back' : confirm?.kind === 'activate' ? 'Activate' : 'Deactivate'}
        destructive={confirm?.kind !== 'activate'}
        busy={confirmBusy.isPending}
        error={confirmBusy.error}
        onClose={() => {
          rollback.reset();
          setActive.reset();
          setConfirm(null);
        }}
        onConfirm={() => {
          if (!confirm) return;
          if (confirm.kind === 'rollback') rollback.mutate(confirm.version);
          else setActive.mutate(confirm.kind === 'activate');
        }}
      >
        {confirm?.kind === 'rollback' && (
          <p>
            Serve the earlier v{confirm.version} again{active ? ` instead of v${active.version}` : ''}. Computers get it on their next heartbeat. Later versions stay in the history.
            {dirty && ' Your unsaved edits are discarded.'}
          </p>
        )}
        {confirm?.kind === 'activate' && <p>Activate {p.name}? It applies again to every computer it is assigned to.</p>}
        {confirm?.kind === 'deactivate' && <p>Deactivate {p.name}? It stops applying to every computer it is assigned to (assignments are kept).</p>}
      </ConfirmDialog>
    </>
  );
}
