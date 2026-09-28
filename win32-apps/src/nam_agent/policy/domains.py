"""Domain-pattern normalization, validation and matching (contract §5).

Independent implementation of the same rules the server applies. Pure: no I/O.
"""

from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from typing import Iterable, Literal, Sequence

MAX_DOMAIN_LENGTH = 253
_LABEL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_WS_RE = re.compile(r"\s")


class DomainPatternError(ValueError):
    pass


def _to_alabels(host: str) -> str | None:
    """IDNA-encode each non-ASCII label. Delivered patterns are already A-labels, so this
    only matters for locally supplied input. Uses the stdlib IDNA 2003 codec; it agrees
    with UTS #46 for ordinary IDNs (e.g. bücher.de -> xn--bcher-kva.de)."""
    out = []
    for label in host.split("."):
        if label.isascii():
            out.append(label)
            continue
        try:
            out.append(label.encode("idna").decode("ascii"))
        except UnicodeError:
            return None
    return ".".join(out).lower()


def normalize_domain(value: str) -> str | None:
    """Trim, lowercase, drop ONE trailing dot, convert Unicode labels to A-labels.
    A leading `*.` is preserved. Returns None if IDNA conversion fails."""
    s = value.strip().lower()
    if s.endswith("."):
        s = s[:-1]
    if s.isascii():
        return s
    wildcard = s.startswith("*.")
    body = s[2:] if wildcard else s
    ascii_ = _to_alabels(body)
    if not ascii_:
        return None
    return ("*." if wildcard else "") + ascii_


def _looks_like_ip(s: str) -> bool:
    if s.startswith("[") and s.endswith("]"):
        s = s[1:-1]
    try:
        ipaddress.ip_address(s)
        return True
    except ValueError:
        return False


def _check_hostname(host: str, min_labels: int) -> str | None:
    labels = host.split(".")
    if len(labels) < min_labels:
        return "must contain at least two labels"
    for label in labels:
        if not label:
            return "empty label"
        if len(label) > 63:
            return "label longer than 63 characters"
        if not _LABEL_RE.match(label):
            return f'invalid label "{label}"'
    return None


def validate_domain_pattern(value: object) -> str:
    """Return the normalized pattern or raise DomainPatternError."""
    if not isinstance(value, str):
        raise DomainPatternError("must be a string")
    raw = value.strip()
    if not raw:
        raise DomainPatternError("must not be empty")
    if len(raw) > 1024:
        raise DomainPatternError("too long")
    if "://" in raw:
        raise DomainPatternError("must not contain a scheme")
    if _looks_like_ip(raw):
        raise DomainPatternError("IP literals are not allowed in domain lists (use blocked_ips)")
    if any(c in raw for c in "/?#"):
        raise DomainPatternError("must not contain a path, query or fragment")
    if "@" in raw:
        raise DomainPatternError('must not contain "@"')
    if ":" in raw:
        raise DomainPatternError("must not contain a port")
    if _WS_RE.search(raw):
        raise DomainPatternError("must not contain whitespace")
    v = normalize_domain(raw)
    if not v:
        raise DomainPatternError("invalid internationalized domain name")
    if _looks_like_ip(v):
        raise DomainPatternError("IP literals are not allowed in domain lists (use blocked_ips)")
    if len(v) > MAX_DOMAIN_LENGTH:
        raise DomainPatternError(f"longer than {MAX_DOMAIN_LENGTH} characters")
    host = v
    if "*" in v:
        if not v.startswith("*.") or "*" in v[1:]:
            raise DomainPatternError('the only allowed wildcard form is a leading "*."')
        host = v[2:]
    err = _check_hostname(host, 2)
    if err:
        raise DomainPatternError(err)
    return v


def normalize_query_name(value: str) -> str | None:
    v = normalize_domain(value)
    if not v or "*" in v or len(v) > MAX_DOMAIN_LENGTH or _looks_like_ip(v):
        return None
    return v if _check_hostname(v, 1) is None else None


def pattern_matches(pattern: str, name: str) -> bool:
    if pattern.startswith("*."):
        base = pattern[2:]
        return len(name) > len(base) + 1 and name.endswith("." + base)
    return pattern == name


def specificity(pattern: str) -> tuple[int, int]:
    return (len(pattern.split(".")), 0 if pattern.startswith("*.") else 1)


def is_management_host(name: str, management_hosts: Iterable[str]) -> bool:
    for h in management_hosts:
        host = normalize_domain(h)
        if host and (name == host or name.endswith("." + host)):
            return True
    return False


@dataclass(frozen=True)
class Decision:
    action: Literal["allow", "block"]
    reason: Literal["management", "rule", "tie", "default", "disabled", "invalid_name"]
    pattern: str | None = None


def decide(
    name_input: str,
    *,
    default_action: Literal["allow", "block"],
    allowed_domains: Sequence[str],
    blocked_domains: Sequence[str],
    enabled: bool = True,
    management_hosts: Iterable[str] = (),
) -> Decision:
    name = normalize_query_name(name_input)
    if name is None:
        return Decision(default_action, "invalid_name")
    if is_management_host(name, management_hosts):
        return Decision("allow", "management")
    if not enabled:
        return Decision("allow", "disabled")

    def best(patterns: Sequence[str]) -> tuple[str, tuple[int, int]] | None:
        top = None
        for p in patterns:
            if pattern_matches(p, name):
                s = specificity(p)
                if top is None or s > top[1]:
                    top = (p, s)
        return top

    a, b = best(allowed_domains), best(blocked_domains)
    if a is None and b is None:
        return Decision(default_action, "default")
    if b is None:
        return Decision("allow", "rule", a[0])  # type: ignore[index]
    if a is None:
        return Decision("block", "rule", b[0])
    if a[1] > b[1]:
        return Decision("allow", "rule", a[0])
    if a[1] < b[1]:
        return Decision("block", "rule", b[0])
    return Decision("block", "tie", b[0])
