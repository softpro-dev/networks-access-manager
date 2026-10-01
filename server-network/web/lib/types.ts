// Response shapes of the Fastify admin API (see ../../docs/api.md). snake_case, ISO-8601 timestamps.

export type Role = 'SUPER_ADMIN' | 'ORGANIZATION_ADMIN';
export type ActiveStatus = 'ACTIVE' | 'DISABLED';
export type DeviceStatus = 'PRE_REGISTERED' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'REVOKED';
export const DEVICE_STATUSES: DeviceStatus[] = ['PRE_REGISTERED', 'PENDING', 'APPROVED', 'REJECTED', 'REVOKED'];
export type RestrictionKind = 'ALLOW_ONLY' | 'BLACKLIST' | 'REDIRECT';
export type VersionStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export type AssignmentScope = 'ORGANIZATION' | 'GROUP' | 'DEVICE';

export interface Page<T> {
  items: T[];
  page: number;
  page_size: number;
  total: number;
}
export interface List<T> {
  items: T[];
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  organization_id: string | null;
  organization_code: string | null;
  status: ActiveStatus;
  last_login_at: string | null;
  locked_until: string | null;
  created_at: string;
}

export interface LoginResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  user: User;
}

export interface Features {
  organization_delete: boolean;
}
export interface MeResponse {
  user: User;
  session_id: string;
  features?: Features;
}

/** POST /organizations/:id/login-link (super admin). */
export interface LoginLink {
  url: string;
  expires_at: string;
  user: { id: string; email: string };
}

export interface Organization {
  id: string;
  code: string;
  name: string;
  status: ActiveStatus;
  phone: string | null;
  has_registration_token: boolean;
  has_access_token: boolean;
  created_at: string;
  updated_at: string;
  stats?: { devices: number; pending_devices: number; policies: number };
}

export interface DeviceInterface {
  name: string;
  mac?: string | null;
  ipv4?: string[];
  ipv6?: string[];
  type: string;
  is_primary?: boolean;
}

export interface PolicyStatus {
  policy_id: string | null;
  version: number | null;
  status: string;
  error_code: string | null;
  message: string | null;
  active_policy_id: string | null;
  active_version: number | null;
  updated_at: string | null;
}

export interface Device {
  id: string;
  display_name: string | null;
  /** Same value as display_name (the admin-given title). */
  title: string | null;
  serial_number: string | null;
  /** Normalized AA:BB:CC:DD:EE:FF. */
  mac_address: string | null;
  groups: { id: string; name: string }[];
  organization: { id: string; code: string; name: string };
  /** null for PRE_REGISTERED computers (no agent has registered yet). */
  hostname: string | null;
  device_uuid: string | null;
  status: DeviceStatus;
  approval: { approved_at: string | null; approved_by: { id: string; email: string } | null };
  last_heartbeat_at: string | null;
  online: boolean;
  current_ip: string | null;
  last_request_ip: string | null;
  agent_version: string | null;
  windows_version: string | null;
  reported_status: string | null;
  current_policy: { id: string | null; policy_id: string | null; name: string | null; version: number | null } | null;
  policy_status: PolicyStatus | null;
  /** Version of the merged EFFECTIVE policy the server serves (null = nothing assigned / not resolved yet). */
  effective_policy_version: number | null;
  created_at: string;
  updated_at: string;
}

