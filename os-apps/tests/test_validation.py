import json

import pytest
from fake_server import EXAMPLE_CONTENT

from nam_agent.policy.canonical import content_sha256
from nam_agent.policy.validator import PolicyValidationError, validate_policy

DEV = "3f0c7a52-9a6e-4f5b-8a2c-2d9e1f4b7c10"


def doc(**over):
    content = over.pop("content", EXAMPLE_CONTENT)
    d = {
        "schema_version": 1, "policy_id": "POL-001", "version": 7, "organization_id": "INST-001", "device_uuid": DEV,
        "assignment_scope": "ORGANIZATION", "published_at": "2026-09-28T09:00:00.000Z",
        "content_sha256": content_sha256(content), "content": content,
    }
    d.update(over)
    return d


def v(raw, **kw):
    return validate_policy(raw, expected_organization_id="INST-001", expected_device_uuid=DEV, management_hosts=["mgmt.example.test"], **kw)


def test_valid_contract_example():
    p = v(json.dumps(doc()).encode(), response_etag='"POL-001:7:0587ffd8"')
    assert p.pair == ("POL-001", 7) and p.content_sha256.startswith("0587ffd8")
    assert p.content.allowed_domains == ("company.com", "*.company.com")


def _step(raw, **kw):
    with pytest.raises(PolicyValidationError) as ei:
        v(raw, **kw)
    return ei.value.step


def test_invalid_json():
    assert _step(b"{not json") == 1
    assert _step(b'{"a":1,"a":2}') == 1
    assert _step(b"[1,2]") == 1
    assert _step(json.dumps(doc(version=7.5)).encode()) == 1


def test_unknown_keys_rejected():
    assert _step(json.dumps(doc(extra=1)).encode()) == 2
    c = dict(EXAMPLE_CONTENT, surprise=True)
    assert _step(json.dumps(doc(content=c)).encode()) == 2


@pytest.mark.parametrize(
    "over",
    [{"schema_version": 2}, {"version": 0}, {"version": "7"}, {"assignment_scope": "WORLD"}, {"policy_id": "pol 1"},
     {"content": dict(EXAMPLE_CONTENT, enabled="true")}, {"content": dict(EXAMPLE_CONTENT, default_action="deny")}],
)
def test_schema_errors(over):
    assert _step(doc(**over)) == 2


def test_wrong_org():
    assert _step(doc(organization_id="COMPANY-002")) == 3


def test_wrong_device():
    assert _step(doc(device_uuid="00000000-0000-4000-8000-000000000000")) == 4


def test_bad_sha():
    assert _step(doc(content_sha256="0" * 64)) == 5
    tampered = dict(EXAMPLE_CONTENT, block_quic=False)
    d = doc()
    d["content"] = tampered
    assert _step(d) == 5


def test_etag_mismatch():
    assert _step(doc(), response_etag='"POL-001:6:0587ffd8"') == 5


@pytest.mark.parametrize("bad", ["*example.com", "1.2.3.4", "com", "https://x.com/", "x.com:443"])
def test_bad_domains(bad):
    c = dict(EXAMPLE_CONTENT, blocked_domains=[bad])
    assert _step(doc(content=c)) == 6


def test_bad_ips():
    c = dict(EXAMPLE_CONTENT, blocked_ips=["203.0.113.1/24"])
    assert _step(doc(content=c)) == 6


def test_management_exception_required_and_warned():
    with pytest.raises(PolicyValidationError) as ei:
        validate_policy(doc(), expected_organization_id="INST-001", expected_device_uuid=DEV, management_hosts=[])
    assert ei.value.step == 7
    c = dict(EXAMPLE_CONTENT, blocked_domains=["*.example.test"], default_action="block", allowed_domains=[])
    p = v(doc(content=c))
    assert any("management host" in w for w in p.warnings)


def test_missing_fields_take_defaults_but_hash_uses_delivered_content():
    c = {"blocked_domains": ["example.com"]}
    p = v(doc(content=c))
    assert p.content.enabled and p.content.default_action == "allow" and p.content.block_quic
    assert p.content_sha256 == content_sha256(c)


def test_agent_rejects_bad_policies_and_keeps_working_one(harness, server, backend):
    server.assign("POL-001", 6)
    a = harness.enroll()
    bad_cases = [
        {"doc_overrides": {"content_sha256": "f" * 64}},
        {"doc_overrides": {"organization_id": "COMPANY-002"}},
        {"doc_overrides": {"device_uuid": "00000000-0000-4000-8000-000000000000"}},
        {"doc_overrides": {"unexpected": 1}},
        {"raw_body": b"<html>proxy error</html>"},
    ]
    for i, kw in enumerate(bad_cases):
        server.assign("POL-001", 7 + i, **kw)
        a.tick()
        assert harness.db.get_policy("current").version == 6
        assert server.status_reports[-1]["status"] == "VALIDATION_FAILED"
        assert server.status_reports[-1]["error_code"] == "policy_validation_failed"
        assert server.status_reports[-1]["active_version"] == 6
    assert backend.applied_versions() == [6]
    # bad domain content: server-side sha is consistent, agent still rejects on syntax
    server.assign("POL-001", 20, dict(EXAMPLE_CONTENT, blocked_domains=["ex*.com"]))
    a.tick()
    assert harness.db.get_policy("current").version == 6
    assert "step 6" in server.status_reports[-1]["message"]


def test_failed_version_not_retried_until_ttl(harness, server):
    server.assign("POL-001", 6)
    a = harness.enroll()
    server.assign("POL-001", 7, doc_overrides={"content_sha256": "f" * 64})
    a.tick()
    n = len(server.policy_downloads)
    a.tick()
    assert len(server.policy_downloads) == n
    harness.clock.advance(301)
    a.tick()
    assert len(server.policy_downloads) == n + 1
