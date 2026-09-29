# MASTER PROJECT PROMPT — Organization Network Access Management System

## Role

You are an expert in:

- Node.js, TypeScript, REST API architecture
- Python, Windows systems programming, Windows Services
- Windows networking, Windows Filtering Platform (WFP)
- MySQL
- Cybersecurity, secure software architecture
- Enterprise endpoint management

## Goal

Build a complete organization-managed network policy management system consisting of **TWO SEPARATE APPLICATIONS**:

| # | Application | Purpose | Absolute path |
|---|-------------|---------|---------------|
| 1 | `server-network` | Central Network Access Management server (Node.js / TypeScript) — the policy authority | `/Users/mamun/apps/network-access-manager/server-network` |
| 2 | `os-apps` | Windows Client Agent (Python) — packaged as a `.exe` running as a Windows Service, performs local enforcement | `/Users/mamun/apps/network-access-manager/os-apps` |

Workspace root: `/Users/mamun/apps/network-access-manager/`

```text
network-access-manager/
│
├── server-network/     # Application 1 — Node.js management server
├── os-apps/         # Application 2 — Python Windows Service agent (.exe)
└── docs/               # Shared, cross-application documentation
```

These are **independent applications** with separate source code, dependencies, configuration, builds, and documentation. Do not share code between them; they communicate only over the HTTPS REST API.

---

# APPLICATION 1 — `server-network`

**Path:** `/Users/mamun/apps/network-access-manager/server-network`

The `server-network` application is the central network access management server and policy authority.

## Technology

- Node.js + TypeScript
- Fastify or Express
- MySQL
- Prisma ORM
- Zod (or equivalent) schema validation
- HTTP/HTTPS REST API
- JWT/session authentication for administrators
- Secure password hashing (Argon2 or bcrypt)
- Structured logging
- Environment configuration
- Automated tests

## Responsibilities

The server manages:

- Organizations
- Administrators and Super Administrators
- Windows devices
- Device registration, approval, and credentials
- Network policies, policy versions, and policy assignments
- Device status and heartbeats
- Policy synchronization
- Audit logs

> The server **MUST NOT** process individual browser requests. The Windows Agent (`os-apps`) performs local enforcement.

## Directory Layout

```text
server-network/
├── src/
├── prisma/
├── tests/
├── scripts/
├── docs/
├── package.json
├── tsconfig.json
├── .env.example
├── README.md
└── ...
```

Suggested clean modular source structure (may be improved):

```text
src/
├── config/
├── modules/
│   ├── auth/
│   ├── organizations/
│   ├── users/
│   ├── devices/
│   ├── policies/
│   ├── agents/
│   └── audit/
├── middleware/
├── database/
├── services/
├── utils/
├── routes/
├── app.ts
└── server.ts
```

## Multi-Tenant Organization Model

The system must support multiple organizations, e.g.:

| Organization | ID |
|--------------|----|
| Organization A | `INST-001` |
| Organization B | `COMPANY-002` |
| Organization C | `BRANCH-003` |

Every device belongs to exactly one organization. A device belonging to Organization A must **NEVER** be able to retrieve Organization B's:

- policies
- devices
- configuration
- administrative data

Rules:

- Organization isolation must be enforced **server-side**.
- Never rely only on the client sending the correct organization ID.
- The **authenticated device identity** determines its organization.

## User Roles

Implement at least `SUPER_ADMIN` and `ORGANIZATION_ADMIN`.

**SUPER_ADMIN**

- Manage all organizations; create organizations
- Manage organization administrators
- View all devices; approve/revoke devices
- Manage policies
- View audit logs

**ORGANIZATION_ADMIN**

- Access only their own organization
- View their devices; approve/reject devices where permitted
- Manage policies for their organization
- View device status and policy status

Never allow an organization administrator to access another organization.

## Admin Authentication

Requirements:

- Password hashing
- Session/JWT authentication with secure token handling
- Authorization middleware and role-based access control
- Rate limiting and login validation
- Account status (active/disabled)
- Audit logging

Never store plaintext passwords. Never log passwords or authentication tokens.

## Device Registration

The agent registers through `POST /api/agent/register` with:

- `organization_id`
- `device_uuid`
- `hostname`
- MAC/interface information
- IPv4 / IPv6
- Windows version
- Agent version

Rules:

