"""Service body shared by the SCM host and `run` (foreground)."""

from __future__ import annotations

import logging
import threading
from typing import Callable

from ..agent.runtime import build_runtime
from ..config.paths import resolve_paths
from ..config.settings import ConfigError
from ..logs.setup import configure_logging

log = logging.getLogger(__name__)

CONFIG_RETRY_SECONDS = 60


def run_agent(
    stop: threading.Event,
    *,
    console: bool = False,
    event_log: bool = False,
    release_on_stop: Callable[[], bool] | None = None,
) -> None:
    """Run until `stop` is set. When `release_on_stop()` is true at that point (the service was
    stopped on purpose, not Windows shutting down), every installed restriction is removed; the
    cached policy is kept, so starting the service again re-applies it."""
    paths = resolve_paths()
    paths.ensure()
    configure_logging(paths.logs_dir, "INFO", console=console, event_log=event_log)
    while not stop.is_set():
        try:
            rt = build_runtime(paths)
        except ConfigError as e:
            # Stay running (so SCM recovery does not loop) and re-read config periodically.
            log.error("%s; run `OrganizationNetworkAgent.exe configure` as Administrator", e)
            stop.wait(CONFIG_RETRY_SECONDS)
            continue
        configure_logging(paths.logs_dir, rt.settings.log_level, console=console, event_log=event_log)
        log.info("agent starting (mode=%s, organization=%s, server=%s)", rt.settings.mode, rt.settings.organization_id, rt.settings.api_base_url)
        try:
            rt.agent.run(stop)
        finally:
            if release_on_stop is not None and release_on_stop() and rt.backend is not None:
                try:
                    rt.backend.remove()
                    log.info("service stopped: all restrictions removed (they return when the service starts)")
                except Exception as e:  # noqa: BLE001 - stopping must still complete
                    log.error("service stopped but removing restrictions failed: %s", e)
            rt.close()
        return
