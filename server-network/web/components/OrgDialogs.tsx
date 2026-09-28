'use client';
import { useEffect, useState } from 'react';
import { del, patch, post } from '@/lib/api';
import { useAction } from '@/lib/queries';
import type { Organization } from '@/lib/types';
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
