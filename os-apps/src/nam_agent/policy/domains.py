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


# Loopback is always allowed (never blocked), independent of policy or management config.
LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "::1")


def is_loopback(name_input: str) -> bool:
    """True for `localhost` (and its subdomains) and any IPv4/IPv6 loopback literal."""
    v = name_input.strip().strip(".").lower()
    if not v:
        return False
    if v == "localhost" or v.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(v).is_loopback
    except ValueError:
        return False


def is_management_host(name: str, management_hosts: Iterable[str]) -> bool:
    for h in management_hosts:
        host = normalize_domain(h)
        if host and (name == host or name.endswith("." + host)):
            return True
    return False


@dataclass(frozen=True)
class Decision:
    action: Literal["allow", "block", "redirect"]
    reason: Literal["management", "rule", "tie", "default", "disabled", "invalid_name"]
    pattern: str | None = None
    target: str | None = None


# On equal specificity: block beats redirect beats allow (contract §5).
_TIE_RANK = {"blocked": 3, "redirect": 2, "allowed": 1}


def decide(
    name_input: str,
    *,
    default_action: Literal["allow", "block"],
    allowed_domains: Sequence[str],
    blocked_domains: Sequence[str],
    redirect_rules: Sequence[tuple[str, str]] = (),
    enabled: bool = True,
    management_hosts: Iterable[str] = (),
) -> Decision:
    """Most specific matching rule wins; ties resolve block > redirect > allow.
    Redirect targets are always allowed. `redirect_rules` are (from_pattern, to_host) pairs."""
    if is_loopback(name_input):
        return Decision("allow", "management")
    name = normalize_query_name(name_input)
    if name is None:
        return Decision(default_action, "invalid_name")
    if is_management_host(name, management_hosts):
        return Decision("allow", "management")
    if not enabled:
        return Decision("allow", "disabled")
    if any(to == name for _, to in redirect_rules):
        return Decision("allow", "rule", name)

    best: tuple[str, tuple[int, int], str, str | None] | None = None
    tied = False

    def consider(pattern: str, lst: str, target: str | None = None) -> None:
        nonlocal best, tied
        if not pattern_matches(pattern, name):
            return
        s = specificity(pattern)
        if best is None or s > best[1]:
            best, tied = (pattern, s, lst, target), False
        elif s == best[1] and lst != best[2]:
            tied = True
            if _TIE_RANK[lst] > _TIE_RANK[best[2]]:
                best = (pattern, s, lst, target)

    for p in allowed_domains:
        consider(p, "allowed")
    for p in blocked_domains:
        consider(p, "blocked")
    for frm, to in redirect_rules:
        consider(frm, "redirect", to)

    if best is None:
        return Decision(default_action, "default")
    reason = "tie" if tied else "rule"
    if best[2] == "allowed":
        return Decision("allow", reason, best[0])
    if best[2] == "blocked":
        return Decision("block", reason, best[0])
    return Decision("redirect", reason, best[0], best[3])
