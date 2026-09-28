"""Logging: rotating file under <data root>\\logs, optional console, Event Log for errors.

Every handler carries a RedactingFilter so credentials never reach disk or the Event Log.
"""

from __future__ import annotations

import logging
import logging.handlers
from pathlib import Path

from ..security.redact import RedactingFilter

LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s [%(threadName)s] %(message)s"
MAX_BYTES = 5 * 1024 * 1024
BACKUPS = 5


class ServiceEventLogHandler(logging.Handler):
    """Forward ERROR+ records to the Windows Application Event Log via servicemanager
    (only meaningful while hosted by the Service Control Manager)."""

    def __init__(self) -> None:
        super().__init__(level=logging.ERROR)

    def emit(self, record: logging.LogRecord) -> None:  # pragma: no cover - Windows only
        try:
            import servicemanager

            msg = self.format(record)[:8000]
            if record.levelno >= logging.ERROR:
                servicemanager.LogErrorMsg(msg)
            else:
                servicemanager.LogWarningMsg(msg)
        except Exception:
            self.handleError(record)


def configure_logging(logs_dir: Path | None, level: str = "INFO", *, console: bool = False, event_log: bool = False) -> None:
    root = logging.getLogger()
    for h in list(root.handlers):
        root.removeHandler(h)
        h.close()
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    fmt = logging.Formatter(LOG_FORMAT)
    redact = RedactingFilter()
    handlers: list[logging.Handler] = []
    if logs_dir is not None:
        logs_dir.mkdir(parents=True, exist_ok=True)
        handlers.append(
            logging.handlers.RotatingFileHandler(logs_dir / "agent.log", maxBytes=MAX_BYTES, backupCount=BACKUPS, encoding="utf-8")
        )
    if console:
        handlers.append(logging.StreamHandler())
    if event_log:
        handlers.append(ServiceEventLogHandler())
    for h in handlers:
        h.setFormatter(fmt)
        h.addFilter(redact)
        root.addHandler(h)
    # httpx logs full URLs at INFO; keep it quiet.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
