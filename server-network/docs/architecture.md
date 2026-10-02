# Architecture

```
 Admin browser ─┐
 Admin CLI ─────┼──HTTPS──▶ server-network (:PORT) ──▶ MySQL 8
 Windows agents ┘             ├─ Next.js: / and all non-API routes
                               └─ Fastify: /api/*
                                    ├─ /api/auth, /api/organizations, ...
                                    └─ /api/agent/*
```

* **Admin console** (`web/`): Next.js App Router, all pages are client components using TanStack Query
  against same-origin `/api/*`. Fastify handles that namespace directly and passes every non-API request
  to Next on the same listener. No business logic, API routes or server actions live in Next; RBAC and
  tenant isolation are enforced only (and always) by the API.
  `middleware.ts` sets a per-request nonce CSP; `next.config.mjs` adds the static security headers.
  `WEB_PUBLIC_URL` is the public URL of the shared listener.
  Pages: Dashboard (`/`, analytics), Computers (`/computers`, `/computers/:id`, groups tab and
  `/computers/groups/:id`), Restrictions (`/restrictions`, `/new`, `/:id`), Set access (`/access`, drag and
  drop with `@dnd-kit/core`, optimistic assignment updates), Audit log, Organization(s), Administrators.
  Old `/devices`, `/groups`, `/policies` URLs redirect (`next.config.mjs`). A super admin's working
  organization is a per-tab client setting (`web/lib/orgScope.ts`) that only narrows API queries.
* **Pure domain layer** (`src/domain/`): domain-pattern normalization/validation/matching and `decide()`,
  canonical JSON + sha256, ETag, policy content schema, assignment resolution, RBAC scoping, token
  format. No I/O; fully unit-tested, including every contract §5 example.
* **Modules** (`src/modules/*`): each is an encapsulated Fastify plugin with its own auth hook; route
  handlers only parse input (Zod) and call the service, services enforce business and tenant rules.
* **Tenant isolation**: the org scope comes from the authenticated principal (admin session → user row;
  device credential → credential/device row). Request parameters can only narrow a SUPER_ADMIN's scope.

## Data model (prisma/schema.prisma)

Organization · User · Session · LoginLink · Device (title, serial, MAC; `PRE_REGISTERED` until an agent
links) · DeviceCredential · DeviceGroup/DeviceGroupMember · Policy (= restriction, with `kind`) ·
PolicyVersion · PolicyAssignment · DeviceEffectivePolicy (merged content + per-device version) ·
DevicePolicyStatus (one current row per device) · AuditLog.
History-bearing relations use `Restrict` (orgs, policies, versions); join/child rows cascade.

## Enrollment

0. (Optional) An admin pre-adds a computer by MAC (`POST /api/devices`) → `PRE_REGISTERED`.
1. Agent `POST /api/agent/register` with registration token + `sha256(enrollment_secret)` → Device `PENDING`
   (a `PRE_REGISTERED` row with a matching MAC in the same organization is linked instead of creating a new one).
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

## Assignment resolution (merge)

For a device: every assignment in the device's org whose restriction is active and has an active published
version and that is ORGANIZATION, GROUP containing the device, or DEVICE = the device. All of them are
**merged** into one document (`src/domain/mergeRestrictions.ts`): any Allow Only ⇒ allow-only mode with the
union of allowed domains; black lists and redirections are unioned; protocol flags OR-ed. The result is
stored per device (`DeviceEffectivePolicy`, version bumped when the hash changes) and served to the agent
as `policy_id "EFFECTIVE"`. The console's editor uses `PUT /api/policies/:id/content` (save = publish a
new immutable version); the draft/publish endpoints remain for API clients.

## Sign-in links

A super admin can issue a single-use, short-lived link (`POST /api/organizations/:id/login-link`) that
signs in as one of the organization's admins. Only the token's sha256 is stored; the console strips
`?org_admin=` from the URL before exchanging it (`POST /api/auth/login-link`) and pages send
`Referrer-Policy: no-referrer`.
