"""Agent control loop.

startup: load + re-assert cached policy -> enroll / poll -> [every heartbeat interval]
heartbeat -> version check -> download (If-None-Match) -> validate -> apply -> verify -> ack.

The cached policy is never dropped because the server is unreachable, rejects the
credential, or reports that nothing is assigned. Only a delivered policy with
`enabled: false` removes enforcement.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable

from .. import AGENT_VERSION
from ..api.backoff import AUTH_RETRY_SECONDS, Backoff
from ..api.client import AgentApiClient
from ..api.errors import ApiError, ApiUnavailable
from ..api.models import PolicyRef
from ..config.paths import AgentPaths
from ..config.settings import AgentSettings
from ..enforcement.base import EnforcementBackend, EnforcementState, ManagementEndpoints
from ..enforcement.management import Resolver, resolve_management, system_resolver
from ..identity.device_id import get_or_create_device_uuid
from ..network import interfaces as netif
from ..policy.validator import PolicyValidationError, ValidatedPolicy, validate_policy
from ..security.redact import redact
from ..security.secret_store import REGISTRATION_TOKEN, SecretStore
from ..storage.db import Database, StoredPolicy, utcnow
from .enrollment import Enrollment
from .pipeline import PolicyApplier

log = logging.getLogger(__name__)

MIN_INTERVAL = 10
MAX_INTERVAL = 3600
MAX_PENDING_REPORTS = 20


@dataclass
class AgentDeps:
    settings: AgentSettings
    paths: AgentPaths
    db: Database
    secrets: SecretStore
    api: AgentApiClient
    backend: EnforcementBackend
    interfaces: Callable[[], list[netif.NetworkInterface]] | None = None
    resolver: Resolver = system_resolver
    clock: Callable[[], float] = time.time


class Agent:
    def __init__(self, deps: AgentDeps, token_source: str | None = None):
        self.d = deps
        self.settings = deps.settings
        self.db = deps.db
        self.api = deps.api
        self.backend = deps.backend
        self.clock = deps.clock
        self.device_uuid = get_or_create_device_uuid(self.db)
        self._interfaces_fn = deps.interfaces or (lambda: netif.discover(self.settings.primary_interface))
        self.enrollment = Enrollment(
            settings=deps.settings,
            paths=deps.paths,
            db=deps.db,
            secrets_=deps.secrets,
            api=deps.api,
            device_uuid=self.device_uuid,
            interfaces=self._interfaces_fn,
        )
        self.applier = PolicyApplier(
            deps.db,
            deps.backend,
            management=self.management,
            connectivity_check=self._connectivity_check,
            report=self._report,
            ack=self._ack,
            revalidate=self._revalidate_stored,
            clock=deps.clock,
        )
        self.backoff = Backoff()
        self._token_source = token_source
        self._started = False
        self._first_cycle_done = False
        self._auth_blocked_until = 0.0
        self._last_version_check = 0.0
        self._consecutive_errors = 0
        self._warned_unassigned = False

    # ============================================================ helpers
    def management(self) -> ManagementEndpoints:
        return resolve_management(self.settings.management_host, self.settings.management_port, self.d.resolver)

    def _connectivity_check(self) -> None:
        self.api.health()

    def _validate(self, raw, etag: str | None = None) -> ValidatedPolicy:
        return validate_policy(
            raw,
            expected_organization_id=self.settings.organization_id,
            expected_device_uuid=self.device_uuid,
            management_hosts=[self.settings.management_host],
            response_etag=etag,
        )

    def _revalidate_stored(self, stored: StoredPolicy) -> ValidatedPolicy:
        return self._validate(stored.document)

    def active_policy(self) -> StoredPolicy | None:
        return self.db.get_policy("current")

    def _token(self) -> str:
        tok = self.enrollment.credential()
        if tok is None:
            raise RuntimeError("no device credential")
        return tok

    # --------------------------------------------------- queued reporting
    def _queue(self, kind: str, body: dict) -> None:
        pending = self.db.get_runtime("pending_reports", [])
        pending.append({"kind": kind, "body": body})
        self.db.set_runtime("pending_reports", pending[-MAX_PENDING_REPORTS:])

    def _send_report(self, kind: str, body: dict) -> None:
        tok = self._token()
        if kind == "status":
            self.api.report_status(tok, body)
        else:
            self.api.ack(tok, body["policy_id"], body["version"], body["content_sha256"])

    def _deliver(self, kind: str, body: dict) -> None:
        try:
            self._send_report(kind, body)
        except ApiUnavailable as e:
            log.warning("could not send %s report (%s); queued", kind, e)
            self._queue(kind, body)
        except ApiError as e:
            if e.is_auth_failure or e.is_rate_limited:
                self._queue(kind, body)
            else:
                log.warning("server refused %s report: %s", kind, e.code)

    def _report(self, body: dict) -> None:
        self._deliver("status", body)

    def _ack(self, policy: ValidatedPolicy) -> None:
        self._deliver("ack", {"policy_id": policy.policy_id, "version": policy.version, "content_sha256": policy.content_sha256})

    def _flush_pending(self) -> None:
        pending = self.db.get_runtime("pending_reports", [])
        if not pending:
            return
        self.db.set_runtime("pending_reports", [])
        for item in pending:
            self._deliver(item["kind"], item["body"])

    # ================================================== heartbeat payload
    def heartbeat_status(self) -> str:
        if not self._first_cycle_done:
            return "STARTING"
        err = self.db.get_runtime("enforcement_error", {}) or {}
        if err.get("error"):
            return "ENFORCEMENT_ERROR"
        active = self.active_policy()
        if active is not None and active.document.get("content", {}).get("enabled", True):
            if self.backend.status().state != EnforcementState.ACTIVE:
                return "ENFORCEMENT_ERROR"
        if self._consecutive_errors > 0:
            return "DEGRADED"
        return "HEALTHY"

    def heartbeat_body(self) -> dict:
        active = self.active_policy()
        ifaces = self._interfaces_fn()
        # Exactly the five contract fields; nothing about user activity.
        return {
            "device_uuid": self.device_uuid,
            "agent_version": AGENT_VERSION,
            "current_policy_version": active.version if active else 0,
            "current_ip": netif.current_ip(ifaces),
            "status": self.heartbeat_status(),
        }

    # ============================================================ lifecycle
    def startup(self) -> None:
        if self._started:
            return
        self._started = True
        self.enrollment.import_registration_token(self._token_source)
        active = self.active_policy()
        if active:
            log.info("loaded cached policy %s v%s", active.policy_id, active.version)
        else:
            log.info("no cached policy")
        self.applier.reassert_cached()

    def run(self, stop: threading.Event) -> None:
        self.startup()
        while not stop.is_set():
            delay = self.tick()
            stop.wait(max(0.0, delay))
        log.info("agent loop stopped; enforcement state left unchanged")

    def tick(self) -> float:
        """One scheduling step. Returns seconds until the next step."""
        self.startup()
        try:
            if not self.enrollment.is_enrolled():
                delay = self.enrollment.step()
                self.backoff.reset()
                if not self.enrollment.is_enrolled():
                    return delay
            now = self.clock()
            if now < self._auth_blocked_until:
                return self._auth_blocked_until - now
            return self._cycle()
        except ApiUnavailable as e:
            self._consecutive_errors += 1
            self.db.update_row("sync_state", consecutive_failures=self._consecutive_errors)
            delay = e.retry_after if e.retry_after is not None else self.backoff.next_delay()
            log.warning("server unavailable (%s); keeping cached policy, retry in %.0fs", e, delay)
            return delay
        except ApiError as e:
            self._consecutive_errors += 1
            if e.is_auth_failure:
                return self._on_auth_failure(e)
            delay = e.retry_after if (e.is_rate_limited and e.retry_after) else self.backoff.next_delay()
            log.warning("server returned %s; retry in %.0fs", e.code, delay)
            return delay
        except Exception:
            self._consecutive_errors += 1
            log.exception("unexpected error in agent loop")
            return self.backoff.next_delay()

    def _on_auth_failure(self, e: ApiError) -> float:
        # Keep enforcing the cached policy; a revoked credential never removes local enforcement.
        self.db.update_row("auth_metadata", last_auth_error=e.code, last_auth_error_at=utcnow())
        if self.d.secrets.has(REGISTRATION_TOKEN) and e.code in ("INVALID_CREDENTIAL", "CREDENTIAL_REVOKED", "DEVICE_NOT_APPROVED"):
            log.warning("credential rejected (%s) and a new registration token is configured; re-enrolling", e.code)
            self.enrollment.drop_credential_for_reenrollment()
            return 1.0
        log.error("credential rejected by server (%s); keeping cached policy, retrying in %ds", e.code, AUTH_RETRY_SECONDS)
        self._auth_blocked_until = self.clock() + AUTH_RETRY_SECONDS
        return AUTH_RETRY_SECONDS

    # ================================================ authenticated cycle
    def _cycle(self) -> float:
        token = self._token()
        hb = self.api.heartbeat(token, self.heartbeat_body())
        now = self.clock()
        self.db.update_row(
            "sync_state",
            last_heartbeat_at=utcnow(),
            last_heartbeat_ok_at=utcnow(),
            server_policy_id=hb.policy.policy_id if hb.policy else None,
            server_version=hb.policy.version if hb.policy else 0,
            server_etag=hb.policy.etag if hb.policy else None,
            heartbeat_interval=hb.heartbeat_interval_seconds,
        )
        self.db.update_row("auth_metadata", last_auth_ok_at=utcnow(), last_auth_error=None, last_auth_error_at=None)
        self.enrollment.forget_registration_token()  # credential proven good
        self._flush_pending()

        ref = hb.policy
        if now - self._last_version_check >= self.settings.policy_cache_ttl or ref is None:
            ref = self.api.policy_version(token)
            self._last_version_check = now
            self.db.update_row("sync_state", last_version_check_at=utcnow())
        self.sync(ref)

        self._first_cycle_done = True
        self._consecutive_errors = 0
        self.db.update_row("sync_state", consecutive_failures=0)
        self.backoff.reset()
        interval = hb.heartbeat_interval_seconds or self.settings.heartbeat_interval
        return float(min(MAX_INTERVAL, max(MIN_INTERVAL, interval)))

    def _recently_failed(self, ref: PolicyRef) -> bool:
        s = self.db.get_row("sync_state")
        if s["failed_policy_id"] != ref.policy_id or s["failed_version"] != ref.version or not s["failed_at"]:
            return False
        failed_at = datetime.fromisoformat(s["failed_at"]).timestamp()
        return self.clock() - failed_at < self.settings.policy_cache_ttl

    def sync(self, ref: PolicyRef | None) -> str:
        """Version check + download + validate + apply. Returns a short outcome string."""
        active = self.active_policy()
        if ref is None or not ref.assigned:
            if active is not None and not self._warned_unassigned:
                log.warning("server reports no policy assigned; keeping cached policy %s v%s", active.policy_id, active.version)
                self._warned_unassigned = True
            return "unassigned"
        self._warned_unassigned = False
        if active is not None and active.pair == (ref.policy_id, ref.version):
            return "up_to_date"
        if self._recently_failed(ref):
            return "recently_failed"

        token = self._token()
        fetch = self.api.get_policy(token, if_none_match=active.etag if active else None)
        if fetch.kind == "not_modified":
            return "not_modified"
        if fetch.kind == "none":
            return "unassigned"
        self.db.update_row("sync_state", last_download_at=utcnow())
        self._report(
            {"policy_id": ref.policy_id, "version": ref.version, "status": "DOWNLOADED",
             "active_policy_id": active.policy_id if active else None, "active_version": active.version if active else None}
        )
        try:
            candidate = self._validate(fetch.body, fetch.etag)
        except PolicyValidationError as e:
            self._validation_failed(ref, fetch.body, e, active)
            return "validation_failed"
        for w in candidate.warnings:
            log.warning("policy %s v%s: %s", candidate.policy_id, candidate.version, w)
        if active is not None and active.pair == candidate.pair and active.content_sha256 == candidate.content_sha256:
            return "up_to_date"
        if active is not None and candidate.version < active.version and candidate.policy_id == active.policy_id:
            log.info("server rolled policy %s back from v%s to v%s", candidate.policy_id, active.version, candidate.version)
        outcome = self.applier.apply_candidate(candidate)
        return "applied" if outcome.ok else outcome.status.lower()

    def _validation_failed(self, ref: PolicyRef, body: bytes, e: PolicyValidationError, active: StoredPolicy | None) -> None:
        log.error("policy %s v%s rejected: %s", ref.policy_id, ref.version, e)
        self.db.update_row(
            "sync_state",
            failed_policy_id=ref.policy_id,
            failed_version=ref.version,
            failed_sha256=None,
            failed_at=datetime.fromtimestamp(self.clock(), timezone.utc).isoformat(),
        )
        self.db.update_row(
            "policy_status", policy_id=ref.policy_id, version=ref.version, status="VALIDATION_FAILED",
            error_code="policy_validation_failed", message=redact(str(e))[:1000],
        )
        self._report(
            {
                "policy_id": ref.policy_id,
                "version": ref.version,
                "status": "VALIDATION_FAILED",
                "error_code": "policy_validation_failed",
                "message": redact(str(e))[:1000],
                "active_policy_id": active.policy_id if active else None,
                "active_version": active.version if active else None,
            }
        )

    # ============================================================ status
    def status_summary(self) -> dict:
        active = self.active_policy()
        prev = self.db.get_policy("previous")
        dev = self.db.get_row("device_state")
        auth = self.db.get_row("auth_metadata")
        sync = self.db.get_row("sync_state")
        pst = self.db.get_row("policy_status")
        be = self.backend.status()
        return {
            "device_uuid": self.device_uuid,
            "organization_id": self.settings.organization_id,
            "api_base_url": self.settings.api_base_url,
            "enrollment_state": dev["enrollment_state"],
            "credential_id": auth["credential_id"],
            "last_auth_ok_at": auth["last_auth_ok_at"],
            "last_auth_error": auth["last_auth_error"],
            "active_policy": f"{active.policy_id} v{active.version}" if active else None,
            "previous_policy": f"{prev.policy_id} v{prev.version}" if prev else None,
            "policy_status": {k: pst[k] for k in ("policy_id", "version", "status", "error_code", "message")},
            "last_heartbeat_ok_at": sync["last_heartbeat_ok_at"],
            "enforcement_backend": self.backend.name,
            "enforcement_state": be.state.value,
            "enforcement_detail": be.detail,
        }


def dumps_status(summary: dict) -> str:
    return json.dumps(summary, indent=2, sort_keys=True)


__all__ = ["Agent", "AgentDeps", "dumps_status"]
