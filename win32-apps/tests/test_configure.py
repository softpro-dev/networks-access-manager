import httpx
import pytest
from fake_server import BASE_URL, REG_TOKEN, FakeServer

from nam_agent.config.configure import ConfigureRequest, apply_configuration
from nam_agent.config.paths import AgentPaths
from nam_agent.config.settings import ConfigError, load_settings, read_env_file
from nam_agent.security.protector import InsecureDevProtector
from nam_agent.security.secret_store import REGISTRATION_TOKEN, SecretStore
from nam_agent.storage.db import Database

ENV = {"NAM_SECRET_PROTECTOR": "insecure-dev"}


def test_configure_saves_settings_and_protected_token(tmp_path):
    server = FakeServer()
    paths = AgentPaths(tmp_path)
    apply_configuration(paths, ConfigureRequest("INST-001", BASE_URL + "/", REG_TOKEN), transport=server.transport, environ=ENV)
    assert server.requests[0].url.path == "/api/health"
    env = read_env_file(paths.env_file)
    assert env["ORGANIZATION_ID"] == "INST-001" and env["API_BASE_URL"] == BASE_URL
    assert REG_TOKEN not in paths.env_file.read_text()
    db = Database(paths.db_path)
    assert SecretStore(db, InsecureDevProtector()).get(REGISTRATION_TOKEN) == REG_TOKEN
    db.close()
    s, _ = load_settings(paths, ENV)
    assert s.organization_id == "INST-001"


@pytest.mark.parametrize(
    "req",
    [
        ConfigureRequest("inst-001", BASE_URL, REG_TOKEN),
        ConfigureRequest("INST-001", "http://mgmt.example.test/api", REG_TOKEN),
        ConfigureRequest("INST-001", BASE_URL, ""),
        ConfigureRequest("INST-001", BASE_URL, "has space"),
    ],
)
def test_configure_rejects_bad_input(tmp_path, req):
    with pytest.raises(ConfigError):
        apply_configuration(AgentPaths(tmp_path), req, transport=FakeServer().transport, environ=ENV)
    assert not AgentPaths(tmp_path).env_file.exists()


def test_configure_requires_server_connectivity(tmp_path):
    server = FakeServer()
    server.down = True
    with pytest.raises(ConfigError, match="connectivity"):
        apply_configuration(AgentPaths(tmp_path), ConfigureRequest("INST-001", BASE_URL, REG_TOKEN), transport=server.transport, environ=ENV)
    assert not AgentPaths(tmp_path).env_file.exists()
    bad = httpx.MockTransport(lambda r: httpx.Response(200, json={"hello": "world"}))
    with pytest.raises(ConfigError):
        apply_configuration(AgentPaths(tmp_path), ConfigureRequest("INST-001", BASE_URL, REG_TOKEN), transport=bad, environ=ENV)


def test_changing_org_of_enrolled_device_requires_reset(harness, server):
    harness.enroll()
    harness.stop()
    req = ConfigureRequest("COMPANY-002", BASE_URL, REG_TOKEN)
    with pytest.raises(ConfigError, match="reset-enrollment"):
        apply_configuration(harness.paths, req, transport=server.transport, environ=ENV)
    apply_configuration(
        harness.paths, ConfigureRequest("COMPANY-002", BASE_URL, REG_TOKEN, reset_enrollment=True), transport=server.transport, environ=ENV
    )
    db = Database(harness.paths.db_path)
    assert db.get_secret("device_credential") is None
    assert db.get_device_uuid() is not None  # identity kept
    db.close()
