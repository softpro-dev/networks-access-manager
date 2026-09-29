"""Entry point for SoftProIt.network.admin (PyInstaller) and `python src/main_admin.py`."""

import os
import sys

if not getattr(sys, "frozen", False):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from nam_admin.main import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
