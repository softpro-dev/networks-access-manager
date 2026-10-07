# Windows enforcement

On Windows the service uses `WindowsEnforcementBackend`
(`src/nam_agent/enforcement/windows.py`, chosen by `default_backend()`); other platforms still use
`NotImplementedBackend`. Three layers are installed and removed as one unit:

| Layer | What it does | Limits |
|-------|--------------|--------|
| Browser enterprise policies (`HKLM\SOFTWARE\Policies`) | Chrome, Edge, Brave, Chromium: `URLBlocklist` / `URLAllowlist` (Allow Only = block `*` + allowlist), `DnsOverHttpsMode=off` (block_doh), `QuicAllowed=0` (block_quic). Firefox: `WebsiteFilter`, DoH off. A blocked page shows the browser's own "blocked by your organization" error in the same tab. | Only with `enforce_browser_policies`. Chromium reloads policies by itself; Firefox on its next start. Browsers without policy support are not covered. |
| hosts file | Names the policy blocks are sinkholed to `0.0.0.0` for every app (exact names, plus `www.`/`m.` when §5 blocks them); redirect sources point at the local redirect server. Between `# BEGIN/END SoftProIt Network` markers. | No wildcards; not used in Allow Only mode. |
| Local redirect server (Redirection restrictions) | See below. | Needs port 443 free on 127.77.0.1. |
| Windows Firewall (group "SoftProIt Network") | Blocks `blocked_ips` (management addresses carved out), QUIC (UDP 443), DoT (853). | Outbound only. |

### Redirects

An HTTPS site cannot be redirected by pointing the hosts file at the target: the browser checks
the certificate and shows `NET::ERR_CERT_COMMON_NAME_INVALID`. So the service answers redirected
names itself:

1. `redirect_routes()` lists the names to redirect (exact sources; `www.`/`m.` for `*.x` sources).
2. `redirect_certs.py` creates a **root CA per rule set**, **name-constrained** (critical
   NameConstraints) to the source domains, uses it to sign one server certificate for exactly those
   names, and **discards the CA private key** (never written to disk). Only the server certificate
   and its key are kept, in `<data>\redirect\` (they can only vouch for the redirected names, which
   this machine already routes to itself).
3. `redirect_server.py` listens on **127.77.0.1:443** (HTTPS) and **:80** (HTTP) with
   `SO_EXCLUSIVEADDRUSE`, answers `302 Location: https://<target>/` (`Cache-Control: no-store`, no
   access log, unknown names 404), and the hosts file maps each name to `127.77.0.1`.
4. Only when HTTPS is listening is the CA added to the machine **Trusted Root** store (`certutil`;
   Chrome/Edge/Brave use it, Firefox via the `Certificates\ImportEnterpriseRoots` policy). Its
   thumbprint is in `enforcement-state.json`; the same certificate is reused until the names change
   or it is 30 days from expiry, then the old CA is removed and a new one created.
5. Removing the redirects, the restriction, stopping the service or uninstalling stops the server,
   removes the CA from the store and deletes the files.

If port 443 is taken (e.g. XAMPP/IIS on the same PC) the redirect sources are **blocked** through
the browser policies instead (the browser's clear "blocked by your organization" page), nothing is
trusted, and the log says `redirects: port 443 on 127.77.0.1 is in use by another program`. Port 80
taken only affects plain-HTTP visits (browsers try HTTPS first).

Browsers and tabs are never closed; the DNS cache is flushed after every apply. The management
server is always allowlisted and never sinkholed or firewalled. Registry values that existed before
the first apply are backed up to `<data>\enforcement-state.json` and restored by `remove()`. A failed
apply removes everything (clean state) and raises `EnforcementError`; the pipeline then restores the
previous policy. Matching follows contract §5 (`youtube.com` covers only that name: list
`*.youtube.com` too for its subdomains).

## Interface contract for a future enforcement component

`src/nam_agent/enforcement/base.py` defines `EnforcementBackend`:

```python
apply(policy: ValidatedPolicy, management: ManagementEndpoints) -> None
verify() -> VerifyResult
remove() -> None
status() -> EnforcementStatus
```

A conforming implementation must:

1. **apply** — replace all previously installed rules with those for `policy`
   atomically (all or nothing). On any failure, raise `EnforcementError` (optionally
   with `code`) and leave the system in either the previous state or the clean state,
   never a partial one. `policy.content` is already validated and normalized
   (A-label domains, validated IP/CIDR entries) per contract §4–§5.
2. **Keep the management server reachable, always.** Every rule set must exempt
   `management.hosts` (and subdomains, per §5 decision step 1) and
   `management.addresses` on `management.port`, regardless of `default_action`,
   `blocked_domains`, `blocked_ips` or the QUIC/DoT/DoH flags. The pipeline re-checks
   `GET /api/health` after `verify()` and rolls back with `management_unreachable`
   if it fails.
3. **verify** — inspect the live system (not in-memory state) and confirm it matches
   the last successful `apply()`. Return `ok=False` with a short, non-sensitive
   `detail` on mismatch; the pipeline then rolls back with `enforcement_verify_failed`.
4. **remove** — delete everything the component installed; used for
   `enabled: false` and when a first policy fails with no previous one to restore.
5. **status** — side-effect free; `ACTIVE` only when rules are installed and verified.
6. Implement §5 matching semantics exactly (`nam_agent.policy.domains.decide` is the
   reference implementation), treat a failed apply as fatal to the candidate only,
   survive service restarts (the service calls `apply()` with the cached policy at
   start-up), and never collect browsing data or inspect TLS contents.

The pipeline around the backend (`src/nam_agent/agent/pipeline.py`) already handles
staging, verification, management connectivity, activation, rollback to the
previous policy, and status/ack reporting. Wiring a new backend means returning it
from `nam_agent.enforcement.default_backend()`.
