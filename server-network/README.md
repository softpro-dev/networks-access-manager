# server-network

Central Network Access Management server: the policy authority for the `win32-apps` Windows agent.
It manages organizations, administrators, device enrollment/credentials, versioned network policies,
assignments, heartbeats and audit logs. It never sees or filters browser traffic — agents enforce locally.

Stack: Node 22 · TypeScript (ESM, strict) · Fastify 5 · Zod · Prisma 6 / MySQL 8 · argon2id · JWT (jose) · Vitest.
Admin console (`web/`): Next.js 15 (App Router) · React 19 · TanStack Query — a pure client of the API.

## Quick start

```bash
# 1. Node 22+ (e.g. via nvm) — then:
npm install
npx prisma generate

# 2. MySQL 8: create a database and a dedicated user
mysql -u root -p <<'SQL'
CREATE DATABASE network_manager CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'nam'@'localhost' IDENTIFIED BY 'a-long-random-password';
GRANT ALL PRIVILEGES ON network_manager.* TO 'nam'@'localhost';
SQL

# 3. Configure
cp .env.example .env
#   DATABASE_URL=mysql://nam:a-long-random-password@localhost:3306/network_manager
#   JWT_SECRET=$(openssl rand -base64 48)
#   AGENT_REGISTRATION_TOKEN=$(openssl rand -base64 32)

# 4. Migrate + seed (seed prints generated admin passwords ONCE)
set -a; . ./.env; set +a
npx prisma migrate deploy
npm run db:seed

# 5. Run (API + admin console together)
npm run dev                  # API: tsx watch on $PORT · console: next dev on $WEB_PORT (3001)
npm run build && npm start   # compiled API (dist/) + next start
curl http://localhost:3000/api/health
```

## Admin console

Open **http://localhost:3001** (dev and `npm start`; `WEB_PORT` changes it) and sign in with a seeded
administrator (e.g. `superadmin@example.com` and the password printed by `npm run db:seed`).
Visiting the API origin itself (`http://localhost:$PORT/`) shows a small page linking to the console
(`WEB_PUBLIC_URL`, default `http://localhost:3001`).

* The console is a Next.js app in `web/`. The browser only talks to the console origin; Next proxies
  `/api/*` to the Fastify API (`API_URL`, default `http://localhost:$PORT`, where `PORT` is read from the
  real environment or — only that key — from `./.env`). Fastify remains the only backend and security
  authority; there are no Next API routes or server actions.
* Pages: dashboard (device counts, pending approvals with quick approve/reject, stale heartbeats,
  policy failures, recent audit), organizations (super admin; org admins see their own), administrators,
  devices (+ detail with interfaces, credential metadata, approve/reject/revoke/re-enroll/rename), device
  groups, policies (versions, draft editor with normalization preview, validate/publish/new version/
  rollback/archive, activate/deactivate, assignments) and the audit log. Navigation and actions follow the
  signed-in role; the API enforces RBAC regardless.
* The access token is kept in memory + `sessionStorage` (per tab, never `localStorage`) and sent as a
  Bearer token; any 401 or the JWT lifetime ending returns you to the sign-in page.
* `next start` bakes the `/api` rewrite target at **build** time: rebuild after changing `API_URL`/`PORT`.

Dev workflow: `npm run dev` (both, via `concurrently`), or `npm run dev:api` / `npm run dev:web` separately.
Build: `npm run build` = `build:api` (tsc → `dist/`) + `build:web` (`next build web` → `web/.next/`).

API only: `POST /api/auth/login {"email":"superadmin@example.com","password":"..."}` → use
`Authorization: Bearer <access_token>` on admin endpoints.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` / `start` / `build` | API + console: run (watch) / run compiled / build both |
| `npm run dev:api` / `dev:web` / `start:api` / `start:web` / `build:api` / `build:web` | one side only |
| `npm run typecheck` | `tsc --noEmit` over src + tests, then over `web/` |
| `npm test` | unit tests + integration tests (integration only when `TEST_DATABASE_URL` is set) |
| `npm run test:unit` / `test:integration` | one suite |
| `npm run db:migrate` / `db:seed` | `prisma migrate deploy` / seed |
| `npm run test:vector` | print canonical-JSON/sha256/ETag vectors for cross-checking the agent |

## Layout

```
src/
  app.ts            buildApp(deps) factory (used by tests via app.inject())
  server.ts         entry point: HTTP, or native HTTPS when TLS_CERT_PATH/TLS_KEY_PATH are set
  config/           Zod-validated env config (fails fast)
  domain/           pure logic: domain patterns, canonical JSON, ETag, policy schema, assignment resolution, RBAC, tokens
  middleware/       admin JWT+session auth, device credential auth
  modules/          auth, organizations, users, devices, groups, policies, audit, agents (routes + services)
  services/         audit writer, password hashing, JWT, rate limiting, policy resolution
prisma/             schema.prisma, migrations/, seed.ts
tests/unit          no database
tests/integration   MySQL (TEST_DATABASE_URL)
web/                Next.js admin console (app/ routes, components/, lib/ API client + auth)
docs/               architecture, security, api, deployment, testing, troubleshooting
```

The agent wire contract is `../docs/api-contract.md`; this server implements it verbatim.