- A newly registered device is initially **`PENDING`**.
- An administrator must approve it.
- After approval, the server issues a **device-specific credential**.
- The server must **NOT** use `device_uuid` as authentication.
- The server must **NOT** use the MAC address as a secret.

## Device Credentials

Use a secure, practical device-specific authentication mechanism, such as:

- device token
- rotating credential
- certificate-based authentication

Requirements:

- The credential is bound to one device and one organization.
- A revoked credential must immediately block normal API access.
- Do not store raw credentials unnecessarily (store hashes).

## Agent APIs

Implement APIs similar to (REST design may be improved):

```http
POST /api/agent/register
GET  /api/agent/registration-status
POST /api/agent/heartbeat
GET  /api/agent/policy/version
GET  /api/agent/policy
POST /api/agent/policy/status
POST /api/agent/policy/ack
```

## Heartbeat

Default interval: **60 seconds**.

Heartbeat payload contains only:

- `device_uuid`
- `agent_version`
- `current_policy_version`
- `current_ip`
- `status`

Do **NOT** collect: browsing/browser history, page contents, keystrokes, cookies, passwords.

The server records: last heartbeat, device status, last IP, current policy version, agent version.

## Policy Management

Example policy (schema may be expanded):

```json
{
  "policy_id": "POL-001",
  "version": 7,
  "enabled": true,
  "allowed_domains": ["company.com", "*.company.com"],
  "blocked_domains": ["example.com", "*.example.com"],
  "block_quic": true
}
```

Support: creation, drafts, validation, publishing, versioning, assignment, rollback, activation/deactivation.

- Published policies are **immutable**.
- To change a published policy, create a new version.

## Policy Versioning

Example: Policy 1 → Version 5 → Version 6 → Version 7.

The agent first checks the current policy version:

- `local version == server version` → do not download the full policy.
- `local version != server version` → download the new policy.

Support `ETag`, `If-None-Match`, and `304 Not Modified` where appropriate.

## Policy Assignment

Policies may be assigned to:

- organization
- device
- device group

Implement a clean assignment model. The server decides which policy a device receives. The agent must never be able to request another organization's policy.

## Device Status (Admin View)

Administrators must see: Device, Organization, Hostname, UUID, Status, Approval status, Last heartbeat, Current IP, Agent version, Current policy, Policy status.

Do not collect unnecessary user activity.

## Audit Log

Record important events:

- login
- organization created
- administrator created
- device registered / approved / revoked
- policy created / published / assigned / rolled back
- policy application failure

Never record sensitive credentials.

## Database

Use **MySQL 8+ + Prisma** (`provider = "mysql"`). Create models for at least:

- `User`
- `Organization`
- `Device`
- `DeviceCredential`
- `Policy`
- `PolicyVersion`
- `PolicyAssignment`
- `DevicePolicyStatus`
- `AuditLog`

Use foreign keys, indexes, unique constraints, timestamps, and appropriate cascading behavior.

Create `prisma/schema.prisma`, database migrations, and development seed data.

## Configuration

Create `server-network/.env.example`:

```env
NODE_ENV=development
PORT=3000
DATABASE_URL=mysql://user:password@localhost:3306/network_manager
JWT_SECRET=CHANGE_ME
AGENT_REGISTRATION_TOKEN=CHANGE_ME
LOG_LEVEL=info
```

Never hardcode secrets.

---
---
---

<!-- ============================================================ -->
<!--            END OF APPLICATION 1 — server-network             -->
<!-- ============================================================ -->
<!--             START OF APPLICATION 2 — os-apps              -->
<!-- ============================================================ -->

---
---
---

# APPLICATION 2 — `os-apps`

**Path:** `/Users/mamun/apps/network-access-manager/os-apps`

The `os-apps` application contains the Python source code for the Windows Client Agent. It is built into a Windows executable (`OrganizationNetworkAgent.exe`) and runs as a **real Windows Service** on organization-owned Windows 10/11 computers.

| Property | Value |
|----------|-------|
| Service name | `OrganizationNetworkAgent` |
| Display name | `Organization Network Management Agent` |
| Executable | `OrganizationNetworkAgent.exe` |

> Development happens on macOS, but the build, service registration, and enforcement target Windows. Keep Windows-only imports (`pywin32`, etc.) isolated so that pure-logic modules and tests can run cross-platform.

