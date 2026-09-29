"""Wire concrete dependencies together for the service / `run` command."""

from __future__ import annotations

import logging
from dataclasses import dataclass

from ..api.client import AgentApiClient
from ..config.paths import AgentPaths, resolve_paths
from ..config.settings import AgentSettings, load_settings
from ..enforcement import EnforcementBackend, default_backend
from ..security.protector import make_protector
from ..security.secret_store import SecretStore
from ..storage.db import Database
from .core import Agent, AgentDeps


@dataclass
class Runtime:
    paths: AgentPaths
    settings: AgentSettings
    db: Database
    api: AgentApiClient
    agent: Agent

    def close(self) -> None:
        self.api.close()
        self.db.close()


def build_runtime(paths: AgentPaths | None = None, backend: EnforcementBackend | None = None) -> Runtime:
    paths = paths or resolve_paths()
    paths.ensure()
    settings, source = load_settings(paths)
    if not settings.verify_tls:
        logging.getLogger(__name__).warning("TLS certificate verification is DISABLED (VERIFY_TLS=false); not for production")
    db = Database(paths.db_path)
    store = SecretStore(db, make_protector(settings.secret_protector))
    api = AgentApiClient(settings.api_base_url, verify=settings.tls_verify_value, timeout=settings.http_timeout)
    deps = AgentDeps(settings=settings, paths=paths, db=db, secrets=store, api=api, backend=backend or default_backend())
    agent = Agent(deps, token_source=source.get("device_registration_token"))
    return Runtime(paths, settings, db, api, agent)
