# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the desktop admin wrapper: SoftProIt.network.admin
#
# Build on the TARGET OS — PyInstaller does not cross-compile:
#   Windows x64 : scripts\build.ps1   (uses the Edge WebView2 runtime at run time)
#   macOS       : scripts/build.sh    (uses system WebKit via pyobjc)
#
# onedir, windowed. This app packages independently from the service and must NOT
# import the service's Windows-only modules (it only depends on nam_admin).

import sys

block_cipher = None

hidden = ["webview"]
if sys.platform == "win32":
    hidden += ["webview.platforms.edgechromium", "clr_loader", "pythonnet"]
elif sys.platform == "darwin":
    hidden += ["webview.platforms.cocoa"]

a = Analysis(
    ["src/main_admin.py"],
    pathex=["src"],
    binaries=[],
    datas=[],
    hiddenimports=hidden,
    hookspath=[],
    runtime_hooks=[],
    # Keep the service package out of the GUI app entirely.
    excludes=["nam_agent", "pytest", "psutil"],
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
