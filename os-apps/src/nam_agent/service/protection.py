"""Uninstall password: stopping or removing the service on purpose (which lifts every
restriction) needs the password baked into the installer (UNINSTALL_PASSWORD at build time).

The installer writes only a salted PBKDF2 hash to agent.env (`UNINSTALL_PASSWORD_HASH`); no
hash there means the service is unprotected (older installs, development). Pure except for the
small file helpers, so it runs and is tested on every OS.

How a protected Windows service is stopped (see `windows_service.py` / `control.py`):
  - it does not accept the normal SCM stop, so the Services app greys out "Stop";
  - `stop` / `uninstall` (CLI, also run by the uninstaller) check the password, write it to a
    one-time permit file in the admin-only config dir and send CONTROL_RELEASE_STOP; the
    service re-checks the permit, deletes it, removes every restriction and stops;
  - setup upgrades send CONTROL_KEEP_STOP: the service stops but leaves the restrictions on.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets

from ..config.paths import AgentPaths
from ..config.settings import read_env_file

HASH_KEY = "UNINSTALL_PASSWORD_HASH"
#: the uninstaller / caller passes the password to `stop` / `uninstall` in this variable
PASSWORD_ENV = "NAM_UNINSTALL_PASSWORD"
PERMIT_NAME = "stop-permit"
ALGORITHM = "pbkdf2-sha256"
DEFAULT_ITERATIONS = 200_000

#: user-defined SCM control codes (128-255)
CONTROL_RELEASE_STOP = 200  # password permit present: remove restrictions, then stop
CONTROL_KEEP_STOP = 201  # setup upgrade: stop, keep the restrictions in place


def hash_password(password: str, *, salt: bytes | None = None, iterations: int = DEFAULT_ITERATIONS) -> str:
    """`pbkdf2-sha256:<iterations>:<salt hex>:<hash hex>`; build.ps1 produces the same format."""
    salt = secrets.token_bytes(16) if salt is None else salt
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"{ALGORITHM}:{iterations}:{salt.hex()}:{digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, iterations, salt_hex, hash_hex = encoded.strip().split(":")
        if algorithm != ALGORITHM:
            return False
        iterations_n = int(iterations)
        if not 1 <= iterations_n <= 10_000_000:
            return False
        salt, expected = bytes.fromhex(salt_hex), bytes.fromhex(hash_hex)
    except ValueError:
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations_n)
    return hmac.compare_digest(digest, expected)


def load_password_hash(paths: AgentPaths) -> str | None:
    """The configured hash, or None when the service is not password protected."""
    value = read_env_file(paths.env_file).get(HASH_KEY, "").strip()
    return value or None


def is_protected(paths: AgentPaths) -> bool:
    return load_password_hash(paths) is not None


def check_password(paths: AgentPaths, password: str | None) -> bool:
    """True when no password is configured or `password` matches it."""
    encoded = load_password_hash(paths)
    if encoded is None:
        return True
    return password is not None and verify_password(password, encoded)


def permit_path(paths: AgentPaths):
    return paths.config_dir / PERMIT_NAME


def write_stop_permit(paths: AgentPaths, password: str) -> None:
    """Hand the password to the running service. The config dir is SYSTEM/Administrators only."""
    path = permit_path(paths)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(password, encoding="utf-8")


def clear_stop_permit(paths: AgentPaths) -> None:
    try:
        os.remove(permit_path(paths))
    except FileNotFoundError:
        pass


def consume_stop_permit(paths: AgentPaths) -> bool:
    """Read and delete the permit; True when it holds the right password (or none is needed)."""
    path = permit_path(paths)
    try:
        password = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return not is_protected(paths)
    finally:
        clear_stop_permit(paths)
    return check_password(paths, password)
