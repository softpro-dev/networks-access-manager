"""macOS launchd control for the SoftProIt.network.conducted daemon.

Mirrors `service/control.py` (Windows) for macOS: install/uninstall/start/stop and a
state query, driven through `launchctl`. A LaunchDaemon runs as root at boot, which is
the macOS analogue of a Windows LocalSystem auto-start service. Nothing here is hidden
from the OS: the plist lives in the standard `/Library/LaunchDaemons` location.

All launchctl operations require root and are Darwin-only; they are guarded and
excluded from coverage. `render_plist` is pure and unit-tested.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from xml.sax.saxutils import escape

from ..platform import IS_MACOS

LAUNCHD_LABEL = "com.softproit.network.conducted"
LAUNCHD_DIR = Path("/Library/LaunchDaemons")
LAUNCHD_PLIST = LAUNCHD_DIR / f"{LAUNCHD_LABEL}.plist"


class ServiceControlError(RuntimeError):
    pass


def _require_macos() -> None:
    if not IS_MACOS:
        raise ServiceControlError("launchd service management is only available on macOS")


def render_plist(exe_path: str, *, label: str = LAUNCHD_LABEL, log_dir: str | None = None) -> str:
    """Render the LaunchDaemon plist. The daemon runs `<exe> run` in the foreground;
    launchd owns the process lifecycle (KeepAlive + boot start)."""
    e = escape(exe_path)
    stdout = f"{log_dir}/launchd.out.log" if log_dir else "/var/log/com.softproit.network.conducted.out.log"
    stderr = f"{log_dir}/launchd.err.log" if log_dir else "/var/log/com.softproit.network.conducted.err.log"
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{escape(label)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{e}</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>{escape(stdout)}</string>
    <key>StandardErrorPath</key>
    <string>{escape(stderr)}</string>
</dict>
</plist>
"""


def _launchctl(*args: str) -> subprocess.CompletedProcess:  # pragma: no cover - macOS only
    return subprocess.run(["launchctl", *args], capture_output=True, text=True)


def install(exe_path: str | None = None, log_dir: str | None = None) -> None:  # pragma: no cover - macOS only
    _require_macos()
    exe = exe_path or sys.executable
    LAUNCHD_DIR.mkdir(parents=True, exist_ok=True)
    LAUNCHD_PLIST.write_text(render_plist(exe, log_dir=log_dir), encoding="utf-8")
    subprocess.run(["chown", "root:wheel", str(LAUNCHD_PLIST)], capture_output=True, text=True)
    LAUNCHD_PLIST.chmod(0o644)
    r = _launchctl("bootstrap", "system", str(LAUNCHD_PLIST))
    if r.returncode != 0 and "already" not in (r.stderr + r.stdout).lower():
        # Fall back to the older API on macOS versions without `bootstrap`.
        r = _launchctl("load", "-w", str(LAUNCHD_PLIST))
        if r.returncode != 0:
            raise ServiceControlError(f"launchctl load failed: {r.stderr.strip() or r.stdout.strip()}")


def uninstall() -> None:  # pragma: no cover - macOS only
    _require_macos()
    if LAUNCHD_PLIST.exists():
        r = _launchctl("bootout", "system", str(LAUNCHD_PLIST))
        if r.returncode != 0:
            _launchctl("unload", "-w", str(LAUNCHD_PLIST))
        LAUNCHD_PLIST.unlink(missing_ok=True)


def start() -> str:  # pragma: no cover - macOS only
    _require_macos()
    r = _launchctl("kickstart", "-k", f"system/{LAUNCHD_LABEL}")
    if r.returncode != 0:
        _launchctl("start", LAUNCHD_LABEL)
    return query_state()


def stop() -> str:  # pragma: no cover - macOS only
    _require_macos()
    _launchctl("kill", "SIGTERM", f"system/{LAUNCHD_LABEL}")
    _launchctl("stop", LAUNCHD_LABEL)
    return query_state()


def query_state() -> str:  # pragma: no cover - macOS only
    _require_macos()
    r = _launchctl("list", LAUNCHD_LABEL)
    if r.returncode != 0:
        return "NOT_INSTALLED"
    # `launchctl list <label>` prints a dict; a running daemon reports a PID.
    for line in r.stdout.splitlines():
        s = line.strip()
        if s.startswith('"PID"'):
            return "RUNNING"
    return "STOPPED"
