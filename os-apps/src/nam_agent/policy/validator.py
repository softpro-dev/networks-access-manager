"""Candidate-policy validation, steps 1-8 of the apply pipeline.

1 JSON  2 schema  3 organization  4 device assignment  5 version / integrity
6 domain + IP syntax  7 management-server exception  8 enforcement configuration

Any failure raises PolicyValidationError; a malformed policy never replaces a working one.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Sequence

from pydantic import ValidationError

from .canonical import content_sha256, make_etag
from .domains import DomainPatternError, decide, validate_domain_pattern
from .ip_rules import validate_ip_or_cidr
from .schema import PolicyContent, PolicyDocument

MAX_DOCUMENT_BYTES = 4 * 1024 * 1024


class PolicyValidationError(Exception):
    error_code = "policy_validation_failed"

    def __init__(self, step: int, message: str):
        super().__init__(f"step {step}: {message}")
        self.step = step
        self.message = message[:900]


@dataclass(frozen=True)
class EffectiveContent:
    """Normalized content the enforcement backend consumes."""

    enabled: bool
    default_action: str
    allowed_domains: tuple[str, ...]
    blocked_domains: tuple[str, ...]
    blocked_ips: tuple[str, ...]
    block_quic: bool
    block_dot: bool
    block_doh: bool
    enforce_browser_policies: bool
    #: (from_pattern, to_host) pairs, in delivered order
    redirect_rules: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class ValidatedPolicy:
    policy_id: str
    version: int
    content_sha256: str
    etag: str
    document: dict[str, Any]
    content: EffectiveContent
    warnings: tuple[str, ...] = field(default_factory=tuple)

    @property
    def pair(self) -> tuple[str, int]:
        return (self.policy_id, self.version)


def _no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in pairs:
        if k in out:
            raise ValueError(f"duplicate key {k!r}")
        out[k] = v
    return out


def _reject_float(s: str) -> Any:
    raise ValueError("non-integer numbers are not allowed")


def _reject_constant(s: str) -> Any:
    raise ValueError(f"{s} is not allowed")


def parse_json(raw: bytes | str) -> Any:
    if isinstance(raw, bytes):
        if len(raw) > MAX_DOCUMENT_BYTES:
            raise PolicyValidationError(1, "document too large")
        try:
            raw = raw.decode("utf-8")
        except UnicodeDecodeError:
            raise PolicyValidationError(1, "document is not valid UTF-8") from None
    try:
        return json.loads(raw, object_pairs_hook=_no_duplicates, parse_float=_reject_float, parse_constant=_reject_constant)
    except ValueError as e:
        raise PolicyValidationError(1, f"invalid JSON: {str(e)[:200]}") from None


def _schema_errors(e: ValidationError, prefix: str = "") -> str:
    return "; ".join(
        f"{prefix}{'.'.join(str(p) for p in err['loc'])}: {err['msg']}" for err in e.errors(include_input=False)[:10]
    )


def validate_policy(
    raw: bytes | str | dict,
    *,
    expected_organization_id: str,
    expected_device_uuid: str,
    management_hosts: Sequence[str],
    response_etag: str | None = None,
) -> ValidatedPolicy:
    # 1. JSON
    data = parse_json(raw) if not isinstance(raw, dict) else raw
    if not isinstance(data, dict):
        raise PolicyValidationError(1, "document must be a JSON object")

    # 2. schema (unknown keys rejected at both levels)
    try:
        doc = PolicyDocument.model_validate(data)
    except ValidationError as e:
        raise PolicyValidationError(2, _schema_errors(e)) from None
    try:
        content = PolicyContent.model_validate(doc.content)
    except ValidationError as e:
        raise PolicyValidationError(2, _schema_errors(e, "content.")) from None

    # 3. organization
    if doc.organization_id != expected_organization_id:
        raise PolicyValidationError(3, "policy was issued for a different organization")

    # 4. device assignment
    if doc.device_uuid != expected_device_uuid:
        raise PolicyValidationError(4, "policy was issued for a different device")

    # 5. version + integrity (a lower version than the active one is a legitimate server rollback)
    actual_sha = content_sha256(doc.content)
    if actual_sha != doc.content_sha256:
        raise PolicyValidationError(5, "content_sha256 does not match the canonical content hash")
    etag = make_etag(doc.policy_id, doc.version, actual_sha)
    if response_etag is not None and response_etag.strip().removeprefix("W/") != etag:
        raise PolicyValidationError(5, "ETag header does not match the document")

    # 6. domain + IP syntax
    def norm_domains(values: list[str], fld: str) -> tuple[str, ...]:
        out = []
        for i, v in enumerate(values):
            try:
                out.append(validate_domain_pattern(v))
            except DomainPatternError as e:
                raise PolicyValidationError(6, f"content.{fld}[{i}]: {e}") from None
        return tuple(out)

    allowed = norm_domains(content.allowed_domains, "allowed_domains")
    blocked = norm_domains(content.blocked_domains, "blocked_domains")
    ips = []
    for i, v in enumerate(content.blocked_ips):
        try:
            ips.append(validate_ip_or_cidr(v))
        except ValueError as e:
            raise PolicyValidationError(6, f"content.blocked_ips[{i}]: {e}") from None

    redirects: list[tuple[str, str]] = []
    for i, r in enumerate(content.redirect_rules):
        try:
            frm = validate_domain_pattern(r.from_)
            to = validate_domain_pattern(r.to)
        except DomainPatternError as e:
            raise PolicyValidationError(6, f"content.redirect_rules[{i}]: {e}") from None
        if to.startswith("*."):
            raise PolicyValidationError(6, f"content.redirect_rules[{i}].to: redirect target must be an exact hostname")
        if frm == to:
            raise PolicyValidationError(6, f"content.redirect_rules[{i}]: a name cannot redirect to itself")
        redirects.append((frm, to))

    # 7. management-server exception
    hosts = [h for h in management_hosts if h]
    if not hosts:
        raise PolicyValidationError(7, "management server host is unknown; refusing to apply without an exception")
    warnings: list[str] = []
    for host in hosts:
        common = dict(
            default_action=content.default_action,
            allowed_domains=allowed,
            blocked_domains=blocked,
            redirect_rules=tuple(redirects),
            enabled=content.enabled,
        )
        if decide(host, **common).action != "allow":
            warnings.append(f"policy would block or redirect the management host {host}; the management exception overrides it")
        if decide(host, **common, management_hosts=hosts).action != "allow":  # pragma: no cover - invariant
            raise PolicyValidationError(7, "management exception does not cover the management host")

    # 8. enforcement configuration
    if content.enabled and content.default_action == "block" and not allowed:
        warnings.append('default_action "block" with no allowed_domains blocks everything except the management host')
    overlap = set(allowed) & set(blocked)
    if overlap:
        warnings.append(f"{len(overlap)} pattern(s) are both allowed and blocked; equal specificity resolves to BLOCK")

    return ValidatedPolicy(
        policy_id=doc.policy_id,
        version=doc.version,
        content_sha256=actual_sha,
        etag=etag,
        document=data,
        content=EffectiveContent(
            enabled=content.enabled,
            default_action=content.default_action,
            allowed_domains=allowed,
            blocked_domains=blocked,
            blocked_ips=tuple(ips),
            block_quic=content.block_quic,
            block_dot=content.block_dot,
            block_doh=content.block_doh,
            enforce_browser_policies=content.enforce_browser_policies,
            redirect_rules=tuple(redirects),
        ),
        warnings=tuple(warnings),
    )
