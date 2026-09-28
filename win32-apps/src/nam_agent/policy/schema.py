"""Strict schemas for the Policy Document (contract §4). Unknown keys are rejected."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr

MAX_DOMAIN_ENTRIES = 5000
MAX_IP_ENTRIES = 1000

POLICY_ID_PATTERN = r"^[A-Z0-9][A-Z0-9-]{1,31}$"
ORG_ID_PATTERN = POLICY_ID_PATTERN
UUID_PATTERN = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
SHA256_PATTERN = r"^[0-9a-f]{64}$"


class PolicyContent(BaseModel):
    """`content` object. Missing fields take the contract defaults; hashing always uses
    the content exactly as delivered, never these defaults."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    enabled: StrictBool = True
    default_action: Literal["allow", "block"] = "allow"
    allowed_domains: list[StrictStr] = Field(default_factory=list, max_length=MAX_DOMAIN_ENTRIES)
    blocked_domains: list[StrictStr] = Field(default_factory=list, max_length=MAX_DOMAIN_ENTRIES)
    blocked_ips: list[StrictStr] = Field(default_factory=list, max_length=MAX_IP_ENTRIES)
    block_quic: StrictBool = True
    block_dot: StrictBool = True
    block_doh: StrictBool = True
    enforce_browser_policies: StrictBool = True


class PolicyDocument(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal[1]
    policy_id: StrictStr = Field(pattern=POLICY_ID_PATTERN)
    version: StrictInt = Field(ge=1)
    organization_id: StrictStr = Field(pattern=ORG_ID_PATTERN)
    device_uuid: StrictStr = Field(pattern=UUID_PATTERN)
    assignment_scope: Literal["DEVICE", "GROUP", "ORGANIZATION"]
    published_at: StrictStr | None = None
    content_sha256: StrictStr = Field(pattern=SHA256_PATTERN)
    content: dict
