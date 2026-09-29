"""Tiny platform helpers. Nothing here imports Windows-only modules at import time."""

from __future__ import annotations

import sys

IS_WINDOWS = sys.platform == "win32"
IS_MACOS = sys.platform == "darwin"


def is_frozen() -> bool:
    """True when running from the PyInstaller-built executable."""
    return bool(getattr(sys, "frozen", False))
