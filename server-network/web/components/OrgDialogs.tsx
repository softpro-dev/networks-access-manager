'use client';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, del, patch, post } from '@/lib/api';
import { useAction } from '@/lib/queries';
import type { LoginLink, Organization, Page, User } from '@/lib/types';
import { useToast } from './toast';
import { Alert, Button, ConfirmDialog, CopyButton, ErrorBox, Field, Modal, Mono } from './ui';

const MIN_PASSWORD = 12;
const PHONE_RE = /^\d{11}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** POST /organizations also returns the administrator it created; PATCH does not. */
type SavedOrg = Organization & { admin?: { id: string; email: string } };

export function OrgFormDialog({ open, org, onClose }: { open: boolean; org?: Organization | null; onClose: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  useEffect(() => {
    if (open) {
      setCode(org?.code ?? '');
      setName(org?.name ?? '');
      setPhone(org?.phone ?? '');
      setEmail('');
      setPassword('');
    }
  }, [open, org]);
  const save = useAction(
    () =>
      org
        ? patch<SavedOrg>(`/organizations/${org.id}`, { name: name.trim(), ...(phone ? { phone } : {}) })
        : post<SavedOrg>('/organizations', {
            code: code.trim().toUpperCase(),
            name: name.trim(),
            phone,
            admin_email: email.trim().toLowerCase(),
            admin_password: password,
          }),
    {
      success: (r) => (r.admin ? `Organization created — administrator ${r.admin.email} can sign in` : 'Organization updated'),
      invalidate: [['organizations'], ['organization'], ['users']],
      onSuccess: onClose,
    },
  );
  useEffect(() => {
    if (open) save.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const codeOk = /^[A-Z0-9][A-Z0-9-]{1,31}$/.test(code.trim().toUpperCase());
  const phoneOk = PHONE_RE.test(phone);
  const emailOk = EMAIL_RE.test(email.trim());
  // Existing organizations may predate the phone field: allow saving them with it still empty.
  const valid = !!name.trim() && (org ? !phone || phoneOk : codeOk && phoneOk && emailOk && password.length >= MIN_PASSWORD);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={org ? `Edit ${org.code}` : 'New organization'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={save.isPending} disabled={!valid} onClick={() => save.mutate(undefined)}>
            {org ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate(undefined);
        }}
      >
        <Field label="Code" hint={org ? 'The code is permanent: agents are configured with it.' : 'Uppercase letters, digits and "-", 2–32 characters (e.g. INST-001). Agents are configured with this code.'}>
          <input value={code} disabled={!!org} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={32} autoFocus={!org} />
        </Field>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoFocus={!!org} />
        </Field>
        <Field label="Phone number" hint="Exactly 11 digits (e.g. 01712345678)." error={phone && !phoneOk ? `${phone.length}/11 digits` : null}>
          <input
            type="tel"
            inputMode="numeric"
            autoComplete="tel"
            placeholder="01712345678"
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
            maxLength={11}
            required={!org}
          />
        </Field>
        {!org && (
          <>
            <Field label="Administrator email" hint="Sign-in email of this organization's first administrator." error={email && !emailOk ? 'Enter a valid email' : null}>
              <input type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} required />
            </Field>
            <NewPasswordField label="Administrator password" value={password} onChange={setPassword} />
          </>
        )}
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
 * Organization service access token (used by SoftProIt.network.conducted). Generating or rotating
 * shows the raw token once in a dialog with a Copy button; only its hash is stored, so a lost token
 * must be rotated. Non-expiring; rotate or clear to revoke.
 */
export function AccessTokenControls({ org, short = false }: { org: Organization; short?: boolean }) {
  const [confirm, setConfirm] = useState<'rotate' | 'clear' | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const gen = useAction(() => post<{ access_token: string }>(`/organizations/${org.id}/access-token`), {
    invalidate: [['organizations'], ['organization', org.id]],
    onSuccess: (r) => {
      setConfirm(null);
      setToken(r.access_token);
    },
  });
  const clear = useAction(() => del<Organization>(`/organizations/${org.id}/access-token`), {
    success: 'Access token cleared',
    invalidate: [['organizations'], ['organization', org.id]],
    onSuccess: () => setConfirm(null),
  });
  return (
    <>
      <div className="btn-row">
        <Button
          size="sm"
          variant={org.has_access_token ? 'warning' : 'secondary'}
          busy={gen.isPending}
          onClick={() => {
            if (!org.has_access_token) return gen.mutate(undefined);
            gen.reset();
            setConfirm('rotate');
          }}
        >
          {org.has_access_token ? (short ? 'Rotate token' : 'Rotate access token') : short ? 'Generate token' : 'Generate access token'}
        </Button>
        {org.has_access_token && (
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
        title="Rotate access token"
        confirmLabel="Rotate"
        destructive
        busy={gen.isPending}
        error={gen.error}
        onClose={() => setConfirm(null)}
        onConfirm={() => gen.mutate(undefined)}
      >
        <p>
          A new service access token for <strong>{org.code}</strong> is generated, copied, and shown once. The current token
          stops working immediately, so every already-installed service must be reconfigured with the new token.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'clear'}
        title="Clear access token"
        confirmLabel="Clear token"
        destructive
        busy={clear.isPending}
        error={clear.error}
        onClose={() => setConfirm(null)}
        onConfirm={() => clear.mutate(undefined)}
      >
        <p>
          Remove the service access token for <strong>{org.code}</strong>? It stops working immediately: every installed
          service using it can no longer fetch policy updates and keeps enforcing its last cached policy until it is
          reconfigured with a new token.
        </p>
      </ConfirmDialog>
      <Modal open={!!token} onClose={() => setToken(null)} title="Access token" footer={<Button variant="primary" onClick={() => setToken(null)}>I have stored it</Button>}>
        <div className="stack">
          <Alert tone="warn" title="Copy it now">
            This token is shown only once and cannot be retrieved later. Paste it into the agent installer (access token /
            ACCESS_TOKE). Anyone with it can read this organization&apos;s policy. If it is lost, rotate it.
          </Alert>
          <div className="secret-box">
            <code className="mono secret">{token}</code>
            {token && <CopyButton value={token} />}
          </div>
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

// Look-alike characters (I l 1 O 0) are left out so a generated password can be read out or retyped.
const PASSWORD_SETS = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%^&*-_=+?'];

/** Uniform random integer in [0, n) from the Web Crypto CSPRNG (rejection sampling, no modulo bias). */
function randomIndex(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0]! >= limit);
  return buf[0]! % n;
}

/** 20 characters (~125 bits), at least one from each character set, shuffled. */
function generatePassword(length = 20): string {
  const all = PASSWORD_SETS.join('');
  const chars = PASSWORD_SETS.map((set) => set[randomIndex(set.length)]!);
  while (chars.length < length) chars.push(all[randomIndex(all.length)]!);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

/** Password input with Generate (CSPRNG) / Show / Copy, enforcing the server's minimum length. */
function NewPasswordField({
  label,
  hint,
  value,
  onChange,
  autoFocus,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!value) setShow(false);
  }, [value]);
  return (
    <>
      <Field
        label={label}
        hint={`At least ${MIN_PASSWORD} characters.${hint ? ` ${hint}` : ''} Copy a generated password before saving — it is not shown again.`}
        error={value.length > 0 && value.length < MIN_PASSWORD ? 'Too short' : null}
      >
        <input
          type={show ? 'text' : 'password'}
          className={show ? 'mono' : undefined}
          autoComplete="new-password"
          spellCheck={false}
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={1024}
        />
      </Field>
      <div className="btn-row">
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            onChange(generatePassword());
            setShow(true);
          }}
        >
          Generate secure password
        </Button>
        <Button size="sm" disabled={!value} onClick={() => setShow((s) => !s)}>
          {show ? 'Hide' : 'Show'}
        </Button>
        {value && <CopyButton value={value} />}
      </div>
    </>
  );
}

/**
 * Super admin: set a new password for the organization's administrator. Uses PATCH /users/:id, which
 * also revokes that user's sessions and writes an audit entry (never the password).
 */
export function OrgPasswordDialog({ org, onClose }: { org: Organization | null; onClose: () => void }) {
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const admins = useQuery({
    queryKey: ['users', { organization_id: org?.id, role: 'ORGANIZATION_ADMIN' }],
    queryFn: () => api<Page<User>>('/users', { query: { organization_id: org!.id, role: 'ORGANIZATION_ADMIN', page_size: 200 } }),
    enabled: !!org,
  });
  const items = admins.data?.items ?? [];
  const selected = items.find((u) => u.id === userId) ?? items[0];
  const m = useAction(() => patch<User>(`/users/${selected!.id}`, { password }), {
    success: (u) => `Password updated for ${u.email}`,
    invalidate: [['users'], ['audit']],
    onSuccess: onClose,
  });
  useEffect(() => {
    if (org) {
      setUserId('');
      setPassword('');
      m.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org]);
  const canSubmit = !!selected && password.length >= MIN_PASSWORD && !m.isPending;
  return (
    <Modal
      open={!!org}
      onClose={onClose}
      title={`Update password — ${org?.code ?? ''}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={m.isPending} disabled={!canSubmit} onClick={() => m.mutate(undefined)}>
            Update password
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) m.mutate(undefined);
        }}
      >
        {admins.error && <ErrorBox error={admins.error} />}
        {admins.isLoading ? (
          <p>Loading administrators…</p>
        ) : !selected ? (
          <Alert tone="info">This organization has no administrator account. Create one on the Users page.</Alert>
        ) : (
          <>
            <Field label="Email">
              {items.length > 1 ? (
                <select value={selected.id} onChange={(e) => setUserId(e.target.value)}>
                  {items.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.email}
                      {u.status !== 'ACTIVE' ? ' (disabled)' : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <input type="email" value={selected.email} readOnly />
              )}
            </Field>
            <NewPasswordField
              label="New password"
              hint="Takes effect immediately and signs this administrator out everywhere."
              value={password}
              onChange={setPassword}
              autoFocus
            />
          </>
        )}
        <ErrorBox error={m.error} />
      </form>
    </Modal>
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
