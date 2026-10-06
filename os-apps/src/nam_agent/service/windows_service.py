"""pywin32 Windows Service host. Import only on Windows."""

from __future__ import annotations

import threading

import servicemanager  # type: ignore[import-not-found]
import win32service  # type: ignore[import-not-found]
import win32serviceutil  # type: ignore[import-not-found]

from .. import SERVICE_DESCRIPTION, SERVICE_DISPLAY_NAME, SERVICE_NAME
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

    def SvcStop(self):
        self._release = True
        self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING, waitHint=30000)
        self._stop.set()

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
