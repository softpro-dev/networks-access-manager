"""Enrollment state machine (contract §2).

UNREGISTERED --register--> PENDING --poll--> APPROVED + credential --> ENROLLED
                                    \\-> REJECTED / REVOKED (poll slowly; admin may re-enroll)
NEEDS_CONFIGURATION: no registration token available (run `configure`).
"""

from __future__ import annotations

import base64
import hashlib
import logging
import re
import secrets
from typing import Callable

from .. import AGENT_VERSION
from ..api.backoff import AUTH_RETRY_SECONDS
from ..api.client import AgentApiClient
from ..api.errors import ApiError
from ..config.paths import AgentPaths
from ..config.settings import AgentSettings, remove_env_key
from ..identity import system_info
from ..network.interfaces import NetworkInterface
from ..security.secret_store import DEVICE_CREDENTIAL, ENROLLMENT_SECRET, REGISTRATION_TOKEN, SecretStore
from ..storage.db import Database, utcnow

log = logging.getLogger(__name__)

CREDENTIAL_RE = re.compile(r"^ndc_[a-z0-9]{8,64}\.[A-Za-z0-9_-]{43}$")

UNREGISTERED = "UNREGISTERED"
PENDING = "PENDING"
ENROLLED = "ENROLLED"
REJECTED = "REJECTED"
REVOKED = "REVOKED"
NEEDS_CONFIGURATION = "NEEDS_CONFIGURATION"


