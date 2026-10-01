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
  [string]$Python = ""   # override the base interpreter, e.g. "py -3.12" or C:\Python312\python.exe
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not [Environment]::Is64BitOperatingSystem) { throw "A 64-bit Windows host is required." }

# KEY from the environment, else the last KEY= in os-apps\.env (quotes stripped), else ''.
function Get-EnvValue([string]$Key) {
  $fromEnv = [Environment]::GetEnvironmentVariable($Key)
  if ($fromEnv) { return $fromEnv.Trim() }
  $envFile = Join-Path $Root ".env"
  if (Test-Path $envFile) {
    $line = Get-Content $envFile | Where-Object { $_ -match "^\s*$Key\s*=" } | Select-Object -Last 1
    if ($line) { return ($line -replace "^\s*$Key\s*=\s*", '').Trim().Trim('"', "'") }
  }
  return ""
}

$BuildVersion = if ($Version) { $Version } else { Get-EnvValue "BUILD_VERSION" }
if (-not $BuildVersion) { $BuildVersion = "1.0.0" }
# Inno Setup compares versions numerically for upgrades: keep it to 2-4 dotted numbers.
if ($BuildVersion -notmatch '^\d+(\.\d+){1,3}$') { throw "BUILD_VERSION '$BuildVersion' must look like 1.0.0" }

# Installer settings baked in from os-apps\.env so setup asks nothing. Checked before the slow build.
# Quotes are refused because the values are embedded in Inno Setup string literals.
$CfgServer = Get-EnvValue "ADMIN_SERVER"
$CfgToken = Get-EnvValue "ACCESS_TOKE"
$CfgCache = Get-EnvValue "CACHE_EXPIRATION_TIME_IN_MINUTE"
if (-not $CfgCache) { $CfgCache = "5" }
$CfgCode = Get-EnvValue "CODE_NUMBER"   # display only: identifies the build on the setup screen
if ($Installer) {
  if ($CfgCode -match '["'']' -or $CfgCode.Length -gt 64) { throw "CODE_NUMBER in os-apps\.env must be at most 64 characters, without quotes" }
  if ($CfgServer -notmatch '^https?://[^\s"'']+$') { throw "ADMIN_SERVER in os-apps\.env must be an http(s):// URL (got '$CfgServer')" }
  if ($Target -ne "Admin") {
    if ($CfgToken -notmatch '^nat_[^\s"'']+$' -or $CfgToken.Length -gt 512) {
      throw "ACCESS_TOKE in os-apps\.env must be the organization access token (nat_...). Admin console: Organizations > Generate token."
    }
    if ($CfgCache -notmatch '^\d+$' -or [int]$CfgCache -lt 1 -or [int]$CfgCache -gt 1440) {
      throw "CACHE_EXPIRATION_TIME_IN_MINUTE in os-apps\.env must be 1-1440 (got '$CfgCache')"
    }
  }
}

$apps = @(
  @{ Name = "Service"; Dir = "SoftProIt.network.conducted"; Spec = "SoftProIt.network.conducted.spec"; Iss = "installer\SoftProIt.Network.Service.iss" },
  @{ Name = "Admin"; Dir = "SoftProIt.network.admin"; Spec = "SoftProIt.network.admin.spec"; Iss = "installer\SoftProIt.Network.Admin.iss" }
) | Where-Object { $Target -eq "All" -or $_.Name -eq $Target }
Write-Host "Building $($apps.Name -join ' + ') version $BuildVersion"

# True when the command (exe + leading args) runs as 64-bit Python 3.11+.
function Test-Python([string[]]$Cmd) {
  if (-not $Cmd -or -not $Cmd[0]) { return $false }
  $exe = $Cmd[0]
  $pre = @($Cmd | Select-Object -Skip 1)
  if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { return $false }
  try {
    & $exe @pre -c "import struct,sys; sys.exit(0 if sys.version_info >= (3, 11) and struct.calcsize('P') == 8 else 1)" 2>$null | Out-Null
    return $LASTEXITCODE -eq 0
  } catch { return $false }
}

