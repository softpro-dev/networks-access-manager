import { describe, expect, it } from 'vitest';
import { resolveAssignment, type ResolvableAssignment } from '../../src/domain/assignment.js';

const device = { id: 'dev1', organizationId: 'orgA', groupIds: ['g1', 'g2'] };
let n = 0;
function a(partial: Partial<ResolvableAssignment> & { scope: ResolvableAssignment['scope'] }, policy: Partial<ResolvableAssignment['policy']> = {}): ResolvableAssignment {
  n += 1;
  return {
    id: `a${n}`,
    organizationId: 'orgA',
    targetGroupId: null,
    targetDeviceId: null,
    priority: 0,
    createdAt: new Date(2026, 0, 1, 0, 0, n),
    ...partial,
    policy: { id: `p${n}`, organizationId: 'orgA', isActive: true, activeVersionId: `v${n}`, ...policy },
  };
}

describe('assignment resolution', () => {
  it('DEVICE > GROUP > ORGANIZATION', () => {
    const org = a({ scope: 'ORGANIZATION', priority: 100 });
    const grp = a({ scope: 'GROUP', targetGroupId: 'g1', priority: 50 });
    const dev = a({ scope: 'DEVICE', targetDeviceId: 'dev1', priority: -5 });
    expect(resolveAssignment(device, [org, grp, dev])).toBe(dev);
    expect(resolveAssignment(device, [org, grp])).toBe(grp);
    expect(resolveAssignment(device, [org])).toBe(org);
  });
  it('higher priority wins within a scope, then most recent', () => {
    const low = a({ scope: 'GROUP', targetGroupId: 'g1', priority: 1 });
    const high = a({ scope: 'GROUP', targetGroupId: 'g2', priority: 5 });
    expect(resolveAssignment(device, [high, low])).toBe(high);
    const older = a({ scope: 'ORGANIZATION', createdAt: new Date('2026-01-01') });
    const newer = a({ scope: 'ORGANIZATION', createdAt: new Date('2026-02-01') });
    expect(resolveAssignment(device, [older, newer])).toBe(newer);
    expect(resolveAssignment(device, [newer, older])).toBe(newer);
  });
  it('skips inactive policies and policies without an active version', () => {
    const inactive = a({ scope: 'DEVICE', targetDeviceId: 'dev1' }, { isActive: false });
    const unpublished = a({ scope: 'GROUP', targetGroupId: 'g1' }, { activeVersionId: null });
    const org = a({ scope: 'ORGANIZATION' });
    expect(resolveAssignment(device, [inactive, unpublished, org])).toBe(org);
    expect(resolveAssignment(device, [inactive, unpublished])).toBeNull();
  });
  it('ignores other devices, other groups and other organizations', () => {
    const otherDevice = a({ scope: 'DEVICE', targetDeviceId: 'dev2' });
    const otherGroup = a({ scope: 'GROUP', targetGroupId: 'g9' });
    const otherOrg = a({ scope: 'ORGANIZATION', organizationId: 'orgB' }, { organizationId: 'orgB' });
    const crossOrgPolicy = a({ scope: 'DEVICE', targetDeviceId: 'dev1' }, { organizationId: 'orgB' });
    expect(resolveAssignment(device, [otherDevice, otherGroup, otherOrg, crossOrgPolicy])).toBeNull();
  });
});
