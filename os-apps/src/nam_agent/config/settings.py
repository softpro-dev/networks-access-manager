"""Agent configuration.

Sources (lowest to highest precedence):
  1. `<data root>\\config\\agent.env` (dotenv format, written by `configure`)
  2. process environment variables

Nothing is hardcoded: there is no default management server.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Literal, Mapping
from urllib.parse import urlsplit

from dotenv import dotenv_values
from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError, field_validator, model_validator

from .paths import AgentPaths

ORG_ID_RE = re.compile(r"^[A-Z0-9][A-Z0-9-]{1,31}$")

# env var name -> settings field name
ENV_KEYS: dict[str, str] = {
    # --- documented org-token-mode keys (see .env.example) ---
    "ADMIN_SERVER": "admin_server",
    "ACCESS_TOKE": "access_token",
    "CACHE_EXPIRATION_TIME_IN_MINUTE": "cache_expiration_minutes",
    # Testing only: poll every N seconds instead of CACHE_EXPIRATION_TIME_IN_MINUTE (5-3600).
    "NAM_TEST_POLL_SECONDS": "test_poll_seconds",
    # --- per-device (enrollment) keys, still supported ---
    "ORGANIZATION_ID": "organization_id",
    "API_BASE_URL": "api_base_url",
    "DEVICE_REGISTRATION_TOKEN": "device_registration_token",
    "POLICY_CACHE_TTL": "policy_cache_ttl",
    "HEARTBEAT_INTERVAL": "heartbeat_interval",
    "LOG_LEVEL": "log_level",
    "VERIFY_TLS": "verify_tls",
    "CA_BUNDLE": "ca_bundle",
    "HTTP_TIMEOUT": "http_timeout",
    "ENROLLMENT_POLL_INTERVAL": "enrollment_poll_interval",
    "PRIMARY_INTERFACE": "primary_interface",
    "NAM_SECRET_PROTECTOR": "secret_protector",
    "NAM_ALLOW_INSECURE_HTTP": "allow_insecure_http",
    # The API base is derived as `${ADMIN_SERVER}${NAM_API_BASE_SUFFIX}` (default "/api").
    # Override the suffix for non-standard deployments; API_BASE_URL overrides it entirely.
    "NAM_API_BASE_SUFFIX": "api_base_suffix",
}

# Selected agent operating modes.
MODE_ORG_TOKEN = "org-token"
MODE_PER_DEVICE = "per-device"


class ConfigError(ValueError):
    """Raised when the configuration is missing or invalid. Never contains secret values."""


def validate_api_base_url(value: str, allow_insecure_http: bool = False) -> str:
    v = (value or "").strip()
    if not v:
        raise ValueError("API_BASE_URL is required")
    parts = urlsplit(v)
    if parts.scheme not in ("https", "http"):
        raise ValueError("API_BASE_URL must be an https:// URL")
    if parts.scheme == "http" and not allow_insecure_http:
        raise ValueError("API_BASE_URL must use https (set NAM_ALLOW_INSECURE_HTTP=true only for local development)")
    if not parts.hostname:
        raise ValueError("API_BASE_URL must contain a host name")
    if parts.username or parts.password or "@" in parts.netloc:
        raise ValueError("API_BASE_URL must not contain credentials")
    if parts.query or parts.fragment:
        raise ValueError("API_BASE_URL must not contain a query or fragment")
    try:
        _ = parts.port
    except ValueError as e:
        raise ValueError("API_BASE_URL has an invalid port") from e
    return v.rstrip("/")


class AgentSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    # organization_id is required in per-device mode and optional in org-token mode.
    organization_id: str | None = None
    # api_base_url may be given explicitly or derived from admin_server + api_base_suffix.
    api_base_url: str | None = None
    admin_server: str | None = None
    api_base_suffix: str = "/api"
    access_token: SecretStr | None = None
    cache_expiration_minutes: int = Field(default=5, ge=1, le=1440)
    #: testing only — overrides the org-token poll interval (seconds); never set in production
    test_poll_seconds: int | None = Field(default=None, ge=5, le=3600)
    device_registration_token: SecretStr | None = None
    policy_cache_ttl: int = Field(default=300, ge=30, le=86400)
    heartbeat_interval: int = Field(default=60, ge=10, le=3600)
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = "INFO"
    verify_tls: bool = True
    ca_bundle: Path | None = None
    http_timeout: float = Field(default=15.0, ge=1.0, le=120.0)
    enrollment_poll_interval: int = Field(default=45, ge=30, le=600)
    primary_interface: str | None = None
    secret_protector: Literal["dpapi", "file-key", "insecure-dev"] = "dpapi"
    allow_insecure_http: bool = False

    @field_validator("organization_id")
    @classmethod
    def _org(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if not v:
            return None
        if not ORG_ID_RE.match(v):
            raise ValueError("ORGANIZATION_ID must match ^[A-Z0-9][A-Z0-9-]{1,31}$")
        return v

    @field_validator("access_token", mode="before")
    @classmethod
    def _access_token(cls, v: object) -> object:
        if v is None:
            return None
        s = v.get_secret_value() if isinstance(v, SecretStr) else str(v)
        s = s.strip()
        # Ignore the .env.example placeholder so an unedited template selects nothing.
        if not s or s == "copy_from_organization_list":
            return None
        if len(s) > 512 or any(c.isspace() for c in s):
            raise ValueError("ACCESS_TOKE has an invalid format")
        return s

    @field_validator("test_poll_seconds", mode="before")
    @classmethod
    def _test_poll_empty_none(cls, v: object) -> object:
        return None if isinstance(v, str) and not v.strip() else v

    @field_validator("admin_server", "api_base_url", mode="before")
    @classmethod
    def _url_empty_none(cls, v: object) -> object:
        if isinstance(v, str) and not v.strip():
            return None
        return v

    @field_validator("log_level", mode="before")
    @classmethod
    def _level(cls, v: object) -> object:
        return v.strip().upper() if isinstance(v, str) else v

    @field_validator("device_registration_token", mode="before")
    @classmethod
    def _token(cls, v: object) -> object:
        if v is None:
            return None
        s = v.get_secret_value() if isinstance(v, SecretStr) else str(v)
        s = s.strip()
        if not s or s == "CHANGE_ME":
            return None
        if len(s) > 512 or any(c.isspace() for c in s):
            raise ValueError("DEVICE_REGISTRATION_TOKEN has an invalid format")
        return s

    @field_validator("ca_bundle", "primary_interface", mode="before")
    @classmethod
    def _empty_none(cls, v: object) -> object:
        if isinstance(v, str) and not v.strip():
            return None
        return v

    @model_validator(mode="after")
    def _cross(self) -> "AgentSettings":
        # Derive the API base: an explicit API_BASE_URL wins; otherwise use ADMIN_SERVER
        # + the (overridable) suffix. The admin console proxies /api to the API.
        api_base = self.api_base_url
        if api_base is None and self.admin_server is not None:
            suffix = self.api_base_suffix if self.api_base_suffix.startswith("/") else "/" + self.api_base_suffix
            api_base = self.admin_server.rstrip("/") + suffix.rstrip("/")
        if api_base is None:
            raise ValueError("API_BASE_URL or ADMIN_SERVER is required")
        object.__setattr__(self, "api_base_url", validate_api_base_url(api_base, self.allow_insecure_http))
        # Normalize/validate ADMIN_SERVER too when it was supplied.
        if self.admin_server is not None:
            object.__setattr__(self, "admin_server", validate_api_base_url(self.admin_server, self.allow_insecure_http))
        if self.mode == MODE_PER_DEVICE and self.organization_id is None:
            raise ValueError("ORGANIZATION_ID is required in per-device mode (set ACCESS_TOKE for org-token mode)")
        if self.ca_bundle is not None and not self.ca_bundle.is_file():
            raise ValueError("CA_BUNDLE does not point to an existing file")
        return self

    @property
    def mode(self) -> str:
        """`org-token` when an ACCESS_TOKE is configured, otherwise `per-device`."""
        return MODE_ORG_TOKEN if self.access_token is not None else MODE_PER_DEVICE

    @property
    def cache_expiration_seconds(self) -> int:
        """Org-token poll interval; NAM_TEST_POLL_SECONDS (testing only) overrides the minutes."""
        return self.test_poll_seconds or self.cache_expiration_minutes * 60

    @property
    def management_host(self) -> str:
        return (urlsplit(self.api_base_url).hostname or "").lower()

    @property
    def management_port(self) -> int:
        p = urlsplit(self.api_base_url)
        return p.port or (443 if p.scheme == "https" else 80)

    @property
    def tls_verify_value(self) -> bool | str:
        """Value for httpx `verify=`: False, True, or a CA bundle path."""
        if not self.verify_tls:
            return False
        return str(self.ca_bundle) if self.ca_bundle else True


def read_env_file(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    return {k: v for k, v in dotenv_values(path).items() if v is not None}


def collect_raw(paths: AgentPaths, environ: Mapping[str, str] | None = None) -> tuple[dict[str, str], dict[str, str]]:
    """Merge file + environment. Returns (raw values keyed by field, source per field)."""
    env = os.environ if environ is None else environ
    raw: dict[str, str] = {}
    source: dict[str, str] = {}
    for key, value in read_env_file(paths.env_file).items():
        if key in ENV_KEYS:
            raw[ENV_KEYS[key]] = value
            source[ENV_KEYS[key]] = "file"
    for key, field in ENV_KEYS.items():
        if key in env:
            raw[field] = env[key]
            source[field] = "env"
    return raw, source


def load_settings(paths: AgentPaths, environ: Mapping[str, str] | None = None) -> tuple[AgentSettings, dict[str, str]]:
    raw, source = collect_raw(paths, environ)
    try:
        return AgentSettings(**raw), source
    except ValidationError as e:
        # Summarize without echoing input values (they may include the token).
        problems = "; ".join(
            f"{'.'.join(str(p) for p in err['loc']) or 'config'}: {err['msg']}" for err in e.errors(include_input=False)
        )
        raise ConfigError(f"invalid agent configuration: {problems}") from None


def write_env_file(path: Path, values: Mapping[str, str | None]) -> None:
    """Atomically update keys in the dotenv file, keeping unrelated keys. None deletes a key."""
    existing = read_env_file(path)
    for k, v in values.items():
        if v is None:
            existing.pop(k, None)
        else:
            if any(c in v for c in '\r\n"\\'):
                raise ConfigError(f"{k} contains characters not allowed in the config file")
            existing[k] = v
    lines = ["# Managed by OrganizationNetworkAgent configure. Secrets are NOT stored here.\n"]
    for k in sorted(existing):
        lines.append(f'{k}="{existing[k]}"\n')
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text("".join(lines), encoding="utf-8")
    os.replace(tmp, path)


def remove_env_key(path: Path, key: str) -> bool:
    """Remove a key from the dotenv file. Returns True if it was present."""
    if key not in read_env_file(path):
        return False
    write_env_file(path, {key: None})
    return True
