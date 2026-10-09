'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import { Alert, Button, ErrorBox, Field, Spinner } from '@/components/ui';
import { BrandMark } from '@/components/BrandMark';

/** One-time sign-in link state (?org_admin=<token>, issued by a super admin). */
type LinkState = 'checking' | 'busy' | 'done' | 'failed' | 'none';

/** How long the "signed in" check stays visible before the console opens. */
const SUCCESS_PAUSE_MS = 900;

/**
 * Full-card screen for a sign-in link: no login form is shown while the link is used. Animated
 * "signing in" → "signed in" check → redirect; on failure a card offers password sign-in instead.
 */
function LinkSignInScreen({ state, onUsePassword }: { state: 'busy' | 'done' | 'failed'; onUsePassword: () => void }) {
  return (
    <main className="login-wrap">
      <div className="login-card link-signin" role="status" aria-live="polite">
        {state === 'busy' && (
          <>
            <div className="link-signin-mark" aria-hidden>
              <span className="link-signin-ring" />
              <span className="link-signin-ring link-signin-ring-2" />
              <BrandMark size={52} className="link-signin-logo" />
            </div>
            <h1 className="link-signin-title">Signing you in</h1>
            <p className="muted">
              Checking your sign-in link
              <span className="link-signin-dots" aria-hidden>
                <span>.</span>
                <span>.</span>
                <span>.</span>
              </span>
            </p>
          </>
        )}
        {state === 'done' && (
          <>
            <svg className="link-signin-check" viewBox="0 0 52 52" aria-hidden>
              <circle className="link-signin-check-circle" cx="26" cy="26" r="24" />
              <path className="link-signin-check-tick" d="M15 27 l7 7 l15 -15" />
            </svg>
            <h1 className="link-signin-title">Signed in</h1>
            <p className="muted">Opening your console…</p>
          </>
        )}
        {state === 'failed' && (
          <>
            <svg className="link-signin-fail" viewBox="0 0 52 52" aria-hidden>
              <circle cx="26" cy="26" r="24" />
              <path d="M18 18 L34 34 M34 18 L18 34" />
            </svg>
            <h1 className="link-signin-title">Sign-in link not accepted</h1>
            <p className="muted">The link is invalid, has expired or was already used (links work once). Ask your administrator for a new link.</p>
            <Button variant="primary" className="btn-block" onClick={onUsePassword}>
              Sign in with password
            </Button>
          </>
        )}
      </div>
    </main>
  );
}

export default function LoginPage() {
  const { session, login, loginWithLink, endReason } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [link, setLink] = useState<LinkState>('checking');
  /** After a failed link, the password form is shown only when asked for. */
  const [passwordAfterFailedLink, setPasswordAfterFailedLink] = useState(false);

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
      .then(() => setLink('done'))
      .catch(() => setLink('failed'));
  }, [loginWithLink]);

  useEffect(() => {
    // While a sign-in link is being exchanged, an older session in this tab must not redirect first.
    if (!session || (link !== 'none' && link !== 'done')) return;
    let next = '/';
    try {
      const n = new URLSearchParams(window.location.search).get('next');
      // Only same-origin, path-absolute targets (no "//evil" or scheme URLs).
      if (n && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\')) next = n;
    } catch {
      /* ignore */
    }
    // After a link sign-in, let the success check play briefly before the console opens.
    const t = window.setTimeout(() => router.replace(next), link === 'done' ? SUCCESS_PAUSE_MS : 0);
    return () => window.clearTimeout(t);
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

  if (link === 'checking') {
    return (
      <main className="login-wrap">
        <div className="login-card">
          <Spinner label="Loading…" />
        </div>
      </main>
    );
  }
  // A sign-in link never shows the login form (only on request after it failed).
  if (link === 'busy' || link === 'done' || (link === 'failed' && !passwordAfterFailedLink)) {
    return <LinkSignInScreen state={link} onUsePassword={() => setPasswordAfterFailedLink(true)} />;
  }

  return (
    <main className="login-wrap">
      <form className="login-card" onSubmit={onSubmit} noValidate>
        <div className="brand brand-lg">
          <BrandMark size={34} />
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
        <p className="muted small">Sessions last 1 day (password or login link); sign in again when prompted.</p>
      </form>
    </main>
  );
}
