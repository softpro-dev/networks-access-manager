# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for OrganizationNetworkAgent.exe. Build on Windows x64 only:
#   scripts\build.ps1
#
# onedir (not onefile): a onefile exe unpacks itself to %TEMP% on every start.
# For a LocalSystem service that means a writable, per-start extraction directory
# (slower start, AV false positives, stale _MEI folders after crashes, and binaries
# loaded from a location outside the ACL-protected Program Files tree). onedir
# keeps every DLL/pyd under C:\Program Files\OrganizationNetworkAgent\.

block_cipher = None

a = Analysis(
    ["src/main.py"],
    pathex=["src"],
    binaries=[],
    datas=[],
    hiddenimports=[
        "win32timezone",       # required by pywin32 service framework at runtime
        "servicemanager",
        "win32serviceutil",
        "win32service",
        "win32event",
        "win32crypt",
        "nam_agent.service.windows_service",
        "nam_agent.network.win_adapters",
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "psutil", "pytest"],
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="OrganizationNetworkAgent",
    debug=False,
    strip=False,
    upx=False,
    console=True,           # CLI subcommands need a console; the SCM never shows one for services
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
    name="OrganizationNetworkAgent",
)
