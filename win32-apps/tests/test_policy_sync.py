from fake_server import EXAMPLE_CONTENT


def test_first_policy_downloaded_validated_applied_acked(harness, server, backend):
    server.assign("POL-001", 7)
    a = harness.enroll()
    assert backend.applied_versions() == [7]
    assert server.policy_downloads[0]["if_none_match"] is None
    assert server.acks == [{"policy_id": "POL-001", "version": 7, "content_sha256": server.assignment.sha}]
    assert [r["status"] for r in server.status_reports] == ["DOWNLOADED", "APPLYING"]
    cur = harness.db.get_policy("current")
    assert cur.pair == ("POL-001", 7) and cur.etag == server.assignment.etag
    assert backend.last_management.hosts == ("mgmt.example.test",)
    assert backend.last_management.addresses == ("198.51.100.10",)
    assert a.db.get_row("policy_status")["status"] == "APPLIED"


def test_same_version_does_not_download(harness, server):
    server.assign("POL-001", 7)
    a = harness.enroll()
    n = len(server.policy_downloads)
    a.tick()
    a.tick()
    assert len(server.policy_downloads) == n


def test_if_none_match_304_keeps_active(harness, server, backend):
    server.assign("POL-001", 7)
    a = harness.enroll()
    etag = harness.db.get_policy("current").etag
    # Server momentarily advertises a different version but content/etag unchanged.
    fetch = a.api.get_policy(a.enrollment.credential(), if_none_match=etag)
    assert fetch.kind == "not_modified"
    from nam_agent.api.models import PolicyRef

    assert a.sync(PolicyRef(policy_id="POL-001", version=8, etag=None)) == "not_modified"
    assert server.policy_downloads[-1]["if_none_match"] == etag
    assert harness.db.get_policy("current").version == 7
    assert backend.applied_versions() == [7]


def test_version_change_downloads_and_rotates(harness, server, backend):
    server.assign("POL-001", 6)
    a = harness.enroll()
    server.assign("POL-001", 7, dict(EXAMPLE_CONTENT, blocked_domains=["example.com"]))
    a.tick()
    assert backend.applied_versions() == [6, 7]
    assert server.policy_downloads[-1]["if_none_match"] == '"POL-001:6:0587ffd8"'
    assert harness.db.get_policy("current").version == 7
    assert harness.db.get_policy("previous").version == 6


def test_lower_version_from_server_rollback_is_accepted(harness, server, backend):
    server.assign("POL-001", 7)
    a = harness.enroll()
    server.assign("POL-001", 5, dict(EXAMPLE_CONTENT, block_quic=False))
    a.tick()
    assert harness.db.get_policy("current").version == 5
    assert backend.installed.content.block_quic is False


def test_disabled_policy_removes_enforcement(harness, server, backend):
    server.assign("POL-001", 7)
    a = harness.enroll()
    server.assign("POL-001", 8, dict(EXAMPLE_CONTENT, enabled=False))
    a.tick()
    assert backend.installed is None and ("remove",) in backend.calls
    assert harness.db.get_policy("current").version == 8
    a.tick()
    assert server.heartbeats[-1]["status"] == "HEALTHY"


def test_unassigned_keeps_cached_policy(harness, server, backend):
    server.assign("POL-001", 7)
    a = harness.enroll()
    server.assignment = None
    a.tick()
    assert harness.db.get_policy("current").version == 7
    assert backend.installed.version == 7


def test_policy_cache_ttl_triggers_explicit_version_check(harness, server):
    server.assign("POL-001", 7)
    a = harness.enroll()
    n = sum(r.url.path.endswith("/policy/version") for r in server.requests)
    a.tick()
    assert sum(r.url.path.endswith("/policy/version") for r in server.requests) == n
    harness.clock.advance(301)
    a.tick()
    assert sum(r.url.path.endswith("/policy/version") for r in server.requests) == n + 1
