"""Entry point for SoftProIt.network.admin — the desktop admin-console wrapper.

The pywebview import is deferred into `run()` so `nam_admin.config` (and this
module) import cleanly on a headless host / in tests without a GUI backend.

On Windows pywebview uses the Edge WebView2 runtime; on macOS it uses the system
WebKit (via pyobjc). This is a normal desktop window with standard chrome (no
browser address bar, exactly like any Electron app) — it conceals nothing: the
server URL lives in `agent.env`, appears in normal network traffic, and is shown in
the About dialog.
"""

from __future__ import annotations

import argparse
import sys

from . import ADMIN_VERSION, APP_NAME, WINDOW_TITLE
from .config import about_text, check_reachable, error_page_html, loading_page_html, resolve_admin_server


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="SoftProIt.network.admin", description=APP_NAME)
    p.add_argument("--version", action="version", version=ADMIN_VERSION)
    p.add_argument("--server", help="override the admin server URL (default: ADMIN_SERVER / agent.env)")
    return p


def run(server_url: str | None) -> int:
    """Open the desktop window. Requires pywebview and a GUI backend."""
    try:
        import webview  # pywebview
    except ImportError:
        print(
            "error: pywebview is not installed. Install it (and, on Windows, the Edge "
            "WebView2 runtime) to run the admin desktop app.",
            file=sys.stderr,
        )
        return 2

    reachable = bool(server_url) and check_reachable(server_url)
    if reachable:
        # Show a loading page at once, scan the LAN in pywebview's worker thread, then open the
        # console with ?connected_devices=... (see network_scan).
        window = webview.create_window(WINDOW_TITLE, html=loading_page_html())
        _install_about_menu(webview, server_url)
        webview.start(_open_console, (window, server_url))
    else:
        detail = "" if server_url else "ADMIN_SERVER is not set in agent.env or the environment."
        webview.create_window(WINDOW_TITLE, html=error_page_html(server_url, detail))
        _install_about_menu(webview, server_url)
        webview.start()
    return 0


def _open_console(window, server_url: str) -> None:
    from .network_scan import connected_devices, with_devices_param

    try:
        devices = connected_devices()
    except Exception:  # noqa: BLE001 - never block the console on a failed scan
        devices = []
    window.load_url(with_devices_param(server_url, devices) if devices else server_url)


def _install_about_menu(webview, server_url: str | None) -> None:
    """Add a visible Help -> About menu (app name, version, server). Best-effort:
    pywebview's menu API varies by version, so failure is non-fatal."""
    try:
        from webview.menu import Menu, MenuAction  # type: ignore

        def _about() -> None:
            active = webview.active_window() if hasattr(webview, "active_window") else None
            info = about_text(server_url).replace("\n", "\\n")
            if active is not None:
                active.evaluate_js(f"alert('{info}')")

        webview.menu = [Menu("Help", [MenuAction(f"About {APP_NAME}", _about)])]  # type: ignore[attr-defined]
    except Exception:  # pragma: no cover - depends on pywebview version/backend
        pass


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(sys.argv[1:] if argv is None else argv)
    server_url = args.server or resolve_admin_server()
    return run(server_url)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
