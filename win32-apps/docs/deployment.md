# Deployment

## Build (Windows 10/11 x64 only)

PyInstaller does not cross-compile. The `.exe` **must be built on Windows x64**
with 64-bit Python 3.11+ and (for the installer) Inno Setup 6.

```powershell
cd win32-apps
powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Installer
# -> dist\OrganizationNetworkAgent\OrganizationNetworkAgent.exe  (onedir)
# -> installer\Output\OrganizationNetworkAgent-1.0.0-setup.exe
```

`build.ps1` creates `.venv`, installs `requirements-dev.txt` (includes pywin32 and
PyInstaller on Windows), runs the tests, builds with `OrganizationNetworkAgent.spec`,
and smoke-runs `--version`.

**Why onedir:** onefile unpacks to `%TEMP%\_MEI*` on every start. For a LocalSystem
service that is slower, attracts AV heuristics, leaves stale directories after
crashes, and loads DLLs from outside the ACL-protected Program Files tree. onedir
keeps all binaries under `C:\Program Files\OrganizationNetworkAgent\`.

Sign the exe and installer with your organization's code-signing certificate before
distribution.

## Install

Interactive: run the setup as Administrator and enter Organization ID, Server
(`https://…/api`) and Registration Token. Setup:

1. installs to `C:\Program Files\OrganizationNetworkAgent\`
2. creates `C:\ProgramData\OrganizationNetworkAgent\{config,data,logs}` and applies ACLs (icacls)
3. runs `configure` (validates input, `GET /api/health` over verified TLS, stores the token with DPAPI)
4. `install` → service `OrganizationNetworkAgent`, automatic start
5. `sc failure` (restart 5 s/30 s/60 s, reset daily), `sc failureflag 1`, `sc sdset`
6. `start`, which fails unless the service reaches RUNNING

Silent: `setup.exe /VERYSILENT /ORG=INST-001 /SERVER=https://management.example.com/api /TOKENFILE=C:\path\token.txt`
(delete the token file afterwards). The same executable serves every organization;
only configuration differs.

## Manual service management (elevated prompt)

```powershell
$exe = "C:\Program Files\OrganizationNetworkAgent\OrganizationNetworkAgent.exe"
& $exe configure --organization-id INST-001 --server-url https://management.example.com/api   # prompts for token
& $exe install; & $exe start; & $exe status
& $exe stop; & $exe uninstall
```

`configure` options: `--token-stdin`, `--token-file`, `--ca-bundle`,
`--no-verify-tls` (not for production), `--reset-enrollment` (required to move an
enrolled device to another organization; keeps the device UUID).

## Configuration keys (`agent.env` / environment)

| Key | Default | Notes |
|-----|---------|-------|
| `ORGANIZATION_ID` | — | required, `^[A-Z0-9][A-Z0-9-]{1,31}$` |
| `API_BASE_URL` | — | required, https, includes `/api` |
| `DEVICE_REGISTRATION_TOKEN` | — | dev only; moved into the DPAPI store on start |
| `POLICY_CACHE_TTL` | 300 | seconds between explicit version checks, and before retrying a failed candidate. The cached policy never expires. |
| `HEARTBEAT_INTERVAL` | 60 | used until the server supplies `heartbeat_interval_seconds` |
| `LOG_LEVEL` | INFO | |
| `VERIFY_TLS` | true | |
| `CA_BUNDLE` | — | PEM file |
| `HTTP_TIMEOUT` | 15 | seconds |
| `ENROLLMENT_POLL_INTERVAL` | 45 | 30–600 |
| `PRIMARY_INTERFACE` | — | force a primary adapter by name (e.g. a VPN) |
| `NAM_DATA_DIR` | `%ProgramData%\OrganizationNetworkAgent` | dev/test override |
| `NAM_SECRET_PROTECTOR` | dpapi | `insecure-dev` for non-Windows dev only |
| `NAM_ALLOW_INSECURE_HTTP` | false | dev only |

After changing configuration: `stop` then `start` the service.

## Uninstall

Apps & Features → uninstall (requires admin): stops and removes the service and
program files. `C:\ProgramData\OrganizationNetworkAgent` is kept so a reinstall keeps
the device UUID; delete it to wipe the device completely.
