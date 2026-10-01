<#
.SYNOPSIS
  Build the Windows executables (PyInstaller onedir) and, optionally, their Inno Setup
  installers:
    - Service: SoftProIt.network.conducted.exe -> SoftProIt-Network-Service-<ver>-setup.exe
    - Admin:   SoftProIt.network.admin.exe     -> SoftProIt-Network-Admin-<ver>-setup.exe
.PARAMETER Target
  Service, Admin or All (default).
.PARAMETER Version
  Installer version. Default: $env:BUILD_VERSION, else BUILD_VERSION in os-apps\.env, else 1.0.0.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Target Admin -Installer
.NOTES
  Must run on Windows 10/11 x64 with 64-bit Python 3.11+ on PATH (py launcher).
  PyInstaller does not cross-compile: a macOS/Linux build cannot produce the .exe.
  The admin app uses the Edge WebView2 runtime at run time (ship/require it separately).
#>
[CmdletBinding()]
param(
  [ValidateSet("All", "Service", "Admin")]
  [string]$Target = "All",
  [string]$Version = "",
  [switch]$SkipTests,
  [switch]$Installer,
  [string]$Python = "py -3"
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not [Environment]::Is64BitOperatingSystem) { throw "A 64-bit Windows host is required." }

function Get-BuildVersion {
  if ($Version) { return $Version }
  if ($env:BUILD_VERSION) { return $env:BUILD_VERSION }
  $envFile = Join-Path $Root ".env"
  if (Test-Path $envFile) {
    $line = Get-Content $envFile | Where-Object { $_ -match '^\s*BUILD_VERSION\s*=' } | Select-Object -Last 1
    if ($line) { return ($line -replace '^\s*BUILD_VERSION\s*=\s*', '').Trim().Trim('"', "'") }
  }
  return "1.0.0"
}
$BuildVersion = Get-BuildVersion
# Inno Setup compares versions numerically for upgrades: keep it to 2-4 dotted numbers.
if ($BuildVersion -notmatch '^\d+(\.\d+){1,3}$') { throw "BUILD_VERSION '$BuildVersion' must look like 1.0.0" }

$apps = @(
  @{ Name = "Service"; Dir = "SoftProIt.network.conducted"; Spec = "SoftProIt.network.conducted.spec"; Iss = "installer\SoftProIt.Network.Service.iss" },
  @{ Name = "Admin"; Dir = "SoftProIt.network.admin"; Spec = "SoftProIt.network.admin.spec"; Iss = "installer\SoftProIt.Network.Admin.iss" }
) | Where-Object { $Target -eq "All" -or $_.Name -eq $Target }
Write-Host "Building $($apps.Name -join ' + ') version $BuildVersion"

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
  # A private temp dir: the shared %TEMP%\pytest-of-<user> can hold folders owned by an
  # elevated run, which makes pytest fail with "Access is denied".
  & $py -m pytest -p no:cacheprovider --basetemp (Join-Path $Root "build\pytest")
  if ($LASTEXITCODE -ne 0) { throw "tests failed" }
}

foreach ($app in $apps) {
  # Only this target's folders, so building one app keeps the other's last build.
  Remove-Item -Recurse -Force "build\$($app.Dir)", "dist\$($app.Dir)" -ErrorAction SilentlyContinue
  & $py -m PyInstaller --noconfirm --clean $app.Spec
  if ($LASTEXITCODE -ne 0) { throw "PyInstaller ($($app.Name)) failed" }
  $exe = Join-Path $Root "dist\$($app.Dir)\$($app.Dir).exe"
  & $exe --version
  if ($LASTEXITCODE -ne 0) { throw "built $($app.Name) executable does not start" }
  Write-Host "Built: $exe"
}

if ($Installer) {
  $iscc = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $iscc) { throw "Inno Setup 6 (ISCC.exe) not found. Install it: winget install JRSoftware.InnoSetup" }
  foreach ($app in $apps) {
    & $iscc /Q "/DAppVersion=$BuildVersion" $app.Iss
    if ($LASTEXITCODE -ne 0) { throw "ISCC ($($app.Name)) failed" }
    Write-Host "Installer: $(Join-Path $Root "installer\Output\SoftProIt-Network-$($app.Name)-$BuildVersion-setup.exe")"
  }
}
