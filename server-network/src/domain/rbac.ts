/**
 * Tenant-scoping rules. The organization scope is always derived from the authenticated principal;
 * request parameters can only narrow it (SUPER_ADMIN) and never widen it. Cross-org access is
 * reported as 404 to avoid resource enumeration.
 */
import { AppError, badRequest, notFound } from '../utils/errors.js';

export type Role = 'SUPER_ADMIN' | 'ORGANIZATION_ADMIN';

export interface AdminPrincipal {
  userId: string;
  email: string;
  role: Role;
  organizationId: string | null;
  sessionId: string;
}

export const isSuperAdmin = (p: AdminPrincipal) => p.role === 'SUPER_ADMIN';

export function requireSuperAdmin(p: AdminPrincipal): void {
  if (!isSuperAdmin(p)) throw new AppError(403, 'FORBIDDEN', 'Super administrator role required');
}

/** Org filter for list endpoints. `undefined` = all organizations (SUPER_ADMIN without filter). */
export function listScope(p: AdminPrincipal, requestedOrgId?: string | null): string | undefined {
  if (isSuperAdmin(p)) return requestedOrgId ?? undefined;
  if (!p.organizationId) throw notFound();
  if (requestedOrgId && requestedOrgId !== p.organizationId) throw notFound('Organization not found');
  return p.organizationId;
}

/** Org for creating a resource. SUPER_ADMIN must name one; ORGANIZATION_ADMIN always gets their own. */
export function createScope(p: AdminPrincipal, requestedOrgId?: string | null): string {
  if (isSuperAdmin(p)) {
    if (!requestedOrgId) throw badRequest('organization_id is required', [{ path: 'organization_id', message: 'Required' }]);
    return requestedOrgId;
  }
  return listScope(p, requestedOrgId)!;
}

export function canAccessOrg(p: AdminPrincipal, resourceOrgId: string | null | undefined): boolean {
  if (isSuperAdmin(p)) return true;
  return !!p.organizationId && resourceOrgId === p.organizationId;
}

/** Throws 404 when the resource is missing or belongs to another organization. */
export function assertOrgAccess<T extends { organizationId: string | null }>(p: AdminPrincipal, resource: T | null | undefined, what = 'Resource'): T {
  if (!resource || !canAccessOrg(p, resource.organizationId)) throw notFound(`${what} not found`);
  return resource;
}
