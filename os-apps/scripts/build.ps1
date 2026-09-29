<#
.SYNOPSIS
  Build BOTH Windows executables (PyInstaller onedir) and, optionally, the Inno Setup
  installer:
    - SoftProIt.network.conducted.exe  (the background service)
    - SoftProIt.network.admin.exe      (the desktop admin-console wrapper)
.NOTES
  Must run on Windows 10/11 x64 with 64-bit Python 3.11+ on PATH (py launcher).
  PyInstaller does not cross-compile: a macOS/Linux build cannot produce the .exe.
  The admin app uses the Edge WebView2 runtime at run time (ship/require it separately).
#>
[CmdletBinding()]
param(
  [switch]$SkipTests,
  [switch]$Installer,
  [string]$Python = "py -3"
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not [Environment]::Is64BitOperatingSystem) { throw "A 64-bit Windows host is required." }

$venv = Join-Path $Root ".venv"
if (-not (Test-Path $venv)) {
  Write-Host "Creating virtual environment..."
  Invoke-Expression "$Python -m venv `"$venv`""
}
$py = Join-Path $venv "Scripts\python.exe"
& $py -c "import struct,sys; assert struct.calcsize('P')==8, '64-bit Python required'; print(sys.version)"
if ($LASTEXITCODE -ne 0) { throw "64-bit Python required" }

& $py -m pip install --upgrade pip
& $py -m pip install -r requirements-dev.txt
if ($LASTEXITCODE -ne 0) { throw "dependency install failed" }

if (-not $SkipTests) {
  & $py -m pytest
  if ($LASTEXITCODE -ne 0) { throw "tests failed" }
}

Remove-Item -Recurse -Force build, dist -ErrorAction SilentlyContinue

& $py -m PyInstaller --noconfirm --clean "SoftProIt.network.conducted.spec"
if ($LASTEXITCODE -ne 0) { throw "PyInstaller (conducted) failed" }
& $py -m PyInstaller --noconfirm --clean "SoftProIt.network.admin.spec"
if ($LASTEXITCODE -ne 0) { throw "PyInstaller (admin) failed" }

$svcExe = Join-Path $Root "dist\SoftProIt.network.conducted\SoftProIt.network.conducted.exe"
& $svcExe --version
if ($LASTEXITCODE -ne 0) { throw "built service executable does not start" }
$adminExe = Join-Path $Root "dist\SoftProIt.network.admin\SoftProIt.network.admin.exe"
& $adminExe --version
if ($LASTEXITCODE -ne 0) { throw "built admin executable does not start" }
Write-Host "Built:`n  $svcExe`n  $adminExe"

if ($Installer) {
  $iscc = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $iscc) { throw "Inno Setup 6 (ISCC.exe) not found" }
  & $iscc "installer\OrganizationNetworkAgent.iss"
  if ($LASTEXITCODE -ne 0) { throw "ISCC failed" }
  Write-Host "Installer written to installer\Output\"
}
