'use client';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, del, patch, post } from '@/lib/api';
import { useAction } from '@/lib/queries';
import type { LoginLink, Organization } from '@/lib/types';
import { useToast } from './toast';
import { Alert, Button, ConfirmDialog, CopyButton, ErrorBox, Field, Modal, Mono } from './ui';

export function OrgFormDialog({ open, org, onClose }: { open: boolean; org?: Organization | null; onClose: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  useEffect(() => {
    if (open) {
      setCode(org?.code ?? '');
      setName(org?.name ?? '');
    }
  }, [open, org]);
  const save = useAction(
    () => (org ? patch<Organization>(`/organizations/${org.id}`, { name: name.trim() }) : post<Organization>('/organizations', { code: code.trim().toUpperCase(), name: name.trim() })),
    { success: org ? 'Organization updated' : 'Organization created', invalidate: [['organizations'], ['organization']], onSuccess: onClose },
  );
  useEffect(() => {
    if (open) save.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const codeOk = /^[A-Z0-9][A-Z0-9-]{1,31}$/.test(code.trim().toUpperCase());
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={org ? `Edit ${org.code}` : 'New organization'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={save.isPending} disabled={!name.trim() || (!org && !codeOk)} onClick={() => save.mutate(undefined)}>
            {org ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined);
        }}
      >
        <Field label="Code" hint={org ? 'The code is permanent: agents are configured with it.' : 'Uppercase letters, digits and "-", 2–32 characters (e.g. INST-001). Agents are configured with this code.'}>
          <input value={code} disabled={!!org} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={32} autoFocus={!org} />
        </Field>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoFocus={!!org} />
        </Field>
        <ErrorBox error={save.error} />
      </form>
    </Modal>
  );
}

export function OrgStatusDialog({ org, onClose }: { org: Organization | null; onClose: () => void }) {
  const disabling = org?.status === 'ACTIVE';
  const m = useAction(() => patch<Organization>(`/organizations/${org!.id}`, { status: disabling ? 'DISABLED' : 'ACTIVE' }), {
    success: disabling ? 'Organization disabled' : 'Organization enabled',
    invalidate: [['organizations'], ['organization']],
    onSuccess: onClose,
  });
  return (
    <ConfirmDialog
      open={!!org}
      title={disabling ? `Disable ${org?.code}` : `Enable ${org?.code}`}
      confirmLabel={disabling ? 'Disable' : 'Enable'}
      destructive={disabling}
      busy={m.isPending}
      error={m.error}
      onClose={() => {
        m.reset();
        onClose();
      }}
      onConfirm={() => m.mutate(undefined)}
    >
      {disabling ? (
        <p>
          Disabling <strong>{org?.name}</strong> blocks sign-in for its organization administrators and makes its agents receive <Mono>DEVICE_NOT_APPROVED</Mono> until re-enabled.
        </p>
      ) : (
        <p>
          Re-enable <strong>{org?.name}</strong>? Its administrators can sign in again and approved agents resume.
        </p>
      )}
    </ConfirmDialog>
  );
}

/** Generate (rotate) / clear the per-organization registration token. The raw token is shown exactly once. */
export function RegistrationTokenControls({ org }: { org: Organization }) {
  const [confirm, setConfirm] = useState<'rotate' | 'clear' | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const rotate = useAction(() => post<{ organization: Organization; registration_token: string }>(`/organizations/${org.id}/registration-token`), {
    invalidate: [['organizations'], ['organization', org.id]],
    onSuccess: (r) => {
      setConfirm(null);
      setToken(r.registration_token);
    },
  });
  const clear = useAction(() => del<Organization>(`/organizations/${org.id}/registration-token`), {
    success: 'Registration token cleared',
    invalidate: [['organizations'], ['organization', org.id]],
    onSuccess: () => setConfirm(null),
  });
  return (
    <>
      <div className="btn-row">
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            rotate.reset();
            setConfirm('rotate');
          }}
        >
          {org.has_registration_token ? 'Rotate token' : 'Generate token'}
        </Button>
        {org.has_registration_token && (
          <Button
            size="sm"
            onClick={() => {
              clear.reset();
              setConfirm('clear');
            }}
          >
            Clear
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirm === 'rotate'}
        title={org.has_registration_token ? 'Rotate registration token' : 'Generate registration token'}
        confirmLabel={org.has_registration_token ? 'Rotate' : 'Generate'}
        destructive={org.has_registration_token}
        busy={rotate.isPending}
        error={rotate.error}
        onClose={() => setConfirm(null)}
        onConfirm={() => rotate.mutate(undefined)}
      >
        <p>
          A new registration token for <strong>{org.code}</strong> will be generated and shown <strong>once</strong>.
          {org.has_registration_token && ' The current token stops working immediately; agents already enrolled are not affected.'}
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'clear'}
        title="Clear registration token"
        confirmLabel="Clear token"
        destructive
        busy={clear.isPending}
        error={clear.error}
        onClose={() => setConfirm(null)}
        onConfirm={() => clear.mutate(undefined)}
      >
        <p>Remove the per-organization token? New agents for {org.code} will then need the server&apos;s global AGENT_REGISTRATION_TOKEN (if configured).</p>
      </ConfirmDialog>
      <Modal open={!!token} onClose={() => setToken(null)} title="Registration token" footer={<Button variant="primary" onClick={() => setToken(null)}>I have stored it</Button>}>
        <div className="stack">
          <Alert tone="warn" title="Copy it now">
            This token is shown only once and cannot be retrieved later. Store it in the agent installer configuration or a password manager. Anyone with it can register devices (they still need approval).
          </Alert>
          <div className="secret-box">
            <code className="mono secret">{token}</code>
            {token && <CopyButton value={token} />}
          </div>
          <ErrorBox error={null} />
        </div>
      </Modal>
    </>
  );
}

