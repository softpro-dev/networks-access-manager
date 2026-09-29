'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, getSession, onSessionChange, setSession, type Session } from './api';
import type { Features, LoginResponse, MeResponse, User } from './types';

interface AuthState {
  /** undefined while the stored session is being restored on first render. */
  session: Session | null | undefined;
  user: User | null;
  isSuper: boolean;
  /** Why the last session ended (shown on the login page). */
  endReason: 'expired' | 'logout' | null;
  /** Server feature switches from /auth/me (null until loaded). */
  features: Features | null;
  login: (email: string, password: string) => Promise<void>;
  /** Exchange a one-time sign-in link token (?org_admin=…) for a session. */
  loginWithLink: (token: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [session, setState] = useState<Session | null | undefined>(undefined);
  const [endReason, setEndReason] = useState<'expired' | 'logout' | null>(null);
  const [features, setFeatures] = useState<Features | null>(null);

  useEffect(() => {
    setState(getSession());
    return onSessionChange((s, reason) => {
      setState(s);
      if (!s) {
        setEndReason(reason ?? null);
        setFeatures(null);
        qc.clear();
      }
    });
  }, [qc]);

  // Expire proactively when the JWT lifetime elapses (the API would answer 401 anyway).
  useEffect(() => {
    if (!session) return;
    const ms = session.expiresAt - Date.now();
    const t = setTimeout(() => setSession(null, 'expired'), Math.max(0, ms));
    return () => clearTimeout(t);
  }, [session]);

  // Re-validate a restored session (user may have been disabled / logged out elsewhere) and refresh the user row.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    api<MeResponse>('/auth/me')
      .then((r) => {
        if (!cancelled) setFeatures(r.features ?? { organization_delete: false });
        if (!cancelled && r.user && JSON.stringify(r.user) !== JSON.stringify(session.user)) setSession({ ...session, user: r.user });
      })
      .catch(() => {
        /* 401 handled centrally */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token]);

  const start = useCallback(
    (r: LoginResponse) => {
      setEndReason(null);
      qc.clear();
      // Small safety margin so the UI never sends an about-to-expire token.
      setSession({ token: r.access_token, expiresAt: Date.now() + (r.expires_in - 5) * 1000, user: r.user });
    },
    [qc],
  );

  const login = useCallback(
    async (email: string, password: string) => start(await api<LoginResponse>('/auth/login', { method: 'POST', body: { email, password }, auth: false })),
    [start],
  );

  // Same session handling as a password login; the link replaces any session in this tab.
  const loginWithLink = useCallback(async (token: string) => start(await api<LoginResponse>('/auth/login-link', { method: 'POST', body: { token }, auth: false })), [start]);

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      /* already invalid: still clear locally */
    }
    setSession(null, 'logout');
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      session,
      user: session?.user ?? null,
      isSuper: session?.user.role === 'SUPER_ADMIN',
      endReason,
      features,
      login,
      loginWithLink,
      logout,
    }),
    [session, endReason, features, login, loginWithLink, logout],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
