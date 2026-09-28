# Troubleshooting

Logs: `C:\ProgramData\OrganizationNetworkAgent\logs\agent.log` (5 MB × 5 rotation).
Start/stop and errors also go to **Event Viewer → Windows Logs → Application**,
source `OrganizationNetworkAgent`. Local state: `OrganizationNetworkAgent.exe status`
(elevated).

| Symptom | Cause / action |
|---------|----------------|
| `configure` fails "server connectivity check failed" | Wrong URL (must include `/api`), DNS, proxy/firewall, or TLS: untrusted certificate → install the CA or pass `--ca-bundle` |
| `invalid agent configuration` in log / Event Log | `agent.env` missing or invalid; re-run `configure`. The service stays running and re-reads config every 60 s |
| `enrollment_state: NEEDS_CONFIGURATION` | No registration token; run `configure` |
| Registration rejected `INVALID_REGISTRATION_TOKEN` | Wrong token or organization (unknown orgs also return this) |
| Stuck `PENDING` | Approve the device in the server UI; agent polls every 45 s |
| `DEVICE_ALREADY_REGISTERED` | The UUID is bound to another enrollment secret (e.g. credential response lost, disk restored). Use "re-enroll" on the server; the agent retries every 5 min |
| `last_auth_error: INVALID_CREDENTIAL / CREDENTIAL_REVOKED` | Credential revoked or device reset. Cached policy stays in force. Re-enroll on the server, then run `configure` with a registration token; the agent re-enrolls automatically |
| Heartbeat `ENFORCEMENT_ERROR`, policy `FAILED policy_apply_failed` with `ENFORCEMENT_NOT_AVAILABLE` | Expected in this build: no enforcement component is installed |
| `VALIDATION_FAILED` | Message names the failed step (org, device, sha, domain syntax…). The previous policy remains active. The same version is retried after `POLICY_CACHE_TTL` |
| DPAPI "could not decrypt" | `policy.db` copied from another machine, or protector changed. Re-enroll the device |
| `stored device_uuid is corrupt` | Database tampered/corrupted. The agent refuses to invent a new identity; restore the DB or delete `data\policy.db` and re-enroll (new UUID) |
| `sc stop` "Access is denied" as standard user | By design (service DACL) |

Debug in the foreground (elevated, after stopping the service):

```powershell
& "C:\Program Files\OrganizationNetworkAgent\OrganizationNetworkAgent.exe" run
```
