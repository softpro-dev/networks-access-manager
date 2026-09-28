# Architecture

```
 Admin (browser/CLI) ──HTTPS──▶ ┌──────────── server-network ────────────┐ ◀──HTTPS── Windows agents
   JWT (15 min) + Session row   │ Fastify                                │   ndc_ device credential
                                │  ├─ /api/auth, /api/organizations, ... │
                                │  ├─ /api/agent/*  (wire contract)      │
                                │  └─ error handler → {"error":{...}}    │
                                │ services/ domain/ (pure)               │
                                │ Prisma ─────────▶ MySQL 8              │
                                └────────────────────────────────────────┘
```

* **Pure domain layer** (`src/domain/`): domain-pattern normalization/validation/matching and `decide()`,
  canonical JSON + sha256, ETag, policy content schema, assignment resolution, RBAC scoping, token
  format. No I/O; fully unit-tested, including every contract §5 example.
* **Modules** (`src/modules/*`): each is an encapsulated Fastify plugin with its own auth hook; route
  handlers only parse input (Zod) and call the service, services enforce business and tenant rules.
* **Tenant isolation**: the org scope comes from the authenticated principal (admin session → user row;
  device credential → credential/device row). Request parameters can only narrow a SUPER_ADMIN's scope.

## Data model (prisma/schema.prisma)

Organization · User · Session · Device · DeviceCredential · DeviceGroup/DeviceGroupMember · Policy ·
PolicyVersion · PolicyAssignment · DevicePolicyStatus (one current row per device) · AuditLog.
History-bearing relations use `Restrict` (orgs, policies, versions); join/child rows cascade.

## Enrollment

1. Agent `POST /api/agent/register` with registration token + `sha256(enrollment_secret)` → Device `PENDING`.
2. Admin approves → Device `APPROVED`, an **unclaimed** `DeviceCredential` row (no secret yet).
3. Agent polls `registration-status` with the raw enrollment secret. On the first APPROVED poll, one
   transaction consumes the enrollment secret (conditional update), mints `ndc_<credential_id>.<secret>`,
   stores `sha256(secret)`, marks the credential claimed, and returns the token once.
4. Revoke → all credentials revoked (checked on every request). Re-enroll → credentials revoked, device
   `PENDING`, enrollment secret cleared; the agent registers again with a new secret.

## Policy lifecycle

```
create ─▶ v1 DRAFT ─edit─▶ validate ─▶ publish ─▶ PUBLISHED (immutable, sha256 computed, becomes active)
                          new version = copy of latest → vN+1 DRAFT (one draft at a time)
rollback(vK) = activeVersionId → earlier PUBLISHED vK      archive = non-active version → ARCHIVED
activate/deactivate = Policy.isActive (inactive policies are skipped during resolution)
```

Content is always stored as the full 9-field object, defaults applied and domains normalized to
A-labels, so the stored JSON hashes identically on both sides.

## Assignment resolution

For a device: candidate assignments in the device's org whose policy is active and has an active
version; applicable if ORGANIZATION, GROUP containing the device, or DEVICE = the device. Winner:
DEVICE > GROUP > ORGANIZATION, then higher `priority`, then most recent. (`src/domain/assignment.ts`)
