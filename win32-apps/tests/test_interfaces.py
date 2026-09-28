from nam_agent.network.interfaces import NetworkInterface, classify, current_ip, normalize_mac, select_primary


def test_classify():
    assert classify("Ethernet", "Intel(R) Ethernet Connection I219-V", 6) == "ethernet"
    assert classify("Wi-Fi", "Intel(R) Wi-Fi 6 AX201", 71) == "wifi"
    assert classify("vEthernet (Default Switch)", "Hyper-V Virtual Ethernet Adapter", 6) == "virtual"
    assert classify("VMware Network Adapter VMnet8", "VMware Virtual Ethernet Adapter", 6) == "virtual"
    assert classify("Ethernet 3", "VirtualBox Host-Only Ethernet Adapter", 6) == "virtual"
    assert classify("Local Area Connection", "TAP-Windows Adapter V9", 6) == "vpn"
    assert classify("WireGuard Tunnel", "WireGuard Tunnel", 53) == "vpn"
    assert classify("Ethernet 4", "Cisco AnyConnect Secure Mobility Client Virtual Miniport Adapter", 6) == "vpn"
    assert classify("Loopback Pseudo-Interface 1", "", 24) == "loopback"
    assert classify("en0") == "ethernet"


def _ifaces():
    return [
        NetworkInterface("vEthernet (WSL)", "00:15:5D:00:00:01", ["172.30.0.1"], [], "virtual", has_gateway=False),
        NetworkInterface("VPN", None, ["10.8.0.2"], [], "vpn", has_gateway=True),
        NetworkInterface("Wi-Fi", "AA:BB:CC:DD:EE:01", ["192.168.0.10"], [], "wifi", has_gateway=True),
        NetworkInterface("Ethernet", "AA:BB:CC:DD:EE:02", ["10.0.0.5"], ["2001:db8::5", "fe80::5"], "ethernet", has_gateway=True),
    ]


def test_primary_skips_virtual_and_vpn():
    ifs = _ifaces()
    p = select_primary(ifs)
    assert p.name == "Ethernet" and sum(i.is_primary for i in ifs) == 1
    assert current_ip(ifs) == "10.0.0.5"


def test_primary_prefers_up_with_gateway():
    ifs = _ifaces()
    ifs[3].is_up = False
    assert select_primary(ifs).name == "Wi-Fi"


def test_explicit_primary_override_even_if_vpn():
    ifs = _ifaces()
    assert select_primary(ifs, "vpn").name == "VPN"


def test_ipv6_only_primary():
    ifs = [NetworkInterface("Ethernet", None, [], ["fe80::1", "2001:db8::9"], "ethernet")]
    select_primary(ifs)
    assert current_ip(ifs) == "2001:db8::9"


def test_mac_normalization_and_wire_format():
    assert normalize_mac("00-1a-2b-3c-4d-5e") == "00:1A:2B:3C:4D:5E"
    assert normalize_mac(bytes([0, 0x1A, 0x2B, 0x3C, 0x4D, 0x5E])) == "00:1A:2B:3C:4D:5E"
    assert normalize_mac("00:00:00:00:00:00") is None
    wire = _ifaces()[3].to_wire()
    assert set(wire) == {"name", "mac", "ipv4", "ipv6", "type", "is_primary"}
