# Architecture

`OrganizationNetworkAgent.exe` is a Windows Service (pywin32) that acts as the
**control plane** between a Windows 10/11 device and `server-network`. The
enforcement plane is an interface only in this build (see
[windows-enforcement.md](windows-enforcement.md)).

## Modules (`src/nam_agent/`)

| Package | Responsibility |
|---------|----------------|
| `config/` | `paths.py` data-root layout; `settings.py` pydantic settings from `agent.env` + environment; `configure.py` admin configuration utility |
| `identity/` | persistent UUIDv4 device id; hostname / Windows version |
| `network/` | interface inventory: `win_adapters.py` (`GetAdaptersAddresses` via ctypes, Windows), `fallback.py` (dev hosts), pure classification and primary selection |
| `security/` | `SecretProtector` (DPAPI machine scope / explicit insecure-dev), `SecretStore`, elevation check, log redaction |
| `storage/` | SQLite (`policy.db`, WAL, migrations) |
| `api/` | httpx client for the wire contract, error types, backoff |
| `policy/` | canonical JSON + sha256, §5 domain rules, IP/CIDR rules, strict schema, validator (steps 1–8) |
| `enforcement/` | `EnforcementBackend` interface, `NotImplementedBackend`, management endpoint resolution |
| `agent/` | `enrollment.py` state machine, `pipeline.py` apply/verify/rollback (steps 9–12), `core.py` scheduling loop, `runtime.py` wiring |
| `service/` | SCM host (`windows_service.py`), service control (`control.py`), shared service body (`host.py`) |
| `logs/` | rotating file log + Event Log handler |
| `cli.py` | single-exe subcommands |

Windows-only modules (`win32*`, `servicemanager`, `winreg`, `ctypes.windll`) are
imported lazily inside functions or in modules imported only on Windows, so every
other module and the test suite run on macOS/Linux.

## Runtime flow

```
start
  └─ open policy.db, load device_uuid (create once), import registration token
  └─ load cached policy → backend.apply(cached) (re-assert after reboot)
loop
  ├─ not enrolled: register → poll registration-status (45 s) → store credential
  └─ enrolled, every heartbeat interval (server value, default 60 s):
       heartbeat → [policy/version when POLICY_CACHE_TTL elapsed]
       → if (policy_id, version) ≠ active: GET /policy (If-None-Match: active ETag)
       → 304: nothing │ 200: DOWNLOADED → validate 1–8 → APPLYING
         → apply → verify → management health check → promote → ack
         → on failure: re-apply previous (ROLLED_BACK) or clean state (FAILED)
```

Failures: network/5xx → exponential backoff with jitter (5 s → 300 s);
401/403 → keep cached policy, retry every 300 s; status reports that cannot be
delivered are queued in SQLite and flushed after the next heartbeat.

## Policy lifecycle on the device

| Slot (`policies` table) | Meaning |
|-------------------------|---------|
| `current` | last policy that was applied, verified and acked (enforced) |
| `previous` | the one before it (rollback target) |
| `candidate` | staged during apply; removed on success or failure |

Promotion (`current → previous`, `candidate → current`) is one SQLite
transaction. Nothing but a successful apply changes `current`; no network
condition, credential problem, or "no policy assigned" response removes it.
A candidate that failed is not re-attempted until `POLICY_CACHE_TTL` has passed.

## Heartbeat status

| Value | When |
|-------|------|
| `STARTING` | first heartbeat after service start |
| `ENFORCEMENT_ERROR` | last apply/rollback left enforcement failed, or an enabled active policy is not `ACTIVE` in the backend |
| `DEGRADED` | the previous cycle hit a server/network/auth error |
| `HEALTHY` | otherwise |
