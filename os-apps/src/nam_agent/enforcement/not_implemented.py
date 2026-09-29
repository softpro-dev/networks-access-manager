"""The only backend shipped in this build: performs no network changes and says so."""

from __future__ import annotations

from ..policy.validator import ValidatedPolicy
from .base import (
    EnforcementBackend,
    EnforcementError,
    EnforcementState,
    EnforcementStatus,
    ManagementEndpoints,
    VerifyResult,
)

_DETAIL = "no network enforcement component is included in this build"


class NotImplementedBackend(EnforcementBackend):
    name = "not-implemented"

    def apply(self, policy: ValidatedPolicy, management: ManagementEndpoints) -> None:
        raise EnforcementError(f"ENFORCEMENT_NOT_AVAILABLE: {_DETAIL}", code="policy_apply_failed")

    def verify(self) -> VerifyResult:
        return VerifyResult(ok=False, detail=f"ENFORCEMENT_NOT_AVAILABLE: {_DETAIL}")

    def remove(self) -> None:
        # Nothing was ever installed, so the clean state already holds.
        return None

    def status(self) -> EnforcementStatus:
        return EnforcementStatus(EnforcementState.ENFORCEMENT_NOT_AVAILABLE, _DETAIL)
