"""Host facts sent at registration: hostname and Windows version string."""

from __future__ import annotations

import os
import platform
import socket

from ..platform import IS_WINDOWS


def hostname() -> str:
    name = (os.environ.get("COMPUTERNAME") if IS_WINDOWS else None) or socket.gethostname() or "unknown"
    return name.strip()[:255] or "unknown"


def format_windows_version(product: str, display_version: str | None, build: str | None, ubr: int | None) -> str:
    """e.g. 'Windows 11 Pro 23H2 (10.0.22631.4317)'.

    The registry ProductName still says 'Windows 10' on Windows 11; build >= 22000 is Windows 11.
    """
    name = product.strip() or "Windows"
    try:
        if build and int(build) >= 22000 and name.startswith("Windows 10"):
            name = "Windows 11" + name[len("Windows 10"):]
    except ValueError:
        pass
    parts = [name]
    if display_version:
        parts.append(display_version)
    if build:
        parts.append(f"(10.0.{build}{'.' + str(ubr) if ubr is not None else ''})")
    return " ".join(parts)[:200]


def windows_version() -> str:
    if IS_WINDOWS:  # pragma: no cover - Windows only
        try:
            import winreg

            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion") as k:

                def q(name: str):
                    try:
                        return winreg.QueryValueEx(k, name)[0]
                    except OSError:
                        return None

                return format_windows_version(
                    q("ProductName") or "Windows",
                    q("DisplayVersion") or q("ReleaseId"),
                    q("CurrentBuildNumber"),
                    q("UBR"),
                )
        except OSError:
            pass
        return f"Windows {platform.release()} ({platform.version()})"[:200]
    return f"{platform.system()} {platform.release()} (development host)"[:200]
