"""`blocked_ips` entry validation: IPv4/IPv6 address or CIDR (network address, no zone ids)."""

from __future__ import annotations

import ipaddress
import re

_PREFIX_RE = re.compile(r"^(0|[1-9]\d{0,2})$")


def validate_ip_or_cidr(value: object) -> str:
    """Return the normalized (trimmed, lowercased) entry or raise ValueError."""
    if not isinstance(value, str):
        raise ValueError("must be a string")
    s = value.strip().lower()
    if not s or len(s) > 64 or "%" in s:
        raise ValueError("invalid IP address or CIDR")
    addr, sep, prefix = s.partition("/")
    if "/" in prefix:
        raise ValueError("invalid IP address or CIDR")
    try:
        ip = ipaddress.ip_address(addr)  # rejects IPv4 leading zeros
    except ValueError:
        raise ValueError("invalid IP address (no zone ids or leading zeros)") from None
    if not sep:
        return s
    if not _PREFIX_RE.match(prefix) or int(prefix) > ip.max_prefixlen:
        raise ValueError(f"invalid prefix length (0-{ip.max_prefixlen})")
    try:
        ipaddress.ip_network(s, strict=True)
    except ValueError:
        raise ValueError("CIDR has host bits set; use the network address") from None
    return s
