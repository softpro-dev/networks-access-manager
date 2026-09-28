from .base import (
    EnforcementBackend,
    EnforcementError,
    EnforcementState,
    EnforcementStatus,
    ManagementEndpoints,
    VerifyResult,
)
from .not_implemented import NotImplementedBackend


def default_backend() -> EnforcementBackend:
    """The backend used by the service. Only NotImplementedBackend exists in this build."""
    return NotImplementedBackend()


__all__ = [
    "EnforcementBackend",
    "EnforcementError",
    "EnforcementState",
    "EnforcementStatus",
    "ManagementEndpoints",
    "NotImplementedBackend",
    "VerifyResult",
    "default_backend",
]