def new_enrollment_secret() -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode("ascii")


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class Enrollment:
    def __init__(
        self,
        *,
        settings: AgentSettings,
        paths: AgentPaths,
        db: Database,
        secrets_: SecretStore,
        api: AgentApiClient,
        device_uuid: str,
        interfaces: Callable[[], list[NetworkInterface]],
    ):
        self.settings = settings
        self.paths = paths
        self.db = db
        self.secrets = secrets_
        self.api = api
        self.device_uuid = device_uuid
        self._interfaces = interfaces

    # ------------------------------------------------------------- queries
    @property
    def state(self) -> str:
        return self.db.get_row("device_state")["enrollment_state"]

    def _set_state(self, state: str, **extra) -> None:
        self.db.update_row("device_state", enrollment_state=state, **extra)

    def credential(self) -> str | None:
        return self.secrets.get(DEVICE_CREDENTIAL)

    def is_enrolled(self) -> bool:
        return self.secrets.has(DEVICE_CREDENTIAL)

    # ------------------------------------------------------ token handling
    def import_registration_token(self, source: str | None) -> None:
        """Move a token from configuration into the protected store (only when not enrolled)."""
        token = self.settings.device_registration_token
        if token is None or self.is_enrolled():
            return
        self.secrets.put(REGISTRATION_TOKEN, token.get_secret_value())
        if source == "file" and remove_env_key(self.paths.env_file, "DEVICE_REGISTRATION_TOKEN"):
            log.info("registration token moved from agent.env into the protected store")
        elif source == "env":
            log.warning("registration token supplied via environment; prefer `configure` so it is stored with DPAPI")

    def drop_credential_for_reenrollment(self) -> None:
        """Called when the credential stopped working and an admin supplied a new token."""
        self.secrets.delete(DEVICE_CREDENTIAL)
        self.secrets.delete(ENROLLMENT_SECRET)
        self._set_state(UNREGISTERED, last_error="credential rejected; re-enrolling with new registration token")

    def forget_registration_token(self) -> None:
        if self.secrets.delete(REGISTRATION_TOKEN):
            log.info("registration token deleted after successful enrollment")

    # ------------------------------------------------------------ one step
    def step(self) -> float:
        """Advance enrollment by one request. Returns seconds until the next step
        (0 = enrolled / continue immediately). Network errors propagate to the caller's backoff."""
        if self.is_enrolled():
            return 0.0
        secret = self.secrets.get(ENROLLMENT_SECRET)
        if secret is None:
            if not self.secrets.has(REGISTRATION_TOKEN):
                if self.state != NEEDS_CONFIGURATION:
                    log.error("no registration token: run `OrganizationNetworkAgent.exe configure` as Administrator")
                self._set_state(NEEDS_CONFIGURATION)
                return AUTH_RETRY_SECONDS
            secret = new_enrollment_secret()
            self.secrets.put(ENROLLMENT_SECRET, secret)  # persist BEFORE sending so retries are idempotent
            self._set_state(UNREGISTERED)
        if self.state in (UNREGISTERED, NEEDS_CONFIGURATION):
            return self._register(secret)
        return self._poll(secret)

    def registration_body(self, secret: str) -> dict:
        return {
            "organization_id": self.settings.organization_id,
            "device_uuid": self.device_uuid,
            "hostname": system_info.hostname(),
            "windows_version": system_info.windows_version(),
            "agent_version": AGENT_VERSION,
            "enrollment_secret_hash": sha256_hex(secret),
            "interfaces": [i.to_wire() for i in self._interfaces()],
        }

    def _register(self, secret: str) -> float:
        token = self.secrets.get(REGISTRATION_TOKEN)
        if token is None:
            self._set_state(NEEDS_CONFIGURATION)
            return AUTH_RETRY_SECONDS
        try:
            resp = self.api.register(token, self.registration_body(secret))
        except ApiError as e:
            if e.status == 409:
                # Our uuid is bound to another enrollment secret (e.g. credential response lost).
                # Discard ours; a fresh one succeeds once an administrator uses "re-enroll".
                log.error("device already registered with a different enrollment secret; waiting for administrator re-enroll")
                self.secrets.delete(ENROLLMENT_SECRET)
                self._set_state(UNREGISTERED, last_error=e.code)
                return AUTH_RETRY_SECONDS
            if e.status in (400, 401, 403):
                log.error("registration rejected: %s", e.code)
                self._set_state(UNREGISTERED, last_error=e.code)
                return AUTH_RETRY_SECONDS
            raise
        log.info("registered with server; device status %s", resp.status)
        self._set_state(
            resp.status if resp.status in (REJECTED, REVOKED) else PENDING,
            device_id=resp.device_id,
            organization_id=self.settings.organization_id,
            registered_at=utcnow(),
            last_error=None,
        )
        return 0.0

    def _poll(self, secret: str) -> float:
        try:
            st = self.api.registration_status(self.device_uuid, secret)
        except ApiError as e:
            if e.status == 401:
                # Secret unknown or already consumed: start over with a new one.
                log.warning("enrollment secret no longer valid (%s); registering again", e.code)
                self.secrets.delete(ENROLLMENT_SECRET)
                self._set_state(UNREGISTERED, last_error=e.code)
                return 1.0
            raise
        if st.status == "PENDING":
            self._set_state(PENDING)
            return float(self.settings.enrollment_poll_interval)
        if st.status in (REJECTED, REVOKED):
            if self.state != st.status:
                log.warning("device enrollment is %s by the administrator", st.status)
            self._set_state(st.status)
            return AUTH_RETRY_SECONDS
        # APPROVED
        cred = st.credential
        if cred is None or not CREDENTIAL_RE.match(cred.token):
            log.error("server approved the device but returned no usable credential")
            return float(self.settings.enrollment_poll_interval)
        self.secrets.put(DEVICE_CREDENTIAL, cred.token)
        self.db.update_row(
            "auth_metadata",
            credential_id=cred.credential_id,
            issued_at=cred.issued_at,
            expires_at=cred.expires_at,
            last_auth_error=None,
            last_auth_error_at=None,
        )
        self.secrets.delete(ENROLLMENT_SECRET)
        self.forget_registration_token()
        self._set_state(ENROLLED, approved_at=utcnow(), last_error=None)
        log.info("device approved; credential %s stored", cred.credential_id)
        return 0.0
