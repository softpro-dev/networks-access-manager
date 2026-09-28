import pytest

from nam_agent.policy.domains import DomainPatternError, decide, normalize_domain, validate_domain_pattern
from nam_agent.policy.ip_rules import validate_ip_or_cidr


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("Example.COM", "example.com"),
        ("  example.com.  ", "example.com"),
        ("*.Example.com", "*.example.com"),
        ("bücher.de", "xn--bcher-kva.de"),
        ("*.bücher.de", "*.xn--bcher-kva.de"),
        ("a-b.c-d.example", "a-b.c-d.example"),
    ],
)
def test_normalize_and_validate(raw, expected):
    assert validate_domain_pattern(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "", "com", "localhost", "*", "*example.com", "ex*.com", "a.*.com", "*.*.example.com",
        "https://x.com/", "x.com:443", "x.com/path", "user@x.com", "1.2.3.4", "[2001:db8::1]", "2001:db8::1",
        "-a.com", "a-.com", "a..com", "exa mple.com", "a" * 64 + ".com", ".".join(["a" * 60] * 5), "example.com..", 42,
    ],
)
def test_invalid_patterns(raw):
    with pytest.raises(DomainPatternError):
        validate_domain_pattern(raw)


def test_only_one_trailing_dot_removed():
    assert normalize_domain("example.com..") == "example.com."


def _d(name, allowed=(), blocked=(), default="allow", mgmt=()):
    return decide(name, default_action=default, allowed_domains=list(allowed), blocked_domains=list(blocked), management_hosts=mgmt)


def test_matching_semantics():
    b = ["example.com"]
    assert _d("example.com", blocked=b).action == "block"
    assert _d("a.example.com", blocked=b).action == "allow"
    w = ["*.example.com"]
    assert _d("a.example.com", blocked=w).action == "block"
    assert _d("a.b.example.com", blocked=w).action == "block"
    assert _d("example.com", blocked=w).action == "allow"
    assert _d("badexample.com", blocked=w).action == "allow"
    assert _d("EXAMPLE.com.", blocked=b).action == "block"


def test_specificity_and_ties():
    # exact (3,1) beats wildcard (3,0)
    assert _d("a.example.com", allowed=["a.example.com"], blocked=["*.example.com"]).action == "allow"
    # longer wildcard wins
    assert _d("x.b.example.com", allowed=["*.b.example.com"], blocked=["*.example.com"]).action == "allow"
    assert _d("x.b.example.com", allowed=["*.example.com"], blocked=["*.b.example.com"]).action == "block"
    # tie -> block
    d = _d("example.com", allowed=["example.com"], blocked=["example.com"])
    assert (d.action, d.reason) == ("block", "tie")
    # no match -> default
    assert _d("other.org", default="block").action == "block"


def test_management_host_always_allowed():
    d = _d("api.mgmt.example.org", blocked=["*.example.org"], default="block", mgmt=["mgmt.example.org"])
    assert (d.action, d.reason) == ("allow", "management")
    assert _d("mgmt.example.org", default="block", mgmt=["mgmt.example.org"]).action == "allow"


@pytest.mark.parametrize("ok", ["203.0.113.0/24", "2001:db8::/32", "10.0.0.1", "::1", "0.0.0.0/0", "2001:DB8::1"])
def test_ip_ok(ok):
    assert validate_ip_or_cidr(ok) == ok.lower()


@pytest.mark.parametrize("bad", ["203.0.113.1/24", "01.2.3.4", "1.2.3.4/33", "fe80::1%eth0", "1.2.3.4/024", "example.com", "", "1.2.3.4/8/1"])
def test_ip_bad(bad):
    with pytest.raises(ValueError):
        validate_ip_or_cidr(bad)
