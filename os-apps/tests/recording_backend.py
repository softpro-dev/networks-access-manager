"""Test-only EnforcementBackend that records calls and makes NO system changes."""

from __future__ import annotations

from nam_agent.enforcement.base import (
    EnforcementBackend,
    EnforcementError,
    EnforcementState,
    EnforcementStatus,
    ManagementEndpoints,
    VerifyResult,
)
from nam_agent.policy.validator import ValidatedPolicy


class RecordingBackend(EnforcementBackend):
    name = "recording-test"

    def __init__(self) -> None:
        self.calls: list[tuple] = []
        self.installed: ValidatedPolicy | None = None
        self.fail_apply: set[int] = set()
        self.fail_verify: set[int] = set()
        self.fail_remove = False
        self.last_management: ManagementEndpoints | None = None

    def apply(self, policy: ValidatedPolicy, management: ManagementEndpoints) -> None:
        self.calls.append(("apply", policy.policy_id, policy.version))
        self.last_management = management
        if policy.version in self.fail_apply:
            raise EnforcementError("simulated filter add failure 0x80320009")
        self.installed = policy

    def verify(self) -> VerifyResult:
        v = self.installed.version if self.installed else None
        self.calls.append(("verify", v))
        if v in self.fail_verify:
            return VerifyResult(False, "simulated verify mismatch")
        return VerifyResult(self.installed is not None)

    def remove(self) -> None:
        self.calls.append(("remove",))
        if self.fail_remove:
            raise EnforcementError("simulated remove failure")
        self.installed = None

    def status(self) -> EnforcementStatus:
        if self.installed:
            return EnforcementStatus(EnforcementState.ACTIVE, "", self.installed.policy_id, self.installed.version)
        return EnforcementStatus(EnforcementState.INACTIVE)

    def applied_versions(self) -> list[int]:
        return [c[2] for c in self.calls if c[0] == "apply"]
