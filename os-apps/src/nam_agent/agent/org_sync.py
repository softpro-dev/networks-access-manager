"""Org-token (unattended) mode control loop.

Selected when an ACCESS_TOKE is configured (contract §4.2). Unlike per-device mode
there is no enrollment, no device identity and no heartbeat: the service simply
authenticates with the non-expiring organization access token and fetches the merged
**organization-wide** policy on a fixed cadence (`CACHE_EXPIRATION_TIME_IN_MINUTE`).

startup: re-assert the cached policy -> loop:
  fetch org-policy (If-None-Match: cached ETag)
    304  -> nothing changed, keep enforcing
    404  -> no org policy assigned, keep the cached policy
    200  -> validate (no device_uuid) -> apply via EnforcementBackend -> cache
  on 401 (token rotated/cleared)  -> keep enforcing the cached policy, retry slowly
  on network / 5xx                -> keep enforcing the cached policy, back off

The cached policy is never dropped because the server is unreachable or the token
was rotated; only a delivered policy with `enabled: false` removes enforcement.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from typing import Callable

from ..api.backoff import AUTH_RETRY_SECONDS, Backoff
from ..api.client import AgentApiClient
from ..api.errors import ApiError, ApiUnavailable
from ..config.paths import AgentPaths
from ..config.settings import AgentSettings
from ..enforcement.base import EnforcementBackend, ManagementEndpoints
from ..enforcement.management import Resolver, resolve_management, system_resolver
from ..policy.validator import PolicyValidationError, ValidatedPolicy, validate_org_policy
from ..security.redact import redact
from ..storage.db import Database, StoredPolicy, utcnow
from .pipeline import PolicyApplier

log = logging.getLogger(__name__)


@dataclass
class OrgAgentDeps:
    settings: AgentSettings
    paths: AgentPaths
    db: Database
    api: AgentApiClient
    backend: EnforcementBackend
    resolver: Resolver = system_resolver
    clock: Callable[[], float] = time.time
    #: This computer's primary MAC, sent as X-Device-MAC so the console can show it as synced.
    device_mac: Callable[[], str | None] | None = None


MAX_LOGGED_ENTRIES = 50


def _short_list(items: list) -> str:
    shown = ", ".join(str(x) for x in items[:MAX_LOGGED_ENTRIES])
    more = len(items) - MAX_LOGGED_ENTRIES
    return (shown + (f", … (+{more} more)" if more > 0 else "")) or "(none)"


def policy_headline(doc: dict) -> str:
    """One line: version, mode and list sizes of a policy document (no secrets)."""
    c = doc.get("content") or {}
    mode = "Allow Only" if c.get("default_action") == "block" else "Black List"
    if c.get("enabled") is False:
        mode = "disabled"
    return (
        f"{doc.get('policy_id')} v{doc.get('version')}, {mode}, "
        f"{len(c.get('allowed_domains') or [])} allowed, {len(c.get('blocked_domains') or [])} blocked, "
        f"{len(c.get('blocked_ips') or [])} IPs, {len(c.get('redirect_rules') or [])} redirects"
    )


def describe_policy(doc: dict) -> list[str]:
    """Readable lines describing a received policy document, for the service log."""
    c = doc.get("content") or {}
    sources = ", ".join(
        f"{s.get('code')} ({s.get('kind')} via {'/'.join(s.get('via') or [])})" for s in doc.get("sources") or []
    ) or "(none listed)"
    flags = ", ".join(
        f"{k}={'on' if c.get(k) else 'off'}" for k in ("block_quic", "block_dot", "block_doh", "enforce_browser_policies")
    )
    redirects = [f"{r.get('from')} -> {r.get('to')}" for r in c.get("redirect_rules") or []]
    return [
        f"  scope: {doc.get('assignment_scope')}; from restrictions: {sources}",
        f"  default action: {c.get('default_action')} (enabled={c.get('enabled')})",
        f"  allowed domains: {_short_list(list(c.get('allowed_domains') or []))}",
        f"  blocked domains: {_short_list(list(c.get('blocked_domains') or []))}",
        f"  blocked IPs: {_short_list(list(c.get('blocked_ips') or []))}",
        f"  redirects: {_short_list(redirects)}",
        f"  protocols: {flags}",
    ]


def primary_mac(preferred_interface: str | None = None) -> str | None:
    """MAC of the primary interface, the same selection the agent reports elsewhere. Never raises."""
    try:
        from ..network.interfaces import discover

        primary = next((i for i in discover(preferred_interface) if i.is_primary), None)
        return primary.mac if primary else None
    except Exception:  # noqa: BLE001 - identification is optional
        log.debug("could not determine the primary MAC", exc_info=True)
        return None


class OrgAgent:
    def __init__(self, deps: OrgAgentDeps):
        self.d = deps
        self.settings = deps.settings
        self.db = deps.db
        self.api = deps.api
        self.backend = deps.backend
        self.clock = deps.clock
        # No status/ack endpoint exists for org-token mode: reporting is local only.
        self.applier = PolicyApplier(
            deps.db,
            deps.backend,
            management=self.management,
            connectivity_check=self._connectivity_check,
            report=lambda body: None,
            ack=lambda policy: None,
            revalidate=self._revalidate_stored,
            clock=deps.clock,
        )
        self.backoff = Backoff()
        self._started = False
        self._warned_unassigned = False
        #: Set by the live-events listener (or anyone) to check the server now instead of at the next poll.
        self._wake = threading.Event()
        #: Optional `LiveEvents` listener, started/stopped with `run()` (wired in runtime.py).
        self.live = None
        self.wake_jitter: Callable[[], float] = lambda: 0.0

    # ------------------------------------------------------------ helpers
    def management(self) -> ManagementEndpoints:
        # The management host is the ADMIN_SERVER host (API base = ADMIN_SERVER/api),
        # so the management exception always keeps ADMIN_SERVER reachable.
        return resolve_management(self.settings.management_host, self.settings.management_port, self.d.resolver)

    def _connectivity_check(self) -> None:
        self.api.health()

    def _access_token(self) -> str:
        tok = self.settings.access_token
        if tok is None:  # pragma: no cover - runtime only builds OrgAgent when set
            raise RuntimeError("no organization access token configured")
        return tok.get_secret_value()

    def _validate(self, raw, etag: str | None = None) -> ValidatedPolicy:
        return validate_org_policy(
            raw,
            expected_organization_id=self.settings.organization_id,
            management_hosts=[self.settings.management_host],
            response_etag=etag,
        )

    def _revalidate_stored(self, stored: StoredPolicy) -> ValidatedPolicy:
        return self._validate(stored.document)

    def active_policy(self) -> StoredPolicy | None:
        return self.db.get_policy("current")

    def _release_unassigned(self, active: StoredPolicy) -> None:
        """Remove enforcement and forget the cached policy. If removal fails, keep the cache so the
        next cycle retries (never report 'unassigned' while rules are still installed)."""
        try:
            self.backend.remove()
        except Exception as e:  # noqa: BLE001
            log.error("could not remove enforcement after restrictions were cleared: %s", e)
            return
        self.db.clear_active()
        self.db.update_row(
            "policy_status", policy_id="EFFECTIVE", version=0, status="UNASSIGNED", error_code=None,
            message="no restriction assigned; enforcement removed",
        )
        log.info("no organization policy assigned any more: removed enforcement of %s v%s", active.policy_id, active.version)

    def _cadence(self) -> float:
        return float(self.settings.cache_expiration_seconds)

    # ------------------------------------------------------------ lifecycle
    def startup(self) -> None:
        if self._started:
            return
        self._started = True
        active = self.active_policy()
        if active:
            log.info("org-token mode: loaded cached policy %s v%s", active.policy_id, active.version)
        else:
            log.info("org-token mode: no cached policy")
        self.applier.reassert_cached()

    def wake(self, reason: str = "") -> None:
        """Check the server now (called from the live-events thread). Thread-safe."""
        self._wake.set()

    def _sleep(self, stop: threading.Event, delay: float) -> None:
        """Wait `delay` seconds, returning early on stop or wake (a wake adds a small random delay
        so many computers notified at once do not all hit the server in the same instant)."""
        remaining = max(0.0, delay)
        while remaining > 0 and not stop.is_set():
            step = min(1.0, remaining)
            if self._wake.wait(step):
                self._wake.clear()
                stop.wait(self.wake_jitter())
                return
            remaining -= step

    def run(self, stop: threading.Event) -> None:
        self.startup()
        if self.live is not None:
            self.live.start()
        try:
            while not stop.is_set():
                self._wake.clear()  # this cycle covers every change notified so far
                delay = self.tick()
                self._sleep(stop, delay)
        finally:
            if self.live is not None:
                self.live.stop()
        log.info("org-token loop stopped; enforcement state left unchanged")

    def tick(self) -> float:
        """One scheduling step. Returns seconds until the next step."""
        self.startup()
        try:
            return self._cycle()
        except ApiUnavailable as e:
            delay = e.retry_after if e.retry_after is not None else self.backoff.next_delay()
            self.db.set_runtime("org_last_sync_error", redact(str(e))[:300])
            log.warning("management server unavailable (%s); keeping cached policy, retry in %.0fs", e, delay)
            return delay
        except ApiError as e:
            if e.is_auth_failure:
                # The access token was rotated/cleared (401) or the organization was
                # disabled (403). Keep enforcing the cached policy; retry slowly.
                self.db.set_runtime("org_last_sync_error", e.code)
                log.error("access token rejected (%s); keeping cached policy, retrying in %ds", e.code, int(AUTH_RETRY_SECONDS))
                return AUTH_RETRY_SECONDS
            delay = e.retry_after if (e.is_rate_limited and e.retry_after) else self.backoff.next_delay()
            self.db.set_runtime("org_last_sync_error", e.code)
            log.warning("server returned %s; retry in %.0fs", e.code, delay)
            return delay
        except Exception as e:
            self.db.set_runtime("org_last_sync_error", f"{e.__class__.__name__}")
            log.exception("unexpected error in org-token loop")
            return self.backoff.next_delay()

    # ------------------------------------------------------------ one cycle
    def _cycle(self) -> float:
        token = self._access_token()
        active = self.active_policy()
        mac_fn = self.d.device_mac or (lambda: primary_mac(self.settings.primary_interface))
        fetch = self.api.org_policy(token, if_none_match=active.etag if active else None, device_mac=mac_fn())
        # A successful request proves the token and server are good.
        self.backoff.reset()
        self.db.set_runtime("org_last_sync_ok_at", utcnow())
        self.db.set_runtime("org_last_sync_error", None)

        # One line per check-in, so `Get-Content agent.log -Wait` shows every poll.
        if fetch.kind == "not_modified":
            log.info("check-in: restrictions unchanged (%s)", policy_headline(active.document) if active else "nothing cached")
            return self._cadence()
        if fetch.kind == "none":
            log.info("check-in: no restriction assigned to this computer or organization")
            # An authenticated "no policy assigned" is the admin's decision (restrictions removed),
            # not an outage: lift enforcement. Network errors / 401 above keep the cache.
            if active is not None:
                self._release_unassigned(active)
            return self._cadence()
        self._warned_unassigned = False

        try:
            candidate = self._validate(fetch.body, fetch.etag)
        except PolicyValidationError as e:
            log.error("organization policy rejected: %s", e)
            self.db.update_row(
                "policy_status", policy_id="EFFECTIVE", version=0, status="VALIDATION_FAILED",
                error_code="policy_validation_failed", message=redact(str(e))[:1000],
            )
            return self._cadence()

        for w in candidate.warnings:
            log.warning("policy %s v%s: %s", candidate.policy_id, candidate.version, w)
        if active is not None and active.pair == candidate.pair and active.content_sha256 == candidate.content_sha256:
            log.info("check-in: restrictions unchanged (%s)", policy_headline(candidate.document))
            return self._cadence()
        log.info("check-in: received new restrictions: %s", policy_headline(candidate.document))
        for line in describe_policy(candidate.document):
            log.info(line)
        if active is not None and candidate.version < active.version and candidate.policy_id == active.policy_id:
            log.info("server rolled the org policy back from v%s to v%s", active.version, candidate.version)
        self.applier.apply_candidate(candidate)
        return self._cadence()

    # ------------------------------------------------------------ status
    def status_summary(self) -> dict:
        active = self.active_policy()
        prev = self.db.get_policy("previous")
        pst = self.db.get_row("policy_status")
        be = self.backend.status()
        return {
            "mode": "org-token",
            "organization_id": self.settings.organization_id,
            "admin_server": self.settings.admin_server,
            "api_base_url": self.settings.api_base_url,
            "cache_expiration_minutes": self.settings.cache_expiration_minutes,
            "active_policy": f"{active.policy_id} v{active.version}" if active else None,
            "previous_policy": f"{prev.policy_id} v{prev.version}" if prev else None,
            "policy_status": {k: pst[k] for k in ("policy_id", "version", "status", "error_code", "message")},
            "last_sync_ok_at": self.db.get_runtime("org_last_sync_ok_at"),
            "last_sync_error": self.db.get_runtime("org_last_sync_error"),
            "enforcement_backend": self.backend.name,
            "enforcement_state": be.state.value,
            "enforcement_detail": be.detail,
        }


__all__ = ["OrgAgent", "OrgAgentDeps"]
