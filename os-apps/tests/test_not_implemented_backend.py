import pytest

from nam_agent.enforcement import EnforcementError, EnforcementState, NotImplementedBackend, default_backend


def test_default_backend_is_not_implemented():
    assert isinstance(default_backend(), NotImplementedBackend)


def test_fails_honestly(harness):
    be = NotImplementedBackend()
    assert be.status().state == EnforcementState.ENFORCEMENT_NOT_AVAILABLE
    assert be.verify().ok is False
    with pytest.raises(EnforcementError):
        be.apply(None, None)  # type: ignore[arg-type]
    be.remove()  # nothing installed: no-op


def test_pipeline_with_not_implemented_backend_reports_failure(tmp_path, server):
    from conftest import FakeClock, Harness

    h = Harness(tmp_path, server, NotImplementedBackend(), FakeClock())
    try:
        server.assign("POL-001", 7)
        a = h.enroll()
        r = server.status_reports[-1]
        assert (r["status"], r["error_code"]) == ("FAILED", "policy_apply_failed")
        assert "ENFORCEMENT_NOT_AVAILABLE" in r["message"]
        assert server.acks == []
        assert h.db.get_policy("current") is None
        a.tick()
        assert server.heartbeats[-1]["status"] == "ENFORCEMENT_ERROR"
        assert server.heartbeats[-1]["current_policy_version"] == 0
        assert a.status_summary()["enforcement_state"] == "ENFORCEMENT_NOT_AVAILABLE"
    finally:
        h.stop()


def test_no_policy_assigned_is_healthy_with_not_implemented_backend(tmp_path, server):
    from conftest import FakeClock, Harness

    h = Harness(tmp_path, server, NotImplementedBackend(), FakeClock())
    try:
        a = h.enroll()
        a.tick()
        assert server.heartbeats[-1]["status"] == "HEALTHY"
    finally:
        h.stop()
