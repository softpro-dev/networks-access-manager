# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository shape

Two **independent** applications that share no code and communicate only over the HTTPS REST API:

| Dir | What | Stack |
|---|---|---|
| `server-network/` | Central policy authority + admin console | Node 22, TypeScript (ESM, strict), Fastify 5, Zod, Prisma 6 / MySQL 8, argon2id, JWT (jose), Vitest; console in `web/` is Next.js 15 / React 19 / TanStack Query |
| `os-apps/` | Agent: background service `SoftProIt.network.conducted` (internal service/daemon name still `OrganizationNetworkAgent`) + desktop admin-console wrapper `SoftProIt.network.admin` | Python 3.11+ (dev uses 3.12), pywin32, httpx, pydantic, SQLite, pywebview, PyInstaller; Inno Setup (Windows) / launchd + .pkg (macOS) |
| `docs/api-contract.md` | **The wire contract** between them | — |

`app-prompt.md` is the original master spec for the whole system (roles, multi-tenant rules, requirements). Each app also has its own `docs/` (architecture, security, api, deployment, testing, troubleshooting; agent adds `windows-enforcement.md`). The per-app `README.md` files predate the merged-policy / org-token / admin-wrapper changes; trust the contract, the code and this file over them.

**Contract rule:** any change to agent endpoints, policy document shape, canonical JSON/sha256/ETag, or domain-pattern semantics (contract §5) must be made identically on both sides and in `docs/api-contract.md`. Cross-check hashes with `npm run test:vector` (server) against `os-apps/tests/test_canonical.py`. Known vectors: contract §4 example → `0587ffd8…75cf`; all-defaults `{}` → `b45d676b…93b9`.

## server-network commands

Run from `server-network/`:

```bash
npm install && npx prisma generate
npm run dev                 # API (tsx watch, $PORT, default 3000) + console (next dev, $WEB_PORT, default 3001)
npm run dev:api | dev:web   # one side only
npm run build               # tsc → dist/  +  next build web
npm run typecheck           # tsc over src+tests, then over web/
npm run test:unit           # no DB needed
npm test                    # unit + integration (integration skipped unless TEST_DATABASE_URL set)
npx vitest run tests/unit/<file>.test.ts -t "<test name>"   # single test
npm run db:migrate          # prisma migrate deploy   (db:migrate:dev for new migrations)
npm run db:seed             # prints generated admin passwords ONCE
npm run suadmin__reset_password   # scripts/reset-password.ts
```

- `predev` runs `scripts/dev-sync-admin.ts`: when `NODE_ENV=development`, it resets the seed super admin's password to `SEED_SUPER_ADMIN_PASSWORD` from `.env` (revokes sessions, writes audit log). Never fails dev start.
- Integration tests need a **disposable** MySQL DB: it is wiped with `prisma migrate reset --force` per run and tables emptied per test. Test files run sequentially (`fileParallelism: false`).
- `next start` bakes the `/api` rewrite target at build time — rebuild after changing `API_URL`/`PORT`.
- Config is Zod-validated env (`src/config/`) and fails fast; see `.env.example`.

## server-network architecture

