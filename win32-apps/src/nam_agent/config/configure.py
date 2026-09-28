"""Administrator configuration utility (`OrganizationNetworkAgent.exe configure`).

Validates input, proves the server is reachable over verified TLS (GET /api/health),
then writes non-secret settings to agent.env and the registration token to the
DPAPI-protected store. The token is never written to agent.env.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import httpx

from ..api.client import AgentApiClient
from ..api.errors import ApiError, ApiUnavailable
from ..config.paths import AgentPaths
from ..config.settings import ORG_ID_RE, ConfigError, collect_raw, validate_api_base_url, write_env_file
from ..security.protector import make_protector
from ..security.secret_store import DEVICE_CREDENTIAL, ENROLLMENT_SECRET, REGISTRATION_TOKEN, SecretStore
from ..storage.db import Database

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class ConfigureRequest:
    organization_id: str
    api_base_url: str
    registration_token: str
    verify_tls: bool = True
    ca_bundle: Path | None = None
    reset_enrollment: bool = False


def validate_request(req: ConfigureRequest, allow_insecure_http: bool = False) -> ConfigureRequest:
    org = req.organization_id.strip()
    if not ORG_ID_RE.match(org):
        raise ConfigError("Organization ID must match ^[A-Z0-9][A-Z0-9-]{1,31}$ (e.g. INST-001)")
    try:
        url = validate_api_base_url(req.api_base_url, allow_insecure_http)
    except ValueError as e:
        raise ConfigError(str(e)) from None
    token = req.registration_token.strip()
    if not token or len(token) > 512 or any(c.isspace() for c in token) or token == "CHANGE_ME":
        raise ConfigError("registration token is empty or has an invalid format")
    if req.ca_bundle is not None and not req.ca_bundle.is_file():
        raise ConfigError("CA bundle file does not exist")
    return ConfigureRequest(org, url, token, req.verify_tls, req.ca_bundle, req.reset_enrollment)


def check_connectivity(req: ConfigureRequest, transport: httpx.BaseTransport | None = None, timeout: float = 15.0) -> None:
    verify: bool | str = (str(req.ca_bundle) if req.ca_bundle else True) if req.verify_tls else False
    client = AgentApiClient(req.api_base_url, verify=verify, timeout=timeout, transport=transport)
    try:
        client.health()
    except (ApiUnavailable, ApiError) as e:
        raise ConfigError(f"server connectivity check failed: {e}") from None
    finally:
        client.close()


def apply_configuration(
    paths: AgentPaths,
    req: ConfigureRequest,
    *,
    transport: httpx.BaseTransport | None = None,
    environ: dict[str, str] | None = None,
) -> None:
    raw, _ = collect_raw(paths, environ)
    allow_http = str(raw.get("allow_insecure_http", "false")).lower() in ("1", "true", "yes")
    req = validate_request(req, allow_http)
    check_connectivity(req, transport)

    paths.ensure()
    db = Database(paths.db_path)
    try:
        store = SecretStore(db, make_protector(raw.get("secret_protector", "dpapi")))
        state = db.get_row("device_state")
        enrolled_org = state["organization_id"]
        if enrolled_org and enrolled_org != req.organization_id and store.has(DEVICE_CREDENTIAL):
            if not req.reset_enrollment:
                raise ConfigError(
                    f"device is enrolled in {enrolled_org}; pass --reset-enrollment to enroll it in {req.organization_id}"
                )
        if req.reset_enrollment:
            store.delete(DEVICE_CREDENTIAL)
            store.delete(ENROLLMENT_SECRET)
            db.update_row("device_state", enrollment_state="UNREGISTERED", device_id=None, organization_id=None, last_error=None)
            db.update_row("auth_metadata", credential_id=None, issued_at=None, expires_at=None)
        write_env_file(
            paths.env_file,
            {
                "ORGANIZATION_ID": req.organization_id,
                "API_BASE_URL": req.api_base_url,
                "VERIFY_TLS": "true" if req.verify_tls else "false",
                "CA_BUNDLE": str(req.ca_bundle) if req.ca_bundle else None,
                "DEVICE_REGISTRATION_TOKEN": None,
            },
        )
        store.put(REGISTRATION_TOKEN, req.registration_token)
    finally:
        db.close()
    log.info("configuration saved for organization %s", req.organization_id)
