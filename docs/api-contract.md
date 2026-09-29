# Agent ⇄ Server Wire Contract

This is the single source of truth for everything that crosses the wire between
`server-network` (policy authority) and `os-apps` (Windows agent). The two
applications share **no code**; each implements this contract independently.

All JSON uses `snake_case`. All timestamps are ISO-8601 UTC strings.
All agent endpoints live under `/api/agent/*`. TLS is mandatory in production.

---

## 1. Identities and secrets

| Item | Who creates it | Secret? | Notes |
|------|----------------|---------|-------|
| `organization_id` | Admin (e.g. `INST-001`) | No | Public organization code. Pattern `^[A-Z0-9][A-Z0-9-]{1,31}$`. |
| `device_uuid` | Agent, once, at first install (UUIDv4 from CSPRNG) | **No** | Identifier only. Never authenticates anything. |
| Registration token | Admin / installer | Yes | Proves "this machine is being enrolled by someone the org trusts". Sent only to `/register`. Either the global `AGENT_REGISTRATION_TOKEN` or a per-organization token (per-org wins if set). |
| Enrollment secret | Agent, at first registration (32 random bytes, base64url) | Yes | Agent sends only `sha256(secret)` hex at register time. Proves the poller is the same agent that registered. |
| Device credential (token) | Server, on approval, delivered once | Yes | Format `ndc_<credential_id>.<secret>`; secret = 32 random bytes base64url. Server stores only `sha256(secret)`. Bound to one device and one organization. |

MAC addresses and `device_uuid` are **never** used as secrets.

---

## 2. Enrollment flow

```
Agent                                              Server
  | POST /api/agent/register                          |
  |   X-Registration-Token: <token>                   |
  |   body: device facts + enrollment_secret_hash     |
  |-------------------------------------------------->|  Device(status=PENDING)
  |<-------------------- 201 {status: "PENDING"} -----|
  |                                                   |
  | (loop, every ~30-60 s, with backoff)              |
  | GET /api/agent/registration-status                |
  |   X-Device-UUID: <uuid>                           |
  |   X-Enrollment-Secret: <raw enrollment secret>    |
  |-------------------------------------------------->|
  |<----------- 200 {status: "PENDING"} --------------|
  |                                                   |  admin approves
  |<----- 200 {status:"APPROVED", credential:{...}} --|  credential issued ONCE
  |                                                   |  (enrollment secret consumed)
  | all further calls: Authorization: Bearer ndc_...  |
```

### `POST /api/agent/register`

Headers: `X-Registration-Token: <token>`

```json
{
  "organization_id": "INST-001",
  "device_uuid": "3f0c7a52-9a6e-4f5b-8a2c-2d9e1f4b7c10",
  "hostname": "LAB-PC-014",
  "windows_version": "Windows 11 Pro 23H2 (10.0.22631)",
  "agent_version": "1.0.0",
  "enrollment_secret_hash": "<64 lowercase hex chars = sha256(enrollment_secret)>",
  "interfaces": [
    {
      "name": "Ethernet",
      "mac": "00:1A:2B:3C:4D:5E",
      "ipv4": ["192.168.1.24"],
      "ipv6": ["fe80::1c2d:3e4f:5a6b:7c8d"],
      "type": "ethernet",
      "is_primary": true
    }
  ]
}
```

`type` ∈ `ethernet | wifi | virtual | vpn | loopback | other`. At most 32 interfaces,
each at most 16 IPv4 + 16 IPv6 addresses.

Responses:

| Code | Body | Meaning |
|------|------|---------|
| 201 | `{"device_id": "...", "status": "PENDING"}` | New device created. |
| 200 | `{"device_id": "...", "status": "<current status>"}` | Same `device_uuid` re-registered **with the same `enrollment_secret_hash`** (idempotent retry; device facts refreshed). |
| 400 | error | Validation failure. |
| 401 | error | Missing/invalid registration token for that organization. |
| 404 | error | Unknown or inactive organization (returned as 401 to avoid org enumeration — see §6). |
| 409 | error `DEVICE_ALREADY_REGISTERED` | `device_uuid` exists with a different enrollment secret hash, or in another organization. |

