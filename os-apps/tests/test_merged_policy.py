"""Merged per-computer policy (policy_id "EFFECTIVE") with sources and redirect rules."""

import json

import pytest
from test_validation import DEV, doc, v

from nam_agent.policy.canonical import content_sha256
from nam_agent.policy.domains import decide
from nam_agent.policy.validator import PolicyValidationError

MERGED_CONTENT = {
    "enabled": True,
    "default_action": "block",
    "allowed_domains": ["*.school.org", "learn.school.org", "school.org"],
    "blocked_domains": ["grp.com", "org.com"],
    "blocked_ips": [],
    "block_quic": True,
    "block_dot": True,
    "block_doh": True,
    "enforce_browser_policies": True,
    "redirect_rules": [{"from": "games.com", "to": "learn.school.org"}],
}

SOURCES = [
    {"code": "ALLOW", "kind": "ALLOW_ONLY", "version": 1, "via": ["DEVICE"]},
    {"code": "REDIR", "kind": "REDIRECT", "version": 2, "via": ["GROUP", "ORGANIZATION"]},
]


def merged(**over):
    base = {"content": MERGED_CONTENT, "policy_id": "EFFECTIVE", "version": 3, "assignment_scope": "MERGED", "sources": SOURCES}
    return doc(**{**base, **over})


def test_merged_document_is_accepted():
    d = merged()
    etag = f'"EFFECTIVE:3:{content_sha256(MERGED_CONTENT)[:8]}"'
    p = v(json.dumps(d).encode(), response_etag=etag)
    assert p.pair == ("EFFECTIVE", 3)
    assert p.content.redirect_rules == (("games.com", "learn.school.org"),)
    assert p.content.default_action == "block"


def test_sources_are_optional_and_strict():
    d = merged()
    del d["sources"]
    assert v(d).pair == ("EFFECTIVE", 3)
    bad = merged(sources=[{**SOURCES[0], "secret": "x"}])
    with pytest.raises(PolicyValidationError) as ei:
        v(bad)
    assert ei.value.step == 2


@pytest.mark.parametrize(
    "rules",
    [
        [{"from": "a.com", "to": "*.b.com"}],
        [{"from": "a.com", "to": "a.com"}],
        [{"from": "a.com"}],
        [{"from": "a.com", "to": "b.com", "extra": 1}],
        [{"from": "1.2.3.4", "to": "b.com"}],
    ],
)
def test_bad_redirect_rules_rejected(rules):
    content = {**MERGED_CONTENT, "redirect_rules": rules}
    with pytest.raises(PolicyValidationError) as ei:
        v(merged(content=content))
    assert ei.value.step in (2, 6)


def test_redirect_rules_empty_list_equivalent_hash_is_separate():
    # The server omits an empty redirect list; if one is delivered anyway, it is hashed as delivered.
    content = {k: val for k, val in MERGED_CONTENT.items() if k != "redirect_rules"}
    assert v(merged(content=content)).content.redirect_rules == ()
    with_empty = {**content, "redirect_rules": []}
    assert content_sha256(with_empty) != content_sha256(content)
    assert v(merged(content=with_empty)).content.redirect_rules == ()


def test_decide_redirect_semantics_match_server():
    kw = dict(
        default_action="allow",
        allowed_domains=["*.example.com"],
        blocked_domains=["bad.example.com"],
        redirect_rules=[("games.example.com", "intranet.company.com"), ("bad.example.com", "intranet.company.com")],
    )
    r = decide("games.example.com", **kw)
    assert (r.action, r.target) == ("redirect", "intranet.company.com")
    assert (decide("bad.example.com", **kw).action, decide("bad.example.com", **kw).reason) == ("block", "tie")
    assert decide("news.example.com", **kw).action == "allow"
    assert decide("intranet.company.com", **{**kw, "default_action": "block"}).action == "allow"
    assert decide("games.example.com", **kw, management_hosts=["games.example.com"]).action == "allow"


def test_device_uuid_still_checked_for_merged():
    with pytest.raises(PolicyValidationError) as ei:
        v(merged(device_uuid=DEV.replace("3f", "4f", 1)))
    assert ei.value.step == 4


def test_loopback_always_allowed_even_under_block_all():
    from nam_agent.policy.domains import decide, is_loopback

    kw = dict(default_action="block", allowed_domains=(), blocked_domains=())
    for host in ["localhost", "app.localhost", "LOCALHOST.", "127.0.0.1", "127.5.9.1", "::1"]:
        assert is_loopback(host)
        assert decide(host, **kw).action == "allow"
    # a normal name is still blocked under block-all
    assert decide("example.com", **kw).action == "block"
    # loopback wins even if someone lists it as blocked
    assert decide("localhost", default_action="allow", allowed_domains=(), blocked_domains=("localhost",)).action == "allow"
