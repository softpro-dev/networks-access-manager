# Deployment

## Topology

Run the Node process on localhost (HTTP) behind a TLS-terminating reverse proxy, set
`TRUST_PROXY` to the proxy's address so `req.ip` (audit, rate limits) is the real client. Alternatively
set `TLS_CERT_PATH`/`TLS_KEY_PATH` for native HTTPS (TLS ≥ 1.2). TLS is mandatory for agents.

## Build & release

```bash
npm ci && npx prisma generate && ENV_FILE=.env.prod npm run build
ENV_FILE=.env.prod npx prisma migrate deploy
ENV_FILE=.env.prod npm start                 # console at / and API at /api/* on PORT
```
The Fastify listener owns `/api/*` and sends every other request to the embedded Next.js console.
Set `PORT` and `WEB_PUBLIC_URL` to the same public service. No `WEB_PORT` or `API_URL` is used.
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
  location / {
    proxy_pass http://127.0.0.1:60100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
  }
  # Live change notifications (contract §4.3): long-lived, unbuffered Server-Sent Events.
  location = /api/agent/events {
    proxy_pass http://127.0.0.1:60100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
  }
}
```
with `TRUST_PROXY=127.0.0.1`.

### Live updates through a proxy

`GET /api/agent/events` is a Server-Sent Events stream (one per computer, pinged every 20 s). Any
proxy in front of the API must not buffer or compress it and must allow idle reads longer than 20 s:

* **nginx:** the `location` block above (the API also sends `X-Accel-Buffering: no`).
* **Caddy:** works as is (`reverse_proxy` flushes `text/event-stream` immediately).
* **IIS + ARR:** set `responseBufferLimit="0"` for the URL (or ARR "Response buffer threshold" 0) and
  disable dynamic compression for `text/event-stream`; keep the ARR proxy timeout ≥ 60 s.
* **Cloud load balancers:** idle timeout ≥ 60 s.

If the stream cannot get through, nothing breaks: services keep polling every
`CACHE_EXPIRATION_TIME_IN_MINUTE` and log `live updates: ...` lines explaining why.
Directly exposed (native `TLS_CERT_PATH`/`TLS_KEY_PATH`, or plain HTTP in development) needs nothing.

## Caddy

```
management.example.com {
  reverse_proxy 127.0.0.1:60100
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
ExecStart=/usr/bin/node --env-file=.env.prod dist/src/server.js
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
(e.g. Redis for `@fastify/rate-limit`) or pin to one instance. The live-update hub
(`src/services/agentEvents.ts`) is also in-process: with several instances, publish `notifyOrg` over
a shared bus (e.g. Redis pub/sub) so a change made on one instance reaches streams held by another.
Everything else is stateless.
