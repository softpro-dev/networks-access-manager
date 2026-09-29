"""Service body shared by the SCM host and `run` (foreground)."""

from __future__ import annotations

import logging
import threading

from ..agent.runtime import build_runtime
from ..config.paths import resolve_paths
from ..config.settings import ConfigError
from ..logs.setup import configure_logging

log = logging.getLogger(__name__)

CONFIG_RETRY_SECONDS = 60


def run_agent(stop: threading.Event, *, console: bool = False, event_log: bool = False) -> None:
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
        log.info("agent starting (device %s, organization %s)", rt.agent.device_uuid, rt.settings.organization_id)
        try:
            rt.agent.run(stop)
        finally:
            rt.close()
        return
