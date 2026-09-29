'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import { Alert, Button, ErrorBox, Field, Spinner } from '@/components/ui';

/** One-time sign-in link state (?org_admin=<token>, issued by a super admin). */
type LinkState = 'checking' | 'busy' | 'failed' | 'none';

export default function LoginPage() {
  const { session, login, loginWithLink, endReason } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [link, setLink] = useState<LinkState>('checking');

  // Take the token out of the address bar (history, screenshots) before anything else, then exchange it.
  // Reading it from window.location each time makes a second (StrictMode) run a no-op.
  useEffect(() => {
    const url = new URL(window.location.href);
    const token = url.searchParams.get('org_admin');
    if (!token) {
      setLink((l) => (l === 'checking' ? 'none' : l));
      return;
    }
    url.searchParams.delete('org_admin');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    setLink('busy');
    loginWithLink(token)
      .then(() => setLink('none'))
      .catch(() => setLink('failed'));
  }, [loginWithLink]);

  useEffect(() => {
    // While a sign-in link is being exchanged, an older session in this tab must not redirect first.
    if (session && link === 'none') {
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
  }, [session, router, link]);

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

  if (link === 'checking' || link === 'busy') {
    return (
      <main className="login-wrap">
        <div className="login-card">
          <Spinner label={link === 'busy' ? 'Signing in with your link…' : 'Loading…'} />
        </div>
      </main>
    );
  }

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
        {link === 'failed' && (
          <Alert tone="error" title="Sign-in link not accepted">
            The link is invalid, has expired or was already used (links are single use). Ask for a new link or sign in with your password.
          </Alert>
        )}
        {endReason === 'expired' && !error && link !== 'failed' && <Alert tone="warn">Your session expired. Please sign in again.</Alert>}
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
