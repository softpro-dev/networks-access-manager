import { describe, expect, it } from 'vitest';
import { assertOrgAccess, canAccessOrg, createScope, listScope, requireSuperAdmin, type AdminPrincipal } from '../../src/domain/rbac.js';
import { AppError } from '../../src/utils/errors.js';

const superAdmin: AdminPrincipal = { userId: 'u1', email: 's@x', role: 'SUPER_ADMIN', organizationId: null, sessionId: 's1' };
const orgA: AdminPrincipal = { userId: 'u2', email: 'a@x', role: 'ORGANIZATION_ADMIN', organizationId: 'A', sessionId: 's2' };

const status = (fn: () => unknown) => {
  try {
    fn();
    return 0;
  } catch (e) {
    return (e as AppError).statusCode;
  }
};

describe('RBAC / tenant scoping', () => {
  it('super admin lists all or filters', () => {
    expect(listScope(superAdmin)).toBeUndefined();
    expect(listScope(superAdmin, 'B')).toBe('B');
  });
  it('org admin is always pinned to own org; other org → 404', () => {
    expect(listScope(orgA)).toBe('A');
    expect(listScope(orgA, 'A')).toBe('A');
    expect(status(() => listScope(orgA, 'B'))).toBe(404);
    expect(createScope(orgA)).toBe('A');
    expect(status(() => createScope(orgA, 'B'))).toBe(404);
  });
  it('super admin must name an org when creating', () => {
    expect(status(() => createScope(superAdmin))).toBe(400);
    expect(createScope(superAdmin, 'B')).toBe('B');
  });
  it('resource access', () => {
    expect(canAccessOrg(orgA, 'A')).toBe(true);
    expect(canAccessOrg(orgA, 'B')).toBe(false);
    expect(canAccessOrg(orgA, null)).toBe(false);
    expect(canAccessOrg(superAdmin, 'B')).toBe(true);
    expect(status(() => assertOrgAccess(orgA, { organizationId: 'B' }))).toBe(404);
    expect(status(() => assertOrgAccess(orgA, null))).toBe(404);
    expect(assertOrgAccess(orgA, { organizationId: 'A', x: 1 }).x).toBe(1);
  });
  it('super-admin-only operations', () => {
    expect(status(() => requireSuperAdmin(orgA))).toBe(403);
    expect(status(() => requireSuperAdmin(superAdmin))).toBe(0);
  });
  it('org admin without an org sees nothing', () => {
    expect(status(() => listScope({ ...orgA, organizationId: null }))).toBe(404);
  });
});
