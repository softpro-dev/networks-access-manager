/** Pure policy-assignment resolution: DEVICE > GROUP > ORGANIZATION, then priority, then recency. */
export type Scope = 'ORGANIZATION' | 'GROUP' | 'DEVICE';

export interface ResolvableAssignment {
  id: string;
  organizationId: string;
  scope: Scope;
  targetGroupId: string | null;
  targetDeviceId: string | null;
  priority: number;
  createdAt: Date;
  policy: {
    id: string;
    organizationId: string;
    isActive: boolean;
    activeVersionId: string | null;
  };
}

export interface ResolvableDevice {
  id: string;
  organizationId: string;
  groupIds: readonly string[];
}

const SCOPE_RANK: Record<Scope, number> = { DEVICE: 3, GROUP: 2, ORGANIZATION: 1 };

export function assignmentApplies(a: ResolvableAssignment, d: ResolvableDevice): boolean {
  if (a.organizationId !== d.organizationId || a.policy.organizationId !== d.organizationId) return false;
  if (!a.policy.isActive || !a.policy.activeVersionId) return false;
  switch (a.scope) {
    case 'ORGANIZATION':
      return true;
    case 'GROUP':
      return a.targetGroupId !== null && d.groupIds.includes(a.targetGroupId);
    case 'DEVICE':
      return a.targetDeviceId === d.id;
  }
}

export function compareAssignments(a: ResolvableAssignment, b: ResolvableAssignment): number {
  // negative => a wins
  if (SCOPE_RANK[a.scope] !== SCOPE_RANK[b.scope]) return SCOPE_RANK[b.scope] - SCOPE_RANK[a.scope];
  if (a.priority !== b.priority) return b.priority - a.priority;
  const t = b.createdAt.getTime() - a.createdAt.getTime();
  if (t !== 0) return t;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function resolveAssignment<T extends ResolvableAssignment>(device: ResolvableDevice, assignments: readonly T[]): T | null {
  const applicable = assignments.filter((a) => assignmentApplies(a, device));
  if (applicable.length === 0) return null;
  return [...applicable].sort(compareAssignments)[0]!;
}
