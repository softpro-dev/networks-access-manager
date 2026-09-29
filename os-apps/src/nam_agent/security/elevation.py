"""Administrator / elevation check."""

from __future__ import annotations

import os

from ..platform import IS_WINDOWS


def is_elevated() -> bool:
    if IS_WINDOWS:  # pragma: no cover - Windows only
        import ctypes

        try:
            return bool(ctypes.windll.shell32.IsUserAnAdmin())
        except Exception:
            return False
    geteuid = getattr(os, "geteuid", None)
    return bool(geteuid and geteuid() == 0)
