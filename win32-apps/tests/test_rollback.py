from fake_server import EXAMPLE_CONTENT


def _setup(harness, server):
    server.assign("POL-001", 6)
    a = harness.enroll()
    server.assign("POL-001", 7, dict(EXAMPLE_CONTENT, blocked_domains=["example.com"]))
    return a


def test_apply_failure_rolls_back_to_previous(harness, server, backend):
    a = _setup(harness, server)
    backend.fail_apply.add(7)
    a.tick()
    assert backend.applied_versions() == [6, 7, 6]
    assert backend.installed.version == 6
    assert harness.db.get_policy("current").version == 6
    assert harness.db.get_policy("candidate") is None
    r = server.status_reports[-1]
    assert (r["status"], r["error_code"], r["version"], r["active_version"]) == ("ROLLED_BACK", "policy_apply_failed", 7, 6)
    assert "0x80320009" in r["message"]
    assert all(ack["version"] == 6 for ack in server.acks)
    a.tick()
    assert server.heartbeats[-1]["current_policy_version"] == 6


def test_verify_failure_rolls_back(harness, server, backend):
    a = _setup(harness, server)
    backend.fail_verify.add(7)
    a.tick()
    assert backend.installed.version == 6
    r = server.status_reports[-1]
    assert (r["status"], r["error_code"]) == ("ROLLED_BACK", "enforcement_verify_failed")


def test_management_unreachable_after_apply_rolls_back(harness, server, backend):
    a = _setup(harness, server)
    server.health_ok = False
    a.tick()
    assert backend.installed.version == 6
    assert server.status_reports[-1]["error_code"] == "management_unreachable"


def test_rollback_failure_is_reported(harness, server, backend):
    a = _setup(harness, server)
    backend.fail_apply.update({6, 7})
    a.tick()
    r = server.status_reports[-1]
    assert (r["status"], r["error_code"]) == ("FAILED", "rollback_failed")
    assert harness.db.get_policy("current").version == 6  # cached policy is never dropped
    a.tick()
    assert server.heartbeats[-1]["status"] == "ENFORCEMENT_ERROR"


def test_failure_without_previous_leaves_clean_state(harness, server, backend):
    backend.fail_apply.add(7)
    server.assign("POL-001", 7)
    a = harness.enroll()
    r = server.status_reports[-1]
    assert (r["status"], r["error_code"], r["active_version"]) == ("FAILED", "policy_apply_failed", None)
    assert ("remove",) in backend.calls
    assert harness.db.get_policy("current") is None
    a.tick()
    assert server.heartbeats[-1]["status"] == "ENFORCEMENT_ERROR"
