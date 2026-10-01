"""org_policy() client: request shape, Authorization header, 200/304/404/401 (contract §4.2)."""

from __future__ import annotations

import json

import httpx
import pytest

from fake_server import ACCESS_TOKEN, BASE_URL, FakeServer

from nam_agent.api.client import AgentApiClient
from nam_agent.api.errors import ApiError


def client(server: FakeServer) -> AgentApiClient:
    return AgentApiClient(BASE_URL, transport=server.transport)


def test_request_shape_and_authorization_header():
    server = FakeServer()
    server.assign_org(version=3)
    c = client(server)
    fetch = c.org_policy(ACCESS_TOKEN)
    assert fetch.kind == "document"
    doc = json.loads(fetch.body)
    assert doc["policy_id"] == "EFFECTIVE" and "device_uuid" not in doc
    assert doc["assignment_scope"] == "ORGANIZATION"
    req = server.requests[-1]
    assert req.method == "GET"
    assert req.url.path == "/api/agent/org-policy"
    assert req.headers["authorization"] == f"Bearer {ACCESS_TOKEN}"
    assert "x-device-mac" not in req.headers  # optional: only sent when known
    assert fetch.etag == server.org_assignment.etag
    c.org_policy(ACCESS_TOKEN, device_mac="AA:BB:CC:DD:EE:01")
    assert server.requests[-1].headers["x-device-mac"] == "AA:BB:CC:DD:EE:01"
    c.close()


def test_304_when_if_none_match_matches():
    server = FakeServer()
    a = server.assign_org(version=1)
    c = client(server)
    fetch = c.org_policy(ACCESS_TOKEN, if_none_match=a.etag)
    assert fetch.kind == "not_modified" and fetch.etag == a.etag
    assert server.org_policy_downloads[-1]["if_none_match"] == a.etag
    c.close()


def test_404_no_policy_assigned_maps_to_none():
    server = FakeServer()  # no org assignment
    c = client(server)
    assert c.org_policy(ACCESS_TOKEN).kind == "none"
    c.close()


def test_401_invalid_access_token_raises():
    server = FakeServer()
    server.assign_org(version=1)
    c = client(server)
    with pytest.raises(ApiError) as ei:
        c.org_policy("nat_wrongtoken")
    assert ei.value.status == 401 and ei.value.code == "INVALID_ACCESS_TOKEN"
    assert ei.value.is_auth_failure
    c.close()


def test_token_never_appears_in_errors():
    def handler(r: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"code": "INVALID_ACCESS_TOKEN", "message": "no"}})

    c = AgentApiClient(BASE_URL, transport=httpx.MockTransport(handler))
    with pytest.raises(ApiError) as ei:
        c.org_policy("nat_supersecrettoken")
    assert "nat_supersecrettoken" not in str(ei.value)
    c.close()