- `src/app.ts` `buildApp(deps)` factory; tests drive it with `app.inject()`. `src/server.ts` is entry (native HTTPS when `TLS_CERT_PATH`/`TLS_KEY_PATH` set).
- `src/domain/` is **pure** (no I/O): domain-pattern normalization/matching/`decide()`, canonical JSON + sha256, ETag, policy content schema, restriction merging (`mergeRestrictions.ts`), IP/CIDR, RBAC scoping, token formats. Put contract logic here and unit-test it.
- `src/modules/*` (auth, organizations, users, devices, groups, policies, audit, agents, analytics): each is an encapsulated Fastify plugin with its own auth hook. Route handlers only parse input with Zod and call the service; services enforce business + tenant rules.
- Auth schemes (`src/middleware/`): admins = JWT (15 min) + `Session` row; devices = `ndc_<credential_id>.<secret>` bearer, secret stored as sha256, revocation checked every request; organization service token = `nat_<43 chars>` (non-expiring, invalidated only by rotate/clear), used only for `GET /api/agent/org-policy`; stored as sha256 (`accessTokenHash`, used for auth) **and** AES-256-GCM-sealed (`accessTokenEnc`, `utils/crypto` `sealSecret`, key `TOKEN_ENCRYPTION_KEY` else `JWT_SECRET`) so the console's "Copy Token" (`GET /api/organizations/:id/access-token`, audited) can return it.
- **Tenant isolation:** org scope always comes from the authenticated principal, never from request params; params can only *narrow* a SUPER_ADMIN's scope. A device must never see another org's data.
- Errors go through one handler → `{"error":{...}}` envelope (contract §6).
- Restrictions can be deleted (`DELETE /api/policies/:id`, `deletePolicy`): one transaction removes assignments, unlinks `activeVersionId`, deletes all versions (Restrict-protected), then the policy; device status rows keep history via SetNull; audited `POLICY_DELETED`.
- Policy lifecycle: v1 DRAFT → validate → publish (immutable, sha256 computed, becomes active). One draft at a time; new version copies latest; rollback repoints `activeVersionId` to an earlier PUBLISHED version; `Policy.isActive` toggles resolution. Content is stored as the full 9-field object with defaults applied and domains normalized to A-labels so both sides hash identically; optional `redirect_rules` is **omitted when empty** so older contents keep their hash.
- Policies are **restrictions** with a `kind` (`ALLOW_ONLY | BLACKLIST | REDIRECT`). Agents never receive a single policy: `src/services/policyResolution.ts` collects every active restriction reaching the device (org, its groups, the device itself), and `mergeRestrictions()` builds one document with `policy_id: "EFFECTIVE"`, `assignment_scope: "MERGED"` (contract §4.1). Any ALLOW_ONLY → `default_action: "block"`; protocol flags are OR-ed; lists are de-duped and sorted; for a redirect `from` that appears in several restrictions, the lowest restriction code wins. `version` is a stored per-device counter bumped only when the merged hash changes. Org-token mode (§4.2): when the service's `X-Device-MAC` matches a registered computer of the org, it gets that computer's full merge (`assignment_scope: "MERGED"`, via `resolveEffectivePolicy`), otherwise only ORGANIZATION-scoped restrictions; its documents never have `device_uuid`. An authenticated 404 makes the org-token agent remove enforcement and clear its cache (`OrgAgent._release_unassigned`); network errors/401 keep the cache. `src/domain/assignment.ts` (single winner by scope/priority) is legacy; only its unit test still uses it.
- Per-computer **Synced** column (Computers page): `Device.syncedSha256/syncedAt/syncedVia` record what a computer's service was last served — org-token services identify themselves with the optional `X-Device-MAC` header on `/api/agent/org-policy` (contract §4.2; agent sends `primary_mac()` from `nam_agent.network`), enrolled agents on `/api/agent/policy` and `/policy/version`. The API computes `synced` read-only by comparing with `currentOrgSha` / `currentDeviceSha` (`services/policyResolution.ts`), so any restriction/assignment change flips it to false with no reset hooks; `null` = never fetched.
- `PolicyAssignment.synced` (API `synced`): set true by `markDeviceAssignmentsSynced` / `markOrgAssignmentsSynced` (`services/policyResolution.ts`) whenever `/api/agent/policy` or `/api/agent/org-policy` serves a document (200 or 304) containing that restriction; reset by `markPolicyUnsynced` on publish, rollback and activate/deactivate. It means "an agent fetched it", not "it is enforced" (agents are control-plane only).
- Enrollment: register (PENDING) → admin approve (unclaimed credential) → first APPROVED `registration-status` poll atomically consumes enrollment secret and returns the credential once. Re-enroll revokes credentials and returns device to PENDING.
- Prisma: history-bearing relations (orgs, policies, versions) use `Restrict`; join/child rows cascade.
- `web/` is a pure API client: all pages are client components; Next only proxies `/api/*` to Fastify. **No Next API routes or server actions** — RBAC lives only in the API. Access token kept in memory + `sessionStorage` (never `localStorage`). `middleware.ts` sets nonce CSP.
- The server never processes or filters browser traffic; agents enforce locally. No user activity is collected (analytics are aggregate counts only).

## os-apps commands

Run from `os-apps/`. macOS/Linux dev works; on Windows use `.venv\Scripts\python` in place of `.venv/bin/python`. `build.ps1` only creates a venv when `.venv` is missing (a venv copied from another OS must be deleted first), and it runs `-Python` through `Invoke-Expression`, which breaks on paths with spaces — pre-create `.venv` instead.

