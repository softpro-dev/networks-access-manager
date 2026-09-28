"""Resolve the management endpoints that every policy must keep reachable."""

from __future__ import annotations

import logging
import socket
from typing import Callable

from .base import ManagementEndpoints

log = logging.getLogger(__name__)

Resolver = Callable[[str, int], list[str]]


def system_resolver(host: str, port: int) -> list[str]:
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    out: list[str] = []
    for info in infos:
        addr = info[4][0]
        if addr not in out:
            out.append(addr)
    return out


def resolve_management(host: str, port: int, resolver: Resolver = system_resolver) -> ManagementEndpoints:
    try:
        addrs = resolver(host, port)
    except OSError as e:
        log.warning("could not resolve management host: %s", e.__class__.__name__)
        addrs = []
    return ManagementEndpoints(hosts=(host,), addresses=tuple(addrs), port=port)