/**
 * Copy text that is still being fetched. The clipboard write must start inside the click (Safari
 * rejects writes after an await), so a ClipboardItem is handed a promise; browsers without
 * promise-based ClipboardItem fall back to writeText once the text arrives.
 */
async function copyPending(text: Promise<string>): Promise<void> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })) })]);
      return;
    } catch (e) {
      // A failed request must not be retried as a clipboard fallback.
      await text;
      void e;
    }
  }
  await navigator.clipboard.writeText(await text);
}

/** Super admin: issue a one-time sign-in link for the organization's (oldest active) admin and copy it. */
export function LoginLinkButton({ org }: { org: Organization }) {
  const toast = useToast();
  const m = useAction(() => post<LoginLink>(`/organizations/${org.id}/login-link`, {}), { invalidate: [['audit']], toastErrors: true });
  const onClick = () => {
    const link = m.mutateAsync(undefined);
    copyPending(link.then((r) => r.url))
      .then(async () => {
        const r = await link;
        const minutes = Math.max(1, Math.round((new Date(r.expires_at).getTime() - Date.now()) / 60_000));
        toast(`Login link for ${r.user.email} copied — valid ${minutes} min, single use`, 'success');
      })
      .catch(async () => {
        // Request errors are already toasted by useAction; only report clipboard failures here.
        if (await link.then(() => true, () => false)) toast('Could not copy: the browser blocked clipboard access. Try again.', 'error');
      });
  };
  return (
    <Button size="sm" busy={m.isPending} disabled={org.status !== 'ACTIVE'} title={org.status !== 'ACTIVE' ? 'Organization is disabled' : `Copy a one-time sign-in link for an administrator of ${org.code}`} onClick={onClick}>
      Copy login link
    </Button>
  );
}

/** Development tool: permanently delete an organization; the admin must type its code. */
export function DeleteOrgDialog({ org, onClose }: { org: Organization | null; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const qc = useQueryClient();
  useEffect(() => {
    if (org) setTyped('');
  }, [org]);
  const m = useAction(() => api<{ devices: number; policies: number; users: number }>(`/organizations/${org!.id}`, { method: 'DELETE', query: { confirm: typed.trim() } }), {
    success: (r) => `Deleted ${org?.code}: ${r.devices} computers, ${r.policies} restrictions, ${r.users} administrators`,
    onSuccess: () => {
      onClose();
      // Everything may have referenced it.
      void qc.invalidateQueries();
    },
  });
  useEffect(() => {
    if (org) m.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org]);
  const matches = !!org && typed.trim() === org.code;
  return (
    <ConfirmDialog
      open={!!org}
      title={`Delete ${org?.code ?? ''} permanently`}
      confirmLabel="Delete organization"
      destructive
      busy={m.isPending}
      confirmDisabled={!matches}
      error={m.error}
      onClose={onClose}
      onConfirm={() => matches && m.mutate(undefined)}
    >
      <Alert tone="error" title="This cannot be undone">
        Deletes <strong>{org?.name}</strong> with all its computers, credentials, groups, restrictions (with every version), assignments and administrators. Audit history is kept.
      </Alert>
      <Field label={`Type ${org?.code ?? ''} to confirm`} error={typed && !matches ? 'Does not match the organization code' : null}>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches) m.mutate(undefined);
          }}
          autoComplete="off"
          spellCheck={false}
          className="mono"
          autoFocus
        />
      </Field>
    </ConfirmDialog>
  );
}
