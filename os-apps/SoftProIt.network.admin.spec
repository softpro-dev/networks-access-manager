# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the desktop admin wrapper: SoftProIt.network.admin
#
# Build on the TARGET OS — PyInstaller does not cross-compile:
#   Windows x64 : scripts\build.ps1   (uses the Edge WebView2 runtime at run time)
#   macOS       : scripts/build.sh    (uses system WebKit via pyobjc)
#
# onedir, windowed. This app packages independently from the service. Of the service package
# it may bundle ONLY nam_agent.network (stdlib interface discovery, used by the LAN scan so
# "Add My PC" gets the same MAC the agent reports); every other service module is excluded.

import sys

block_cipher = None

hidden = ["webview", "nam_agent.network.interfaces"]
if sys.platform == "win32":
    hidden += ["webview.platforms.edgechromium", "clr_loader", "pythonnet", "nam_agent.network.win_adapters"]
elif sys.platform == "darwin":
    hidden += ["webview.platforms.cocoa", "nam_agent.network.fallback"]

# Everything in the service except nam_agent.network (+ its tiny platform helper).
SERVICE_MODULES = [
    f"nam_agent.{m}"
    for m in ("agent", "api", "cli", "config", "enforcement", "identity", "logs", "policy", "security", "service", "storage")
]
# psutil backs the macOS interface fallback; Windows uses GetAdaptersAddresses via ctypes.
EXTRA_EXCLUDES = ["psutil"] if sys.platform == "win32" else []

a = Analysis(
    ["src/main_admin.py"],
    pathex=["src"],
    binaries=[],
    datas=[],
    hiddenimports=hidden,
    hookspath=[],
    runtime_hooks=[],
    excludes=SERVICE_MODULES + EXTRA_EXCLUDES + ["pytest"],
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="SoftProIt.network.admin",
    debug=False,
    strip=False,
    upx=False,
    console=False,          # a windowed desktop app, no console
    uac_admin=False,
    version=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name="SoftProIt.network.admin",
)

# On macOS also wrap the onedir output in a .app bundle.
if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="SoftProIt.network.admin.app",
        icon=None,
        bundle_identifier="com.softproit.network.admin",
        info_plist={
            "CFBundleName": "SoftProIt Network Admin",
            "CFBundleDisplayName": "SoftProIt Network Admin",
            "NSHighResolutionCapable": True,
        },
    )
