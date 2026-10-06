"""Wire concrete dependencies together for the service / `run` command."""

from __future__ import annotations

import logging
from dataclasses import dataclass

from typing import Any

from ..api.client import AgentApiClient
from ..config.paths import AgentPaths, resolve_paths
from ..config.settings import MODE_ORG_TOKEN, AgentSettings, load_settings
from ..enforcement import EnforcementBackend, default_backend
from ..security.protector import make_protector
from ..security.secret_store import SecretStore
from ..storage.db import Database
from .core import Agent, AgentDeps
from .org_sync import OrgAgent, OrgAgentDeps


@dataclass
class Runtime:
    paths: AgentPaths
    settings: AgentSettings
    db: Database
    api: AgentApiClient
    #: Either an enrollment `Agent` (per-device mode) or an `OrgAgent` (org-token mode).
    #: Both expose `run(stop)` and `status_summary()`.
    agent: Any
    #: The enforcement backend the agent uses (lets the service lift rules when it is stopped).
    backend: EnforcementBackend | None = None

    def close(self) -> None:
        self.api.close()
        self.db.close()


def build_runtime(paths: AgentPaths | None = None, backend: EnforcementBackend | None = None) -> Runtime:
    paths = paths or resolve_paths()
    paths.ensure()
    settings, source = load_settings(paths)
    if settings.test_poll_seconds:
        logging.getLogger(__name__).warning(
            "TEST MODE: polling every %ss (NAM_TEST_POLL_SECONDS) instead of every %s min; not for production",
            settings.test_poll_seconds,
            settings.cache_expiration_minutes,
        )
    if not settings.verify_tls:
        logging.getLogger(__name__).warning("TLS certificate verification is DISABLED (VERIFY_TLS=false); not for production")
    db = Database(paths.db_path)
    store = SecretStore(db, make_protector(settings.secret_protector, key_dir=paths.config_dir))
    api = AgentApiClient(settings.api_base_url, verify=settings.tls_verify_value, timeout=settings.http_timeout)
    resolved_backend = backend or default_backend(paths.data_dir)
    if settings.mode == MODE_ORG_TOKEN:
        agent: Any = OrgAgent(OrgAgentDeps(settings=settings, paths=paths, db=db, api=api, backend=resolved_backend))
    else:
        deps = AgentDeps(settings=settings, paths=paths, db=db, secrets=store, api=api, backend=resolved_backend)
        agent = Agent(deps, token_source=source.get("device_registration_token"))
    return Runtime(paths, settings, db, api, agent, resolved_backend)