# A 64-bit Python 3.11+ to create the venv with: -Python, else the py launcher, else python on PATH.
function Find-BasePython {
  $candidates = @()
  if ($Python) { $candidates += , ($Python -split '\s+' | Where-Object { $_ }) }
  $candidates += , @("py", "-3.13"); $candidates += , @("py", "-3.12"); $candidates += , @("py", "-3.11"); $candidates += , @("py", "-3")
  $candidates += , @("python"); $candidates += , @("python3")
  $candidates += , @("$env:LOCALAPPDATA\Programs\Python\Python313\python.exe")
  $candidates += , @("$env:LOCALAPPDATA\Programs\Python\Python312\python.exe")
  $candidates += , @("$env:LOCALAPPDATA\Programs\Python\Python311\python.exe")
  foreach ($c in $candidates) { if (Test-Python $c) { return , $c } }
  return $null
}

$venv = Join-Path $Root ".venv"
$py = Join-Path $venv "Scripts\python.exe"
if (-not (Test-Python @($py))) {
  # Missing, broken, or created on another OS (a macOS venv has bin/, not Scripts\).
  $base = Find-BasePython
  if (-not $base) { throw "64-bit Python 3.11+ not found. Install it (winget install Python.Python.3.12) or pass -Python <path>." }
  if (Test-Path $venv) { Write-Host "Recreating .venv (no usable Python 3.11+ inside)..."; Remove-Item -Recurse -Force $venv }
  else { Write-Host "Creating .venv..." }
  $baseExe = $base[0]
  $baseArgs = @($base | Select-Object -Skip 1)
  & $baseExe @baseArgs -m venv $venv
  if ($LASTEXITCODE -ne 0 -or -not (Test-Python @($py))) { throw "creating .venv failed" }
}
& $py -c "import sys; print('Using', sys.executable, sys.version.split()[0])"

& $py -m pip install --upgrade pip
& $py -m pip install -r requirements-dev.txt
if ($LASTEXITCODE -ne 0) { throw "dependency install failed" }

if (-not $SkipTests) {
  # A private temp dir: the shared %TEMP%\pytest-of-<user> can hold folders owned by an
  # elevated run, which makes pytest fail with "Access is denied".
  # A fresh folder per run: some security tests lock down the permissions of their temp dirs, so a
  # fixed folder could not be cleaned up by the next run.
  $pytestTmp = Join-Path $Root ("build\pytest-" + (Get-Date -Format "yyyyMMddHHmmss"))
  & $py -m pytest -p no:cacheprovider --basetemp $pytestTmp
  if ($LASTEXITCODE -ne 0) { throw "tests failed" }
  Remove-Item -Recurse -Force $pytestTmp -ErrorAction SilentlyContinue
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
  # Generated includes (build\ is git-ignored); the admin one never contains the token.
  New-Item -ItemType Directory -Force (Join-Path $Root "build") | Out-Null
  $adminCfg = Join-Path $Root "build\installer-config-admin.iss"
  $serviceCfg = Join-Path $Root "build\installer-config-service.iss"
  try {
    $shared = @(
      "#define CfgServer `"$CfgServer`"",
      "#define CfgCache `"$CfgCache`"",
      "#define CfgCode `"$CfgCode`""
    )
    Set-Content -Encoding UTF8 $adminCfg $shared
    Set-Content -Encoding UTF8 $serviceCfg ($shared + "#define CfgToken `"$CfgToken`"")
    foreach ($app in $apps) {
      & $iscc /Q "/DAppVersion=$BuildVersion" $app.Iss
      if ($LASTEXITCODE -ne 0) { throw "ISCC ($($app.Name)) failed" }
      Write-Host "Installer: $(Join-Path $Root "installer\Output\SoftProIt-Network-$($app.Name)-$BuildVersion-setup.exe")"
    }
  } finally {
    Remove-Item -Force $adminCfg, $serviceCfg -ErrorAction SilentlyContinue  # holds the token
  }
  Write-Host "Baked in: ADMIN_SERVER=$CfgServer, CACHE_EXPIRATION_TIME_IN_MINUTE=$CfgCache, CODE_NUMBER=$CfgCode$(if ($Target -ne 'Admin') { ', ACCESS_TOKE=nat_...' })"
}
