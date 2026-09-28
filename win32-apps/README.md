# win32-apps — Organization Network Management Agent

Python Windows Service (`OrganizationNetworkAgent.exe`, service name
`OrganizationNetworkAgent`) that enrolls a Windows 10/11 x64 device with
`server-network`, authenticates with a device credential, sends heartbeats, and
downloads, validates, caches and applies network policy per
[`../docs/api-contract.md`](../docs/api-contract.md).

> **Scope of this build: control plane only.** Network enforcement is not included.
> The only enforcement backend, `NotImplementedBackend`, makes no network changes and
> reports `ENFORCEMENT_NOT_AVAILABLE`, so an enabled policy is reported as
> `FAILED / policy_apply_failed` and heartbeats say `ENFORCEMENT_ERROR`. See
> [docs/windows-enforcement.md](docs/windows-enforcement.md) for the interface a
> future Windows-native component must implement.

## What it does

* Persistent UUIDv4 device identity (generated once, stored in SQLite)
* Enrollment: register → wait for admin approval → claim one-time credential
* Secrets (registration token, enrollment secret, credential) encrypted with DPAPI
  machine scope; token deleted after enrollment
* Heartbeat every 60 s (server-controlled) with only the five contract fields
* Policy sync with version check, `If-None-Match`/304, strict validation (schema,
  unknown keys, org, device, canonical-JSON sha256, domain/IP syntax, management
  exception), current/previous cache, apply → verify → management check → ack, and
  rollback on failure
* Offline-safe: the cached policy is never dropped because the server is unreachable
* Real Windows Service (pywin32), Event Log + rotating file logs, recovery actions,
  restrictive service DACL and ProgramData ACLs via the Inno Setup installer

## Layout

```
src/main.py                 entry point (PyInstaller)
src/nam_agent/              agent, api, config, enforcement, identity, logs, network,
                            policy, security, service, storage, cli.py
tests/                      pytest suite, fake server, test-only recording backend
installer/                  Inno Setup script
scripts/                    build.ps1 (Windows), run-tests.sh (dev)
native/                     README only: no native component in this build
docs/                       architecture, security, api, deployment,
                            windows-enforcement, testing, troubleshooting
OrganizationNetworkAgent.spec  PyInstaller (onedir)
```

## Development (macOS / Linux)

```bash
python3.12 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest

# foreground run against a dev server (no DPAPI off Windows):
export NAM_DATA_DIR=$PWD/.nam-data NAM_SECRET_PROTECTOR=insecure-dev
export ORGANIZATION_ID=INST-001 API_BASE_URL=https://localhost:3000/api DEVICE_REGISTRATION_TOKEN=...
.venv/bin/python src/main.py run
```

Windows-only imports (`win32*`, `servicemanager`, `winreg`, `ctypes.windll`) are
lazy, so everything except the service host itself runs on macOS.

## Build and install (Windows x64 only)

The `.exe` must be built on Windows x64 — PyInstaller does not cross-compile.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Installer
```

Then run `installer\Output\OrganizationNetworkAgent-1.0.0-setup.exe` as
Administrator. Details: [docs/deployment.md](docs/deployment.md).

## Commands

| Command | Purpose |
|---------|---------|
| *(no args)* | host the service (used by the SCM) |
| `configure` | organization, server, registration token; verifies `GET /api/health` over TLS (admin) |
| `install` / `uninstall` | register / remove the service (admin) |
| `start` / `stop` | control the service (admin) |
| `status` | service state + local agent state |
| `run` | foreground debug run |

## Configuration

See `.env.example` and the key table in [docs/deployment.md](docs/deployment.md).
Production config lives in `C:\ProgramData\OrganizationNetworkAgent\config\agent.env`
(written by `configure`); environment variables override it. There is no default server.

## Limitations

* No network enforcement in this build.
* A local Administrator can always stop or remove the agent; use GPO/Intune/MDM and
  network-level controls for stronger guarantees.
* Hostname/interface facts are sent at registration only; heartbeats carry `current_ip`.
