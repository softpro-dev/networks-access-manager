'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ApiError, post } from '@/lib/api';
import { useAction } from '@/lib/queries';
import { useOrgScope } from '@/lib/orgScope';
import { KIND_INFO, KINDS } from '@/lib/restrictions';
import type { Issue, RestrictionKind, SavedPolicy } from '@/lib/types';
import { Alert, Button, Card, ErrorBox, Field, PageHeader, Spinner } from '@/components/ui';
import { KindBadge } from '@/components/EffectiveRules';
import { clientErrors, RestrictionEditor, toContent, toForm, type RestrictionForm } from '@/components/RestrictionEditor';

function NewRestrictionInner() {
  const params = useSearchParams();
  const router = useRouter();
  const { orgId, isSuper, orgs } = useOrgScope();
  const initialKind = KINDS.find((k) => k === params.get('kind')) ?? 'BLACKLIST';
  const [kind, setKind] = useState<RestrictionKind>(initialKind);
  const [org, setOrg] = useState(orgId);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [form, setForm] = useState<RestrictionForm>(() => toForm(initialKind, null));
  const [serverErrors, setServerErrors] = useState<Issue[]>([]);
  useEffect(() => setOrg((o) => o || orgId), [orgId]);

  const changeKind = (k: RestrictionKind) => {
    // Keep the protocol settings; the lists belong to one kind only.
    setForm((f) => ({ ...toForm(k, null), flags: f.flags, enabled: f.enabled }));
    setKind(k);
    setServerErrors([]);
  };

  const create = useAction(
    () =>
      post<SavedPolicy>('/policies', {
        name: name.trim(),
        kind,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(isSuper ? { organization_id: org } : {}),
        content: toContent(kind, form),
        publish: true,
      }),
    {
      success: (p) => `${KIND_INFO[p.kind].label} "${p.name}" saved and published as v1${p.warnings.length ? ` (${p.warnings.length} warning(s))` : ''}`,
      invalidate: [['policies'], ['assignments'], ['analytics']],
      onSuccess: (p) => router.push(`/restrictions/${p.id}`),
    },
  );
  useEffect(() => {
    if (create.error instanceof ApiError) setServerErrors(create.error.details);
  }, [create.error]);

  const bad = clientErrors(kind, form);
  const valid = !!name.trim() && (!isSuper || !!org) && bad === 0;

  return (
    <>
      <nav className="breadcrumb">
        <Link href="/restrictions">Restrictions</Link> / New
      </nav>
      <PageHeader title="New restriction" subtitle="Saving publishes it immediately as version 1. It applies to computers once you assign it on Set access." />
      <Card title="Type">
        <div className="kind-cards" role="radiogroup" aria-label="Restriction type">
          {KINDS.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} className={`kind-card ${KIND_INFO[k].css} ${kind === k ? 'selected' : ''}`} onClick={() => changeKind(k)}>
              <span className="kind-card-head">
                <KindBadge kind={k} />
              </span>
              <span className="muted small">{KIND_INFO[k].description}</span>
            </button>
          ))}
        </div>
      </Card>
      <Card title="Details">
        <div className="form-row">
          {isSuper && (
            <Field label="Organization">
              <select value={org} onChange={(e) => setOrg(e.target.value)}>
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
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder={kind === 'ALLOW_ONLY' ? 'Exam mode' : kind === 'BLACKLIST' ? 'No games' : 'Video → learning portal'} autoFocus />
          </Field>
          <Field label="Description (optional)">
            <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
          </Field>
        </div>
      </Card>
      <Card title="Rules">
        <RestrictionEditor kind={kind} form={form} onChange={setForm} serverErrors={serverErrors} />
      </Card>
      {bad > 0 && <Alert tone="warn">Fix the {bad} invalid entr{bad === 1 ? 'y' : 'ies'} above before saving.</Alert>}
      <ErrorBox error={create.error} title="Could not save" />
      <div className="btn-row sticky-actions">
        <Link href="/restrictions" className="btn btn-secondary">
          Cancel
        </Link>
        <Button variant="primary" busy={create.isPending} disabled={!valid} onClick={() => create.mutate(undefined)}>
          Save &amp; publish
        </Button>
      </div>
    </>
  );
}

export default function NewRestrictionPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <NewRestrictionInner />
    </Suspense>
  );
}
