"""Org-token-mode configuration: new keys parsed, ACCESS_TOKE selects the mode,
API base derived from ADMIN_SERVER."""

import pytest

from nam_agent.config.paths import AgentPaths
from nam_agent.config.settings import ConfigError, load_settings

TOKEN = "nat_" + "a" * 43


def paths(tmp_path):
    p = AgentPaths(tmp_path)
    p.ensure()
    return p


def test_access_toke_selects_org_mode_and_derives_api_base(tmp_path):
    s, _ = load_settings(
        paths(tmp_path),
        {"ADMIN_SERVER": "https://admin.example.com", "ACCESS_TOKE": TOKEN, "CACHE_EXPIRATION_TIME_IN_MINUTE": "10"},
    )
    assert s.mode == "org-token"
    assert s.api_base_url == "https://admin.example.com/api"
    assert s.management_host == "admin.example.com" and s.management_port == 443
    assert s.cache_expiration_minutes == 10 and s.cache_expiration_seconds == 600
    assert s.access_token.get_secret_value() == TOKEN
    assert s.organization_id is None  # optional in org-token mode


def test_org_mode_default_cache_is_five_minutes(tmp_path):
    s, _ = load_settings(paths(tmp_path), {"ADMIN_SERVER": "https://admin.example.com", "ACCESS_TOKE": TOKEN})
    assert s.cache_expiration_minutes == 5


def test_placeholder_access_token_is_ignored(tmp_path):
    # An unedited .env.example must not silently select org-token mode.
    with pytest.raises(ConfigError):
        # No ORGANIZATION_ID / API_BASE_URL either -> per-device mode with missing fields.
        load_settings(paths(tmp_path), {"ADMIN_SERVER": "https://admin.example.com", "ACCESS_TOKE": "copy_from_organization_list"})


def test_admin_server_http_requires_insecure_flag(tmp_path):
    with pytest.raises(ConfigError):
        load_settings(paths(tmp_path), {"ADMIN_SERVER": "http://localhost:3001", "ACCESS_TOKE": TOKEN})
    s, _ = load_settings(
        paths(tmp_path),
        {"ADMIN_SERVER": "http://localhost:3001", "ACCESS_TOKE": TOKEN, "NAM_ALLOW_INSECURE_HTTP": "true"},
    )
    assert s.api_base_url == "http://localhost:3001/api" and s.management_port == 3001


def test_api_base_suffix_override(tmp_path):
    s, _ = load_settings(
        paths(tmp_path),
        {"ADMIN_SERVER": "https://admin.example.com", "ACCESS_TOKE": TOKEN, "NAM_API_BASE_SUFFIX": "/gateway/api"},
    )
    assert s.api_base_url == "https://admin.example.com/gateway/api"


def test_explicit_api_base_url_overrides_admin_server_derivation(tmp_path):
    s, _ = load_settings(
        paths(tmp_path),
        {"ADMIN_SERVER": "https://admin.example.com", "API_BASE_URL": "https://api.example.com/api", "ACCESS_TOKE": TOKEN},
    )
    assert s.api_base_url == "https://api.example.com/api"


def test_per_device_mode_still_requires_org(tmp_path):
    # Without ACCESS_TOKE the agent is in per-device mode; ORGANIZATION_ID is required.
    with pytest.raises(ConfigError):
        load_settings(paths(tmp_path), {"ADMIN_SERVER": "https://admin.example.com"})
    s, _ = load_settings(paths(tmp_path), {"ADMIN_SERVER": "https://admin.example.com", "ORGANIZATION_ID": "INST-001"})
    assert s.mode == "per-device" and s.api_base_url == "https://admin.example.com/api"


def test_token_not_leaked_in_repr(tmp_path):
    s, _ = load_settings(paths(tmp_path), {"ADMIN_SERVER": "https://admin.example.com", "ACCESS_TOKE": TOKEN})
    assert TOKEN not in repr(s)
