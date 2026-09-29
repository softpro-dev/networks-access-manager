"""Apply pipeline, steps 9-12, plus rollback.

 9 preserve previous policy (the active one stays in the `current` slot until success)
10 apply candidate via the EnforcementBackend (management endpoints always excepted)
11 verify enforcement, then verify management connectivity
12 mark active: atomically current -> previous, candidate -> current; then ack

On any failure the previously active policy is re-applied (or, if there was none,
the backend is returned to its clean state) and the failure is reported.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable

from ..enforcement.base import EnforcementBackend, EnforcementError, ManagementEndpoints
from ..policy.validator import ValidatedPolicy
from ..security.redact import redact
from ..storage.db import Database, StoredPolicy, utcnow

log = logging.getLogger(__name__)

Reporter = Callable[[dict], None]
Acker = Callable[[ValidatedPolicy], None]
Revalidator = Callable[[StoredPolicy], ValidatedPolicy]


class StepFailure(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ApplyOutcome:
    ok: bool
    status: str  # APPLIED | ROLLED_BACK | FAILED
    error_code: str | None = None
    message: str | None = None


def _msg(text: str) -> str:
    return redact(text)[:1000]


class PolicyApplier:
    def __init__(
        self,
        db: Database,
        backend: EnforcementBackend,
        *,
        management: Callable[[], ManagementEndpoints],
        connectivity_check: Callable[[], None],
        report: Reporter,
        ack: Acker,
        revalidate: Revalidator,
        clock: Callable[[], float] | None = None,
    ):
        self.db = db
        self.backend = backend
        self._management = management
        self._connectivity_check = connectivity_check
        self._report = report
        self._ack = ack
        self._revalidate = revalidate
        self._clock = clock or (lambda: datetime.now(timezone.utc).timestamp())

    # --------------------------------------------------------------- helpers
    def _enforce(self, policy: ValidatedPolicy, mgmt: ManagementEndpoints) -> None:
        """Bring the backend into the state `policy` requires, and verify it."""
        if not policy.content.enabled:
            # Admin intentionally disabled the policy: remove agent enforcement.
            try:
                self.backend.remove()
            except EnforcementError as e:
                raise StepFailure(e.code, f"remove failed: {e}") from None
            return
        try:
            self.backend.apply(policy, mgmt)
        except EnforcementError as e:
            raise StepFailure(e.code or "policy_apply_failed", f"apply failed: {e}") from None
        except Exception as e:
            raise StepFailure("policy_apply_failed", f"apply failed: {e.__class__.__name__}") from None
        result = self.backend.verify()
        if not result.ok:
            raise StepFailure("enforcement_verify_failed", f"verify failed: {result.detail}")

    def _set_enforcement_error(self, flag: bool, detail: str | None = None) -> None:
        self.db.set_runtime("enforcement_error", {"error": flag, "detail": detail})

    # ----------------------------------------------------------------- public
    def reassert_cached(self) -> bool:
        """At startup: re-apply the cached active policy. Never deletes it on failure."""
        active = self.db.get_policy("current")
        if active is None:
            self._set_enforcement_error(False)
            return True
        try:
            policy = self._revalidate(active)
            self._enforce(policy, self._management())
        except StepFailure as e:
            log.error("cached policy %s v%s could not be enforced: %s", active.policy_id, active.version, e.message)
            self._set_enforcement_error(True, _msg(e.message))
            return False
        except Exception as e:
            log.error("cached policy %s v%s failed re-validation: %s", active.policy_id, active.version, e)
            self._set_enforcement_error(True, _msg(str(e)))
            return False
        log.info("cached policy %s v%s re-applied", active.policy_id, active.version)
        self._set_enforcement_error(False)
        return True

    def apply_candidate(self, candidate: ValidatedPolicy) -> ApplyOutcome:
        active = self.db.get_policy("current")
        # Step 9: the active policy stays in `current`; the candidate is staged separately.
        self.db.store_candidate(candidate.document, candidate.etag)
        self._status(candidate, "APPLYING", None, None, active)
        mgmt = self._management()
        try:
            self._enforce(candidate, mgmt)  # steps 10-11
            try:
                self._connectivity_check()
            except Exception as e:
                raise StepFailure("management_unreachable", f"management server unreachable after apply: {e}") from None
        except StepFailure as failure:
            return self._rollback(candidate, active, failure)

        # Step 12
        self.db.promote_candidate(candidate.document, candidate.etag)
        self.db.update_row(
            "policy_status", policy_id=candidate.policy_id, version=candidate.version, status="APPLIED", error_code=None, message=None
        )
        self.db.update_row("sync_state", failed_policy_id=None, failed_version=None, failed_sha256=None, failed_at=None)
        self._set_enforcement_error(False)
        log.info("policy %s v%s is active", candidate.policy_id, candidate.version)
        self._ack(candidate)
        return ApplyOutcome(True, "APPLIED")

    def _rollback(self, candidate: ValidatedPolicy, active: StoredPolicy | None, failure: StepFailure) -> ApplyOutcome:
        log.error("policy %s v%s failed (%s): %s", candidate.policy_id, candidate.version, failure.code, failure.message)
        status, code, message = "FAILED", failure.code, failure.message
        try:
            if active is not None:
                self._enforce(self._revalidate(active), self._management())
                status = "ROLLED_BACK"
                message = f"{failure.message}; rolled back to {active.policy_id} v{active.version}"
                self._set_enforcement_error(False)
            else:
                self.backend.remove()
                message = f"{failure.message}; no previous policy, enforcement left in clean state"
                self._set_enforcement_error(True, _msg(failure.message))
        except Exception as e:
            status, code = "FAILED", "rollback_failed"
            message = f"{failure.message}; rollback failed: {e}"
            self._set_enforcement_error(True, _msg(message))
            log.critical("rollback failed: %s", e)

        self.db.clear_candidate()
        self.db.update_row(
            "sync_state",
            failed_policy_id=candidate.policy_id,
            failed_version=candidate.version,
            failed_sha256=candidate.content_sha256,
            failed_at=datetime.fromtimestamp(self._clock(), timezone.utc).isoformat(),
        )
        self._status(candidate, status, code, message, active)
        return ApplyOutcome(False, status, code, _msg(message))

    def _status(
        self, candidate: ValidatedPolicy, status: str, code: str | None, message: str | None, active: StoredPolicy | None
    ) -> None:
        self.db.update_row(
            "policy_status",
            policy_id=candidate.policy_id,
            version=candidate.version,
            status=status,
            error_code=code,
            message=_msg(message) if message else None,
        )
        body: dict = {
            "policy_id": candidate.policy_id,
            "version": candidate.version,
            "status": status,
            "active_policy_id": active.policy_id if active else None,
            "active_version": active.version if active else None,
        }
        if code:
            body["error_code"] = code
        if message:
            body["message"] = _msg(message)
        self._report(body)


__all__ = ["ApplyOutcome", "PolicyApplier", "StepFailure", "utcnow"]
