"""Org-token sync loop: change -> validate -> apply -> cache; 304 -> no re-apply;
401 / unreachable -> keep enforcing the cached policy (offline behavior)."""

from __future__ import annotations

import copy

import pytest

from conftest import FakeClock
from fake_server import ACCESS_TOKEN, BASE_URL, EXAMPLE_CONTENT, ORG, FakeServer
from recording_backend import RecordingBackend

from nam_agent.api.backoff import AUTH_RETRY_SECONDS
from nam_agent.api.client import AgentApiClient
from nam_agent.agent.org_sync import OrgAgent, OrgAgentDeps
from nam_agent.config.paths import AgentPaths
from nam_agent.config.settings import AgentSettings
from nam_agent.storage.db import Database

ADMIN_SERVER = "https://mgmt.example.test"


def build(tmp_path, server, backend, clock, **overrides):
    paths = AgentPaths(tmp_path)
    paths.ensure()
    db = Database(paths.db_path)
    api = AgentApiClient(BASE_URL, transport=server.transport)
    kw = dict(
        admin_server=ADMIN_SERVER,
        access_token=ACCESS_TOKEN,
        organization_id=ORG,
        cache_expiration_minutes=5,
        secret_protector="insecure-dev",
    )
    kw.update(overrides)
    settings = AgentSettings(**kw)
    agent = OrgAgent(
        OrgAgentDeps(
            settings=settings,
            paths=paths,
            db=db,
            api=api,
            backend=backend,
            resolver=lambda host, port: ["198.51.100.10"],
            clock=clock,
            device_mac=lambda: TEST_MAC,
        )
    )
    return agent, db, api


TEST_MAC = "AA:BB:CC:DD:EE:01"


@pytest.fixture
def parts(tmp_path):
    server = FakeServer()
    backend = RecordingBackend()
    clock = FakeClock()
    agent, db, api = build(tmp_path, server, backend, clock)
    yield agent, db, api, server, backend, clock
    api.close()
    db.close()


def test_org_mode_selected_by_access_token(parts):
    agent, *_ = parts
    assert agent.settings.mode == "org-token"
    assert agent.settings.api_base_url == BASE_URL


def test_first_fetch_validates_applies_and_caches(parts):
    agent, db, api, server, backend, clock = parts
    server.assign_org(version=1)
    delay = agent.tick()
    assert backend.applied_versions() == [1]
    cur = db.get_policy("current")
    assert cur is not None and cur.version == 1 and cur.policy_id == "EFFECTIVE"
    assert delay == agent.settings.cache_expiration_seconds == 300


def test_unchanged_304_does_not_reapply(parts):
    agent, db, api, server, backend, clock = parts
    server.assign_org(version=1)
    agent.tick()
    assert backend.applied_versions() == [1]
    # Second cycle: the client sends If-None-Match with the cached ETag -> 304.
    agent.tick()
    assert backend.applied_versions() == [1]  # no re-apply
    assert server.org_policy_downloads[-1]["if_none_match"] == server.org_assignment.etag


def test_change_downloads_and_reapplies(parts):
    agent, db, api, server, backend, clock = parts
    server.assign_org(version=1)
    agent.tick()
    changed = copy.deepcopy(EXAMPLE_CONTENT)
    changed["blocked_domains"] = ["newbad.example", "*.newbad.example"]
    server.assign_org(version=2, content=changed)
    agent.tick()
    assert backend.applied_versions() == [1, 2]
    assert db.get_policy("current").version == 2


def test_401_keeps_cached_policy_and_retries_slowly(parts):
    agent, db, api, server, backend, clock = parts
    server.assign_org(version=1)
    agent.tick()
    assert backend.installed.version == 1
    # The access token is rotated/cleared on the server.
    server.access_token = "nat_rotated"
    delay = agent.tick()
    assert delay == AUTH_RETRY_SECONDS
    assert backend.installed.version == 1  # still enforcing the cached policy
    assert db.get_policy("current").version == 1
    assert db.get_runtime("org_last_sync_error") == "INVALID_ACCESS_TOKEN"


def test_server_unreachable_keeps_cached_policy(parts):
    agent, db, api, server, backend, clock = parts
    server.assign_org(version=1)
    agent.tick()
    server.down = True
    delay = agent.tick()
    assert delay > 0
    assert backend.installed.version == 1
    assert db.get_policy("current").version == 1


def test_no_policy_assigned_keeps_cache(parts):
    agent, db, api, server, backend, clock = parts
    server.assign_org(version=1)
    agent.tick()
    server.org_assignment = None  # admin removed all org restrictions
    agent.tick()
    assert db.get_policy("current").version == 1
    assert backend.installed.version == 1


def test_restart_reasserts_cached_policy(tmp_path):
    server = FakeServer()
    server.assign_org(version=1)
    backend = RecordingBackend()
    clock = FakeClock()
    agent, db, api = build(tmp_path, server, backend, clock)
    agent.tick()
    assert backend.installed.version == 1
    api.close()
    db.close()

    # Restart offline: a fresh backend, server unreachable; the cached policy is re-applied.
    server.down = True
    backend2 = RecordingBackend()
    agent2, db2, api2 = build(tmp_path, server, backend2, clock)
    agent2.startup()
    assert backend2.installed is not None and backend2.installed.version == 1
    api2.close()
    db2.close()


def test_each_fetch_identifies_the_computer_by_mac(parts):
    """X-Device-MAC (contract §4.2) is sent on full downloads and on 304 check-ins alike."""
    agent, db, api, server, backend, clock = parts
    server.assign_org(version=1)
    agent.tick()
    agent.tick()
    assert [d["device_mac"] for d in server.org_policy_downloads] == [TEST_MAC, TEST_MAC]
    assert server.org_policy_downloads[1]["if_none_match"] is not None  # second one was a 304 check-in