### `GET /api/agent/registration-status`

Headers: `X-Device-UUID`, `X-Enrollment-Secret` (raw). Server verifies
`sha256(X-Enrollment-Secret) == stored hash` (constant-time).

```json
{ "status": "PENDING" }
{ "status": "REJECTED" }
{ "status": "REVOKED" }
{
  "status": "APPROVED",
  "credential": {
    "token": "ndc_clx2k9...abc.Qm9ndXMtZXhhbXBsZS1zZWNyZXQ",
    "credential_id": "clx2k9...abc",
    "issued_at": "2026-09-28T10:00:00.000Z",
    "expires_at": null
  }
}
```

The credential is returned **exactly once**. After it has been claimed the
enrollment secret is consumed; subsequent calls with it return 401. If the agent
loses its credential, an administrator uses "re-enroll" on the device which
resets it to `PENDING` and the agent registers again with a new enrollment
secret.

Unknown uuid or wrong secret → `401 INVALID_ENROLLMENT`.

---

## 3. Authenticated agent endpoints

Header on every call: `Authorization: Bearer ndc_<credential_id>.<secret>`.

Server authentication steps (all must pass, otherwise `401 INVALID_CREDENTIAL`
or `403 DEVICE_NOT_APPROVED` / `403 CREDENTIAL_REVOKED`):

1. Parse token → look up `DeviceCredential` by `credential_id`.
2. Constant-time compare `sha256(secret)` with stored hash.
3. Credential not revoked and not expired.
4. Device status is `APPROVED` and organization is active.
5. The **device's organization comes from the credential row**, never from
   request input. Any `device_uuid` in a body must equal the authenticated
   device's uuid, else `403 DEVICE_MISMATCH`.

Revocation is immediate: credential rows are checked on every request (no cache).

### `POST /api/agent/heartbeat`

Default interval 60 s. Body contains **only**:

```json
{
  "device_uuid": "3f0c7a52-...",
  "agent_version": "1.0.0",
  "current_policy_version": 7,
  "current_ip": "192.168.1.24",
  "status": "HEALTHY"
}
```

`status` ∈ `HEALTHY | DEGRADED | ENFORCEMENT_ERROR | STARTING`.
`current_policy_version` is `0` when no policy is active.

Response `200`:

```json
{
  "server_time": "2026-09-28T10:00:00.000Z",
  "heartbeat_interval_seconds": 60,
  "policy": { "policy_id": "POL-001", "version": 7, "etag": "\"POL-001:7:0587ffd8\"" }
}
```

`policy` is `null` when no policy is assigned.

### `GET /api/agent/policy/version`

```json
{ "policy_id": "POL-001", "version": 7, "etag": "\"POL-001:7:0587ffd8\"" }
```
or `{ "policy_id": null, "version": 0, "etag": null }` when nothing is assigned.

Agent rule: if `(policy_id, version)` equals the locally active pair → do nothing.
Otherwise download. A **lower** version than the local one is legitimate
(server-side rollback) and must be accepted.

### `GET /api/agent/policy`

Optional header `If-None-Match: <etag>`.

* `304 Not Modified` (empty body) if the etag matches.
* `404 NO_POLICY_ASSIGNED` if nothing applies.
* `200` with header `ETag: "POL-001:7:0587ffd8"` and body = **Policy Document** (§4).

ETag format: `"<policy_id>:<version>:<first 8 hex of content_sha256>"` (quotes included).

### `POST /api/agent/policy/status`

Reports progress or failure of applying a version.

```json
{
  "policy_id": "POL-001",
  "version": 7,
  "status": "FAILED",
  "error_code": "policy_apply_failed",
  "message": "WFP filter add failed: 0x80320009",
  "active_policy_id": "POL-001",
  "active_version": 6
}
```

