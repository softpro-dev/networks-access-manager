# Security

## Threat model (summary)

| Threat | Mitigation |
|---|---|
| Org admin reads/changes another org | Org scope derived from the session's user row in services; cross-org ids → **404** (no enumeration). Integration-tested. |
| Device fetches another org's policy | Org comes from the credential/device row; the agent cannot name an org. Documents carry `organization_id`/`device_uuid` for agent-side verification. |
| Stolen/forged device identity | `device_uuid` and MACs are identifiers only. Auth = `ndc_<id>.<32-byte secret>`; only `sha256(secret)` stored; constant-time compare. |
| Credential replay after revocation | Credential + device + org rows read on **every** agent request (no cache). |
| Rogue enrollment | Registration token (per-org hash or global env), 10/min/IP. Approval by an admin is always required. Unknown org → 401 (same as bad token). |
| Credential interception at claim | Claim requires the raw enrollment secret whose hash was sent at register; single-use (conditional update). TLS mandatory. |
| Admin password guessing | argon2id (m=19 MiB, t=2), 5/min per IP+email and 20/min per IP, lockout after `LOGIN_LOCKOUT_THRESHOLD` failures, generic error, dummy hash for unknown users. |
| Token theft (admin) | 15-min HS256 JWT bound to a `Session` row; logout, password change or disable revoke immediately. |
| Malformed/oversized input | Zod on every body/query/param/header; strict policy content (unknown keys rejected, list limits); body limit 1 MiB (8 MiB for policy content); prototype-poisoning rejected by Fastify. |
| Log/audit leakage | pino redaction of `authorization`, `x-registration-token`, `x-enrollment-secret`, `password`, `token`; request bodies are not logged; audit metadata passes a key scrubber. |

## Credentials and secrets

| Secret | Stored as |
|---|---|
| Admin password | argon2id hash |
| Admin access token | not stored (JWT); session row id in `sid` |
| Registration token (per org) | sha256 hex; raw shown once on creation |
| Enrollment secret | sha256 hex (sent by agent); nulled when claimed or on re-enroll |
| Device credential secret | sha256 hex; raw minted at claim and returned once |

sha256 (not a slow KDF) is appropriate for the random 256-bit tokens; passwords use argon2id.
Optional credential expiry: `DEVICE_CREDENTIAL_TTL_DAYS` (default 0 = `expires_at: null`).

## RBAC

| Capability | SUPER_ADMIN | ORGANIZATION_ADMIN |
|---|---|---|
| Organizations: create / update / disable | ✓ | – (read own) |
| Registration token rotate/clear | ✓ | own org |
| Users: create / update / disable | ✓ | – (read-only list of own org; super admins invisible) |
| Devices: list / view / rename / approve / reject / revoke / re-enroll | all orgs | own org |
| Device groups, policies, versions, assignments | all orgs | own org |
| Audit logs | all (incl. system rows) | own org |

## What is logged / audited

Audited: login success/failure (email + reason, never the password), logout, org created/updated,
registration token set/cleared, admin created/updated, device registered/approved/rejected/revoked/
re-enrolled/renamed, credential claimed (credential id only), group changes, policy created/updated/
draft created/edited/published/archived/rolled back/activated/deactivated/assigned/unassigned, policy
applied (ack) and policy application failures reported by agents.

Not collected: browsing history, page content, keystrokes, cookies, passwords. Heartbeats carry only
the five contract fields (extra keys are discarded).

## Residual risks

* Anyone holding a valid registration token can create PENDING devices (rate-limited, admin approval needed).
* The one-time credential response can be lost in transit; recovery is admin "re-enroll".
* In-memory rate limits are per process; use a shared store if running multiple instances.
