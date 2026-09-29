from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import pytest

from fake_server import BASE_URL, ORG, REG_TOKEN, FakeServer
from recording_backend import RecordingBackend

from nam_agent.agent.core import Agent, AgentDeps
from nam_agent.api.client import AgentApiClient
from nam_agent.config.paths import AgentPaths
from nam_agent.config.settings import AgentSettings
from nam_agent.enforcement.base import EnforcementBackend
from nam_agent.network.interfaces import NetworkInterface
from nam_agent.security.protector import InsecureDevProtector
from nam_agent.security.secret_store import SecretStore
from nam_agent.storage.db import Database


class FakeClock:
    def __init__(self, t: float = 1_800_000_000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, s: float) -> None:
        self.t += s


def fake_interfaces() -> list[NetworkInterface]:
    return [
        NetworkInterface("vEthernet (Default Switch)", "00:15:5D:01:02:03", ["172.20.0.1"], [], "virtual"),
        NetworkInterface("Ethernet", "00:1A:2B:3C:4D:5E", ["192.168.1.24"], ["fe80::1"], "ethernet", True, has_gateway=True),
    ]


@dataclass
class Harness:
    tmp: Path
    server: FakeServer
    backend: EnforcementBackend
    clock: FakeClock
    settings_overrides: dict = field(default_factory=dict)
    agent: Agent | None = None
    db: Database | None = None

    @property
    def paths(self) -> AgentPaths:
        return AgentPaths(self.tmp)

    def settings(self) -> AgentSettings:
        kw = dict(
            organization_id=ORG,
            api_base_url=BASE_URL,
            device_registration_token=REG_TOKEN,
            secret_protector="insecure-dev",
        )
        kw.update(self.settings_overrides)
        return AgentSettings(**kw)

    def start(self, token_source: str | None = "env") -> Agent:
        """(Re)create the agent from disk, as a service restart would."""
        self.stop()
        self.paths.ensure()
        self.db = Database(self.paths.db_path)
        api = AgentApiClient(BASE_URL, transport=self.server.transport)
        deps = AgentDeps(
            settings=self.settings(),
            paths=self.paths,
            db=self.db,
            secrets=SecretStore(self.db, InsecureDevProtector()),
            api=api,
            backend=self.backend,
            interfaces=fake_interfaces,
            resolver=lambda host, port: ["198.51.100.10"],
            clock=self.clock,
        )
        self.agent = Agent(deps, token_source=token_source)
        self.agent.startup()
        return self.agent

    def stop(self) -> None:
        if self.agent is not None:
            self.agent.api.close()
            self.agent = None
        if self.db is not None:
            self.db.close()
            self.db = None

    def enroll(self) -> Agent:
        a = self.agent or self.start()
        a.tick()  # register -> PENDING
        a.tick()  # poll -> PENDING
        self.server.approve(a.device_uuid)
        a.tick()  # poll -> APPROVED, credential claimed, then first heartbeat cycle
        assert a.enrollment.is_enrolled()
        return a


@pytest.fixture
def server() -> FakeServer:
    return FakeServer()


@pytest.fixture
def backend() -> RecordingBackend:
    return RecordingBackend()


@pytest.fixture
def harness(tmp_path, server, backend):
    h = Harness(tmp_path, server, backend, FakeClock())
    yield h
    h.stop()
