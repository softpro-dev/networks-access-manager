# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository shape

Two **independent** applications that share no code and communicate only over the HTTPS REST API:

| Dir | What | Stack |
|---|---|---|
| `server-network/` | Central policy authority + admin console | Node 22, TypeScript (ESM, strict), Fastify 5, Zod, Prisma 6 / MySQL 8, argon2id, JWT (jose), Vitest; console in `web/` is Next.js 15 / React 19 / TanStack Query |
| `os-apps/` | Windows Service agent (`OrganizationNetworkAgent.exe`) | Python 3.11+ (dev uses 3.12), pywin32, httpx, pydantic, SQLite, PyInstaller, Inno Setup |
| `docs/api-contract.md` | **The wire contract** between them | — |

`app-prompt.md` is the original master spec for the whole system (roles, multi-tenant rules, requirements). Each app also has its own `docs/` (architecture, security, api, deployment, testing, troubleshooting; agent adds `windows-enforcement.md`).

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
- `src/domain/` is **pure** (no I/O): domain-pattern normalization/matching/`decide()`, canonical JSON + sha256, ETag, policy content schema, assignment resolution, RBAC scoping, token format. Put contract logic here and unit-test it.
- `src/modules/*` (auth, organizations, users, devices, groups, policies, audit, agents): each is an encapsulated Fastify plugin with its own auth hook. Route handlers only parse input with Zod and call the service; services enforce business + tenant rules.
- Two auth schemes (`src/middleware/`): admins = JWT (15 min) + `Session` row; devices = `ndc_<credential_id>.<secret>` bearer, secret stored as sha256, revocation checked every request.
- **Tenant isolation:** org scope always comes from the authenticated principal, never from request params; params can only *narrow* a SUPER_ADMIN's scope. A device must never see another org's data.
- Errors go through one handler → `{"error":{...}}` envelope (contract §6).
- Policy lifecycle: v1 DRAFT → validate → publish (immutable, sha256 computed, becomes active). One draft at a time; new version copies latest; rollback repoints `activeVersionId` to an earlier PUBLISHED version; `Policy.isActive` toggles resolution. Content is stored as the full 9-field object with defaults applied and domains normalized to A-labels so both sides hash identically.
- Assignment winner (`src/domain/assignment.ts`): DEVICE > GROUP > ORGANIZATION, then higher `priority`, then most recent; inactive policies skipped.
- Enrollment: register (PENDING) → admin approve (unclaimed credential) → first APPROVED `registration-status` poll atomically consumes enrollment secret and returns the credential once. Re-enroll revokes credentials and returns device to PENDING.
- Prisma: history-bearing relations (orgs, policies, versions) use `Restrict`; join/child rows cascade.
- `web/` is a pure API client: all pages are client components; Next only proxies `/api/*` to Fastify. **No Next API routes or server actions** — RBAC lives only in the API. Access token kept in memory + `sessionStorage` (never `localStorage`). `middleware.ts` sets nonce CSP.
- The server never processes or filters browser traffic; agents enforce locally.

## os-apps commands

Run from `os-apps/` (macOS/Linux dev works):

```bash
python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest                          # or scripts/run-tests.sh
.venv/bin/python -m pytest tests/test_policy_sync.py -k "<name>"   # single test

# foreground run against dev server (no DPAPI off Windows)
export NAM_DATA_DIR=$PWD/.nam-data NAM_SECRET_PROTECTOR=insecure-dev
export ORGANIZATION_ID=INST-001 API_BASE_URL=https://localhost:3000/api DEVICE_REGISTRATION_TOKEN=...
.venv/bin/python src/main.py run
```

Build `.exe` only on Windows x64 (PyInstaller can't cross-compile): `powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Installer` (runs tests first). CLI subcommands: `configure`, `install`/`uninstall`, `start`/`stop`, `status`, `run`; no args = SCM service host.

## os-apps architecture

- Code in `src/nam_agent/` (entry `src/main.py`). **Windows-only imports (`win32*`, `servicemanager`, `winreg`, `ctypes.windll`) must stay lazy** (inside functions or Windows-only modules) so everything else and the test suite run on macOS/Linux.
- **Control plane only.** `enforcement/` defines `EnforcementBackend`; the only real backend, `NotImplementedBackend`, makes no network changes, so an enabled policy reports `FAILED / policy_apply_failed` and heartbeat `ENFORCEMENT_ERROR`. This is intentional — see `docs/windows-enforcement.md`.
- `agent/`: `enrollment.py` state machine, `pipeline.py` apply → verify → management health check → promote → ack with rollback, `core.py` scheduling loop, `runtime.py` wiring. `policy/` validator implements contract validation steps 1–8.
- SQLite `policy.db` (WAL) holds `current` / `previous` / `candidate` policy slots; promotion is one transaction. **Only a successful apply changes `current`** — network errors, 401/403, or "no policy assigned" never drop the cached policy (offline-safe).
- Failures: network/5xx → exp. backoff 5 s → 300 s with jitter; 401/403 → keep cache, retry every 300 s; undeliverable status reports queued in SQLite.
- Heartbeat sends exactly the five contract fields. Secrets are DPAPI machine-scope encrypted (`insecure-dev` protector only for dev/tests); registration token deleted after enrollment. Config: `agent.env` in ProgramData, env vars override; there is no default server and HTTPS is enforced.
- Tests use an in-memory fake server (`tests/fake_server.py` via `httpx.MockTransport`) and a test-only `RecordingBackend`.
