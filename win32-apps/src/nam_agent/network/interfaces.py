"""Network interface inventory (for registration / heartbeat `current_ip`).

Discovery is platform-specific (see win_adapters.py, fallback.py); classification
and primary selection are pure and tested cross-platform. The MAC address is
reported as an inventory fact only and is never used for authentication.
"""

from __future__ import annotations

import ipaddress
import logging
import re
from dataclasses import dataclass, field

from ..platform import IS_WINDOWS

log = logging.getLogger(__name__)

MAX_INTERFACES = 32
MAX_ADDRS = 16

# IANA ifType values (ipifcons.h)
IF_TYPE_ETHERNET_CSMACD = 6
IF_TYPE_PPP = 23
IF_TYPE_SOFTWARE_LOOPBACK = 24
IF_TYPE_PROP_VIRTUAL = 53
IF_TYPE_IEEE80211 = 71
IF_TYPE_TUNNEL = 131
IF_TYPE_IEEE1394 = 144
IF_TYPE_WWANPP = 243
IF_TYPE_WWANPP2 = 244

_VIRTUAL_HINTS = re.compile(
    r"hyper-v|vethernet|virtual|vmware|virtualbox|vbox|docker|wsl|qemu|kvm|parallels|xen|"
    r"loopback pseudo|npcap|bluetooth|^utun|^bridge|^vmnet|^veth|^virbr|^awdl|^llw|^anpi|^gif|^stf|^ap\d",
    re.IGNORECASE,
)
_VPN_HINTS = re.compile(
    r"vpn|wireguard|openvpn|tap-windows|\btap\b|\btun\b|wintun|anyconnect|cisco|fortinet|forticlient|"
    r"globalprotect|pangp|juniper|pulse secure|zscaler|nordlynx|tailscale|zerotier|sonicwall|checkpoint|"
    r"wan miniport|^ipsec|^ppp",
    re.IGNORECASE,
)
_WIFI_HINTS = re.compile(r"wi-?fi|wireless|wlan|802\.11", re.IGNORECASE)


@dataclass
class NetworkInterface:
    name: str
    mac: str | None
    ipv4: list[str] = field(default_factory=list)
    ipv6: list[str] = field(default_factory=list)
    type: str = "other"
    is_primary: bool = False
    description: str = ""
    is_up: bool = True
    has_gateway: bool = False

    def to_wire(self) -> dict:
        return {
            "name": self.name[:256],
            "mac": self.mac,
            "ipv4": self.ipv4[:MAX_ADDRS],
            "ipv6": self.ipv6[:MAX_ADDRS],
            "type": self.type,
            "is_primary": self.is_primary,
        }


def normalize_mac(raw: bytes | str | None) -> str | None:
    if raw is None:
        return None
    if isinstance(raw, (bytes, bytearray)):
        if len(raw) != 6:
            return None
        octets = [f"{b:02X}" for b in raw]
    else:
        octets = [o.upper().zfill(2) for o in re.split(r"[:\-]", raw.strip()) if o]
        if len(octets) != 6 or not all(re.fullmatch(r"[0-9A-F]{2}", o) for o in octets):
            return None
    if all(o == "00" for o in octets):
        return None
    return ":".join(octets)


def clean_ipv4(addrs: list[str]) -> list[str]:
    out = []
    for a in addrs:
        try:
            ip = ipaddress.IPv4Address(a)
        except ValueError:
            continue
        if ip.is_unspecified or ip.is_loopback:
            continue
        if str(ip) not in out:
            out.append(str(ip))
    return out[:MAX_ADDRS]


def clean_ipv6(addrs: list[str]) -> list[str]:
    out = []
    for a in addrs:
        try:
            ip = ipaddress.IPv6Address(a.split("%", 1)[0])
        except ValueError:
            continue
        if ip.is_unspecified or ip.is_loopback:
            continue
        if str(ip) not in out:
            out.append(str(ip))
    return out[:MAX_ADDRS]


def classify(name: str, description: str = "", if_type: int | None = None) -> str:
    """Map an adapter to the contract's `type` enum. Name/description hints override ifType
    because Hyper-V/VMware/VPN adapters frequently report ifType 6 (Ethernet)."""
    text = f"{name} {description}"
    if if_type == IF_TYPE_SOFTWARE_LOOPBACK or re.match(r"^lo\d*$", name) or "loopback" in text.lower():
        return "loopback"
    if _VPN_HINTS.search(text) or if_type in (IF_TYPE_PPP, IF_TYPE_TUNNEL):
        return "vpn"
    if _VIRTUAL_HINTS.search(text) or if_type == IF_TYPE_PROP_VIRTUAL:
        return "virtual"
    if if_type == IF_TYPE_IEEE80211 or _WIFI_HINTS.search(text):
        return "wifi"
    if if_type == IF_TYPE_ETHERNET_CSMACD or re.match(r"^(en|eth)\d+$", name) or "ethernet" in text.lower():
        return "ethernet"
    return "other"


def select_primary(interfaces: list[NetworkInterface], preferred_name: str | None = None) -> NetworkInterface | None:
    """Mark exactly one interface primary.

    An explicitly configured PRIMARY_INTERFACE wins (even if virtual/VPN). Otherwise
    only physical (ethernet/wifi) adapters are candidates, preferring: up, has a
    default gateway, has IPv4, ethernet over wifi.
    """
    for i in interfaces:
        i.is_primary = False
    chosen: NetworkInterface | None = None
    if preferred_name:
        chosen = next((i for i in interfaces if i.name.lower() == preferred_name.lower()), None)
        if chosen is None:
            log.warning("configured PRIMARY_INTERFACE was not found; using automatic selection")
    if chosen is None:
        physical = [i for i in interfaces if i.type in ("ethernet", "wifi") and (i.ipv4 or i.ipv6)]
        if physical:
            chosen = sorted(
                physical,
                key=lambda i: (not i.is_up, not i.has_gateway, not i.ipv4, i.type != "ethernet", i.name),
            )[0]
    if chosen is not None:
        chosen.is_primary = True
    return chosen


def current_ip(interfaces: list[NetworkInterface]) -> str | None:
    primary = next((i for i in interfaces if i.is_primary), None)
    if primary is None:
        return None
    if primary.ipv4:
        return primary.ipv4[0]
    globals_ = [a for a in primary.ipv6 if not ipaddress.IPv6Address(a).is_link_local]
    return (globals_ or primary.ipv6 or [None])[0]


def discover(preferred_name: str | None = None) -> list[NetworkInterface]:
    """Enumerate interfaces, classify, and select a primary. Never raises."""
    try:
        if IS_WINDOWS:  # pragma: no cover - Windows only
            from .win_adapters import enumerate_adapters

            found = enumerate_adapters()
        else:
            from .fallback import enumerate_interfaces

            found = enumerate_interfaces()
    except Exception:
        log.exception("interface discovery failed")
        found = []
    found = [i for i in found if i.type != "loopback"][:MAX_INTERFACES]
    select_primary(found, preferred_name)
    return found
