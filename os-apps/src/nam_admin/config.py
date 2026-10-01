"""Configuration and URL resolution for the admin desktop wrapper.

Pure, headless-safe logic (no pywebview import) so it can be unit-tested without a
display. Reads ADMIN_SERVER from the process environment, then `admin.env` next to
the executable (written by the installer, user-readable), then the agent's
`agent.env` in the data directory (admin-only on Windows; skipped if unreadable). If only
API_BASE_URL is present, ADMIN_SERVER is derived from it by removing the trailing
`/api`.
"""

from __future__ import annotations

import sys
from html import escape
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import dotenv_values

from . import ADMIN_VERSION, APP_NAME

PRODUCT_DIR_NAME = "OrganizationNetworkAgent"
DEFAULT_API_SUFFIX = "/api"
ADMIN_ENV_NAME = "admin.env"


class AdminConfigError(RuntimeError):
    pass


def default_data_root(environ: dict[str, str]) -> Path | None:
    """The service data root, mirroring nam_agent.config.paths (kept independent so the
    admin app does not import the service package)."""
    override = environ.get("NAM_DATA_DIR")
    if override:
        return Path(override).expanduser()
    if sys.platform == "win32":
        program_data = environ.get("ProgramData") or environ.get("PROGRAMDATA") or r"C:\ProgramData"
        return Path(program_data) / PRODUCT_DIR_NAME
    if sys.platform == "darwin":
        return Path("/Library/Application Support") / PRODUCT_DIR_NAME
    return None


def _clean_base(value: str) -> str | None:
    v = (value or "").strip()
    if not v:
        return None
    parts = urlsplit(v)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None
    return v.rstrip("/")


def _derive_from_api_base(api_base_url: str) -> str | None:
    base = _clean_base(api_base_url)
    if base is None:
        return None
    if base.endswith(DEFAULT_API_SUFFIX):
        base = base[: -len(DEFAULT_API_SUFFIX)]
    return base.rstrip("/") or None


def default_admin_env_file() -> Path | None:
    """`admin.env` next to the frozen executable. The Windows installer writes it with
    ADMIN_SERVER only, readable by Users — unlike agent.env, whose ProgramData ACL keeps
    the access token away from non-admins."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent / ADMIN_ENV_NAME
    return None


def _read_env_file(path: str | Path | None) -> dict[str, str]:
    """Values from a dotenv file; empty when missing or unreadable (e.g. agent.env is
    SYSTEM/Administrators-only and the admin app runs as a normal user)."""
    if path is None:
        return {}
    try:
        if not Path(path).is_file():
            return {}
        return {k: v for k, v in dotenv_values(path).items() if v is not None}
    except OSError:
        return {}


def resolve_admin_server(
    environ: dict[str, str] | None = None,
    env_file: str | Path | None = None,
    admin_env_file: str | Path | None = None,
) -> str | None:
    """Resolve the admin console base URL, or None when unconfigured.

    Precedence: ADMIN_SERVER (env) > ADMIN_SERVER (admin.env) > ADMIN_SERVER (agent.env) >
    API_BASE_URL-derived (agent.env) > API_BASE_URL-derived (env).
    """
    import os

    environ = dict(os.environ) if environ is None else environ

    val = _clean_base(environ.get("ADMIN_SERVER", ""))
    if val:
        return val

    if admin_env_file is None:
        admin_env_file = default_admin_env_file()
    val = _clean_base(_read_env_file(admin_env_file).get("ADMIN_SERVER", ""))
    if val:
        return val

    if env_file is None:
        root = default_data_root(environ)
        env_file = (root / "config" / "agent.env") if root is not None else None
    values = _read_env_file(env_file)
    val = _clean_base(values.get("ADMIN_SERVER", ""))
    if val:
        return val
    derived = _derive_from_api_base(values.get("API_BASE_URL", ""))
    if derived:
        return derived

    return _derive_from_api_base(environ.get("API_BASE_URL", ""))


def about_text(server_url: str | None) -> str:
    """Plain-text About info: app name, version and the configured server (not hidden)."""
    lines = [f"{APP_NAME}", f"Version {ADMIN_VERSION}"]
    lines.append(f"Admin server: {server_url}" if server_url else "Admin server: not configured")
    return "\n".join(lines)


def error_page_html(server_url: str | None, detail: str = "") -> str:
    """A clear error page (with a Retry button) shown instead of a blank window when the
    admin server is unreachable or unconfigured."""
    shown = escape(server_url) if server_url else "(not configured — set ADMIN_SERVER in agent.env)"
    detail_html = f"<p class='detail'>{escape(detail)}</p>" if detail else ""
    retry = (
        f"window.location.href={server_url!r};" if server_url else "window.location.reload();"
    )
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{escape(APP_NAME)}</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ font-family: -apple-system, "Segoe UI", system-ui, sans-serif; margin: 0;
         display: flex; min-height: 100vh; align-items: center; justify-content: center;
         background: #f5f6f8; color: #1c1e21; }}
  @media (prefers-color-scheme: dark) {{ body {{ background: #1c1e21; color: #e7e9ea; }} }}
  .card {{ max-width: 30rem; padding: 2rem; text-align: center; }}
  h1 {{ font-size: 1.3rem; margin: 0 0 .5rem; }}
  .server {{ font-family: ui-monospace, "SF Mono", Menlo, monospace; word-break: break-all;
             background: rgba(127,127,127,.15); padding: .4rem .6rem; border-radius: 6px; display: inline-block; }}
  .detail {{ opacity: .7; font-size: .85rem; }}
  button {{ margin-top: 1.25rem; padding: .6rem 1.4rem; font-size: 1rem; border: 0; border-radius: 8px;
            background: #2d6cdf; color: #fff; cursor: pointer; }}
  button:hover {{ background: #2559b8; }}
  footer {{ margin-top: 1.5rem; font-size: .75rem; opacity: .55; }}
</style></head>
<body><div class="card">
  <h1>{escape(APP_NAME)}</h1>
  <p>Could not reach the admin server.</p>
  <p class="server">{shown}</p>
  {detail_html}
  <button onclick="{retry}">Retry</button>
  <footer>{escape(APP_NAME)} v{escape(ADMIN_VERSION)}</footer>
</div></body></html>
"""


def check_reachable(url: str, *, timeout: float = 5.0, transport=None) -> bool:
    """Best-effort reachability probe used before loading the window. Never raises."""
    import httpx

    try:
        with httpx.Client(timeout=timeout, follow_redirects=True, transport=transport) as c:
            resp = c.get(url)
        return resp.status_code < 500
    except Exception:
        return False
