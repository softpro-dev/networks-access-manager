'use client';
// Thin fetch wrapper over the same-origin /api/* (proxied by Next to Fastify).
// The access token lives in memory and sessionStorage (per tab, cleared when the tab closes) — never localStorage.

import type { User } from './types';

export interface ErrorDetail {
  path: string;
  message: string;
}

/** Mirrors the API error envelope {error:{code,message,details}}. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: ErrorDetail[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface Session {
  token: string;
  expiresAt: number; // epoch ms
  user: User;
}

const STORAGE_KEY = 'nam.session';
let current: Session | null = null;
let loaded = false;
const listeners = new Set<(s: Session | null, reason?: 'expired' | 'logout') => void>();

function safeStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function getSession(): Session | null {
  if (!loaded) {
    loaded = true;
    try {
      const raw = safeStorage()?.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw) as Session;
        if (s && typeof s.token === 'string' && s.expiresAt > Date.now()) current = s;
        else safeStorage()?.removeItem(STORAGE_KEY);
      }
    } catch {
      current = null;
    }
  }
  return current;
}

export function setSession(s: Session | null, reason?: 'expired' | 'logout') {
  current = s;
  loaded = true;
  try {
    if (s) safeStorage()?.setItem(STORAGE_KEY, JSON.stringify(s));
    else safeStorage()?.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable: memory only */
  }
  for (const l of listeners) l(s, reason);
}

export function onSessionChange(fn: (s: Session | null, reason?: 'expired' | 'logout') => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

type Query = Record<string, string | number | boolean | null | undefined>;

export function qs(q: Query = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Query;
  /** false for /auth/login: a 401 there is a bad password, not an expired session. */
  auth?: boolean;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const session = getSession();
  if (opts.auth !== false && session) headers.authorization = `Bearer ${session.token}`;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}${qs(opts.query)}`, { method: opts.method ?? 'GET', headers, body, cache: 'no-store', credentials: 'omit' });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Is the API running?');
  }
  if (res.status === 204 || res.status === 304) return undefined as T;
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string; details?: ErrorDetail[] } } | null)?.error;
    const e = new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? (res.status >= 500 ? 'Server error (is the API running?)' : res.statusText || 'Request failed'), err?.details ?? []);
    // Only end the session that made this request (a late 401 for an old token must not log out a fresh login).
    if (res.status === 401 && opts.auth !== false && session && getSession()?.token === session.token) setSession(null, 'expired');
    throw e;
  }
  return json as T;
}

export const get = <T>(path: string, query?: Query) => api<T>(path, { query });
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body });
export const patch = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body });
export const put = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body });
export const del = <T = void>(path: string) => api<T>(path, { method: 'DELETE' });

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Unexpected error';
}
