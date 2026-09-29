# API usage (client side)

The binding contract is `../../docs/api-contract.md`. This page lists how the agent
implements it. `API_BASE_URL` includes the `/api` prefix
(`https://management.example.com/api`); paths below are relative to it.

| Call | Auth | Agent behaviour |
|------|------|-----------------|
| `GET /health` | none | `configure` requires `200 {"status":"ok"}` before saving; also run after every apply as the management-connectivity check |
| `POST /agent/register` | `X-Registration-Token` | body: org, uuid, hostname, Windows version, agent version, `enrollment_secret_hash` (= sha256 hex of the UTF-8 base64url secret), ≤32 interfaces. Secret is persisted **before** the request so retries are idempotent. 401/400 → retry in 5 min; 409 → discard secret, retry in 5 min (succeeds after admin "re-enroll") |
| `GET /agent/registration-status` | `X-Device-UUID`, `X-Enrollment-Secret` | every `ENROLLMENT_POLL_INTERVAL` (45 s) while PENDING; REJECTED/REVOKED → every 5 min; APPROVED → store `credential.token` (DPAPI), delete enrollment secret and registration token; 401 → discard secret and register again |
| `POST /agent/heartbeat` | Bearer | exactly `device_uuid, agent_version, current_policy_version, current_ip, status`; honours `heartbeat_interval_seconds` (clamped 10–3600) |
| `GET /agent/policy/version` | Bearer | when `POLICY_CACHE_TTL` elapsed or heartbeat had no policy ref |
| `GET /agent/policy` | Bearer, `If-None-Match` = active ETag | 304 → keep; 404 `NO_POLICY_ASSIGNED` → keep cached; 200 → validate with the `ETag` header |
| `POST /agent/policy/status` | Bearer | `DOWNLOADED`, `APPLYING`, `VALIDATION_FAILED`, `FAILED`, `ROLLED_BACK` with `error_code`, `message` (≤1000, redacted), `active_policy_id/version` |
| `POST /agent/policy/ack` | Bearer | after promotion; `409 POLICY_MISMATCH` is dropped (next heartbeat resyncs) |

Error envelope `{"error":{"code","message"}}` is parsed into `ApiError`.
Transport errors, timeouts, redirects and 5xx become `ApiUnavailable`. `Retry-After`
on 429/5xx is honoured. Redirects are never followed.

## Validation (steps 1–8)

1. JSON (UTF-8, ≤4 MiB, duplicate keys / floats / NaN rejected)
2. Schema — `schema_version == 1`, unknown keys rejected in document and `content`,
   strict types
3. `organization_id` == configured `ORGANIZATION_ID`
4. `device_uuid` == this device
5. `content_sha256` == sha256 of canonical JSON of `content` as delivered
   (`json.dumps(c, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`);
   response `ETag` must equal `"<policy_id>:<version>:<sha[:8]>"`. Lower versions are accepted.
6. Every domain pattern (§5) and IP/CIDR entry
7. Management host known; warning if the policy would block it (the exception overrides)
8. Enforcement-configuration warnings (block-all, allow/block overlap)

## Merged per-computer policy

The server merges every restriction assigned to this computer (organization-wide, via its groups,
and directly) into one document with `policy_id: "EFFECTIVE"` and `assignment_scope: "MERGED"`
(contract §4.1). The agent treats it like any other policy: the version is a per-computer counter,
so "version changed → download → validate → apply → ack" is unchanged. Two additive fields are
accepted and validated strictly:

- `sources` — diagnostic list of contributing restrictions (`code`, `kind`, `version`, `via`).
- `content.redirect_rules` — `[{from, to}]`; `from` is a domain pattern, `to` an exact hostname.
  Decision order: most specific rule wins; ties resolve block > redirect > allow; redirect
  targets are always allowed. Omitted by the server when empty.