## Technology

- Python 3
- pywin32
- httpx
- pydantic
- python-dotenv
- SQLite
- logging

Additional dependencies only when justified.

## Directory Layout

```text
os-apps/
├── src/
├── tests/
├── installer/
├── scripts/
├── native/
├── docs/
├── requirements.txt
├── .env.example
├── README.md
└── ...
```

Suggested source structure (may be improved):

```text
src/
├── agent/
├── service/
├── api/
├── identity/
├── network/
├── policy/
├── storage/
├── security/
├── logging/
├── config/
└── main.py
```

## Device UUID

- Generate a cryptographically random UUID during first installation.
- It must remain unchanged across service restarts and Windows restarts.
- Do **NOT** generate a new UUID on each service start.
- The UUID is an **identifier**, not a secret.

## Network Interface Discovery

Record for each interface: name, MAC address, IPv4, IPv6, interface type.

- Do not use the MAC address as authentication.
- Avoid treating Hyper-V, VMware, VirtualBox, or VPN adapters as the primary physical interface unless explicitly configured.

## Configuration

Create `os-apps/.env.example`:

```env
ORGANIZATION_ID=INST-001
API_BASE_URL=https://management.example.com/api
DEVICE_REGISTRATION_TOKEN=CHANGE_ME
POLICY_CACHE_TTL=300
HEARTBEAT_INTERVAL=60
LOG_LEVEL=INFO
VERIFY_TLS=true
```

Do **NOT** hardcode the management server.

## Registration Flow

```text
First startup:
  os-apps Agent → POST /api/agent/register → server-network → PENDING
  Agent waits for administrator approval

After approval:
  server-network → Device Credential → os-apps Agent
```

- Store the credential securely (e.g., Windows DPAPI, machine scope).
- Authenticate all subsequent requests with it.
- Never use `device_uuid` alone as authentication.

## Local Database

Use SQLite at:

```text
C:\ProgramData\OrganizationNetworkAgent\data\policy.db
```

Store: device UUID, device state, authentication metadata, current policy, previous policy, policy version, policy status, synchronization state, runtime state.

The database must survive Windows restarts, service restarts, and temporary server outages.

## Policy Cache

The agent must always retain the last known valid policy.

```text
Server unavailable → Cached Policy v7 → Continue enforcement
```

Do **NOT** remove restrictions because the server is offline. When the server returns:

```text
Reconnect → Authenticate → Heartbeat → Check policy version
  → Download if required → Validate → Apply → Report
```

## Policy Validation

Before applying a new policy:

1. Validate JSON
2. Validate schema
3. Validate organization
4. Validate device assignment
5. Validate policy version
6. Validate domain syntax
7. Validate management-server exception
8. Validate enforcement configuration
9. Preserve previous policy
10. Apply candidate policy
11. Verify enforcement
12. Mark policy active

Malformed policies must never replace a working policy.

## Rollback

Keep at least the previous valid policy.

```text
v6 = active
v7 = candidate
v7 fails → rollback to v6 → report "policy_apply_failed" to server
```

## Windows Service

Use pywin32. The service must:

- Start automatically and run in the background
- Load the cached policy
- Connect and authenticate to the server
- Send heartbeats
- Synchronize and apply policy
- Log errors
- Recover from temporary server failures

Do **NOT** use Startup folder entries, visible terminal windows, hidden scripts, or stealth persistence. This is a legitimate Windows Service.

## Windows Network Enforcement

This is the most technically important part of `os-apps`.

- The Python service is the **CONTROL PLANE**.
- The Windows networking component is the **ENFORCEMENT PLANE**.

Do not assume Python alone can provide complete low-level Windows network filtering. Analyze and select the correct Windows-native technology from:

- Windows Filtering Platform (WFP)
- Windows Firewall
- Windows DNS
- Windows system proxy
- WFP callout
- Native C/C++ helper
- WFP driver

Select the safest practical architecture.

- If a native C/C++ component is required, place it under `os-apps/native/`.
- If a kernel-mode WFP callout driver is genuinely required, document the Windows SDK / WDK / Visual Studio / driver-signing requirements and create all safe, buildable components possible.
- Do **NOT** create fake enforcement.

## Website Policy

Support domain policy such as:

