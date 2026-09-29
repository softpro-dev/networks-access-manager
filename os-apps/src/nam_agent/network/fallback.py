"""Non-Windows interface enumeration for development hosts.

Uses psutil when installed (requirements-dev.txt, non-Windows only); otherwise
falls back to the stdlib and reports only the address used for the default route.
Production Windows builds use win_adapters.py instead.
"""

from __future__ import annotations

import socket

from .interfaces import NetworkInterface, classify, clean_ipv4, clean_ipv6, normalize_mac


def _default_route_ipv4() -> str | None:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 9))  # TEST-NET-1: no packet is sent for a UDP connect
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def enumerate_interfaces() -> list[NetworkInterface]:
    try:
        import psutil
    except ImportError:
        ip = _default_route_ipv4()
        if not ip:
            return []
        return [NetworkInterface(name="default", mac=None, ipv4=clean_ipv4([ip]), type="other", has_gateway=True)]

    default_ip = _default_route_ipv4()
    stats = psutil.net_if_stats()
    out: list[NetworkInterface] = []
    for name, addrs in psutil.net_if_addrs().items():
        v4 = [a.address for a in addrs if a.family == socket.AF_INET]
        v6 = [a.address for a in addrs if a.family == socket.AF_INET6]
        mac = next((normalize_mac(a.address) for a in addrs if a.family == psutil.AF_LINK), None)
        st = stats.get(name)
        out.append(
            NetworkInterface(
                name=name,
                mac=mac,
                ipv4=clean_ipv4(v4),
                ipv6=clean_ipv6(v6),
                type=classify(name),
                is_up=bool(st and st.isup),
                has_gateway=default_ip in v4 if default_ip else False,
            )
        )
    return out
