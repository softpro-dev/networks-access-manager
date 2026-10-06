"""Live change notifications (contract §4.3): SSE listener + waking the org-token loop."""

from __future__ import annotations

import threading
import time

import httpx

from nam_agent.agent.live_events import UNSUPPORTED_RETRY_SECONDS, LiveEvents
from nam_agent.api.backoff import AUTH_RETRY_SECONDS

SSE = "text/event-stream; charset=utf-8"


def make(responses: list[httpx.Response], seen: list[httpx.Request] | None = None):
    changes: list[str] = []
    queue = list(responses)

    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        return queue.pop(0)

    live = LiveEvents("http://mgmt.test/api", lambda: "nat_TEST", changes.append, transport=httpx.MockTransport(handler))
    return live, changes


def stream(body: str) -> httpx.Response:
    return httpx.Response(200, headers={"content-type": SSE}, content=body.encode())


READY = 'retry: 10000\nevent: ready\ndata: {"organization_code":"ORG"}\n\n'


def test_policy_changed_wakes_the_agent_and_sends_the_token():
    seen: list[httpx.Request] = []
    live, changes = make(
        [stream(READY + ": ping\n\n" + 'event: policy_changed\ndata: {"reasons":["POLICY_ASSIGNED","POLICY_PUBLISHED"]}\n\n')],
        seen,
    )
    delay = live.run_once()
    assert changes == ["POLICY_ASSIGNED, POLICY_PUBLISHED"]  # first `ready` alone triggers nothing
    assert delay is not None and delay > 0  # stream ended -> reconnect later
    assert seen[0].url.path == "/api/agent/events"
    assert seen[0].headers["authorization"] == "Bearer nat_TEST"
    assert seen[0].headers["accept"] == "text/event-stream"


def test_reconnect_checks_once_for_changes_missed_while_disconnected():
    live, changes = make([stream(READY), stream(READY)])
    live.run_once()
    assert changes == []
    live.run_once()
    assert changes == ["reconnected"]


def test_rejected_token_and_old_server():
    live, changes = make([httpx.Response(401, json={"error": {"code": "INVALID_ACCESS_TOKEN"}})])
    assert live.run_once() == AUTH_RETRY_SECONDS
    live, _ = make([httpx.Response(404, json={"error": {"code": "NOT_FOUND"}})])
    assert live.run_once() == UNSUPPORTED_RETRY_SECONDS
    assert changes == []


def test_non_stream_response_backs_off():
    live, changes = make([httpx.Response(200, headers={"content-type": "text/html"}, content=b"<html>")])
    delay = live.run_once()
    assert delay is not None and 5 <= delay <= 300
    assert changes == []


def test_network_error_backs_off():
    def handler(request):
        raise httpx.ConnectError("refused", request=request)

    live = LiveEvents("http://mgmt.test/api", lambda: "nat_TEST", lambda r: None, transport=httpx.MockTransport(handler))
    delay = live.run_once()
    assert delay is not None and 5 <= delay <= 300


def test_org_agent_sleep_returns_early_on_wake():
    from nam_agent.agent.org_sync import OrgAgent

    agent = OrgAgent.__new__(OrgAgent)  # only the wait machinery is exercised
    agent._wake = threading.Event()
    agent.wake_jitter = lambda: 0.0
    stop = threading.Event()
    threading.Timer(0.2, agent.wake).start()
    t0 = time.monotonic()
    agent._sleep(stop, 30)
    assert time.monotonic() - t0 < 2
    assert not agent._wake.is_set()