```json
{
  "allowed_domains": ["company.com", "*.company.com"],
  "blocked_domains": ["example.com", "*.example.com"]
}
```

Define clearly:

- Exact domain matching
- Subdomain matching
- Wildcard behavior
- Case normalization
- Trailing-dot normalization
- IDN / punycode
- IP literals

## Network Protocols

Explicitly address: IPv4, IPv6, HTTP, HTTPS, DNS, DNS-over-HTTPS, DNS-over-TLS, QUIC, HTTP/3, VPN, proxy, direct IP access.

- Do not falsely claim complete domain enforcement using only IP rules.
- Do not claim DNS filtering automatically defeats DoH/DoT.
- Do not claim VPN traffic can always be controlled unless the chosen mechanism actually provides that.
- Document limitations.

## No HTTPS MITM

**NEVER** implement: HTTPS MITM, TLS interception, fake root CA, certificate injection, HTTPS decryption, page-content inspection. The agent does not need to see HTTPS page contents.

## No Surveillance

The agent must **NOT** implement: keylogging, password collection, browser password extraction, cookie extraction, screen/webcam/microphone capture, browser history collection, page-content collection, credential theft, rootkits, process injection, hidden remote control, or malware persistence.

Only collect what is required for device identification, management, heartbeat, policy enforcement, and diagnostics.

## Management Server Exception

The management server defined by `API_BASE_URL` must always remain reachable. Before applying a policy:

1. Resolve management endpoints.
2. Determine required network destinations.
3. Create an enforcement exception.
4. Apply candidate policy.
5. Verify management connectivity.
6. Activate the policy.

Never accidentally block the management server.

## Standard User Security

The agent is installed with administrator privileges. Standard users must not be able to easily:

- Edit policy files
- Replace agent binaries
- Stop the service
- Modify configuration
- Uninstall the agent

Use proper Windows ACLs and Windows Service permissions. Do **NOT** use stealth techniques.

Document that a user with full local Administrator privileges may be able to modify local security controls. For stronger enterprise enforcement, recommend Group Policy, Microsoft Intune, MDM, and enterprise firewall/network controls where appropriate.

## Windows File Locations

| Purpose | Path |
|---------|------|
| Application | `C:\Program Files\OrganizationNetworkAgent\` |
| Persistent data | `C:\ProgramData\OrganizationNetworkAgent\` |
| Logs | `C:\ProgramData\OrganizationNetworkAgent\logs\` |
| Database | `C:\ProgramData\OrganizationNetworkAgent\data\policy.db` |

Apply proper ACLs.

## Admin Configuration Utility

Create a configuration utility for initial setup that lets an administrator configure:

```text
Organization ID:     INST-001
Server:              https://management.example.com/api
Registration Token:  ********
```

The utility must validate server connectivity before completing setup.

## Packaging (`.exe` Build)

- Package with **PyInstaller** → `OrganizationNetworkAgent.exe`
- Build a Windows installer with **Inno Setup**

The installer must:

- Require administrator privileges
- Install application files and create directories
- Configure organization, API URL, and registration token
- Configure Windows ACLs
- Register the Windows Service with automatic startup
- Start the service and verify its status

Provide build scripts under `os-apps/scripts/` (e.g., `build.ps1`) and the Inno Setup script under `os-apps/installer/`. Document that the `.exe` must be built on Windows (PyInstaller does not cross-compile).

## Organization Configuration

The same executable must support multiple organizations (`INST-001`, `COMPANY-002`, `BRANCH-003`, …).

- Do **NOT** compile a separate source tree per organization.
- Organization configuration must be external.

## Performance

The agent must be lightweight. Avoid:

- Continuous packet capture or traffic inspection
- CPU-heavy scanning
- Sending browser traffic to the server
- Unnecessary logging

Normal operation is primarily: heartbeat, policy version check, occasional policy download, local policy enforcement.

---

# SHARED REQUIREMENTS

## Security

Use: TLS, certificate verification, secure credential storage, least privilege, input validation, schema validation, rate limiting, audit logging, secure filesystem permissions, secure Windows Service permissions.

Never hardcode: passwords, API secrets, organization credentials, device credentials.

## Testing

Create automated tests for both applications.

**`server-network` tests**

- Authentication and authorization
- Organization isolation
- Device registration and approval
- Policy creation, assignment, and versioning
- Heartbeat
- Revoked devices
- Invalid requests

**`os-apps` tests**

- UUID persistence
- Configuration
- Registration and authentication
- Heartbeat
- Policy synchronization
- SQLite cache
- Policy validation and rollback
- Offline behavior

**Windows integration test plan** (document in `os-apps/docs/testing.md`):

- Installation, device registration, administrator approval, device naming
- Policy assignment, synchronization, cached policy
- Windows restart, service restart, server outage, DHCP IP change
- Browsers: Chrome, Edge, Firefox, Opera
- IPv4, IPv6, DNS-over-HTTPS, DNS-over-TLS, HTTP/3, QUIC
- VPN behavior, direct IP access

Document limitations instead of pretending every bypass is prevented.

## Documentation

Each application gets its own `README.md` and `docs/`:

- `README.md`
- `docs/architecture.md`
- `docs/security.md`
- `docs/api.md`
- `docs/deployment.md`
- `docs/windows-enforcement.md` (`os-apps`)
- `docs/testing.md`
- `docs/troubleshooting.md`

Explain:

- System architecture
- Node.js installation, MySQL setup, database migration, server configuration
- Python agent setup, `.exe` build, Windows Service installation
- Policy lifecycle
- Enforcement architecture
- Security boundaries
- Limitations
- Troubleshooting

## Final Project Structure

```text
/Users/mamun/apps/network-access-manager/
│
├── server-network/
│   ├── src/
│   ├── prisma/
│   ├── tests/
│   ├── scripts/
│   ├── docs/
│   ├── package.json
│   ├── tsconfig.json
│   ├── .env.example
│   └── README.md
│
├── os-apps/
│   ├── src/
│   ├── tests/
│   ├── native/
│   ├── installer/
│   ├── scripts/
│   ├── docs/
│   ├── requirements.txt
│   ├── .env.example
│   └── README.md
│
└── docs/
    ├── architecture.md
    ├── security.md
    ├── deployment.md
    ├── testing.md
    └── limitations.md
