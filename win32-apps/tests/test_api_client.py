import httpx
import pytest

from nam_agent.api.client import AgentApiClient
from nam_agent.api.errors import ApiError, ApiUnavailable
from nam_agent.security.redact import redact


def client(handler):
    return AgentApiClient("https://mgmt.example.test/api", transport=httpx.MockTransport(handler))


def test_error_envelope_is_parsed():
    c = client(lambda r: httpx.Response(401, json={"error": {"code": "INVALID_CREDENTIAL", "message": "nope"}}))
    with pytest.raises(ApiError) as ei:
        c.policy_version("ndc_abcdefgh.xyz")
    assert ei.value.code == "INVALID_CREDENTIAL" and ei.value.is_auth_failure
    assert "ndc_" not in str(ei.value)


def test_5xx_and_network_errors_are_unavailable():
    with pytest.raises(ApiUnavailable):
        client(lambda r: httpx.Response(503, headers={"retry-after": "7"})).health()

    def boom(r):
        raise httpx.ConnectError("refused", request=r)

    with pytest.raises(ApiUnavailable):
        client(boom).health()


def test_redirects_are_not_followed():
    seen = []

    def h(r):
        seen.append(str(r.url))
        return httpx.Response(302, headers={"location": "https://evil.example/steal"})

    with pytest.raises(ApiUnavailable):
        client(h).heartbeat("ndc_abcdefgh.secret", {})
    assert seen == ["https://mgmt.example.test/api/agent/heartbeat"]


def test_paths_are_joined_under_api_base():
    urls = []

    def h(r):
        urls.append(r.url.path)
        return httpx.Response(200, json={"status": "ok"})

    client(h).health()
    assert urls == ["/api/health"]


def test_no_policy_assigned():
    c = client(lambda r: httpx.Response(404, json={"error": {"code": "NO_POLICY_ASSIGNED", "message": "x"}}))
    assert c.get_policy("t").kind == "none"


def test_redaction():
    s = redact("Authorization: Bearer ndc_abc123.SECRETsecret_- and X-Registration-Token: tok123")
    assert "SECRET" not in s and "tok123" not in s
    assert redact("token ndc_abc123.SECRETsecret_- here") == "token ndc_*** here"
