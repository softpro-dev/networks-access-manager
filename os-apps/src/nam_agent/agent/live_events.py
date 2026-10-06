"""Live change notifications for org-token mode (contract §4.3).

A background thread keeps one Server-Sent Events stream open to `GET {api}/agent/events`
(`Authorization: Bearer <ACCESS_TOKE>`). The server sends `event: policy_changed` whenever an
admin changes something that can affect this organization's computers; the listener then wakes
the org-token loop, which re-fetches `/agent/org-policy` the normal way (ETag, validation).

The stream carries no policy data and is purely an accelerator: polling every
CACHE_EXPIRATION_TIME_IN_MINUTE continues regardless, so a dropped connection, a proxy that
does not stream, or an older server without the endpoint only means "updates arrive at the next
poll". Works over http (dev) and https (production) with the same TLS settings as the API client.
"""

from __future__ import annotations

import json
import logging
import random
import threading
from typing import Callable

import httpx

from .. import AGENT_VERSION
from ..api.backoff import AUTH_RETRY_SECONDS, Backoff

log = logging.getLogger(__name__)

#: The server pings every 20 s; three missed pings means the connection is dead.
READ_TIMEOUT_SECONDS = 65.0
#: Server without the endpoint (older version): try again rarely.
UNSUPPORTED_RETRY_SECONDS = 3600.0
#: Spread a burst of refetches from many computers over this window.
MAX_WAKE_JITTER_SECONDS = 2.0


class LiveEvents:
    """Owns the listener thread. `on_change(reason)` is called from that thread."""

    def __init__(
        self,
        api_base_url: str,
        access_token: Callable[[], str],
        on_change: Callable[[str], None],
        *,
        verify: bool | str = True,
        connect_timeout: float = 10.0,
        transport: httpx.BaseTransport | None = None,
        backoff: Backoff | None = None,
    ):
        self._token = access_token
        self._on_change = on_change
        self._client = httpx.Client(
            base_url=api_base_url.rstrip("/") + "/",
            verify=verify,
            timeout=httpx.Timeout(READ_TIMEOUT_SECONDS, connect=connect_timeout),
            follow_redirects=False,
            transport=transport,
            headers={"User-Agent": f"OrganizationNetworkAgent/{AGENT_VERSION}", "Accept": "text/event-stream"},
        )
        self._backoff = backoff or Backoff()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._response: httpx.Response | None = None
        self._lock = threading.Lock()
        self.connected = False
        self._connected_before = False

    # ------------------------------------------------------------ lifecycle
    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="live-events", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        with self._lock:
            resp = self._response
        if resp is not None:
            try:
                resp.close()  # unblocks the read in the listener thread
            except Exception:  # noqa: BLE001
                pass
        if self._thread is not None:
            self._thread.join(timeout)
        self._client.close()

    # ------------------------------------------------------------ loop
    def _run(self) -> None:
        while not self._stop.is_set():
            delay = self.run_once()
            if delay is None:
                return
            self._stop.wait(delay)

    def run_once(self) -> float | None:
        """One connection attempt, reading until it ends. Returns seconds to wait before reconnecting."""
        try:
            with self._client.stream("GET", "agent/events", headers={"Authorization": f"Bearer {self._token()}"}) as resp:
                with self._lock:
                    self._response = resp
                if resp.status_code in (401, 403):
                    log.warning("live updates: access token rejected (HTTP %s); retrying in %ds", resp.status_code, int(AUTH_RETRY_SECONDS))
                    return AUTH_RETRY_SECONDS
                if resp.status_code in (404, 405):
                    log.info("live updates: not supported by this server; using polling only")
                    return UNSUPPORTED_RETRY_SECONDS
                if resp.status_code != 200 or "text/event-stream" not in resp.headers.get("content-type", ""):
                    delay = self._backoff.next_delay()
                    log.warning("live updates: server answered HTTP %s; retrying in %.0fs", resp.status_code, delay)
                    return delay
                self._consume(resp)
        except (httpx.TimeoutException, httpx.TransportError, httpx.StreamError) as e:
            if self._stop.is_set():
                return None
            delay = self._backoff.next_delay()
            if self.connected:
                log.warning("live updates: connection lost (%s); reconnecting in %.0fs", e.__class__.__name__, delay)
            else:
                log.debug("live updates: cannot connect (%s); retrying in %.0fs", e.__class__.__name__, delay)
            return delay
        except Exception:  # noqa: BLE001 - never let the listener kill the service
            log.exception("live updates: unexpected error")
            return self._backoff.next_delay()
        finally:
            with self._lock:
                self._response = None
            self.connected = False
        if self._stop.is_set():
            return None
        # The server ended the stream (restart, token rotated, proxy timeout): reconnect soon.
        log.info("live updates: stream closed by the server; reconnecting")
        return self._backoff.next_delay()

    def _consume(self, resp: httpx.Response) -> None:
        event, data = "message", []
        for line in resp.iter_lines():
            if self._stop.is_set():
                return
            if line == "":
                if data or event != "message":
                    self._dispatch(event, "\n".join(data))
                event, data = "message", []
            elif line.startswith(":"):
                continue  # keep-alive ping
            else:
                field, _, value = line.partition(":")
                value = value[1:] if value.startswith(" ") else value
                if field == "event":
                    event = value
                elif field == "data":
                    data.append(value)

    def _dispatch(self, event: str, data: str) -> None:
        if event == "ready":
            self._backoff.reset()
            self.connected = True
            log.info("live updates: connected; admin changes apply within seconds")
            if self._connected_before:
                # Changes made while disconnected produced no event: check once now.
                self._on_change("reconnected")
            self._connected_before = True
        elif event == "policy_changed":
            try:
                reasons = ", ".join(json.loads(data).get("reasons") or []) or "change"
            except (ValueError, AttributeError):
                reasons = "change"
            log.info("live update: restrictions changed on the server (%s); checking now", reasons)
            self._on_change(reasons)


def wake_jitter(rng: random.Random | None = None) -> float:
    return (rng or random).uniform(0.0, MAX_WAKE_JITTER_SECONDS)


__all__ = ["LiveEvents", "wake_jitter"]
