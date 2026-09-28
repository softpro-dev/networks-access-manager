from nam_agent.api.backoff import Backoff


def test_server_down_keeps_cached_policy_and_backs_off(harness, server, backend):
    server.assign("POL-001", 7)
    a = harness.enroll()
    server.down = True
    delays = [a.tick() for _ in range(6)]
    assert all(5 <= d <= 300 for d in delays)
    assert delays[-1] > delays[0]
    assert harness.db.get_policy("current").version == 7
    assert backend.installed.version == 7
    assert ("remove",) not in backend.calls


def test_5xx_is_retried_with_backoff(harness, server):
    server.assign("POL-001", 7)
    a = harness.enroll()
    server.fail_5xx = True
    assert 5 <= a.tick() <= 300
    assert harness.db.get_policy("current").version == 7


def test_restart_while_offline_loads_and_reasserts_cached_policy(harness, server, backend):
    server.assign("POL-001", 7)
    harness.enroll()
    server.down = True
    backend.installed = None  # machine rebooted
    a = harness.start()
    assert backend.installed.version == 7  # re-applied from SQLite before any network I/O
    a.tick()
    assert harness.db.get_policy("current").version == 7


def test_reconnect_resumes_sync(harness, server, backend):
    server.assign("POL-001", 7)
    a = harness.enroll()
    server.down = True
    a.tick()
    server.assign("POL-001", 8)
    server.down = False
    a.tick()
    assert server.heartbeats[-1]["status"] == "DEGRADED"  # reports the outage it just recovered from
    assert harness.db.get_policy("current").version == 8
    a.tick()
    assert server.heartbeats[-1]["status"] == "HEALTHY"


def test_pending_reports_are_flushed_after_outage(harness, server, backend):
    server.assign("POL-001", 6)
    a = harness.enroll()
    server.assign("POL-001", 7)
    backend.fail_apply.add(7)

    original = a.api.report_status
    from nam_agent.api.errors import ApiUnavailable

    def flaky(token, body):
        raise ApiUnavailable("simulated")

    a.api.report_status = flaky
    a.tick()
    a.api.report_status = original
    n = len(server.status_reports)
    harness.clock.advance(400)
    a.tick()
    assert any(r["status"] == "ROLLED_BACK" for r in server.status_reports[n:])


def test_revoked_credential_keeps_enforcement_and_retries_slowly(harness, server, backend):
    server.assign("POL-001", 7)
    a = harness.enroll()
    server.revoke(a.device_uuid)
    assert a.tick() == 300.0
    assert a.tick() <= 300.0  # still blocked, no request
    assert backend.installed.version == 7
    assert harness.db.get_policy("current").version == 7
    assert harness.db.get_row("auth_metadata")["last_auth_error"] == "CREDENTIAL_REVOKED"


def test_backoff_bounds():
    b = Backoff()
    ds = [b.next_delay() for _ in range(15)]
    assert ds[0] == 5.0
    assert all(5.0 <= d <= 300.0 for d in ds)
    assert max(ds[-5:]) >= 150.0
    b.reset()
    assert b.next_delay() == 5.0
