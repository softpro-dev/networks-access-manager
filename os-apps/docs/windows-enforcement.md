# Windows enforcement

**Network enforcement is not included in this build.** The agent is the control
plane only: it enrolls, authenticates, heartbeats, downloads and validates policy,
caches it, and runs the apply/verify/rollback pipeline. It does not intercept DNS,
add firewall or WFP rules, write browser policies, or touch traffic in any way.

The only shipped backend is `NotImplementedBackend`
(`src/nam_agent/enforcement/not_implemented.py`):

| Call | Behaviour |
|------|-----------|
| `apply()` | raises `EnforcementError("ENFORCEMENT_NOT_AVAILABLE: ...")` |
| `verify()` | returns `ok=False` |
| `remove()` | no-op (nothing was ever installed) |
| `status()` | `ENFORCEMENT_NOT_AVAILABLE` |

Consequently, when an enabled policy is assigned the agent reports
`POST /policy/status {status: FAILED, error_code: policy_apply_failed}`, does not
ack, keeps `current_policy_version = 0`, and heartbeats `ENFORCEMENT_ERROR`. A
policy with `enabled: false` needs no enforcement and is marked active normally.

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
