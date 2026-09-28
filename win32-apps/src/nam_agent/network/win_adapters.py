"""Windows adapter enumeration via iphlpapi!GetAdaptersAddresses (ctypes).

Import this module only on Windows. Struct definitions are truncated after the
last field we read; that is safe because the buffers are allocated by the API
and we only walk them through the `Next` pointers it provides.
"""

from __future__ import annotations

import ctypes
import socket
from ctypes import wintypes

from .interfaces import NetworkInterface, classify, clean_ipv4, clean_ipv6, normalize_mac

AF_UNSPEC = 0
AF_INET = 2
AF_INET6 = 23
GAA_FLAG_SKIP_ANYCAST = 0x0002
GAA_FLAG_SKIP_MULTICAST = 0x0004
GAA_FLAG_SKIP_DNS_SERVER = 0x0008
GAA_FLAG_INCLUDE_GATEWAYS = 0x0080
ERROR_SUCCESS = 0
ERROR_BUFFER_OVERFLOW = 111
IF_OPER_STATUS_UP = 1


class SOCKADDR(ctypes.Structure):
    _fields_ = [("sa_family", ctypes.c_ushort), ("sa_data", ctypes.c_ubyte * 26)]


class SOCKET_ADDRESS(ctypes.Structure):
    _fields_ = [("lpSockaddr", ctypes.POINTER(SOCKADDR)), ("iSockaddrLength", ctypes.c_int)]


class IP_ADAPTER_UNICAST_ADDRESS(ctypes.Structure):
    pass


IP_ADAPTER_UNICAST_ADDRESS._fields_ = [
    ("Length", wintypes.ULONG),
    ("Flags", wintypes.DWORD),
    ("Next", ctypes.POINTER(IP_ADAPTER_UNICAST_ADDRESS)),
    ("Address", SOCKET_ADDRESS),
]


class IP_ADAPTER_GATEWAY_ADDRESS(ctypes.Structure):
    pass


IP_ADAPTER_GATEWAY_ADDRESS._fields_ = [
    ("Length", wintypes.ULONG),
    ("Reserved", wintypes.DWORD),
    ("Next", ctypes.POINTER(IP_ADAPTER_GATEWAY_ADDRESS)),
    ("Address", SOCKET_ADDRESS),
]


class IP_ADAPTER_ADDRESSES(ctypes.Structure):
    pass


IP_ADAPTER_ADDRESSES._fields_ = [
    ("Length", wintypes.ULONG),
    ("IfIndex", wintypes.DWORD),
    ("Next", ctypes.POINTER(IP_ADAPTER_ADDRESSES)),
    ("AdapterName", ctypes.c_char_p),
    ("FirstUnicastAddress", ctypes.POINTER(IP_ADAPTER_UNICAST_ADDRESS)),
    ("FirstAnycastAddress", ctypes.c_void_p),
    ("FirstMulticastAddress", ctypes.c_void_p),
    ("FirstDnsServerAddress", ctypes.c_void_p),
    ("DnsSuffix", ctypes.c_wchar_p),
    ("Description", ctypes.c_wchar_p),
    ("FriendlyName", ctypes.c_wchar_p),
    ("PhysicalAddress", ctypes.c_ubyte * 8),
    ("PhysicalAddressLength", wintypes.ULONG),
    ("Flags", wintypes.ULONG),
    ("Mtu", wintypes.ULONG),
    ("IfType", wintypes.ULONG),
    ("OperStatus", ctypes.c_int),
    ("Ipv6IfIndex", wintypes.DWORD),
    ("ZoneIndices", wintypes.ULONG * 16),
    ("FirstPrefix", ctypes.c_void_p),
    ("TransmitLinkSpeed", ctypes.c_ulonglong),
    ("ReceiveLinkSpeed", ctypes.c_ulonglong),
    ("FirstWinsServerAddress", ctypes.c_void_p),
    ("FirstGatewayAddress", ctypes.POINTER(IP_ADAPTER_GATEWAY_ADDRESS)),
]


def _sockaddr_to_str(sa: SOCKET_ADDRESS) -> tuple[int, str] | None:
    if not sa.lpSockaddr:
        return None
    family = sa.lpSockaddr.contents.sa_family
    raw = ctypes.string_at(sa.lpSockaddr, sa.iSockaddrLength)
    if family == AF_INET and len(raw) >= 8:
        return family, socket.inet_ntop(socket.AF_INET, raw[4:8])
    if family == AF_INET6 and len(raw) >= 24:
        return family, socket.inet_ntop(socket.AF_INET6, raw[8:24])
    return None


def enumerate_adapters() -> list[NetworkInterface]:
    iphlpapi = ctypes.windll.iphlpapi
    flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER | GAA_FLAG_INCLUDE_GATEWAYS
    size = wintypes.ULONG(16 * 1024)
    for _ in range(4):
        buf = ctypes.create_string_buffer(size.value)
        rc = iphlpapi.GetAdaptersAddresses(AF_UNSPEC, flags, None, buf, ctypes.byref(size))
        if rc == ERROR_SUCCESS:
            break
        if rc != ERROR_BUFFER_OVERFLOW:
            raise OSError(rc, "GetAdaptersAddresses failed")
    else:
        raise OSError(ERROR_BUFFER_OVERFLOW, "GetAdaptersAddresses buffer kept growing")

    result: list[NetworkInterface] = []
    node = ctypes.cast(buf, ctypes.POINTER(IP_ADAPTER_ADDRESSES))
    while node:
        a = node.contents
        v4: list[str] = []
        v6: list[str] = []
        u = a.FirstUnicastAddress
        while u:
            parsed = _sockaddr_to_str(u.contents.Address)
            if parsed:
                (v4 if parsed[0] == AF_INET else v6).append(parsed[1])
            u = u.contents.Next
        name = a.FriendlyName or (a.AdapterName or b"").decode(errors="replace")
        desc = a.Description or ""
        mac = normalize_mac(bytes(a.PhysicalAddress[: a.PhysicalAddressLength])) if a.PhysicalAddressLength == 6 else None
        result.append(
            NetworkInterface(
                name=name,
                mac=mac,
                ipv4=clean_ipv4(v4),
                ipv6=clean_ipv6(v6),
                type=classify(name, desc, int(a.IfType)),
                description=desc,
                is_up=a.OperStatus == IF_OPER_STATUS_UP,
                has_gateway=bool(a.FirstGatewayAddress),
            )
        )
        node = a.Next
    return result