`status` ∈ `DOWNLOADED | VALIDATION_FAILED | APPLYING | APPLIED | FAILED | ROLLED_BACK`.
`error_code` (optional) ∈ `policy_validation_failed | policy_apply_failed |
enforcement_verify_failed | management_unreachable | rollback_failed`.
`message` max 1000 chars; must never contain credentials or user activity.
Response `204`.

### `POST /api/agent/policy/ack`

Confirms that a version is now active and enforced.

```json
{ "policy_id": "POL-001", "version": 7, "content_sha256": "<hex>" }
```
Response `204`. Server sets `DevicePolicyStatus.status = APPLIED`, records
`device.current_policy_version`. `409 POLICY_MISMATCH` if that `(policy_id,
version)` is not the one currently assigned to the device.

---

## 4. Policy Document (what `GET /api/agent/policy` returns)

```json
{
  "schema_version": 1,
  "policy_id": "POL-001",
  "version": 7,
  "organization_id": "INST-001",
  "device_uuid": "3f0c7a52-9a6e-4f5b-8a2c-2d9e1f4b7c10",
  "assignment_scope": "ORGANIZATION",
  "published_at": "2026-09-28T09:00:00.000Z",
  "content_sha256": "0587ffd890ccf836680f39fafb4740e3bf94185e7b8d8f26c6502560e14775cf",
  "content": {
    "enabled": true,
    "default_action": "allow",
    "allowed_domains": ["company.com", "*.company.com"],
    "blocked_domains": ["example.com", "*.example.com"],
    "blocked_ips": ["203.0.113.0/24", "2001:db8::/32"],
    "block_quic": true,
    "block_dot": true,
    "block_doh": true,
    "enforce_browser_policies": true
  }
}
```

* `assignment_scope` ∈ `DEVICE | GROUP | ORGANIZATION | MERGED`. The server now always sends the
  merged per-computer policy (§4.1) with `policy_id: "EFFECTIVE"` and `assignment_scope: "MERGED"`;
  the example above keeps its original values because it is the shared hash test vector.
* `sources` (optional, diagnostics only): `[{ "code", "kind", "version", "via": [...] }]` — the
  restrictions that were merged. `kind` ∈ `ALLOW_ONLY | BLACKLIST | REDIRECT`, `via` ⊆
  `DEVICE | GROUP | ORGANIZATION`. Unknown keys rejected. Never contains user activity.
* `content_sha256` = SHA-256 hex of the **canonical JSON** of `content`:
  keys sorted lexicographically at every level, no insignificant whitespace,
  UTF-8, arrays kept in stored order. (Python: `json.dumps(c, sort_keys=True,
  separators=(",", ":"), ensure_ascii=False)`.) The agent recomputes and rejects
  on mismatch.
* `organization_id` / `device_uuid` let the agent verify the document was issued
  for *this* device in *this* organization (validation steps 3 and 4).

### `content` field rules

| Field | Type | Default | Rules |
|-------|------|---------|-------|
| `enabled` | bool | `true` | `false` = policy intentionally disabled by admin → agent removes its enforcement. (Never inferred from server being offline.) |
| `default_action` | `"allow" \| "block"` | `"allow"` | Result for names matching no rule. `"block"` = allowlist mode. |
| `allowed_domains` | string[] | `[]` | ≤ 5000 entries, domain-pattern syntax (§5). |
| `blocked_domains` | string[] | `[]` | ≤ 5000 entries, domain-pattern syntax (§5). |
| `blocked_ips` | string[] | `[]` | ≤ 1000 entries, IPv4/IPv6 address or CIDR. This is the **only** place IP literals are allowed. |
| `block_quic` | bool | `true` | Block outbound UDP/443 (QUIC / HTTP/3). Browsers fall back to TCP. |
| `block_dot` | bool | `true` | Block outbound TCP+UDP/853 (DNS-over-TLS / DNS-over-QUIC). |
| `block_doh` | bool | `true` | Sinkhole well-known DoH hostnames, block well-known DoH resolver IPs on 443, disable browser DoH via enterprise policy. |
| `enforce_browser_policies` | bool | `true` | Write HKLM browser enterprise policies (DoH off, QUIC off). |
| `redirect_rules` | `{from, to}[]` | absent | ≤ 1000 entries. `from` = domain pattern (§5), `to` = exact hostname (no wildcard, ≠ `from`). **Omitted by the server when empty**, so contents without redirects hash exactly as before; if present it is hashed as delivered. |

