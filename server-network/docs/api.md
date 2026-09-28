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

---

## Auth

### `POST /api/auth/login`
```json
{ "email": "superadmin@example.com", "password": "..." }
```
200:
```json
{ "access_token": "eyJ...", "token_type": "Bearer", "expires_in": 900,
  "user": { "id": "...", "email": "superadmin@example.com", "role": "SUPER_ADMIN", "organization_id": null, "status": "ACTIVE", ... } }
```
401 `INVALID_CREDENTIALS` (same for unknown user, bad password, disabled, locked). 429 when limited.
Re-login when the token expires (no refresh tokens).

### `POST /api/auth/logout` → 204 (session revoked). `GET /api/auth/me` → `{user, session_id}`.

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

Organization object: `{id, code, name, status, has_registration_token, created_at, updated_at}`.

## Users

| | |
|---|---|
| `GET /api/users?organization_id&role&status` | org admin: own org only (read-only) |
| `POST /api/users` (super) | `{"email","password"(≥12),"role","organization_id"(required for ORGANIZATION_ADMIN),"name"?}` → 201 |
| `GET /api/users/:id` | |
| `PATCH /api/users/:id` (super) | `{"name"?, "status"?, "password"?}`; disabling or password change revokes sessions |

## Devices

`GET /api/devices?organization_id&status&group_id&q&page&page_size`

```json
{ "items": [{
  "id": "clx...", "display_name": "Lab 14",
  "organization": { "id": "...", "code": "INST-001", "name": "Organization A" },
  "hostname": "LAB-PC-014", "device_uuid": "3f0c7a52-...", "status": "APPROVED",
  "approval": { "approved_at": "...", "approved_by": { "id": "...", "email": "..." } },
  "last_heartbeat_at": "...", "online": true, "current_ip": "192.168.1.24", "last_request_ip": "10.0.0.5",
  "agent_version": "1.0.0", "windows_version": "...", "reported_status": "HEALTHY",
  "current_policy": { "id": "...", "policy_id": "POL-001", "name": "Baseline", "version": 7 },
  "policy_status": { "policy_id": "POL-001", "version": 7, "status": "APPLIED", "error_code": null, "message": null, ... }
}], "page": 1, "page_size": 50, "total": 1 }
```

`GET /api/devices/:id` adds `interfaces`, `groups`, `credentials` (metadata only, never hashes) and
`effective_policy {policy_id, version, assignment_scope, etag}`.

| Action | Body | Rule |
|---|---|---|
| `PATCH /api/devices/:id` | `{"display_name": "..."\|null}` | |
| `POST /api/devices/:id/approve` | – | PENDING only; creates unclaimed credential |
| `POST /api/devices/:id/reject` | – | PENDING only |
| `POST /api/devices/:id/revoke` | – | revokes all credentials immediately |
| `POST /api/devices/:id/re-enroll` | – | revoke credentials, → PENDING, clear enrollment secret |

State conflicts → 409 `INVALID_DEVICE_STATE`.

## Device groups

`GET/POST /api/device-groups` (`{"name","description"?,"organization_id"?(super)}`),
`GET/PATCH/DELETE /api/device-groups/:id`, `POST /api/device-groups/:id/members {"device_ids":[...]}`
(devices must be in the group's org, else 400), `DELETE /api/device-groups/:id/members/:deviceId`.

## Policies

| Method & path | Body / notes |
|---|---|
| `GET /api/policies?organization_id` | `{items:[{id, code, name, is_active, active_version, ...}]}` |
| `POST /api/policies` | `{"name","code"?(auto POL-NNN),"description"?,"content"?,"organization_id"?(super)}` → 201 with draft v1 + `warnings` |
| `GET /api/policies/:id` | policy + `versions` (no content) + `assignments` |
| `PATCH /api/policies/:id` | `{"name"?,"description"?}` |
| `POST /api/policies/:id/activate` \| `/deactivate` | inactive policies are skipped for all devices |
| `GET /api/policies/:id/versions` / `GET .../versions/:version` | version incl. `content`, `content_sha256`, `etag` |
| `POST /api/policies/:id/versions` | `{"from_version"?}` → new DRAFT = copy, version = max+1; 409 `DRAFT_EXISTS` |
| `PUT /api/policies/:id/versions/:version` | `{"content":{...}}`; DRAFT only, else 409 `POLICY_VERSION_IMMUTABLE`; returns `warnings` |
| `POST .../versions/:version/validate` | `{valid, errors, warnings, content, content_sha256}` |
| `POST .../versions/:version/publish` | DRAFT → PUBLISHED, sha256 computed, becomes active |
| `POST .../versions/:version/archive` | non-active version → ARCHIVED |
| `POST /api/policies/:id/rollback` | `{"version": 6}` earlier PUBLISHED version becomes active |
| `POST /api/policies/validate` | `{"content":{...},"names"?:["www.example.com"]}` → validation + `decisions` preview |
| `GET/POST /api/policies/:id/assignments` | `{"scope":"ORGANIZATION"\|"GROUP"\|"DEVICE","target_group_id"?,"target_device_id"?,"priority"?}` |
| `DELETE /api/policies/:id/assignments/:assignmentId` | 204 |

Content (all fields optional on input, stored with defaults, unknown keys rejected):
```json
{ "enabled": true, "default_action": "allow",
  "allowed_domains": ["company.com", "*.company.com"], "blocked_domains": ["example.com", "*.example.com"],
  "blocked_ips": ["203.0.113.0/24", "2001:db8::/32"],
  "block_quic": true, "block_dot": true, "block_doh": true, "enforce_browser_policies": true }
```
Validation errors: `{"error":{"code":"VALIDATION_ERROR","details":[{"path":"blocked_domains.1","message":"\"1.2.3.4\": IP literals are not allowed ..."}]}}`.
Warnings: duplicates, entries in both lists, patterns/default that would block a `MANAGEMENT_HOSTNAMES` host.
CIDRs with host bits set (e.g. `203.0.113.5/24`) are rejected.

## Audit logs

`GET /api/audit-logs?organization_id&action&actor_type&target_type&target_id&from&to&page&page_size`
→ `{items:[{id, organization_id, actor_type, actor_id, action, target_type, target_id, metadata, ip, created_at}], ...}`, newest first.
