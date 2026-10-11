"""OrganizationNetworkAgent.exe command line.

  (no arguments)  host the Windows Service (launched by the SCM)
  configure       set organization / server / registration token (Administrator)
  install         register the Windows Service (auto start, recovery, DACL)
  uninstall       stop and remove the service (uninstall password, when set)
  start | stop    control the service (stop: uninstall password, when set)
  check-password  exit 0 when the uninstall password is right (or none is set)
  status          service state + local agent state
  run             run the agent in the foreground (debugging)
"""

from __future__ import annotations

import argparse
import getpass
import json
import sys
import threading
from pathlib import Path

from . import AGENT_VERSION, SERVICE_NAME
from .platform import IS_MACOS, IS_WINDOWS, is_frozen


def _fail(msg: str, code: int = 1) -> int:
    print(f"error: {msg}", file=sys.stderr)
    return code


def _require_admin() -> int | None:
    from .security.elevation import is_elevated

    if (IS_WINDOWS or IS_MACOS) and not is_elevated():
        who = "Administrator" if IS_WINDOWS else "root (sudo)"
        return _fail(f"this command must be run as {who}", 5)
    return None


def cmd_configure(args: argparse.Namespace) -> int:
    if (rc := _require_admin()) is not None:
        return rc
    from .config.configure import ConfigureRequest, apply_configuration
    from .config.paths import resolve_paths
    from .config.settings import ConfigError

    if args.token_stdin:
        token = sys.stdin.readline().strip()
    elif args.token_file:
        token = Path(args.token_file).read_text(encoding="utf-8").strip()
    else:
        token = getpass.getpass("Registration Token: ")
    org = args.organization_id or input("Organization ID: ").strip()
    server = args.server_url or input("Server (e.g. https://management.example.com/api): ").strip()
    try:
        apply_configuration(
            resolve_paths(),
            ConfigureRequest(
                organization_id=org,
                api_base_url=server,
                registration_token=token,
                verify_tls=not args.no_verify_tls,
                ca_bundle=Path(args.ca_bundle) if args.ca_bundle else None,
                reset_enrollment=args.reset_enrollment,
            ),
        )
    except ConfigError as e:
        return _fail(str(e), 2)
    print("Configuration saved and server connectivity verified.")
    if IS_WINDOWS:
        print("Restart the service to apply: OrganizationNetworkAgent.exe stop && OrganizationNetworkAgent.exe start")
    return 0


def _service_module():
    """The platform service-control module (Windows SCM or macOS launchd)."""
    if IS_MACOS:
        from .service import launchd

        return launchd
    from .service import control

    return control


def _remove_restrictions() -> None:
    """Remove everything the enforcement backend installed (browser policies, hosts entries,
    firewall rules). Never fails the calling command."""
    from .config.paths import resolve_paths
    from .enforcement import default_backend

    try:
        default_backend(resolve_paths().data_dir).remove()
        print("All restrictions removed from this computer.")
    except Exception as e:  # noqa: BLE001
        print(f"warning: could not remove every restriction: {e}", file=sys.stderr)


WRONG_PASSWORD_EXIT = 6


def _read_password(args: argparse.Namespace, *, prompt: bool = True) -> str | None:
    """The uninstall password: NAM_UNINSTALL_PASSWORD (the uninstaller sets it), --password-stdin,
    else a prompt when interactive and `prompt`. The uninstaller runs us in a hidden console, where
    a prompt would wait forever: it cannot pass an empty variable (that deletes it), so the commands
    it runs must not prompt."""
    import os

    from .service.protection import PASSWORD_ENV

    if PASSWORD_ENV in os.environ:
        return os.environ[PASSWORD_ENV]
    if getattr(args, "password_stdin", False):
        return sys.stdin.readline().rstrip("\r\n")
    if prompt and not getattr(args, "no_prompt", False) and sys.stdin is not None and sys.stdin.isatty():
        return getpass.getpass("Uninstall password: ")
    return None


def _password_ok(args: argparse.Namespace, *, prompt: bool = True) -> tuple[bool, str | None]:
    """(allowed, password). Allowed when no uninstall password is configured or it matches."""
    from .config.paths import resolve_paths
    from .service import protection

    paths = resolve_paths()
    if not protection.is_protected(paths):
        return True, None
    password = _read_password(args, prompt=prompt)
    return protection.check_password(paths, password), password


def cmd_check_password(args: argparse.Namespace) -> int:
    if (rc := _require_admin()) is not None:
        return rc
    ok, _ = _password_ok(args, prompt=False)  # run hidden by the uninstaller: never prompt
    if not ok:
        return _fail("wrong uninstall password", WRONG_PASSWORD_EXIT)
    print("OK")
    return 0