Unknown keys → validation error on both sides.

### 4.1 Merged per-computer policy (`policy_id: "EFFECTIVE"`)

Admins create **restrictions** of one of three kinds and assign any number of them to the whole
organization, to groups, and to individual computers. The server merges *every* active restriction
that reaches a computer into one document:

| Restriction kind | Contributes |
|------------------|-------------|
| `ALLOW_ONLY` | `allowed_domains`; **any** Allow Only makes `default_action: "block"` (allowlist mode) |
| `BLACKLIST` | `blocked_domains`, `blocked_ips` |
| `REDIRECT` | `redirect_rules`; same `from` in two restrictions → lowest restriction code wins. In allowlist mode every `to` is also added to `allowed_domains`. |

Protocol flags are OR-ed across the merged restrictions. Lists are de-duplicated and sorted so the
hash is stable. `version` is a per-computer counter that increases whenever the merged content hash
changes (it never repeats for different content, including after a restriction rollback), so the
agent's existing "version changed → download" rule keeps working. `status`/`ack` bodies use
`policy_id: "EFFECTIVE"`.

**Redirection limitation:** a name-level redirect cannot change what an HTTPS site presents; a
browser that reaches the redirect target under the original name will show a certificate error.
TLS interception is out of scope by design, so redirects are reliable only for plain HTTP or where a
browser-level mechanism is used. The agent treats the rules as data; enforcement is a separate
component.

### 4.2 Organization service policy (`GET /api/agent/org-policy`)

For unattended deployment, an organization can mint a **service access token** (admin console →
organization → *Generate access token*; format `nat_<43 chars>`, non-expiring, revoked only by
rotating or clearing it). A service authenticates with it and receives the merged **organization-wide**
policy (all `ORGANIZATION`-scoped restrictions merged as in §4.1); group/device targeting does not
apply in this mode.

Request: `GET /api/agent/org-policy` with `Authorization: Bearer <access token>` and optional
`If-None-Match`. Responses: `200` (body below, with `ETag`), `304 Not Modified`,
`404 NO_POLICY_ASSIGNED`, `401 INVALID_ACCESS_TOKEN` (missing/invalid/rotated/cleared token, or
disabled organization).

```json
{
  "schema_version": 1,
  "policy_id": "EFFECTIVE",
  "version": 4,
  "organization_id": "INST-001",
  "assignment_scope": "ORGANIZATION",
  "published_at": "2026-09-29T12:00:00.000Z",
  "content_sha256": "...",
  "sources": [{ "code": "RST-001", "kind": "BLACKLIST", "version": 1, "via": ["ORGANIZATION"] }],
  "content": { "...": "as in §4" }
}
```

The document has **no `device_uuid`** (there is no device identity). The service validates
organization, `content_sha256` and domain/redirect syntax, and enforces the management-server
exception. `version` is a per-organization counter that rises only when the merged content changes.
The management server (`ADMIN_SERVER`) is always allowed by the enforcement exception.

---

## 5. Domain pattern semantics (both sides MUST implement identically)

**Normalization** (applied to patterns at validation time and to queried names at match time):

1. Trim surrounding whitespace.
2. Lowercase.
3. Remove **one** trailing dot (`example.com.` → `example.com`).
4. Convert Unicode labels to punycode A-labels (IDNA; `bücher.de` → `xn--bcher-kva.de`).
   Patterns are stored and delivered already in A-label form.