```

---

# IMPLEMENTATION RULES

- Do **NOT** merely create a design document.
- Do **NOT** repeat this prompt.
- Do **NOT** stop and ask me to design the architecture — you are responsible for reasonable technical decisions.
- If a requirement cannot be implemented exactly as described, do **NOT** fake it. Instead:
  - Implement the closest safe and technically correct solution.
  - Clearly document the limitation.
  - Create the appropriate abstraction/interface.
  - Implement every component that can actually be implemented.
  - Identify any external dependency required for the remaining part.

## Implementation Order

| Phase | Work |
|-------|------|
| 1 | Create `server-network/` and `os-apps/` and establish both project foundations |
| 2 | `server-network`: database and server foundation |
| 3 | `server-network`: authentication and RBAC |
| 4 | `server-network`: organizations and multi-tenancy |
| 5 | `server-network`: device registration and approval |
| 6 | `server-network`: policy management and versioning |
| 7 | `server-network`: agent APIs |
| 8 | `os-apps`: agent foundation |
| 9 | `os-apps`: Windows Service |
| 10 | `os-apps`: device identity and network discovery |
| 11 | `os-apps`: secure server communication |
| 12 | `os-apps`: heartbeat and policy synchronization |
| 13 | `os-apps`: SQLite policy cache |
| 14 | `os-apps`: policy validation and rollback |
| 15 | `os-apps`: Windows-native network enforcement |
| 16 | `os-apps`: configuration utility |
| 17 | `os-apps`: PyInstaller `.exe` build |
| 18 | `os-apps`: Inno Setup installer |
| 19 | Automated tests (both apps) |
| 20 | Complete documentation |

---

# IMPORTANT

The final result must be **TWO real applications**:

- **`server-network`** (`/Users/mamun/apps/network-access-manager/server-network`) — central Node.js network access management server and policy authority.
- **`os-apps`** (`/Users/mamun/apps/network-access-manager/os-apps`) — Python Windows Client Agent, built as `OrganizationNetworkAgent.exe`, running as a Windows Service and performing local policy enforcement.

Principles:

- The server does **NOT** process individual browser requests.
- The agent does **NOT** send browser traffic to the server.
- The central server distributes policies; the Windows agent applies them locally.

Start by creating the two application directories and their project foundations, then continue implementing the phases. Do not stop merely because the repository is initially empty.
