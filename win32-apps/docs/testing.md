# Testing

## Automated (cross-platform)

```bash
cd win32-apps
python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest          # or scripts/run-tests.sh
```

On Windows `scripts\build.ps1` runs the same suite before building.

The suite uses an in-memory fake of `server-network` (`tests/fake_server.py`,
served through `httpx.MockTransport`) and a test-only `RecordingBackend`
(`tests/recording_backend.py`) that records calls and changes nothing on the system.
Secrets use the explicit `insecure-dev` protector.

| File | Covers |
|------|--------|
| `test_canonical.py` | canonical JSON; contract §4 test vector `0587ffd8…75cf`; ETag format |
| `test_domains.py` | §5 normalization, IDNA, invalid patterns, matching, specificity, ties, management exception; IP/CIDR rules |
| `test_identity.py` | UUID generated once, persists across DB reopen and agent restart, corrupt value never replaced |
| `test_config.py` | defaults, file vs env precedence, invalid values, https enforcement, no hardcoded server, token not leaked |
| `test_storage.py` | WAL, migrations, cache persistence across reopen, current/previous rotation, protected secrets |
| `test_enrollment.py` | register → PENDING → approval → credential claim, bearer header, token/secret deletion, bad token, 409 + re-enroll, token moved out of agent.env |
| `test_heartbeat.py` | payload has exactly the 5 allowed fields, STARTING/HEALTHY, server interval |
| `test_policy_sync.py` | first download + ack, no download when version equal, If-None-Match/304, version change, lower-version rollback, `enabled:false`, unassigned keeps cache, TTL version check |
| `test_validation.py` | bad JSON, unknown keys, schema, wrong org, wrong device, bad sha, ETag mismatch, bad domains/IPs, management exception; malformed policy never replaces working one |
| `test_rollback.py` | apply failure, verify failure, management unreachable, rollback failure, failure with no previous policy |
| `test_offline.py` | server down / 5xx → cached policy retained with backoff; restart offline re-asserts cache; reconnect; queued reports; revoked credential keeps enforcement |
| `test_not_implemented_backend.py` | NotImplementedBackend fails honestly → `FAILED/policy_apply_failed`, heartbeat `ENFORCEMENT_ERROR`, no ack |
| `test_interfaces.py` | adapter classification (Hyper-V, VMware, VirtualBox, VPN), primary selection, override |
| `test_configure.py`, `test_cli.py` | configure validation, connectivity requirement, token not in agent.env, org change needs `--reset-enrollment` |
| `test_api_client.py` | error envelope, 5xx/network, no redirects, URL joining, redaction |

## Windows integration test plan

Run on clean Windows 10 22H2 and Windows 11 23H2+ x64 VMs against a staging
`server-network`. Items marked **BLOCKED** depend on the enforcement component,
which is not part of this build; with `NotImplementedBackend` the expected result is
an honest `FAILED / policy_apply_failed` report and heartbeat `ENFORCEMENT_ERROR`.

| # | Area | Test | Expected |
|---|------|------|----------|
| 1 | Installation | Interactive + silent install as admin; install as standard user | Service installed, auto start, RUNNING; ACLs as in security.md; standard user refused |
| 2 | Device registration | First start after install | Device appears PENDING with hostname, Windows version, interfaces; primary = physical NIC |
| 3 | Administrator approval | Approve in server UI | Credential claimed within one poll interval; token deleted from store |
| 4 | Device naming | Rename device in server; rename Windows host + reboot | UUID unchanged; hostname refreshed only on re-registration |
| 5 | Policy assignment | Assign org/group/device policies | Heartbeat ref changes; agent downloads |
| 6 | Synchronization | Publish v+1; unchanged version | Download with If-None-Match; no re-download when equal |
| 7 | Cached policy | Stop server; restart service | Cached policy loaded from policy.db, re-asserted |
| 8 | Windows restart | Reboot | Same UUID, credential, cached policy |
| 9 | Service restart | `stop`/`start`; kill process | SCM recovery restarts it; state kept |
| 10 | Server outage | Stop server 10 min | Backoff ≤ 5 min; cached policy kept; DEGRADED then HEALTHY on recovery |
| 11 | DHCP IP change | Renew lease / switch network | Heartbeat `current_ip` updates |
| 12 | Standard user | Try `sc stop`, edit ProgramData, replace exe, uninstall | All denied |
| 13 | Revocation | Revoke credential | 403 → retries every 5 min, cached policy not removed |
| 14 | Browsers: Chrome, Edge, Firefox, Opera | Allowed/blocked domains | **BLOCKED** (enforcement component) |
| 15 | IPv4 / IPv6 | Blocked domains and `blocked_ips` over both families | **BLOCKED** |
| 16 | DNS-over-HTTPS | Browser DoH on; `block_doh` | **BLOCKED** |
| 17 | DNS-over-TLS | Port 853; `block_dot` | **BLOCKED** |
| 18 | HTTP/3, QUIC | UDP/443; `block_quic` | **BLOCKED** |
| 19 | VPN behaviour | Full-tunnel / split-tunnel VPN | Primary NIC selection correct (testable now); traffic behaviour **BLOCKED** |
| 20 | Direct IP access | Browse by IP literal | **BLOCKED** |
| 21 | Management exception | Policy blocking the management host / default block | Agent still reaches server (validator warning testable now; traffic **BLOCKED**) |