def cmd_service(action: str, args: argparse.Namespace | None = None) -> int:
    if (rc := _require_admin()) is not None:
        return rc
    if not (IS_WINDOWS or IS_MACOS):
        return _fail("service management is only available on Windows and macOS; use `run` for development")
    svc = _service_module()
    args = args or argparse.Namespace()
    password = None
    keep = getattr(args, "keep_restrictions", False)
    if action == "uninstall" or (action == "stop" and not keep):
        ok, password = _password_ok(args)
        if not ok:
            return _fail("wrong uninstall password: the service was not stopped", WRONG_PASSWORD_EXIT)

    try:
        if action == "install":
            svc.install()
            print(f"{SERVICE_NAME} installed (automatic start).")
        elif action == "uninstall":
            svc.uninstall(password) if IS_WINDOWS else svc.uninstall()  # stopping already lifts the restrictions...
            _remove_restrictions()  # ...and this also covers a service that was killed or never ran
            print(f"{SERVICE_NAME} removed.")
        elif action == "start":
            state = svc.start()
            print(state)
            return 0 if state == "RUNNING" else 3
        elif action == "stop":
            if keep and IS_WINDOWS:
                state = svc.stop_keep_restrictions()
            else:
                state = svc.stop(password) if IS_WINDOWS else svc.stop()
            print(state)
            return 0 if state in ("STOPPED", "NOT_INSTALLED") else 3
    except svc.ServiceControlError as e:
        return _fail(str(e))
    except Exception as e:  # pywintypes.error / OSError
        return _fail(f"{action} failed: {e}")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    out: dict = {"agent_version": AGENT_VERSION}
    if IS_WINDOWS or IS_MACOS:
        try:
            out["service_state"] = _service_module().query_state()
        except Exception as e:
            out["service_state"] = f"unknown ({e.__class__.__name__})"
    try:
        from .agent.runtime import build_runtime

        rt = build_runtime()
        try:
            out.update(rt.agent.status_summary())
        finally:
            rt.close()
    except PermissionError:
        out["local_state_error"] = "access denied: run elevated to read local state"
    except Exception as e:
        out["local_state_error"] = f"{e.__class__.__name__}: {e}"
    print(json.dumps(out, indent=2, sort_keys=True))
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    import signal

    from .service.host import run_agent

    stop = threading.Event()
    # macOS launchd (and Linux systemd) stop the daemon with SIGTERM; honour it so the
    # agent shuts down cleanly and leaves enforcement state unchanged.
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, lambda *_: stop.set())
        except (ValueError, OSError):  # pragma: no cover - not in main thread
            pass
    print("Running in the foreground; press Ctrl+C or send SIGTERM to stop.", file=sys.stderr)
    try:
        run_agent(stop, console=True)
    except KeyboardInterrupt:
        stop.set()
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="OrganizationNetworkAgent", description="Organization Network Management Agent")
    p.add_argument("--version", action="version", version=AGENT_VERSION)
    sub = p.add_subparsers(dest="command")
    c = sub.add_parser("configure", help="configure organization, server and registration token")
    c.add_argument("--organization-id")
    c.add_argument("--server-url", help="API base URL, e.g. https://management.example.com/api")
    g = c.add_mutually_exclusive_group()
    g.add_argument("--token-stdin", action="store_true", help="read the registration token from stdin")
    g.add_argument("--token-file", help="read the registration token from a file (the caller deletes it)")
    c.add_argument("--ca-bundle", help="PEM CA bundle for a private PKI")
    c.add_argument("--no-verify-tls", action="store_true", help="disable TLS verification (NOT for production)")
    c.add_argument("--reset-enrollment", action="store_true", help="discard the device credential and enroll again")
    parsers = {}
    for name in ("install", "uninstall", "start", "stop"):
        parsers[name] = sub.add_parser(name, help=f"{name} the background service (Windows Service / macOS launchd)")
    k = sub.add_parser("check-password", help="check the uninstall password (exit 0 = right)")
    for q in (parsers["uninstall"], parsers["stop"], k):
        q.add_argument("--password-stdin", action="store_true", help="read the uninstall password from stdin")
        q.add_argument("--no-prompt", action="store_true", help="never ask for the password (unattended runs)")
    parsers["stop"].add_argument(
        "--keep-restrictions", action="store_true", help="setup upgrades: stop without lifting the restrictions (no password)"
    )
    sub.add_parser("status", help="show service and agent state")
    sub.add_parser("run", help="run the agent in the foreground (debug)")
    return p


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if not argv and IS_WINDOWS and is_frozen():  # pragma: no cover - Windows only
        from .service.windows_service import host_service

        host_service()
        return 0
    args = build_parser().parse_args(argv)
    if args.command is None:
        build_parser().print_help()
        return 0
    if args.command == "configure":
        return cmd_configure(args)
    if args.command in ("install", "uninstall", "start", "stop"):
        return cmd_service(args.command, args)
    if args.command == "check-password":
        return cmd_check_password(args)
    if args.command == "status":
        return cmd_status(args)
    if args.command == "run":
        return cmd_run(args)
    return _fail(f"unknown command {args.command}")
