# server-network

Central Network Access Management server: the policy authority for the `win32-apps` Windows agent.
It manages organizations, administrators, device enrollment/credentials, versioned network policies,
assignments, heartbeats and audit logs. It never sees or filters browser traffic — agents enforce locally.

Stack: Node 22 · TypeScript (ESM, strict) · Fastify 5 · Zod · Prisma 6 / MySQL 8 · argon2id · JWT (jose) · Vitest.

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

# 5. Run
npm run dev                  # tsx watch
npm run build && npm start   # compiled (dist/)
curl http://localhost:3000/api/health
```

Log in: `POST /api/auth/login {"email":"superadmin@example.com","password":"..."}` → use
`Authorization: Bearer <access_token>` on admin endpoints.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` / `start` / `build` | run (watch) / run compiled / compile to `dist/` |
| `npm run typecheck` | `tsc --noEmit` over src + tests |
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
docs/               architecture, security, api, deployment, testing, troubleshooting
```

The agent wire contract is `../docs/api-contract.md`; this server implements it verbatim.