export interface DeviceCredential {
  credential_id: string;
  created_at: string | null;
  claimed_at: string | null;
  issued_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface EffectiveSource {
  policy_id: string;
  code: string;
  kind: RestrictionKind;
  version: number;
  via: AssignmentScope[];
}

/** All restrictions reaching a computer merged into one document (wire policy_id "EFFECTIVE"). */
export interface EffectivePolicy {
  policy_id: string;
  version: number;
  content_sha256: string;
  etag: string;
  updated_at: string;
  sources: EffectiveSource[];
  content: PolicyContent;
}

export interface DeviceDetail extends Device {
  interfaces: DeviceInterface[] | null;
  credentials: DeviceCredential[];
  effective_policy: EffectivePolicy | null;
}

export interface DeviceGroup {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  member_count?: number;
  created_at: string;
  updated_at: string;
}
export interface DeviceGroupDetail extends DeviceGroup {
  members: { device_id: string; hostname: string | null; display_name: string | null; device_uuid: string | null }[];
}

export interface PolicyContent {
  enabled: boolean;
  default_action: 'allow' | 'block';
  allowed_domains: string[];
  blocked_domains: string[];
  blocked_ips: string[];
  block_quic: boolean;
  block_dot: boolean;
  block_doh: boolean;
  enforce_browser_policies: boolean;
  redirect_rules?: RedirectRule[];
}

export interface RedirectRule {
  from: string;
  to: string;
}

export interface Policy {
  id: string;
  organization_id: string;
  organization_code?: string;
  code: string;
  name: string;
  description: string | null;
  kind: RestrictionKind;
  is_active: boolean;
  active_version: number | null;
  created_at: string;
  updated_at: string;
}

export interface PolicyVersion {
  id: string;
  version: number;
  status: VersionStatus;
  is_active_version: boolean;
  content?: PolicyContent;
  content_sha256: string | null;
  etag: string | null;
  published_at: string | null;
  published_by_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Assignment {
  id: string;
  policy_id: string;
  organization_id: string;
  scope: AssignmentScope;
  target_group_id: string | null;
  target_device_id: string | null;
  priority: number;
  created_by_id: string | null;
  created_at: string;
}

export interface PolicyDetail extends Policy {
  versions: PolicyVersion[];
  assignments: Assignment[];
}

/** PUT /policies/:id/content and POST /policies responses. */
export interface SavedPolicy extends PolicyDetail {
  warnings: Issue[];
  unchanged?: boolean;
}

/** GET /assignments?organization_id — every assignment in the organization. */
export interface OrgAssignment extends Assignment {
  policy: { id: string; code: string; name: string; kind: RestrictionKind; is_active: boolean };
  target_name: string | null;
}

export interface AnalyticsOrgRow {
  organization: { id: string; code: string; name: string; status: ActiveStatus };
  computers: { total: number; online: number; by_status: Record<DeviceStatus, number> };
  restrictions: { total: number; active: number; by_kind: Record<RestrictionKind, number> };
  assignments: Record<AssignmentScope, number>;
  failing_computers: number;
}

export interface AnalyticsOverview {
  generated_at: string;
  totals: {
    organizations: number;
    computers: number;
    online: number;
    approved: number;
    pending: number;
    pre_registered: number;
    restrictions: number;
    failing_computers: number;
  };
  organizations: AnalyticsOrgRow[];
  groups: { id: string; name: string; organization_id: string; members: number }[];
  recent_failures: { device_id: string; organization_id: string; title: string | null; status: string; error_code: string | null; updated_at: string }[];
}

export interface Issue {
  path: string;
  message: string;
}
export interface ValidationResult {
  valid: boolean;
  errors: Issue[];
  warnings: Issue[];
  content: PolicyContent | null;
  content_sha256: string | null;
  decisions?: { name: string; action: string; reason: string; pattern?: string; list?: string }[];
}

export interface AuditEntry {
  id: string;
  organization_id: string | null;
  actor_type: 'USER' | 'DEVICE' | 'SYSTEM';
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  created_at: string;
}

export const AUDIT_ACTIONS = [
  'LOGIN_SUCCESS',
  'LOGIN_FAILURE',
  'LOGOUT',
  'LOGIN_LINK_CREATED',
  'LOGIN_LINK_USED',
  'ORGANIZATION_CREATED',
  'ORGANIZATION_UPDATED',
  'ORGANIZATION_DELETED',
  'REGISTRATION_TOKEN_SET',
  'REGISTRATION_TOKEN_CLEARED',
  'ADMIN_CREATED',
  'ADMIN_UPDATED',
  'DEVICE_REGISTERED',
  'DEVICE_APPROVED',
  'DEVICE_REJECTED',
  'DEVICE_REVOKED',
  'DEVICE_RE_ENROLL',
  'DEVICE_UPDATED',
  'DEVICE_CREATED',
  'DEVICE_DELETED',
  'CREDENTIAL_CLAIMED',
  'GROUP_CREATED',
  'GROUP_UPDATED',
  'GROUP_DELETED',
  'GROUP_MEMBERS_CHANGED',
  'POLICY_CREATED',
  'POLICY_UPDATED',
  'POLICY_DRAFT_CREATED',
  'POLICY_DRAFT_UPDATED',
  'POLICY_PUBLISHED',
  'POLICY_VERSION_ARCHIVED',
  'POLICY_ROLLED_BACK',
  'POLICY_ACTIVATED',
  'POLICY_DEACTIVATED',
  'POLICY_ASSIGNED',
  'POLICY_UNASSIGNED',
  'POLICY_APPLIED',
  'POLICY_APPLICATION_FAILED',
] as const;
