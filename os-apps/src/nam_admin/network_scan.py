"""Discover this PC and the devices on its local /24 for the admin console.

On startup the desktop wrapper sweeps the primary interface's /24 (x.x.x.1 - x.x.x.254),
reads the OS ARP table, and passes the result to the console as
`?connected_devices=<JSON>` so "Add My PC" / bulk add can pre-fill MAC addresses (a
browser cannot read them itself).

This PC's own entry comes from the agent's interface discovery
(`nam_agent.network`, stdlib only) so its MAC is the one the agent reports and a
pre-added computer links up. Never raises: on any failure the list is just shorter.
"""

from __future__ import annotations

import getpass
import ipaddress
import json
import logging
import os
import re
import socket
import subprocess
import sys
import time
from urllib.parse import urlencode, urlsplit, urlunsplit, parse_qsl

log = logging.getLogger(__name__)

QUERY_PARAM = "connected_devices"
ARP_SETTLE_SECONDS = 1.5
# Windows: "  192.168.68.1     aa-bb-cc-dd-ee-ff     dynamic"
# macOS:   "? (192.168.68.1) at a:b:c:d:e:f on en0 ifscope [ethernet]"
_ARP_LINE = re.compile(
    r"(?P<ip>\d{1,3}(?:\.\d{1,3}){3})\D+?(?P<mac>[0-9A-Fa-f]{1,2}(?:[:-][0-9A-Fa-f]{1,2}){5})\b"
)


def normalize_mac(raw: str) -> str | None:
    """'a-b-c-d-e-f' / 'aa:bb:..' -> 'AA:BB:CC:DD:EE:FF'; None for invalid, all-zero,
    broadcast or multicast addresses (those are never a computer)."""
    octets = [o.zfill(2).upper() for o in re.split(r"[:-]", raw.strip())]
    if len(octets) != 6 or not all(re.fullmatch(r"[0-9A-F]{2}", o) for o in octets):
        return None
    if int(octets[0], 16) & 1 or all(o == "00" for o in octets):  # multicast bit (incl. FF:FF..)
        return None
    return ":".join(octets)


def parse_arp_output(text: str, network: ipaddress.IPv4Network) -> dict[str, str]:
    """IP -> MAC for every unicast neighbour inside `network` (host addresses only)."""
    found: dict[str, str] = {}
    for line in text.splitlines():
        m = _ARP_LINE.search(line)
        if not m:
            continue
        try:
            ip = ipaddress.IPv4Address(m.group("ip"))
        except ValueError:
            continue
        if ip not in network or ip in (network.network_address, network.broadcast_address):
            continue
        mac = normalize_mac(m.group("mac"))
        if mac:
            found[str(ip)] = mac
    return found


def local_identity() -> dict | None:
    """This PC: primary IPv4 + MAC (agent's selection), hostname and logged-in user."""
    try:
        from nam_agent.network.interfaces import discover

        primary = next((i for i in discover() if i.is_primary), None)
    except Exception:  # noqa: BLE001 - discovery is best-effort
        log.exception("interface discovery failed")
        return None
    if primary is None or not primary.ipv4:
        return None
    try:
        username = os.environ.get("USERNAME") or getpass.getuser()
    except Exception:  # noqa: BLE001
        username = ""
    return {
        "ip": primary.ipv4[0],
        "mac": primary.mac,
        "hostname": socket.gethostname(),
        "username": username,
    }


def sweep(network: ipaddress.IPv4Network, skip: str | None = None) -> None:
    """Send one empty UDP datagram to every host so the OS resolves (ARPs) each address.
    Hosts answer ARP even when their firewall drops the datagram; nothing listens on
    port 9 (discard), so no service is contacted."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setblocking(False)
    try:
        for host in network.hosts():
            if str(host) == skip:
                continue
            try:
                sock.sendto(b"", (str(host), 9))
            except OSError:
                pass
    finally:
        sock.close()


def read_arp_table() -> str:
    kwargs: dict = {"capture_output": True, "timeout": 10}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW  # no console flash from the GUI app
    try:
        out = subprocess.run(["arp", "-a"], **kwargs).stdout  # noqa: S603,S607 - fixed command
    except (OSError, subprocess.SubprocessError):
        log.exception("reading the ARP table failed")
        return ""
    return out.decode(errors="replace")


def connected_devices() -> list[dict]:
    """This PC first (marked "self": true), then every neighbour on its /24, by IP."""
    me = local_identity()
    if me is None:
        return []
    network = ipaddress.IPv4Network(f"{me['ip']}/24", strict=False)
    sweep(network, skip=me["ip"])
    time.sleep(ARP_SETTLE_SECONDS)
    neighbours = parse_arp_output(read_arp_table(), network)
    neighbours.pop(me["ip"], None)
    devices: list[dict] = [{**me, "self": True}] if me.get("mac") else []
    for ip in sorted(neighbours, key=ipaddress.IPv4Address):
        devices.append({"ip": ip, "mac": neighbours[ip]})
    return devices


def with_devices_param(url: str, devices: list[dict]) -> str:
    """`url` with ?connected_devices=<compact JSON> added (existing query kept)."""
    parts = urlsplit(url)
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k != QUERY_PARAM]
    query.append((QUERY_PARAM, json.dumps(devices, separators=(",", ":"))))
    return urlunsplit(parts._replace(path=parts.path or "/", query=urlencode(query)))
