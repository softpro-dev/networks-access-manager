# Deployment

## Topology

Run the Node process on localhost (HTTP) behind a TLS-terminating reverse proxy, set
`TRUST_PROXY` to the proxy's address so `req.ip` (audit, rate limits) is the real client. Alternatively
set `TLS_CERT_PATH`/`TLS_KEY_PATH` for native HTTPS (TLS ≥ 1.2). TLS is mandatory for agents.

## Build & release

```bash
npm ci && npx prisma generate && npm run build
NODE_ENV=production npx prisma migrate deploy
node dist/src/server.js                     # API
npx next start web --port 3001              # admin console (or `npm start` for both)
```
Set `API_URL` (e.g. `http://127.0.0.1:3000`) before `npm run build:web`: the console's `/api` proxy
target is fixed at build time. Set `WEB_PUBLIC_URL` on the API to the console's public URL.
Route the console host (or `/`) to port 3001 and `/api/` to 3000 (or let the console proxy `/api`).
Production requires `JWT_SECRET` ≥ 32 chars and a non-trivial `AGENT_REGISTRATION_TOKEN`
(≥ 16 chars, or empty to require per-organization tokens); startup fails otherwise.

## nginx

```nginx
server {
  listen 443 ssl http2;
  server_name management.example.com;
  ssl_certificate     /etc/letsencrypt/live/management.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/management.example.com/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  client_max_body_size 8m;
  location /api/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```
with `TRUST_PROXY=127.0.0.1`.

## Caddy

```
management.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

## systemd

```ini
# /etc/systemd/system/server-network.service
[Unit]
Description=Network Access Management server
After=network-online.target mysql.service

[Service]
User=nam
Group=nam
WorkingDirectory=/opt/server-network
EnvironmentFile=/etc/server-network/env
ExecStart=/usr/bin/node dist/src/server.js
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```
`/etc/server-network/env` should be `0600` owned by root/nam.

## Database

* Dedicated MySQL user with rights only on the app schema; TLS to MySQL if remote.
* Backups: `mysqldump --single-transaction --routines network_manager | gzip > nam-$(date +%F).sql.gz`
  daily, kept off-host and encrypted; test restores. Point-in-time recovery via binlogs if required.
* The DB contains only hashes of secrets, but still treat dumps as sensitive (audit/IP data).

## Key rotation

| Secret | Rotation | Effect |
|---|---|---|
| `JWT_SECRET` | change env, restart | all admin tokens invalid → re-login |
| `AGENT_REGISTRATION_TOKEN` | change env, restart; update installers | only affects new registrations |
| Per-org registration token | `POST /api/organizations/:id/registration-token` | old token stops working immediately |
| Device credential | admin "re-enroll" on the device | agent re-registers and gets a new credential after approval |
| DB password | change in MySQL + `DATABASE_URL`, restart | – |

## Scaling notes

Rate-limit counters are in-memory per process. For multiple instances, configure a shared store
(e.g. Redis for `@fastify/rate-limit`) or pin to one instance. Everything else is stateless.
