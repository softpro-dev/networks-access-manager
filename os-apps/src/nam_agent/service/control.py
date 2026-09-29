"""Service Control Manager operations (Windows only; imports are lazy)."""

from __future__ import annotations

import subprocess
import sys
import time

from .. import SERVICE_DESCRIPTION, SERVICE_DISPLAY_NAME, SERVICE_NAME
from ..platform import IS_WINDOWS, is_frozen

# SYSTEM + Administrators: full control. Interactive/Service/Authenticated users: query only
# (no start/stop/pause/change-config/delete/user-defined control).
SERVICE_SDDL = (
    "D:"
    "(A;;CCLCSWRPWPDTLOCRRC;;;SY)"
    "(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)"
    "(A;;CCLCSWLORC;;;IU)"
    "(A;;CCLCSWLORC;;;SU)"
    "(A;;CCLCSWLORC;;;AU)"
)
FAILURE_ACTIONS = ["reset=", "86400", "actions=", "restart/5000/restart/30000/restart/60000"]

STATE_NAMES = {1: "STOPPED", 2: "START_PENDING", 3: "STOP_PENDING", 4: "RUNNING", 5: "CONTINUE_PENDING", 6: "PAUSE_PENDING", 7: "PAUSED"}


class ServiceControlError(RuntimeError):
    pass


def _require_windows() -> None:
    if not IS_WINDOWS:
        raise ServiceControlError("service management is only available on Windows")


def _sc(*args: str) -> None:
    r = subprocess.run(["sc.exe", *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise ServiceControlError(f"sc.exe {args[0]} failed ({r.returncode}): {r.stdout.strip() or r.stderr.strip()}")


def install() -> None:  # pragma: no cover - Windows only
    _require_windows()
    if not is_frozen():
        raise ServiceControlError("install requires the built OrganizationNetworkAgent.exe; use `run` for development")
    import win32service
    import win32serviceutil

    win32serviceutil.InstallService(
        None,
        SERVICE_NAME,
        SERVICE_DISPLAY_NAME,
        startType=win32service.SERVICE_AUTO_START,
        exeName=sys.executable,  # quoted by pywin32 -> no unquoted-path issue
        description=SERVICE_DESCRIPTION,
    )
    harden()


def harden() -> None:  # pragma: no cover - Windows only
    """Recovery actions + restrictive service DACL. Idempotent."""
    _require_windows()
    _sc("failure", SERVICE_NAME, *FAILURE_ACTIONS)
    _sc("failureflag", SERVICE_NAME, "1")
    _sc("sdset", SERVICE_NAME, SERVICE_SDDL)


def uninstall() -> None:  # pragma: no cover - Windows only
    _require_windows()
    import win32serviceutil

    try:
        stop()
    except Exception:
        pass
    win32serviceutil.RemoveService(SERVICE_NAME)


def start(wait_seconds: float = 30.0) -> str:  # pragma: no cover - Windows only
    _require_windows()
    import win32serviceutil

    win32serviceutil.StartService(SERVICE_NAME)
    return _wait_for(4, wait_seconds)


def stop(wait_seconds: float = 30.0) -> str:  # pragma: no cover - Windows only
    _require_windows()
    import win32serviceutil

    win32serviceutil.StopService(SERVICE_NAME)
    return _wait_for(1, wait_seconds)


def query_state() -> str:  # pragma: no cover - Windows only
    _require_windows()
    import pywintypes
    import win32serviceutil

    try:
        return STATE_NAMES.get(win32serviceutil.QueryServiceStatus(SERVICE_NAME)[1], "UNKNOWN")
    except pywintypes.error:
        return "NOT_INSTALLED"


def _wait_for(target: int, wait_seconds: float) -> str:  # pragma: no cover - Windows only
    import win32serviceutil

    deadline = time.monotonic() + wait_seconds
    state = 0
    while time.monotonic() < deadline:
        state = win32serviceutil.QueryServiceStatus(SERVICE_NAME)[1]
        if state == target:
            break
        time.sleep(0.5)
    return STATE_NAMES.get(state, "UNKNOWN")
