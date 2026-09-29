# HTTP API

All JSON is `snake_case`, timestamps ISO-8601 UTC. Errors:
`{"error":{"code":"VALIDATION_ERROR","message":"...","details":[{"path":"...","message":"..."}]}}`.
Common codes: `VALIDATION_ERROR` 400, `UNAUTHORIZED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404,
`CONFLICT`/specific 409, `RATE_LIMITED` 429, `INTERNAL_ERROR` 500. Resources in another organization
return 404 to organization admins. List endpoints with paging accept `page` and `page_size` (≤200)
and return `{items, page, page_size, total}`.

`GET /api/health` → `200 {"status":"ok","time":"..."}` (no auth).

---

## Agent API (`/api/agent/*`)

Implemented exactly per `../../docs/api-contract.md` (§2–§7). Summary:

| Method & path | Auth | Success |
|---|---|---|
| `POST /api/agent/register` | `X-Registration-Token` | 201 new / 200 idempotent `{device_id,status}` |
| `GET /api/agent/registration-status` | `X-Device-UUID` + `X-Enrollment-Secret` | `{status}`; APPROVED adds `credential` once |
| `POST /api/agent/heartbeat` | `Bearer ndc_...` | `{server_time, heartbeat_interval_seconds, policy}` |
| `GET /api/agent/policy/version` | Bearer | `{policy_id, version, etag}` or `{null,0,null}` |
| `GET /api/agent/policy` | Bearer, optional `If-None-Match` | 200 Policy Document + `ETag` / 304 / 404 `NO_POLICY_ASSIGNED` |
| `POST /api/agent/policy/status` | Bearer | 204 |
| `POST /api/agent/policy/ack` | Bearer | 204 / 409 `POLICY_MISMATCH` |

Server-specific details (compatible with the contract):
* Missing/malformed `registration-status` headers → 400 `VALIDATION_ERROR`; unknown uuid / wrong or consumed secret → 401 `INVALID_ENROLLMENT`.
* After an admin **re-enroll**, `register` with the same `device_uuid` and a *new* `enrollment_secret_hash` returns **200** `{"status":"PENDING"}` (existing device). After a credential has been claimed, re-registering returns 409.
* Credential failure order: unparseable/unknown/wrong secret/expired → 401 `INVALID_CREDENTIAL`; revoked → 403 `CREDENTIAL_REVOKED`; device not APPROVED or org disabled → 403 `DEVICE_NOT_APPROVED`.
* `heartbeat.current_ip` may also be `null`. Unknown body keys are ignored and not stored.
* `policy/status` with a `policy_id` unknown in the device's org is recorded (unlinked) and returns 204. FAILED / VALIDATION_FAILED / ROLLED_BACK or any `error_code` writes a `POLICY_APPLICATION_FAILED` audit entry.
* `policy/ack` also checks `content_sha256`.
* The policy an agent receives is the **merged** per-computer document with `policy_id: "EFFECTIVE"`
  (see *Effective policy* below); its `version` is a per-computer counter that increases whenever the merged
  content hash changes.
* `register` links a `PRE_REGISTERED` computer of the same organization whose `mac_address` matches one of the
  reported interfaces; the computer then becomes `PENDING` and still needs approval.

---

## Auth

### `POST /api/auth/login`
```json
{ "email": "superadmin@example.com", "password": "..." }
```
200:
```json
{ "access_token": "eyJ...", "token_type": "Bearer", "expires_in": 86400,
  "user": { "id": "...", "email": "superadmin@example.com", "role": "SUPER_ADMIN", "organization_id": null, "status": "ACTIVE", ... } }
```
401 `INVALID_CREDENTIALS` (same for unknown user, bad password, disabled, locked). 429 when limited.
Re-login when the token expires (no refresh tokens).

### `POST /api/auth/login-link`
`{"token": "<value of ?org_admin=…>"}` → same 200 body as password login. The token is single use, expires
after `LOGIN_LINK_TTL_MINUTES` (default 15) and only its sha256 is stored. Invalid / expired / used → 401.
Rate limited per IP.

### `POST /api/auth/logout` → 204 (session revoked).
`GET /api/auth/me` → `{user, session_id, features: {organization_delete: boolean}}`.

---

## Organizations

| | |
|---|---|
| `GET /api/organizations` | super: all; org admin: own only |
| `POST /api/organizations` (super) | `{"code":"INST-001","name":"Organization A"}` → 201 |
| `GET /api/organizations/:id` | adds `stats {devices, pending_devices, policies}` |
| `PATCH /api/organizations/:id` (super) | `{"name"?, "status"?: "ACTIVE"\|"DISABLED"}` |
| `POST /api/organizations/:id/registration-token` | → `{"organization":{...},"registration_token":"nrt_..."}` raw token **once** |
| `DELETE /api/organizations/:id/registration-token` | fall back to global `AGENT_REGISTRATION_TOKEN` |
| `POST /api/organizations/:id/login-link` (super) | `{"user_id"?}` → `{url, expires_at, user:{id,email}}`; one-time sign-in link (`WEB_PUBLIC_URL/login?org_admin=…`) for the given or oldest active organization admin. 409 `ORGANIZATION_DISABLED`, 404 when there is no active admin |
| `DELETE /api/organizations/:id?confirm=<CODE>` (super) | development tool: deletes the organization and all its data (audit kept) → `{devices, policies, users}`. 403 `ORGANIZATION_DELETE_DISABLED` unless `ALLOW_ORGANIZATION_DELETE` (default: on outside production); 400 when `confirm` ≠ code |

Organization object: `{id, code, name, status, has_registration_token, created_at, updated_at}`.

## Users

| | |
|---|---|
| `GET /api/users?organization_id&role&status` | org admin: own org only (read-only) |
| `POST /api/users` (super) | `{"email","password"(≥12),"role","organization_id"(required for ORGANIZATION_ADMIN),"name"?}` → 201 |
| `GET /api/users/:id` | |
| `PATCH /api/users/:id` (super) | `{"name"?, "status"?, "password"?}`; disabling or password change revokes sessions |

## Devices ("computers")

`GET /api/devices?organization_id&status&group_id&q&page&page_size` — `status` ∈ `PRE_REGISTERED`,
`PENDING`, `APPROVED`, `REJECTED`, `REVOKED`; `q` searches title, serial, MAC, hostname, UUID and IP.

```json
{ "items": [{
  "id": "clx...", "display_name": "Lab 14", "title": "Lab 14", "serial_number": "SN-123", "mac_address": "AA:BB:CC:DD:EE:FF",
  "groups": [{ "id": "...", "name": "Lab computers" }],
  "organization": { "id": "...", "code": "INST-001", "name": "Organization A" },
  "hostname": "LAB-PC-014", "device_uuid": "3f0c7a52-...", "status": "APPROVED",
  "approval": { "approved_at": "...", "approved_by": { "id": "...", "email": "..." } },
  "last_heartbeat_at": "...", "online": true, "current_ip": "192.168.1.24", "last_request_ip": "10.0.0.5",
  "agent_version": "1.0.0", "windows_version": "...", "reported_status": "HEALTHY",
  "current_policy": { "id": null, "policy_id": null, "name": null, "version": 7 },
  "policy_status": { "policy_id": "EFFECTIVE", "version": 7, "status": "APPLIED", "error_code": null, "message": null, ... },
  "effective_policy_version": 7
}], "page": 1, "page_size": 50, "total": 1 }
```

`hostname`, `device_uuid` and the agent fields are `null` for `PRE_REGISTERED` computers. `title` equals
`display_name`.

`GET /api/devices/:id` adds `interfaces`, `credentials` (metadata only, never hashes) and
`effective_policy`:

```json
{ "policy_id": "EFFECTIVE", "version": 3, "content_sha256": "…", "etag": "\"EFFECTIVE:3:…\"", "updated_at": "…",
  "sources": [{ "policy_id": "clx…", "code": "RST-001", "kind": "BLACKLIST", "version": 2, "via": ["ORGANIZATION", "GROUP"] }],
  "content": { "enabled": true, "default_action": "allow", "allowed_domains": [], "blocked_domains": ["…"], ... } }
```
(`null` when no active restriction reaches the computer.)

| Action | Body | Rule |
|---|---|---|
| `POST /api/devices` | `{"mac_address","title","serial_number"?,"group_ids"?:[],"organization_id"?(super)}` | → 201 `PRE_REGISTERED`; MAC normalized to `AA:BB:CC:DD:EE:FF`; 409 `MAC_IN_USE`; groups must be in the org (400) |
| `PATCH /api/devices/:id` | `{"title"?,"serial_number"?,"mac_address"?,"group_ids"?,"display_name"?}` | `group_ids` replaces the memberships; a pre-registered computer keeps a MAC |
| `DELETE /api/devices/:id` | – | 204; credentials revoked, row (memberships, direct assignments) removed |
| `POST /api/devices/:id/approve` | – | PENDING only; creates unclaimed credential |
| `POST /api/devices/:id/reject` | – | PENDING only |
| `POST /api/devices/:id/revoke` | – | revokes all credentials immediately |
| `POST /api/devices/:id/re-enroll` | – | revoke credentials, → PENDING, clear enrollment secret |

State conflicts → 409 `INVALID_DEVICE_STATE`.

## Device groups

`GET/POST /api/device-groups` (`{"name","description"?,"organization_id"?(super)}`),
`GET/PATCH/DELETE /api/device-groups/:id`, `POST /api/device-groups/:id/members {"device_ids":[...]}`
(devices must be in the group's org, else 400), `DELETE /api/device-groups/:id/members/:deviceId`.

## Restrictions (policies)

A restriction is a policy with a `kind`; each kind may only use its own lists (others must be empty, else
400):

| `kind` | Console name | Fields |
|---|---|---|
| `ALLOW_ONLY` | Allow Only | `allowed_domains` |
| `BLACKLIST` (default) | Black List | `blocked_domains`, `blocked_ips` |
| `REDIRECT` | Redirection | `redirect_rules: [{"from": "<domain pattern>", "to": "<exact host>"}]` |

All kinds also carry `enabled`, `default_action` and the four booleans `block_quic`, `block_dot`,
`block_doh`, `enforce_browser_policies`.

| Method & path | Body / notes |
|---|---|
| `GET /api/policies?organization_id` | `{items:[{id, code, name, kind, is_active, active_version, ...}]}` |
| `POST /api/policies` | `{"name","kind"?,"code"?(auto POL-NNN),"description"?,"content"?,"publish"?:false,"organization_id"?(super)}` → 201 with v1 (DRAFT, or PUBLISHED + active when `publish:true`) + `warnings` |
| `PUT /api/policies/:id/content` | `{"content":{...}}` — save & publish in one step: new PUBLISHED version, activated, open draft discarded. Returns the policy + `warnings` + `unchanged` (true = content hash equals the active version; nothing created) |
| `GET /api/policies/:id` | policy + `versions` (no content) + `assignments` |
| `PATCH /api/policies/:id` | `{"name"?,"description"?}` (`kind` cannot change) |
| `POST /api/policies/:id/activate` \| `/deactivate` | inactive restrictions are skipped for all computers |
| `GET /api/policies/:id/versions` / `GET .../versions/:version` | version incl. `content`, `content_sha256`, `etag` |
| `POST /api/policies/:id/versions` | `{"from_version"?}` → new DRAFT = copy, version = max+1; 409 `DRAFT_EXISTS` |
| `PUT /api/policies/:id/versions/:version` | `{"content":{...}}`; DRAFT only, else 409 `POLICY_VERSION_IMMUTABLE`; returns `warnings` |
| `POST .../versions/:version/validate` | `{valid, errors, warnings, content, content_sha256}` |
| `POST .../versions/:version/publish` | DRAFT → PUBLISHED, sha256 computed, becomes active |
| `POST .../versions/:version/archive` | non-active version → ARCHIVED |
| `POST /api/policies/:id/rollback` | `{"version": 6}` earlier PUBLISHED version becomes active |
| `POST /api/policies/validate` | `{"content":{...},"names"?:["www.example.com"]}` → validation + `decisions` preview |
| `GET/POST /api/policies/:id/assignments` | `{"scope":"ORGANIZATION"\|"GROUP"\|"DEVICE","target_group_id"?,"target_device_id"?,"priority"?}`; 409 `ALREADY_ASSIGNED` |
| `DELETE /api/policies/:id/assignments/:assignmentId` | 204 |
| `GET /api/assignments?organization_id` | every assignment of the organization, each with `policy {id, code, name, kind, is_active}` and `target_name` (group name / computer title) |
| `POST /api/assignments/bulk` | `{"policy_id","organization"?:bool,"group_ids"?:[],"device_ids"?:[]}` → 201 `{created:[...]}`; idempotent (existing assignments are skipped); targets must be in the restriction's organization |

Content (all fields optional on input, stored with defaults, unknown keys rejected):
```json
{ "enabled": true, "default_action": "allow",
  "allowed_domains": ["company.com", "*.company.com"], "blocked_domains": ["example.com", "*.example.com"],
  "blocked_ips": ["203.0.113.0/24", "2001:db8::/32"],
  "block_quic": true, "block_dot": true, "block_doh": true, "enforce_browser_policies": true,
  "redirect_rules": [{ "from": "*.video.example", "to": "learn.example" }] }
```
`redirect_rules` is omitted from stored/hashed content when empty. Validation errors:
`{"error":{"code":"VALIDATION_ERROR","details":[{"path":"blocked_domains.1","message":"\"1.2.3.4\": IP literals are not allowed ..."}]}}`
(`redirect_rules.N.from` / `.to` for redirections). Warnings: duplicates, entries in both lists, conflicting
redirects, blocked redirect targets, patterns/default that would block a `MANAGEMENT_HOSTNAMES` host.
CIDRs with host bits set (e.g. `203.0.113.5/24`) are rejected.

### Effective policy (merged per computer)

Assignments are **not** a precedence contest: every active, published restriction reaching a computer
(organization-wide, via any of its groups, or directly) is merged (`src/domain/mergeRestrictions.ts`):

* any `ALLOW_ONLY` → `default_action: "block"` and the union of their `allowed_domains` (plus redirect targets);
* `BLACKLIST` → union of `blocked_domains` / `blocked_ips`;
* `REDIRECT` → union of `redirect_rules` (same `from`: the restriction with the lowest code wins);
* the four booleans are OR-ed; restrictions with `enabled: false` contribute nothing.

Lists are sorted and de-duplicated, so the hash only changes when the rules do. The result is served to the
agent as `policy_id: "EFFECTIVE"` and shown on `GET /api/devices/:id` as `effective_policy`.

## Analytics

`GET /api/analytics/overview?organization_id` (super: all or one organization; org admin: own) → aggregate
counts only:
`{generated_at, totals:{organizations, computers, online, approved, pending, pre_registered, restrictions, failing_computers},
organizations:[{organization, computers:{total, online, by_status}, restrictions:{total, active, by_kind}, assignments:{ORGANIZATION, GROUP, DEVICE}, failing_computers}],
groups:[{id, name, organization_id, members}], recent_failures:[{device_id, organization_id, title, status, error_code, updated_at}]}`.

## Audit logs

`GET /api/audit-logs?organization_id&action&actor_type&target_type&target_id&from&to&page&page_size`
→ `{items:[{id, organization_id, actor_type, actor_id, action, target_type, target_id, metadata, ip, created_at}], ...}`, newest first.