```bash
python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest                          # or scripts/run-tests.sh
.venv/bin/python -m pytest tests/test_policy_sync.py -k "<name>"   # single test

# foreground run against dev server (no DPAPI off Windows)
export NAM_DATA_DIR=$PWD/.nam-data NAM_SECRET_PROTECTOR=insecure-dev
# org-token mode (the deployment default; see .env.example):
export ADMIN_SERVER=http://localhost:3001 NAM_ALLOW_INSECURE_HTTP=true ACCESS_TOKE=nat_...
# or per-device mode (used only when ACCESS_TOKE is unset):
#   export ORGANIZATION_ID=INST-001 API_BASE_URL=https://localhost:3000/api DEVICE_REGISTRATION_TOKEN=...
.venv/bin/python src/main.py run
.venv/bin/python src/main_admin.py --server http://localhost:3001   # desktop wrapper (needs GUI + pywebview)
```

PyInstaller can't cross-compile, so build on the target OS:

- **Installers ask nothing.** `ADMIN_SERVER`, `ACCESS_TOKE`, `CACHE_EXPIRATION_TIME_IN_MINUTE` (and `BUILD_VERSION`) are read from `os-apps/.env` (environment wins) and validated before building (`nat_…` token required for Service). Windows: build.ps1 writes `build\installer-config-{admin,service}.iss` (`#define CfgServer/CfgToken/CfgCache`), `#include`d by the .iss and deleted after ISCC; the admin include never holds the token. For security, setup (Ready page + setup log; macOS: DMG README.txt) shows only `ADMIN_SERVER` cut to its first 10 characters, `CACHE_EXPIRATION_TIME_IN_MINUTE`, `CODE_NUMBER` (display-only build identifier, ≤64 chars) and `BUILD_VERSION` — never the token. Every install rewrites agent.env / admin.env. `/SERVER= /TOKENFILE= /CACHE=` still override. The Service installer therefore contains the org access token: treat it as a secret and rotate the token if one leaks.
- Windows x64: `powershell -ExecutionPolicy Bypass -File scripts\build.ps1 [-Target Admin|Service] -Installer` (default `-Target All`; `-SkipTests`; `-Version x.y.z`). Builds the exe(s) (onedir) in `dist/` and two separate Inno Setup installers in `installer\Output\`: `SoftProIt-Network-Admin-<ver>-setup.exe` (`installer\SoftProIt.Network.Admin.iss`, desktop app + `admin.env`) and `SoftProIt-Network-Service-<ver>-setup.exe` (`installer\SoftProIt.Network.Service.iss`, service + `agent.env`; keeps the old combined installer's AppId so it upgrades in place). Version: `-Version`, else `$env:BUILD_VERSION`, else `BUILD_VERSION` in `os-apps\.env`, else 1.0.0, passed as `ISCC /DAppVersion=`. Double-click wrappers: `build-now\build-admin-setup.bat`, `build-now\build-service-setup.bat`. pytest runs with `--basetemp build\pytest` (the shared `%TEMP%\pytest-of-<user>` can contain admin-owned folders).
- macOS: `scripts/build.sh [--target admin|service] [--dmg] [--version x.y.z] [--skip-tests]` (same version resolution as Windows). `--dmg` writes `installer/Output/SoftProIt-Network-Admin-<ver>.dmg` (drag-to-Applications `.app`; embeds `ADMIN_SERVER` from `os-apps/.env` as `Contents/MacOS/admin.env`, because the service's agent.env is root-only) and `SoftProIt-Network-Service-<ver>.dmg` (contains an unsigned `.pkg` built with `pkgbuild`; `installer/macos/postinstall` creates the root-only data dir, writes agent.env from the baked-in `config.env`, then `install`/`start` the LaunchDaemon; each DMG's README.txt lists the baked-in values, token masked). Double-click wrappers: `build-now/build-{admin,service}-dmg.command` (must stay LF + executable; see `.gitattributes`). Signing/notarizing per `installer/README-macos.md`. None of the macOS path has been verified end-to-end.
- `build-now/` holds the double-click build wrappers (Windows `build-{admin,service}-setup.bat`, macOS `build-{admin,service}-dmg.command`; all copy the installer to the user's Downloads folder) and personal command notes. Build/deploy docs: `os-apps/docs/deployment.md`, macOS packaging: `os-apps/installer/README-macos.md`.

Service CLI subcommands: `configure`, `install`/`uninstall`, `start`/`stop`, `status`, `run`; no args = SCM service host.

## os-apps architecture

- Two independently packaged apps:
  - `src/nam_agent/`: the service. Entry `src/main.py`, built from `SoftProIt.network.conducted.spec`.
  - App icon: `os-apps/assets/app-icon.{ico,icns,png}`, generated from the console's `web/app/icon.svg` geometry by `scripts/make_icons.py` (needs Pillow; outputs are committed). Used by the admin spec (exe icon on Windows, `.app` icon on macOS).
  - `src/nam_admin/`: a pywebview window onto the admin console. Entry `src/main_admin.py`, built from `SoftProIt.network.admin.spec`. **`nam_admin` may import only `nam_agent.network`** (stdlib interface discovery; the admin spec excludes every other service module), and pywebview is imported lazily inside `run()`. The window's URL comes from `ADMIN_SERVER` (env var first, then `admin.env` next to the exe, then `agent.env`), else it is derived from `API_BASE_URL`. On startup `nam_admin/network_scan.py` sweeps the primary interface's /24, reads `arp -a`, and opens the console as `/?connected_devices=<JSON>` (this PC first, flagged `self`, MAC from the agent's `discover()` so it matches what the agent reports); the console stores it in localStorage (`web/lib/connectedDevices.ts`) for "Add My PC" / "Add from network".
- **Windows-only imports (`win32*`, `servicemanager`, `winreg`, `ctypes.windll`) must stay lazy** (inside functions or Windows-only modules; `platform.py` has `IS_WINDOWS`/`IS_MACOS`) so everything else and the test suite run on macOS/Linux. `service/` has `windows_service.py` (pywin32) and `launchd.py` (macOS).
- **Enforcement:** `enforcement/` defines `EnforcementBackend`. On Windows `default_backend(data_dir)` returns `WindowsEnforcementBackend` (`enforcement/windows.py`): browser enterprise policies (Chromium `URLBlocklist`/`URLAllowlist`, Firefox `WebsiteFilter`, DoH/QUIC off) + hosts-file sinkhole + Windows Firewall group "SoftProIt Network"; system access goes through `SystemOps` (`WindowsSystemOps` real, tests use a fake), state/backups in `<data>/enforcement-state.json`, never closes browsers. Elsewhere it is still `NotImplementedBackend` (enabled policy → `FAILED / policy_apply_failed`, heartbeat `ENFORCEMENT_ERROR`). See `docs/windows-enforcement.md`.
- **Two run modes**, chosen in `config/settings.py`:
  - **Org-token mode** when `ACCESS_TOKE` is set. That env var really is spelled without the final N; don't "fix" it. Handled by `agent/org_sync.py`: no enrollment, device identity or heartbeat. It polls `GET /api/agent/org-policy` every `CACHE_EXPIRATION_TIME_IN_MINUTE` minutes with `If-None-Match`.
  - **Per-device mode** otherwise: enrollment, heartbeat and `/api/agent/policy`.
  - API base = `API_BASE_URL` if set, else `${ADMIN_SERVER}${NAM_API_BASE_SUFFIX:-/api}`.
- `agent/`: `enrollment.py` state machine, `pipeline.py` apply → verify → management health check → promote → ack with rollback, `core.py` scheduling loop, `runtime.py` wiring. The `policy/` validator implements contract validation steps 1–8. That covers merged `EFFECTIVE` documents with `sources`/`redirect_rules`, and org documents without `device_uuid`.
- SQLite `policy.db` (WAL) holds `current` / `previous` / `candidate` policy slots; promotion is one transaction. **Only a successful apply changes `current`** — network errors, 401/403, or "no policy assigned" never drop the cached policy (offline-safe). Only a delivered policy with `enabled: false` removes enforcement.
- Failures: network/5xx → exp. backoff 5 s → 300 s with jitter; 401/403 → keep cache, retry every 300 s; undeliverable status reports queued in SQLite.
- Heartbeat sends exactly the five contract fields. The secrets protector (`NAM_SECRET_PROTECTOR`) is `dpapi` machine scope on Windows, `file-key` on macOS/POSIX, and `insecure-dev` only for dev and tests. The registration token is deleted after enrollment.
- Config lives in `<data dir>/config/agent.env` (ProgramData on Windows; `NAM_DATA_DIR` overrides the data dir), and env vars override the file. There is no default server. HTTPS is enforced unless `NAM_ALLOW_INSECURE_HTTP=true` (dev only). The management server is always exempt from enforcement.
- Tests use an in-memory fake server (`tests/fake_server.py` via `httpx.MockTransport`) and a test-only `RecordingBackend`.