**Syntax** (after normalization):

* Total length ≤ 253; each label 1–63 chars of `[a-z0-9-]`, not starting or ending with `-`.
* At least two labels (`com` alone is rejected; `localhost` rejected).
* The only wildcard form is a leading `*.` (`*.example.com`). `*` anywhere else,
  `*example.com`, `ex*.com`, or bare `*` → invalid.
* IPv4/IPv6 literals are **invalid** in domain lists (use `blocked_ips`).
* No scheme, port, path, or `@` (`https://x.com/`, `x.com:443` → invalid).

**Matching:**

* `example.com` matches **only** `example.com`.
* `*.example.com` matches any name with one or more extra labels
  (`a.example.com`, `a.b.example.com`) but **not** `example.com` itself.
  To cover both, list both (as in the examples).
* Matching is on whole labels: `*.example.com` does not match `badexample.com`.

**Decision for a queried name:**

1. If the name is a **loopback** address — `localhost` (or any `*.localhost`), an IPv4 `127.0.0.0/8` literal, or IPv6 `::1` → **ALLOW** (always; cannot be overridden).
2. If the name is the management server host (or a subdomain of it) → **ALLOW** (always; cannot be overridden).
3. If the name is exactly a redirect target (`to`) → **ALLOW**.
4. Collect every matching allowed, blocked and redirect (`from`) pattern.
5. The **most specific** match wins. Specificity key = `(label_count, is_exact)`
   compared descending, where `label_count` counts the `*` as a label
   (`*.example.com` = 3, `a.example.com` = 3, `example.com` = 2) and
   `is_exact` is 1 for non-wildcard patterns. Examples for name `a.example.com`:
   exact `a.example.com` (3,1) beats `*.example.com` (3,0). For name
   `x.b.example.com`: `*.b.example.com` (4,0) beats `*.example.com` (3,0).
6. Tie between rules of equal specificity: **BLOCK > REDIRECT > ALLOW**.
7. No match → `default_action`.

A policy that would block the management host is still valid, but the
management exception overrides it; the server's validator emits a warning.

---

## 6. Errors

```json
{ "error": { "code": "INVALID_CREDENTIAL", "message": "Human readable text" } }
```

Codes used by agent endpoints: `VALIDATION_ERROR` (400), `INVALID_REGISTRATION_TOKEN` (401),
`INVALID_ENROLLMENT` (401), `INVALID_CREDENTIAL` (401), `CREDENTIAL_REVOKED` (403),
`DEVICE_NOT_APPROVED` (403), `DEVICE_MISMATCH` (403), `DEVICE_ALREADY_REGISTERED` (409),
`POLICY_MISMATCH` (409), `NO_POLICY_ASSIGNED` (404), `RATE_LIMITED` (429), `INTERNAL_ERROR` (500).

An unknown organization at registration returns `401 INVALID_REGISTRATION_TOKEN`
(not 404) so tokens cannot be used to enumerate organizations.

Agent retry policy: 5xx / network errors → exponential backoff with jitter (5 s → 5 min cap).
401/403 on authenticated calls → stop using the credential, keep enforcing the
cached policy, surface `DEGRADED`, and retry authentication slowly (every 5 min).
A `403 CREDENTIAL_REVOKED` does **not** remove local enforcement.

---

## 7. Rate limits (server)

| Endpoint | Limit |
|----------|-------|
| `POST /api/auth/login` | 5 / min per IP+username, 20 / min per IP |
| `POST /api/agent/register` | 10 / min per IP |
| `GET /api/agent/registration-status` | 30 / min per IP |
| Authenticated agent endpoints | 120 / min per credential |
| `GET /api/agent/org-policy` | 120 / min per access token |

---

## 8. Health

`GET /api/health` (no auth) → `200 {"status":"ok","time":"..."}`. Used by the
agent's configuration utility and by management-connectivity verification.
