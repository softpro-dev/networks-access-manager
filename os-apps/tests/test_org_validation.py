"""validate_org_policy(): accepts the merged doc without device_uuid; rejects wrong org,
bad sha, bad domains/redirects; enforces the management-server (ADMIN_SERVER) exception."""

from __future__ import annotations

import copy
import json

import pytest

from nam_agent.policy.canonical import content_sha256, make_etag
from nam_agent.policy.validator import PolicyValidationError, validate_org_policy

MGMT = ["admin.example.com"]
CONTENT = {
    "enabled": True,
    "default_action": "allow",
    "allowed_domains": ["company.com", "*.company.com"],
    "blocked_domains": ["bad.example", "*.bad.example"],
    "blocked_ips": ["203.0.113.0/24"],
    "block_quic": True,
    "block_dot": True,
    "block_doh": True,
    "enforce_browser_policies": True,
}


def doc(content=None, **overrides):
    content = CONTENT if content is None else content
    d = {
        "schema_version": 1,
        "policy_id": "EFFECTIVE",
        "version": 4,
        "organization_id": "INST-001",
        "assignment_scope": "ORGANIZATION",
        "published_at": "2026-09-29T12:00:00.000Z",
        "content_sha256": content_sha256(content),
        "content": content,
    }
    d.update(overrides)
    return d


def test_accepts_merged_doc_without_device_uuid():
    d = doc()
    vp = validate_org_policy(json.dumps(d).encode(), expected_organization_id="INST-001", management_hosts=MGMT)
    assert vp.policy_id == "EFFECTIVE" and vp.version == 4
    assert vp.content.default_action == "allow"
    assert vp.etag == make_etag("EFFECTIVE", 4, vp.content_sha256)


def test_device_uuid_key_is_rejected_as_unknown():
    d = doc()
    d["device_uuid"] = "3f0c7a52-9a6e-4f5b-8a2c-2d9e1f4b7c10"
    d["content_sha256"] = content_sha256(d["content"])
    with pytest.raises(PolicyValidationError) as ei:
        validate_org_policy(json.dumps(d).encode(), expected_organization_id="INST-001", management_hosts=MGMT)
    assert ei.value.step == 2


def test_no_org_configured_skips_org_check():
    d = doc()
    vp = validate_org_policy(json.dumps(d).encode(), expected_organization_id=None, management_hosts=MGMT)
    assert vp.version == 4


def test_wrong_organization_rejected():
    d = doc()
    with pytest.raises(PolicyValidationError) as ei:
        validate_org_policy(json.dumps(d).encode(), expected_organization_id="OTHER-ORG", management_hosts=MGMT)
    assert ei.value.step == 3


def test_bad_sha_rejected():
    d = doc()
    d["content_sha256"] = "0" * 64
    with pytest.raises(PolicyValidationError) as ei:
        validate_org_policy(json.dumps(d).encode(), expected_organization_id="INST-001", management_hosts=MGMT)
    assert ei.value.step == 5


def test_bad_domain_rejected():
    bad = copy.deepcopy(CONTENT)
    bad["blocked_domains"] = ["not a domain"]
    with pytest.raises(PolicyValidationError) as ei:
        validate_org_policy(json.dumps(doc(bad)).encode(), expected_organization_id="INST-001", management_hosts=MGMT)
    assert ei.value.step == 6


def test_bad_redirect_rejected():
    bad = copy.deepcopy(CONTENT)
    bad["redirect_rules"] = [{"from": "old.example.com", "to": "*.wild.example"}]  # wildcard target invalid
    with pytest.raises(PolicyValidationError) as ei:
        validate_org_policy(json.dumps(doc(bad)).encode(), expected_organization_id="INST-001", management_hosts=MGMT)
    assert ei.value.step == 6


def test_management_host_unknown_rejected():
    with pytest.raises(PolicyValidationError) as ei:
        validate_org_policy(json.dumps(doc()).encode(), expected_organization_id="INST-001", management_hosts=[])
    assert ei.value.step == 7


def test_management_host_always_allowed_even_if_policy_blocks_it():
    # A policy that blocks the admin server host is valid; the exception overrides it,
    # so the ADMIN_SERVER host is always allowed. The validator warns rather than fails.
    blocking = copy.deepcopy(CONTENT)
    blocking["default_action"] = "block"
    blocking["allowed_domains"] = []
    blocking["blocked_domains"] = ["admin.example.com", "*.admin.example.com"]
    vp = validate_org_policy(
        json.dumps(doc(blocking)).encode(), expected_organization_id="INST-001", management_hosts=MGMT
    )
    assert any("management host" in w for w in vp.warnings)

    from nam_agent.policy.domains import decide

    decision = decide(
        "admin.example.com",
        default_action=vp.content.default_action,
        allowed_domains=vp.content.allowed_domains,
        blocked_domains=vp.content.blocked_domains,
        redirect_rules=vp.content.redirect_rules,
        enabled=vp.content.enabled,
        management_hosts=MGMT,
    )
    assert decision.action == "allow" and decision.reason == "management"
