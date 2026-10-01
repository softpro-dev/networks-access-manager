"""Admin desktop wrapper: LAN scan parsing and the ?connected_devices= URL."""

import ipaddress
import json
from urllib.parse import parse_qs, urlsplit

from nam_admin.network_scan import normalize_mac, parse_arp_output, with_devices_param

NET = ipaddress.IPv4Network("192.168.68.0/24")

WINDOWS_ARP = """
Interface: 192.168.68.10 --- 0x5
  Internet Address      Physical Address      Type
  192.168.68.1          a4-2b-b0-11-22-33     dynamic
  192.168.68.25         3c-7c-3f-aa-bb-cc     dynamic
  192.168.68.255        ff-ff-ff-ff-ff-ff     static
  224.0.0.22            01-00-5e-00-00-16     static
  239.255.255.250       01-00-5e-7f-ff-fa     static

Interface: 10.0.0.5 --- 0x9
  10.0.0.1              00-11-22-33-44-55     dynamic
"""

MACOS_ARP = """
? (192.168.68.1) at a4:2b:b0:11:22:33 on en0 ifscope [ethernet]
? (192.168.68.40) at 0:1b:63:a:b:c on en0 ifscope [ethernet]
? (192.168.68.77) at (incomplete) on en0 ifscope [ethernet]
? (192.168.68.255) at ff:ff:ff:ff:ff:ff on en0 ifscope [ethernet]
"""


def test_parse_windows_arp_keeps_only_unicast_in_subnet():
    assert parse_arp_output(WINDOWS_ARP, NET) == {
        "192.168.68.1": "A4:2B:B0:11:22:33",
        "192.168.68.25": "3C:7C:3F:AA:BB:CC",
    }


def test_parse_macos_arp_pads_octets_and_skips_incomplete():
    assert parse_arp_output(MACOS_ARP, NET) == {
        "192.168.68.1": "A4:2B:B0:11:22:33",
        "192.168.68.40": "00:1B:63:0A:0B:0C",
    }


def test_normalize_mac_rejects_multicast_broadcast_and_zero():
    assert normalize_mac("aa-bb-cc-dd-ee-ff") == "AA:BB:CC:DD:EE:FF"
    assert normalize_mac("01-00-5e-00-00-16") is None
    assert normalize_mac("ff:ff:ff:ff:ff:ff") is None
    assert normalize_mac("00:00:00:00:00:00") is None
    assert normalize_mac("aa:bb:cc") is None


def test_with_devices_param_round_trips_json():
    devices = [{"ip": "192.168.68.10", "mac": "AA:BB:CC:DD:EE:FF", "self": True, "username": "mamun"}]
    url = with_devices_param("http://localhost:3200", devices)
    parts = urlsplit(url)
    assert (parts.scheme, parts.netloc, parts.path) == ("http", "localhost:3200", "/")
    assert json.loads(parse_qs(parts.query)["connected_devices"][0]) == devices


def test_with_devices_param_keeps_existing_query_and_replaces_old_value():
    url = with_devices_param("https://admin.example.com/login?next=%2Fcomputers&connected_devices=old", [])
    q = parse_qs(urlsplit(url).query)
    assert q["next"] == ["/computers"]
    assert q["connected_devices"] == ["[]"]
