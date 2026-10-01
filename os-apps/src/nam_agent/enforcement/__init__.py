from pathlib import Path

from .base import (
    EnforcementBackend,
    EnforcementError,
    EnforcementState,
    EnforcementStatus,
    ManagementEndpoints,
    VerifyResult,
)
from .not_implemented import NotImplementedBackend


def default_backend(state_dir: Path | None = None) -> EnforcementBackend:
    """The backend used by the service: hosts + browser policies + firewall on Windows
    (enforcement/windows.py); NotImplementedBackend elsewhere (macOS enforcement is not built)."""
    from .windows import WindowsEnforcementBackend, is_supported

    if is_supported() and state_dir is not None:
        return WindowsEnforcementBackend(state_dir / "enforcement-state.json")
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
