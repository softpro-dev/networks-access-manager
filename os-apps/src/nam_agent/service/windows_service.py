"""pywin32 Windows Service host. Import only on Windows."""

from __future__ import annotations

import threading

import servicemanager  # type: ignore[import-not-found]
import win32service  # type: ignore[import-not-found]
import win32serviceutil  # type: ignore[import-not-found]

from .. import SERVICE_DESCRIPTION, SERVICE_DISPLAY_NAME, SERVICE_NAME
from ..config.paths import resolve_paths
from . import protection
from .host import run_agent


class AgentService(win32serviceutil.ServiceFramework):
    _svc_name_ = SERVICE_NAME
    _svc_display_name_ = SERVICE_DISPLAY_NAME
    _svc_description_ = SERVICE_DESCRIPTION

    def __init__(self, args):
        super().__init__(args)
        self._stop = threading.Event()
        #: True when an administrator stops the service (Stop-Service, Services app, uninstall):
        #: then every restriction is removed. Windows shutting down keeps them for the next boot.
        self._release = False
        #: With an uninstall password the normal SCM stop is refused; see `protection`.
        try:
            self._paths = resolve_paths()
            self._protected = protection.is_protected(self._paths)
        except Exception:  # noqa: BLE001 - an unreadable config must not stop the service
            self._paths, self._protected = None, False

    def GetAcceptedControls(self):
        accepted = super().GetAcceptedControls()
        if self._protected:
            accepted &= ~win32service.SERVICE_ACCEPT_STOP  # "Stop" greyed out in the Services app
        return accepted

    def SvcStop(self):
        self._release = True
        self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING, waitHint=30000)
        self._stop.set()

    def SvcOther(self, control):
        if control == protection.CONTROL_KEEP_STOP:
            # Setup upgrade: stop, but keep the restrictions until the new version starts.
            self.SvcShutdown()
        elif control == protection.CONTROL_RELEASE_STOP:
            if self._paths is None or protection.consume_stop_permit(self._paths):
                self.SvcStop()
            else:
                servicemanager.LogWarningMsg(f"{SERVICE_NAME}: stop refused (wrong or missing uninstall password)")

    def SvcShutdown(self):
        self._release = False
        self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING, waitHint=30000)
        self._stop.set()

    def SvcDoRun(self):
        servicemanager.LogMsg(
            servicemanager.EVENTLOG_INFORMATION_TYPE, servicemanager.PYS_SERVICE_STARTED, (self._svc_name_, "")
        )
        try:
            run_agent(self._stop, event_log=True, release_on_stop=lambda: self._release)
        except Exception as e:
            servicemanager.LogErrorMsg(f"{SERVICE_NAME} terminated with an error: {e.__class__.__name__}: {e}")
            raise
        finally:
            servicemanager.LogMsg(
                servicemanager.EVENTLOG_INFORMATION_TYPE, servicemanager.PYS_SERVICE_STOPPED, (self._svc_name_, "")
            )


def host_service() -> None:
    """Entry point when launched by the Service Control Manager (no arguments)."""
    servicemanager.Initialize()
    servicemanager.PrepareToHostSingle(AgentService)
    servicemanager.StartServiceCtrlDispatcher()
