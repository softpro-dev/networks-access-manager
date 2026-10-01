import pytest

from nam_agent.config.paths import AgentPaths, DataDirError, default_root
from nam_agent.config.settings import ConfigError, load_settings, read_env_file, remove_env_key, write_env_file

BASE = {"ORGANIZATION_ID": "INST-001", "API_BASE_URL": "https://management.example.com/api"}


def paths(tmp_path):
    p = AgentPaths(tmp_path)
    p.ensure()
    return p


def test_defaults_and_env_example_keys(tmp_path):
    s, _ = load_settings(paths(tmp_path), dict(BASE))
    assert s.heartbeat_interval == 60 and s.policy_cache_ttl == 300
    assert s.verify_tls is True and s.log_level == "INFO"
    assert s.secret_protector == "dpapi"
    assert s.management_host == "management.example.com" and s.management_port == 443
    assert s.tls_verify_value is True


def test_file_then_env_precedence(tmp_path):
    p = paths(tmp_path)
    write_env_file(p.env_file, {**BASE, "HEARTBEAT_INTERVAL": "120", "LOG_LEVEL": "debug"})
    s, src = load_settings(p, {"HEARTBEAT_INTERVAL": "90"})
    assert s.heartbeat_interval == 90 and src["heartbeat_interval"] == "env"
    assert s.log_level == "DEBUG" and src["log_level"] == "file"
    assert s.organization_id == "INST-001"


@pytest.mark.parametrize(
    "override",
    [
        {"ORGANIZATION_ID": "inst-001"},
        {"ORGANIZATION_ID": ""},
        {"API_BASE_URL": "http://management.example.com/api"},
        {"API_BASE_URL": "ftp://x"},
        {"API_BASE_URL": "https://user:pw@x.example.com/api"},
        {"API_BASE_URL": "https://x.example.com/api?x=1"},
        {"HEARTBEAT_INTERVAL": "1"},
        {"POLICY_CACHE_TTL": "abc"},
        {"VERIFY_TLS": "maybe"},
        {"LOG_LEVEL": "LOUD"},
        {"UNRELATED": "ignored-but-not-an-error", "ORGANIZATION_ID": "BAD ID"},
    ],
)
def test_invalid_config(tmp_path, override):
    with pytest.raises(ConfigError):
        load_settings(paths(tmp_path), {**BASE, **override})


def test_missing_server_is_an_error_no_default(tmp_path):
    with pytest.raises(ConfigError):
        load_settings(paths(tmp_path), {"ORGANIZATION_ID": "INST-001"})


def test_insecure_http_only_when_explicit(tmp_path):
    s, _ = load_settings(paths(tmp_path), {**BASE, "API_BASE_URL": "http://localhost:3000/api", "NAM_ALLOW_INSECURE_HTTP": "true"})
    assert s.management_port == 3000


def test_token_placeholder_is_ignored_and_errors_do_not_leak_token(tmp_path):
    s, _ = load_settings(paths(tmp_path), {**BASE, "DEVICE_REGISTRATION_TOKEN": "CHANGE_ME"})
    assert s.device_registration_token is None
    with pytest.raises(ConfigError) as ei:
        load_settings(paths(tmp_path), {**BASE, "ORGANIZATION_ID": "x", "DEVICE_REGISTRATION_TOKEN": "super-secret-token"})
    assert "super-secret-token" not in str(ei.value)
    s, _ = load_settings(paths(tmp_path), {**BASE, "DEVICE_REGISTRATION_TOKEN": "super-secret-token"})
    assert "super-secret-token" not in repr(s)


def test_ca_bundle_must_exist(tmp_path):
    with pytest.raises(ConfigError):
        load_settings(paths(tmp_path), {**BASE, "CA_BUNDLE": str(tmp_path / "missing.pem")})
    pem = tmp_path / "ca.pem"
    pem.write_text("x")
    s, _ = load_settings(paths(tmp_path), {**BASE, "CA_BUNDLE": str(pem)})
    assert s.tls_verify_value == str(pem)


def test_env_file_write_and_remove(tmp_path):
    p = paths(tmp_path)
    write_env_file(p.env_file, {**BASE, "DEVICE_REGISTRATION_TOKEN": "tok"})
    assert read_env_file(p.env_file)["DEVICE_REGISTRATION_TOKEN"] == "tok"
    assert remove_env_key(p.env_file, "DEVICE_REGISTRATION_TOKEN")
    assert "DEVICE_REGISTRATION_TOKEN" not in read_env_file(p.env_file)
    assert read_env_file(p.env_file)["ORGANIZATION_ID"] == "INST-001"
    with pytest.raises(ConfigError):
        write_env_file(p.env_file, {"X": "a\nB=c"})


def test_data_dir_override(tmp_path):
    assert default_root({"NAM_DATA_DIR": str(tmp_path)}) == tmp_path.resolve()
    p = AgentPaths(tmp_path)
    assert p.db_path == tmp_path / "data" / "policy.db"
    assert p.env_file == tmp_path / "config" / "agent.env"
    assert p.logs_dir == tmp_path / "logs"


def test_other_platform_requires_data_dir(monkeypatch):
    # Neither Windows nor macOS (e.g. Linux): NAM_DATA_DIR is mandatory.
    monkeypatch.setattr("nam_agent.config.paths.IS_WINDOWS", False)
    monkeypatch.setattr("nam_agent.config.paths.IS_MACOS", False)
    with pytest.raises(DataDirError):
        default_root({})


def test_windows_default_root(monkeypatch):
    monkeypatch.setattr("nam_agent.config.paths.IS_WINDOWS", True)
    monkeypatch.setattr("nam_agent.config.paths.IS_MACOS", False)
    assert str(default_root({"ProgramData": "C:\\ProgramData"})).endswith("OrganizationNetworkAgent")


def test_macos_default_root(monkeypatch):
    monkeypatch.setattr("nam_agent.config.paths.IS_WINDOWS", False)
    monkeypatch.setattr("nam_agent.config.paths.IS_MACOS", True)
    root = default_root({})
    assert root.as_posix() == "/Library/Application Support/OrganizationNetworkAgent"


def test_test_poll_seconds_overrides_the_minutes_only_when_set(tmp_path):
    s, _ = load_settings(paths(tmp_path), {**BASE, "CACHE_EXPIRATION_TIME_IN_MINUTE": "5"})
    assert s.test_poll_seconds is None and s.cache_expiration_seconds == 300
    s, _ = load_settings(paths(tmp_path), {**BASE, "CACHE_EXPIRATION_TIME_IN_MINUTE": "5", "NAM_TEST_POLL_SECONDS": "10"})
    assert s.cache_expiration_seconds == 10
    s, _ = load_settings(paths(tmp_path), {**BASE, "NAM_TEST_POLL_SECONDS": ""})
    assert s.test_poll_seconds is None  # empty = not set
    for bad in ("0", "4", "3601", "0.5"):
        with pytest.raises(ConfigError):
            load_settings(paths(tmp_path), {**BASE, "NAM_TEST_POLL_SECONDS": bad})
