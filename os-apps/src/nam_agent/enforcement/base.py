"""Enforcement plane interface.

The Python service is the control plane. A Windows-native enforcement component
(not included in this build) must implement this interface. See
docs/windows-enforcement.md for the contract.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum

from ..policy.validator import ValidatedPolicy


class EnforcementState(str, Enum):
    ACTIVE = "ACTIVE"  # rules for `policy` are installed and verified
    INACTIVE = "INACTIVE"  # nothing installed (clean state)
    ERROR = "ERROR"  # backend present but in a failed/unknown state
    ENFORCEMENT_NOT_AVAILABLE = "ENFORCEMENT_NOT_AVAILABLE"  # no enforcement component on this machine


@dataclass(frozen=True)
class ManagementEndpoints:
    """Destinations that must stay reachable regardless of policy."""

    hosts: tuple[str, ...]
    addresses: tuple[str, ...] = ()
    port: int = 443


@dataclass(frozen=True)
class EnforcementStatus:
    state: EnforcementState
    detail: str = ""
    policy_id: str | None = None
    version: int | None = None


@dataclass(frozen=True)
class VerifyResult:
    ok: bool
    detail: str = ""
    checks: tuple[str, ...] = field(default_factory=tuple)


class EnforcementError(Exception):
    """Raised by apply()/remove() when the system could not be brought into the requested state."""

    def __init__(self, message: str, *, code: str = "policy_apply_failed"):
        super().__init__(message)
        self.code = code


class EnforcementBackend(ABC):
    name: str = "abstract"

    @abstractmethod
    def apply(self, policy: ValidatedPolicy, management: ManagementEndpoints) -> None:
        """Atomically replace installed rules with `policy`, always keeping `management`
        reachable. Must raise EnforcementError on any failure (never partial success)."""

    @abstractmethod
    def verify(self) -> VerifyResult:
        """Confirm the installed state matches the last successful apply()."""

    @abstractmethod
    def remove(self) -> None:
        """Remove every rule this agent installed. Raises EnforcementError on failure."""

    @abstractmethod
    def status(self) -> EnforcementStatus:
        """Report current state without changing anything."""
