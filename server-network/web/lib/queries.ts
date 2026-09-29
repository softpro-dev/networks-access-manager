'use client';
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { get } from './api';
import { useAuth } from './auth';
import { useToast } from '@/components/toast';
import type { List, OrgAssignment, Organization, Policy } from './types';

/** Organizations visible to the caller (org admins: only their own). */
export function useOrganizations() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['organizations'],
    queryFn: () => get<List<Organization>>('/organizations'),
    enabled: !!session,
    staleTime: 30_000,
  });
}

export function useOrgMap() {
  const q = useOrganizations();
  const map = new Map((q.data?.items ?? []).map((o) => [o.id, o]));
  return map;
}

/**
 * Mutation with success toast + query invalidation. Errors stay on the mutation (`.error`) so the
 * dialog/page can render the API envelope; a toast is shown too when `toastErrors` is set.
 */
export function useAction<TVars, TRes>(
  fn: (v: TVars) => Promise<TRes>,
  opts: { success?: string | ((r: TRes, v: TVars) => string); invalidate?: QueryKey[]; onSuccess?: (r: TRes, v: TVars) => void; toastErrors?: boolean } = {},
) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (r, v) => {
      await Promise.all((opts.invalidate ?? []).map((k) => qc.invalidateQueries({ queryKey: k })));
      if (opts.success) toast(typeof opts.success === 'function' ? opts.success(r, v) : opts.success, 'success');
      opts.onSuccess?.(r, v);
    },
    onError: (e) => {
      if (opts.toastErrors) toast(e instanceof Error ? e.message : 'Action failed', 'error');
    },
  });
}

/** Restrictions (policies) of one organization ('' = all, super admin). */
export function useRestrictions(orgId: string) {
  return useQuery({
    queryKey: ['policies', { org: orgId }],
    queryFn: () => get<List<Policy>>('/policies', { organization_id: orgId || undefined }),
  });
}

/** Every restriction assignment of one organization ('' = all, super admin). */
export function useOrgAssignments(orgId: string, enabled = true) {
  return useQuery({
    queryKey: ['assignments', { org: orgId }],
    queryFn: () => get<List<OrgAssignment>>('/assignments', { organization_id: orgId || undefined }),
    enabled,
  });
}
