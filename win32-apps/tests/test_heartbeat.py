from fake_server import HEARTBEAT_FIELDS


def test_heartbeat_payload_has_only_allowed_fields(harness, server):
    a = harness.enroll()
    hb = server.heartbeats[-1]
    assert set(hb) == HEARTBEAT_FIELDS
    assert hb["device_uuid"] == a.device_uuid
    assert hb["current_policy_version"] == 0
    assert hb["current_ip"] == "192.168.1.24"  # primary physical NIC, not the Hyper-V switch
    assert hb["status"] == "STARTING"
    a.tick()
    assert server.heartbeats[-1]["status"] == "HEALTHY"


def test_server_interval_is_honored_and_clamped(harness, server):
    a = harness.enroll()
    server.heartbeat_interval = 120
    assert a.tick() == 120.0
    server.heartbeat_interval = 1
    assert a.tick() == 10.0


def test_heartbeat_reports_active_version(harness, server):
    a = harness.enroll()
    server.assign("POL-001", 7)
    a.tick()
    a.tick()
    assert server.heartbeats[-1]["current_policy_version"] == 7
    assert server.heartbeats[-1]["status"] == "HEALTHY"
