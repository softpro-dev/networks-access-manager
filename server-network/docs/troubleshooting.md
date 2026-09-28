# Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Invalid configuration: JWT_SECRET ...` at start | Production needs `JWT_SECRET` ≥ 32 chars; generate with `openssl rand -base64 48`. |
| `P1001 Can't reach database server` | Check `DATABASE_URL`, MySQL running, user grants, firewall. |
| `P3009`/`P3018` on `migrate deploy` | A failed migration is recorded; inspect `_prisma_migrations`, fix, then `npx prisma migrate resolve`. |
| `@prisma/client did not initialize yet` | Run `npx prisma generate` after `npm install`. |
| Agent gets 401 `INVALID_REGISTRATION_TOKEN` | Wrong token, unknown/disabled org code, or a per-org token is set (it replaces the global one). |
| Agent gets 409 `DEVICE_ALREADY_REGISTERED` | The uuid exists with another enrollment secret or org, or its credential was already claimed. Use **re-enroll** in the admin API, then let the agent register again. |
| Agent polls forever with PENDING | Approve the device: `POST /api/devices/:id/approve`. |
| Agent gets 401 `INVALID_ENROLLMENT` after approval | Credential already claimed (maybe the response was lost). Re-enroll the device. |
| Agent gets 403 `CREDENTIAL_REVOKED` / `DEVICE_NOT_APPROVED` | Device revoked/re-enrolled, or organization disabled. |
| Agent gets 404 `NO_POLICY_ASSIGNED` | No active policy with a published active version is assigned (check `effective_policy` on `GET /api/devices/:id`, policy `is_active`, assignment scope). |
| 429 `RATE_LIMITED` | Limits per contract §7; behind a proxy set `TRUST_PROXY` or all clients share one IP bucket. |
| Admin token suddenly 401 | Token expired (15 min default), logged out, user/org disabled, or password changed. Log in again. |
| 500 `Policy integrity check failed` | Stored content no longer hashes to the published sha256 (manual DB edit). Publish a new version. |
| Wrong client IPs in audit | Configure `TRUST_PROXY` to the reverse proxy address. |

## Changed `SEED_SUPER_ADMIN_PASSWORD` in `.env` but login still fails

The seed password is used only when the seeder *creates* a user; it never overwrites an existing
account. Reset the stored password instead:

```bash
npm run admin:reset-password -- <email>
```

The password comes from `RESET_PASSWORD`, else `SEED_SUPER_ADMIN_PASSWORD` (when `<email>` is the
seed super admin), else a hidden prompt. It also clears lockout and revokes the user's sessions.
