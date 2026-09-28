'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, get, patch, post, put } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/queries';
import { absTime } from '@/lib/format';
import type { Issue, PolicyDetail, PolicyVersion, ValidationResult } from '@/lib/types';
import { Alert, Badge, Button, Card, ConfirmDialog, ErrorBox, Field, Modal, Mono, PageHeader, Spinner, StatusBadge } from '@/components/ui';
import { ContentEditor, toContent, toForm, type ContentForm } from '@/components/policy/ContentEditor';
import { AssignmentsCard } from '@/components/policy/Assignments';
import { useToast } from '@/components/toast';

type Confirm = { kind: 'publish' | 'rollback' | 'archive' | 'activate' | 'deactivate'; version?: number } | null;

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

export default function PolicyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { isSuper } = useAuth();
  const toast = useToast();
  const policy = useQuery({ queryKey: ['policy', id], queryFn: () => get<PolicyDetail>(`/policies/${id}`) });
  const [selected, setSelected] = useState<number | null>(null);
  const [form, setForm] = useState<ContentForm | null>(null);
  const [baseline, setBaseline] = useState<string>('');
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [saveWarnings, setSaveWarnings] = useState<Issue[]>([]);
  const [serverErrors, setServerErrors] = useState<Issue[]>([]);
  const [testNames, setTestNames] = useState('');
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [editingMeta, setEditingMeta] = useState(false);
  const [meta, setMeta] = useState({ name: '', description: '' });

  const versions = policy.data?.versions ?? [];
  const draft = versions.find((v) => v.status === 'DRAFT');
  const active = versions.find((v) => v.is_active_version);

  // Default selection: the draft (work in progress), else the active version, else the newest.
  useEffect(() => {
    if (!policy.data) return;
    if (selected === null || !versions.some((v) => v.version === selected)) setSelected(draft?.version ?? active?.version ?? versions[0]?.version ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policy.data]);

  const version = useQuery({
    queryKey: ['policy', id, 'version', selected],
    queryFn: () => get<PolicyVersion>(`/policies/${id}/versions/${selected}`),
    enabled: selected !== null,
  });

  // Load (or reload after save: server-normalized) content into the editor. Feedback panels are only
  // cleared when switching to another version, so save warnings survive the post-save refetch.
  const loadedVersion = useRef<string | null>(null);
  useEffect(() => {
    if (!version.data) return;
    const f = toForm(version.data.content);
    setForm(f);
    setBaseline(JSON.stringify(toContent(f)));
    if (loadedVersion.current !== version.data.id) {
      loadedVersion.current = version.data.id;
      setValidation(null);
      setSaveWarnings([]);
      setServerErrors([]);
    }
  }, [version.data]);

  const isDraft = version.data?.status === 'DRAFT';
  const dirty = !!form && JSON.stringify(toContent(form)) !== baseline;

  // Warn before leaving with unsaved draft edits.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const invalidate = [['policy', id], ['policies']] as const;

  const captureErrors = (e: unknown) => {
    if (e instanceof ApiError && e.code === 'VALIDATION_ERROR') setServerErrors(e.details);
  };

  const saveDraft = useAction(
    async () => {
      const r = await put<PolicyVersion & { warnings: Issue[] }>(`/policies/${id}/versions/${selected}`, { content: toContent(form!) });
      return r;
    },
    {
      success: 'Draft saved',
      invalidate: [['policy', id, 'version', selected]],
      onSuccess: (r) => {
        setSaveWarnings(r.warnings ?? []);
        setServerErrors([]);
      },
    },
  );

  const validate = useAction(
    () =>
      post<ValidationResult>('/policies/validate', {
        content: toContent(form!),
        organization_id: policy.data!.organization_id,
        ...(testNames.trim() ? { names: testNames.split(/[\s,]+/).filter(Boolean).slice(0, 200) } : {}),
      }),
    {
      onSuccess: (r) => {
        setValidation(r);
        setServerErrors(r.errors);
        toast(r.valid ? `Valid${r.warnings.length ? ` with ${r.warnings.length} warning(s)` : ''}` : `${r.errors.length} error(s)`, r.valid ? 'success' : 'error');
      },
    },
  );

  const publish = useAction(
    async () => {
      if (dirty) await put(`/policies/${id}/versions/${selected}`, { content: toContent(form!) });
      return post<PolicyVersion & { warnings: Issue[] }>(`/policies/${id}/versions/${selected}/publish`);
    },
    {
      success: () => `Version ${selected} published and active`,
      invalidate: [...invalidate, ['policy', id, 'version'], ['devices'], ['device']],
      onSuccess: () => setConfirm(null),
    },
  );

  const newVersion = useAction((from?: number) => post<PolicyVersion>(`/policies/${id}/versions`, from ? { from_version: from } : {}), {
    success: (v, from) => `Draft v${v.version} created${from ? ` from v${from}` : ''}`,
    invalidate: [...invalidate],
    onSuccess: (v) => setSelected(v.version),
    toastErrors: true,
  });

  const rollback = useAction((v: number) => post<PolicyDetail>(`/policies/${id}/rollback`, { version: v }), {
    success: (_r, v) => `Rolled back: v${v} is now active`,
    invalidate: [...invalidate, ['policy', id, 'version'], ['devices'], ['device']],
    onSuccess: () => setConfirm(null),
  });
  const archive = useAction((v: number) => post<PolicyVersion>(`/policies/${id}/versions/${v}/archive`), {
    success: (_r, v) => `Version ${v} archived`,
    invalidate: [...invalidate, ['policy', id, 'version']],
    onSuccess: () => setConfirm(null),
  });
  const setActive = useAction((on: boolean) => post<PolicyDetail>(`/policies/${id}/${on ? 'activate' : 'deactivate'}`), {
    success: (_r, on) => (on ? 'Policy activated' : 'Policy deactivated'),
    invalidate: [...invalidate, ['devices'], ['device']],
    onSuccess: () => setConfirm(null),
  });
  const saveMeta = useAction(() => patch<PolicyDetail>(`/policies/${id}`, { name: meta.name.trim(), description: meta.description.trim() ? meta.description.trim() : null }), {
    success: 'Policy updated',
    invalidate: [...invalidate],
    onSuccess: () => setEditingMeta(false),
  });

  useEffect(() => {
    if (saveDraft.error) captureErrors(saveDraft.error);
  }, [saveDraft.error]);
  useEffect(() => {
    if (publish.error) captureErrors(publish.error);
  }, [publish.error]);

  const confirmMutation = useMemo(() => {
    switch (confirm?.kind) {
      case 'publish':
        return publish;
      case 'rollback':
        return rollback;
      case 'archive':
        return archive;
      case 'activate':
      case 'deactivate':
        return setActive;
      default:
        return null;
    }
  }, [confirm, publish, rollback, archive, setActive]);

  if (policy.isLoading) return <Spinner />;
  if (policy.error || !policy.data) return <ErrorBox error={policy.error} title="Could not load policy" />;
  const p = policy.data;
  const v = version.data;
  const canRollbackTo = (x: PolicyVersion) => x.status === 'PUBLISHED' && !x.is_active_version && (!active || x.version < active.version);

  return (
    <>
      <nav className="breadcrumb">
        <Link href="/policies">Policies</Link> / {p.code}
      </nav>
      <PageHeader
        title={
          <>
            {p.name} {p.is_active ? <Badge tone="green">active</Badge> : <Badge tone="gray">inactive</Badge>}
          </>
        }
        subtitle={
          <>
            <Mono>{p.code}</Mono>
            {isSuper && p.organization_code && ` · ${p.organization_code}`}
            {p.active_version ? ` · serving v${p.active_version}` : ' · not published'}
            {p.description && <span className="block">{p.description}</span>}
          </>
        }
        actions={
          <>
            <Button
              onClick={() => {
                setMeta({ name: p.name, description: p.description ?? '' });
                saveMeta.reset();
                setEditingMeta(true);
              }}
            >
              Edit details
            </Button>
            <Button variant={p.is_active ? 'danger' : 'primary'} onClick={() => { setActive.reset(); setConfirm({ kind: p.is_active ? 'deactivate' : 'activate' }); }}>
              {p.is_active ? 'Deactivate' : 'Activate'}
            </Button>
            {!draft && (
              <Button variant="primary" busy={newVersion.isPending} onClick={() => newVersion.mutate(undefined)}>
                New version
              </Button>
            )}
          </>
        }
      />
      {!p.is_active && <Alert tone="warn">This policy is inactive: all of its assignments are skipped when resolving device policies.</Alert>}

      <div className="policy-layout">
        <Card title="Versions" className="versions-card">
          <ul className="version-list">
            {versions.map((x) => (
              <li key={x.id}>
                <button type="button" className={`version-item ${x.version === selected ? 'selected' : ''}`} onClick={() => setSelected(x.version)} aria-pressed={x.version === selected}>
                  <span className="version-no">v{x.version}</span>
                  <StatusBadge status={x.status} />
                  {x.is_active_version && <Badge tone="violet">serving</Badge>}
                  <span className="muted small version-date">{absTime(x.published_at ?? x.updated_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <div className="stack">
          {version.isLoading || !form || !v ? (
            version.error ? <ErrorBox error={version.error} /> : <Spinner />
          ) : (
            <Card
              title={
                <>
                  Version {v.version} <StatusBadge status={v.status} /> {v.is_active_version && <Badge tone="violet">serving</Badge>}
                  {isDraft && dirty && <Badge tone="amber">unsaved changes</Badge>}
                </>
              }
              actions={
                isDraft ? (
                  <>
                    <Button size="sm" disabled={!dirty} onClick={() => { setForm(toForm(JSON.parse(baseline))); setServerErrors([]); }}>
                      Discard
                    </Button>
                    <Button size="sm" busy={validate.isPending} onClick={() => validate.mutate(undefined)}>
                      Validate
                    </Button>
                    <Button size="sm" busy={saveDraft.isPending} disabled={!dirty} onClick={() => saveDraft.mutate(undefined)}>
                      Save draft
                    </Button>
                    <Button size="sm" variant="primary" onClick={() => { publish.reset(); setConfirm({ kind: 'publish', version: v.version }); }}>
                      Publish…
                    </Button>
                  </>
                ) : (
                  <>
                    {canRollbackTo(v) && (
                      <Button size="sm" onClick={() => { rollback.reset(); setConfirm({ kind: 'rollback', version: v.version }); }}>
                        Roll back to v{v.version}
                      </Button>
                    )}
                    {!v.is_active_version && v.status !== 'ARCHIVED' && (
                      <Button size="sm" onClick={() => { archive.reset(); setConfirm({ kind: 'archive', version: v.version }); }}>
                        Archive
                      </Button>
                    )}
                    <Button size="sm" variant="primary" disabled={!!draft} title={draft ? `v${draft.version} is already a draft` : undefined} busy={newVersion.isPending} onClick={() => newVersion.mutate(v.version)}>
                      New draft from v{v.version}
                    </Button>
                  </>
                )
              }
            >
              {!isDraft && (
                <Alert tone="info">
                  {v.status === 'PUBLISHED' ? 'Published versions are immutable.' : 'Archived versions are read-only.'} Create a new draft to make changes.
                  {v.content_sha256 && (
                    <div className="small">
                      sha256 <Mono>{v.content_sha256}</Mono> · ETag <Mono>{v.etag}</Mono> · published {absTime(v.published_at)}
                    </div>
                  )}
                </Alert>
              )}
              <ErrorBox error={saveDraft.error} title="Save failed" />
              <IssueList title="Warnings from last save" items={saveWarnings} tone="warn" />
              <ContentEditor form={form} onChange={setForm} readOnly={!isDraft} serverErrors={isDraft ? serverErrors : []} />

              {isDraft && (
                <div className="validate-panel">
                  <Field label="Test names (optional)" hint="Space/comma separated hostnames; Validate shows the allow/block decision for each.">
                    <input value={testNames} onChange={(e) => setTestNames(e.target.value)} placeholder="www.example.com mail.company.com" />
                  </Field>
                  <ErrorBox error={validate.error} title="Validation request failed" />
                  {validation && (
                    <div className="stack">
                      {validation.valid ? (
                        <Alert tone="success" title="Content is valid">
                          {validation.content_sha256 && (
                            <span className="small">
                              Normalized sha256 <Mono>{validation.content_sha256}</Mono>
                            </span>
                          )}
                        </Alert>
                      ) : (
                        <IssueList title={`${validation.errors.length} error(s)`} items={validation.errors} tone="error" />
                      )}
                      <IssueList title={`${validation.warnings.length} warning(s)`} items={validation.warnings} tone="warn" />
                      {validation.decisions && validation.decisions.length > 0 && (
                        <table className="table">
                          <thead>
                            <tr>
                              <th>Name</th>
                              <th>Decision</th>
                              <th>Reason</th>
                            </tr>
                          </thead>
                          <tbody>
                            {validation.decisions.map((d, i) => (
                              <tr key={i}>
                                <td>
                                  <Mono>{d.name}</Mono>
                                </td>
                                <td>
                                  <Badge tone={d.action === 'block' ? 'red' : 'green'}>{d.action}</Badge>
                                </td>
                                <td className="small">
                                  {d.reason}
                                  {d.pattern && (
                                    <>
                                      {' '}
                                      (<Mono>{d.pattern}</Mono> in {d.list})
                                    </>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </div>
              )}
            </Card>
          )}
          <AssignmentsCard policy={p} />
        </div>
      </div>

      <ConfirmDialog
        open={!!confirm}
        title={
          confirm?.kind === 'publish'
            ? `Publish version ${confirm.version}`
            : confirm?.kind === 'rollback'
              ? `Roll back to version ${confirm.version}`
              : confirm?.kind === 'archive'
                ? `Archive version ${confirm.version}`
                : confirm?.kind === 'activate'
                  ? 'Activate policy'
                  : 'Deactivate policy'
        }
        confirmLabel={confirm?.kind === 'publish' ? 'Publish' : confirm?.kind === 'rollback' ? 'Roll back' : confirm?.kind === 'archive' ? 'Archive' : confirm?.kind === 'activate' ? 'Activate' : 'Deactivate'}
        destructive={confirm?.kind === 'deactivate' || confirm?.kind === 'rollback'}
        busy={confirmMutation?.isPending}
        error={confirmMutation?.error}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (!confirm) return;
          if (confirm.kind === 'publish') publish.mutate(undefined);
          else if (confirm.kind === 'rollback') rollback.mutate(confirm.version!);
          else if (confirm.kind === 'archive') archive.mutate(confirm.version!);
          else setActive.mutate(confirm.kind === 'activate');
        }}
      >
        {confirm?.kind === 'publish' && (
          <>
            <p>
              Publishing makes v{confirm.version} <strong>immutable</strong> and immediately the serving version for every device this policy is assigned to
              {active ? ` (replacing v${active.version})` : ''}.
            </p>
            {dirty && <p>Your unsaved changes will be saved first.</p>}
            {!p.is_active && <p className="muted">The policy is currently inactive, so devices will not receive it until it is activated.</p>}
          </>
        )}
        {confirm?.kind === 'rollback' && (
          <p>
            Make the earlier published v{confirm.version} the serving version{active ? ` instead of v${active.version}` : ''}. Agents download it on their next heartbeat. Later versions stay available.
          </p>
        )}
        {confirm?.kind === 'archive' && <p>Archive v{confirm.version}? Archived versions cannot be published or rolled back to, but can be copied into a new draft.</p>}
        {confirm?.kind === 'activate' && <p>Activate {p.code}? Its assignments start applying again.</p>}
        {confirm?.kind === 'deactivate' && <p>Deactivate {p.code}? All of its assignments are skipped; devices fall back to other matching policies or no policy.</p>}
      </ConfirmDialog>

      <Modal
        open={editingMeta}
        onClose={() => setEditingMeta(false)}
        title="Edit policy details"
        footer={
          <>
            <Button onClick={() => setEditingMeta(false)}>Cancel</Button>
            <Button variant="primary" busy={saveMeta.isPending} disabled={!meta.name.trim()} onClick={() => saveMeta.mutate(undefined)}>
              Save
            </Button>
          </>
        }
      >
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (meta.name.trim()) saveMeta.mutate(undefined);
          }}
        >
          <Field label="Name">
            <input value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} maxLength={200} autoFocus />
          </Field>
          <Field label="Description">
            <textarea rows={3} value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} maxLength={2000} />
          </Field>
          <ErrorBox error={saveMeta.error} />
        </form>
      </Modal>
    </>
  );
}
