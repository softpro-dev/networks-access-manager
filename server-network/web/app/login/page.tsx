'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import { Alert, Button, ErrorBox, Field } from '@/components/ui';

export default function LoginPage() {
  const { session, login, endReason } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (session) {
      let next = '/';
      try {
        const n = new URLSearchParams(window.location.search).get('next');
        // Only same-origin, path-absolute targets (no "//evil" or scheme URLs).
        if (n && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\')) next = n;
      } catch {
        /* ignore */
      }
      router.replace(next);
    }
  }, [session, router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err);
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  const rateLimited = error instanceof ApiError && error.code === 'RATE_LIMITED';

  return (
    <main className="login-wrap">
      <form className="login-card" onSubmit={onSubmit} noValidate>
        <div className="brand brand-lg">
          <span className="brand-mark" aria-hidden>
            N
          </span>
          <span>Network Access Manager</span>
        </div>
        <h1 className="login-title">Sign in to the admin console</h1>
        {endReason === 'expired' && !error && <Alert tone="warn">Your session expired. Please sign in again.</Alert>}
        {endReason === 'logout' && !error && <Alert tone="info">You have been signed out.</Alert>}
        {error ? (
          rateLimited ? (
            <Alert tone="error" title="Too many attempts">
              Wait a minute and try again.
            </Alert>
          ) : error instanceof ApiError && error.code === 'INVALID_CREDENTIALS' ? (
            <Alert tone="error">Invalid email or password.</Alert>
          ) : (
            <ErrorBox error={error} title="Sign-in failed" />
          )
        ) : null}
        <Field label="Email">
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field label="Password">
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" busy={busy} disabled={!email || !password} className="btn-block">
          Sign in
        </Button>
        <p className="muted small">Sessions last for the API&apos;s JWT lifetime (default 15 minutes); sign in again when prompted.</p>
      </form>
    </main>
  );
}
