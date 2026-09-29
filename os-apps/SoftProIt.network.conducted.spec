# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the background service: SoftProIt.network.conducted
# (internal service/daemon name still OrganizationNetworkAgent).
#
# Build on the TARGET OS — PyInstaller does not cross-compile:
#   Windows x64 : scripts\build.ps1
#   macOS       : scripts/build.sh
#
# onedir (not onefile): a onefile exe unpacks itself to a temp dir on every start.
# For a LocalSystem/root service that means a writable per-start extraction directory
# (slower start, AV false positives, stale folders after crashes, binaries loaded
# from outside the ACL-protected install tree). onedir keeps every binary under the
# install directory.

import sys

block_cipher = None

# Windows service host imports (pywin32) are only meaningful on Windows.
hidden = [
    "nam_agent.service.windows_service",
    "nam_agent.network.win_adapters",
]
if sys.platform == "win32":
    hidden += [
        "win32timezone",       # required by pywin32 service framework at runtime
        "servicemanager",
        "win32serviceutil",
        "win32service",
        "win32event",
        "win32crypt",
    ]

a = Analysis(
    ["src/main.py"],
    pathex=["src"],
    binaries=[],
    datas=[],
    hiddenimports=hidden,
    hookspath=[],
    runtime_hooks=[],
    # The service must not pull in the GUI wrapper or its heavy backends.
    excludes=["tkinter", "psutil", "pytest", "webview", "pywebview", "nam_admin"],
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="SoftProIt.network.conducted",
    debug=False,
    strip=False,
    upx=False,
    console=True,           # CLI subcommands need a console; the SCM/launchd never shows one
    uac_admin=False,        # elevation is checked per command; `status` works unelevated
    version=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name="SoftProIt.network.conducted",
)
