# Testing

```bash
npm run typecheck
npm run test:unit          # no database needed
npm test                   # unit + integration (integration skipped unless TEST_DATABASE_URL is set)
```

## Unit tests (`tests/unit`)

Domain patterns (every contract §5 example: trailing dot, case, IDN, IP literals, wildcard vs apex,
`badexample.com`, specificity and tie rules, management exception), canonical JSON + sha256 fixed
vectors, ETag / If-None-Match, policy content schema (defaults, unknown keys, limits, warnings),
IP/CIDR validation, assignment resolution, device token parse/hash/verify, RBAC scoping, config,
audit scrubbing, and HTTP behaviour that does not reach the DB (auth rejection, validation, error
envelope, rate limits) via `app.inject()`.

Cross-implementation vectors (`npm run test:vector`):

| Content | sha256 |
|---|---|
| contract §4 example `content` | `0587ffd890ccf836680f39fafb4740e3bf94185e7b8d8f26c6502560e14775cf` |
| all defaults (`{}`) | `b45d676bdcb5b8b2ff0ccc8ccaab1ff54c3214c6d694642f659db69e80b293b9` |

## Integration tests (`tests/integration`)

Require a **disposable** MySQL 8 database — it is wiped (`prisma migrate reset --force`) at the start of
each run and tables are emptied before each test.

```bash
mysql -u root -p -e "CREATE DATABASE network_manager_test; CREATE USER 'nam_test'@'localhost' IDENTIFIED BY 'pw'; GRANT ALL ON network_manager_test.* TO 'nam_test'@'localhost';"
TEST_DATABASE_URL=mysql://nam_test:pw@localhost:3306/network_manager_test npm run test:integration
```
(`migrate reset` may need CREATE/DROP rights on the schema.)

Coverage: login success/failure + audit, logout/disable revocation, RBAC, org isolation for devices,
policies, audit logs and agent calls, registration/idempotency/409/401, per-org tokens, approval and
one-time credential claim, reject, revoke → 403, re-enroll, heartbeat, policy lifecycle and immutability,
new version, rollback to a lower version, assignment precedence, activate/deactivate, ETag/304, ack,
status + failure audit, invalid input → 400.
