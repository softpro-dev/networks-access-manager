# Security

## Secrets

| Secret | Lifetime | Storage |
|--------|----------|---------|
| Registration token | until the device credential is claimed (or first successful heartbeat) | DPAPI blob in `policy.db` → deleted |
| Enrollment secret (32 random bytes, base64url) | register → credential claim | DPAPI blob → deleted; only its sha256 is sent at registration |
| Device credential `ndc_<id>.<secret>` | until revoked | DPAPI blob |

* DPAPI is used with `CRYPTPROTECT_LOCAL_MACHINE` (machine scope) because the service
  runs as LocalSystem and must decrypt without a user profile. Machine-scope DPAPI
  protects against the file being copied to another machine; on the same machine
  the protection is the ACL on `C:\ProgramData\OrganizationNetworkAgent` (SYSTEM +
  Administrators only, Users no access).
* `configure` never writes the token to `agent.env`. If an admin puts
  `DEVICE_REGISTRATION_TOKEN` in `agent.env`, the service moves it into the protected
  store and removes the line on start.
* `NAM_SECRET_PROTECTOR=insecure-dev` stores secrets **unencrypted** (marker-prefixed).
  It exists for macOS/Linux development and tests only and must be set explicitly.
* All log handlers pass through a redaction filter (`ndc_…`, `Bearer …`,
  registration/enrollment headers). Exceptions from the API client never include
  header values. Status-report messages are redacted and capped at 1000 characters.
* `device_uuid` and MAC addresses are identifiers, never credentials.

## Transport

* HTTPS only; `http://` is refused unless `NAM_ALLOW_INSECURE_HTTP=true` (development).
* Certificate verification on by default (`VERIFY_TLS=true`); `CA_BUNDLE` adds a
  private CA. `VERIFY_TLS=false` / `--no-verify-tls` is for lab use only; the service
  logs a warning at start when verification is disabled.
* Redirects are not followed, so the bearer credential cannot leak to another host.
* Response bodies are size-limited (policy ≤ 4 MiB) and schema-validated.

## Policy integrity

A policy replaces the active one only after steps 1–12 pass, including org and device
binding and the canonical-JSON sha256. Malformed, tampered, foreign-org or
foreign-device documents are reported as `VALIDATION_FAILED` and never stored as
`current`.

## Local hardening (installer)

| Object | ACL |
|--------|-----|
| `C:\ProgramData\OrganizationNetworkAgent\` (config, data, logs) | inheritance removed; SYSTEM F, Administrators F; no Users entry |
| `C:\Program Files\OrganizationNetworkAgent\` | SYSTEM F, Administrators F, Users RX |
| Service DACL (`sc sdset`) | SYSTEM/Administrators full; IU/SU/AU query only (`CCLCSWLORC`): standard users cannot stop, reconfigure or delete the service |
| Service binary path | quoted by pywin32 (no unquoted-path hijack) |

Standard users therefore cannot edit policy/config, replace binaries, stop the
service or uninstall (the uninstaller requires elevation).

## Limitations

* A user with local Administrator rights can stop or remove the service, read the
  DPAPI blobs, and change any local control. This is inherent to Windows. For stronger
  guarantees remove local admin rights and use Group Policy, Microsoft Intune/MDM,
  and network-level controls (enterprise firewall, DNS filtering).
* No network enforcement exists in this build (see windows-enforcement.md).

## Privacy

The agent collects only: hostname, Windows version, agent version, interface
inventory (name, MAC, IPs, type) at registration, and the five heartbeat fields. It
does not collect browsing history, page contents, keystrokes, cookies, passwords,
screenshots or any user activity.
