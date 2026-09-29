"""OrganizationNetworkAgent.exe command line.

  (no arguments)  host the Windows Service (launched by the SCM)
  configure       set organization / server / registration token (Administrator)
  install         register the Windows Service (auto start, recovery, DACL)
  uninstall       stop and remove the service
  start | stop    control the service
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
from .platform import IS_WINDOWS, is_frozen


def _fail(msg: str, code: int = 1) -> int:
    print(f"error: {msg}", file=sys.stderr)
    return code


def _require_admin() -> int | None:
    from .security.elevation import is_elevated

    if IS_WINDOWS and not is_elevated():
        return _fail("this command must be run from an elevated (Administrator) prompt", 5)
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


def cmd_service(action: str) -> int:
    if (rc := _require_admin()) is not None:
        return rc
    from .service import control

    try:
        if action == "install":
            control.install()
            print(f"{SERVICE_NAME} installed (automatic start).")
        elif action == "uninstall":
            control.uninstall()
            print(f"{SERVICE_NAME} removed.")
        elif action == "start":
            state = control.start()
            print(state)
            return 0 if state == "RUNNING" else 3
        elif action == "stop":
            state = control.stop()
            print(state)
            return 0 if state == "STOPPED" else 3
    except control.ServiceControlError as e:
        return _fail(str(e))
    except Exception as e:  # pywintypes.error
        return _fail(f"{action} failed: {e}")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    out: dict = {"agent_version": AGENT_VERSION}
    if IS_WINDOWS:
        from .service import control

        try:
            out["service_state"] = control.query_state()
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
    from .service.host import run_agent

    stop = threading.Event()
    print("Running in the foreground; press Ctrl+C to stop.", file=sys.stderr)
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
    for name in ("install", "uninstall", "start", "stop"):
        sub.add_parser(name, help=f"{name} the Windows Service")
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
        return cmd_service(args.command)
    if args.command == "status":
        return cmd_status(args)
    if args.command == "run":
        return cmd_run(args)
    return _fail(f"unknown command {args.command}")
