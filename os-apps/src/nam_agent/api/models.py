"""Response models for agent endpoints (unknown response keys are ignored)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict


class _Resp(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)


class RegisterResponse(_Resp):
    device_id: str
    status: str


class Credential(_Resp):
    token: str
    credential_id: str
    issued_at: str | None = None
    expires_at: str | None = None


class RegistrationStatus(_Resp):
    status: Literal["PENDING", "APPROVED", "REJECTED", "REVOKED"]
    credential: Credential | None = None


class PolicyRef(_Resp):
    policy_id: str | None
    version: int
    etag: str | None

    @property
    def assigned(self) -> bool:
        return self.policy_id is not None and self.version > 0


class HeartbeatResponse(_Resp):
    server_time: str | None = None
    heartbeat_interval_seconds: int | None = None
    policy: PolicyRef | None = None


class PolicyFetch(_Resp):
    """Result of GET /agent/policy."""

    kind: Literal["not_modified", "document", "none"]
    body: bytes = b""
    etag: str | None = None
