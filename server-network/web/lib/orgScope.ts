'use client';
// The organization a SUPER_ADMIN is currently working in (shared by Dashboard, Computers,
// Restrictions and Set access; '' = all organizations). Per tab (sessionStorage), like the session.
// Organization admins are always scoped to their own organization; the API enforces it regardless.
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useAuth } from './auth';
import { useOrganizations } from './queries';

const KEY = 'nam.org';
let value: string | null = null;
const listeners = new Set<() => void>();

function read(): string {
  if (value === null) {
    try {
      value = window.sessionStorage.getItem(KEY) ?? '';
    } catch {
      value = '';
    }
  }
  return value;
}

export function setScopedOrg(id: string) {
  value = id;
  try {
    if (id) window.sessionStorage.setItem(KEY, id);
    else window.sessionStorage.removeItem(KEY);
  } catch {
    /* memory only */
  }
  for (const l of listeners) l();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * `orgId`: the organization to scope requests to ('' = all, super admin only).
 * `required`: the page needs exactly one organization (e.g. Set access); a super admin with a
 * single organization gets it selected automatically.
 */
export function useOrgScope({ required = false }: { required?: boolean } = {}) {
  const { user, isSuper } = useAuth();
  const orgs = useOrganizations();
  const stored = useSyncExternalStore(subscribe, read, () => '');
  const items = orgs.data?.items;
  // Forget a selection that no longer exists (deleted organization).
  const known = !stored || !items || items.some((o) => o.id === stored);
  useEffect(() => {
    if (isSuper && !known) setScopedOrg('');
  }, [isSuper, known]);
  useEffect(() => {
    if (isSuper && required && !stored && items?.length === 1) setScopedOrg(items[0]!.id);
  }, [isSuper, required, stored, items]);
  const setOrgId = useCallback((id: string) => setScopedOrg(id), []);
  const orgId = isSuper ? (known ? stored : '') : (user?.organization_id ?? '');
  const org = items?.find((o) => o.id === orgId) ?? null;
  return { orgId, org, setOrgId, isSuper, orgs: items ?? [] };
}
