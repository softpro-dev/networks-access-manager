<#
.SYNOPSIS
  Build the Windows executables (PyInstaller onedir) and, optionally, their Inno Setup
  installers:
    - Service: SoftProIt.network.conducted.exe -> SoftProIt-Network-Service-<ver>-setup.exe
    - Admin:   SoftProIt.network.admin.exe     -> SoftProIt-Network-Admin-<ver>-setup.exe
.PARAMETER Target
  Service, Admin or All (default).
.PARAMETER Version
  Installer version. Default: BUILD_VERSION in the env file, else 1.0.0.
.PARAMETER SelectEnv
  Show a searchable list of os-apps\__all.env.for.build\*.env and build with the chosen one.
  Installers are then named <env name>-SoftProIt-Network-<App>-<ver>-setup.exe.
.PARAMETER EnvFile
  Build with this env file (a path, or a file name inside os-apps\__all.env.for.build; same naming
  as -SelectEnv). Default: os-apps\.env, installers without a prefix.
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
  [string]$Python = "",   # override the base interpreter, e.g. "py -3.12" or C:\Python312\python.exe
  [switch]$SelectEnv,
  [string]$EnvFile = ""
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not [Environment]::Is64BitOperatingSystem) { throw "A 64-bit Windows host is required." }

# Last KEY= in an env file (quotes stripped), or ''.
function Read-EnvKey([string]$Path, [string]$Key) {
  if (-not (Test-Path -LiteralPath $Path)) { return "" }
  $line = Get-Content -LiteralPath $Path | Where-Object { $_ -match "^\s*$Key\s*=" } | Select-Object -Last 1
  if ($line) { return ($line -replace "^\s*$Key\s*=\s*", '').Trim().Trim('"', "'") }
  return ""
}

# Searchable picker over os-apps\__all.env.for.build\*.env: type to filter, Up/Down, Enter, Esc.
# Shows the server and version of each file, never the token. Returns the chosen FileInfo.
function Select-BuildEnv {
  $dir = Join-Path $Root "__all.env.for.build"
  $files = @(Get-ChildItem -LiteralPath $dir -Filter "*.env" -File -ErrorAction SilentlyContinue | Sort-Object Name)
  if (-not $files) { throw "No env files found in $dir (add e.g. CUSTOMER-001.env with ADMIN_SERVER, ACCESS_TOKE, ...)." }
  $items = foreach ($f in $files) {
    [pscustomobject]@{ File = $f; Name = $f.BaseName; Server = (Read-EnvKey $f.FullName "ADMIN_SERVER"); Version = (Read-EnvKey $f.FullName "BUILD_VERSION") }
  }
  if ([Console]::IsInputRedirected) {
    # No interactive console (e.g. piped): numbered prompt instead.
    for ($i = 0; $i -lt $items.Count; $i++) { Write-Host ("  {0,2}) {1,-28} {2}" -f ($i + 1), $items[$i].Name, $items[$i].Server) }
    $n = [int](Read-Host "Number of the env file to build with")
    if ($n -lt 1 -or $n -gt $items.Count) { throw "No env file selected." }
    return $items[$n - 1].File
  }
  $filter = ""; $sel = 0
  while ($true) {
    $shown = @($items | Where-Object { "$($_.Name) $($_.Server)".IndexOf($filter, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
    if ($sel -ge $shown.Count) { $sel = [Math]::Max(0, $shown.Count - 1) }
    if ($sel -lt 0) { $sel = 0 }
    Clear-Host
    Write-Host "Build $Target - choose the settings (os-apps\__all.env.for.build)" -ForegroundColor Cyan
    Write-Host "Type to search   Up/Down to move   Enter to build   Esc to cancel" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  Search: " -NoNewline; Write-Host "$filter" -NoNewline -ForegroundColor Yellow; Write-Host "_"
    Write-Host ""
    if (-not $shown) { Write-Host "  (no env file matches '$filter')" -ForegroundColor DarkYellow }
    for ($i = 0; $i -lt $shown.Count; $i++) {
      $row = " {0,-28} {1,-42} {2}" -f $shown[$i].Name, $shown[$i].Server, $(if ($shown[$i].Version) { "v$($shown[$i].Version)" } else { "" })
      if ($i -eq $sel) { Write-Host ">$row" -ForegroundColor Black -BackgroundColor Cyan } else { Write-Host " $row" }
    }
    Write-Host ""
    Write-Host "  $($shown.Count) of $($items.Count) env files" -ForegroundColor DarkGray
    $k = [Console]::ReadKey($true)
    switch ($k.Key) {
      "UpArrow" { $sel--; continue }
      "DownArrow" { $sel++; continue }
      "PageUp" { $sel = 0; continue }
      "PageDown" { $sel = $shown.Count - 1; continue }
      "Enter" { if ($shown) { Clear-Host; return $shown[$sel].File }; continue }
      "Escape" { Clear-Host; throw "Build cancelled (no env file selected)." }
      "Backspace" { if ($filter) { $filter = $filter.Substring(0, $filter.Length - 1) }; $sel = 0; continue }
      default { if ($k.KeyChar -and -not [char]::IsControl($k.KeyChar)) { $filter += $k.KeyChar; $sel = 0 } }
    }
  }
}

# Which env file this build uses. A chosen file (-SelectEnv / -EnvFile) is used as is; only the
# default os-apps\.env can still be overridden by environment variables (older behaviour).
$ExplicitEnv = $false
if ($SelectEnv) { $EnvPath = (Select-BuildEnv).FullName; $ExplicitEnv = $true }
elseif ($EnvFile) {
  $EnvPath = (Resolve-Path -LiteralPath $EnvFile -ErrorAction SilentlyContinue).Path
  if (-not $EnvPath) { $EnvPath = (Resolve-Path -LiteralPath (Join-Path $Root "__all.env.for.build\$EnvFile") -ErrorAction SilentlyContinue).Path }
  if (-not $EnvPath) { throw "Env file not found: $EnvFile" }
  $ExplicitEnv = $true
}
else { $EnvPath = Join-Path $Root ".env" }
$EnvLabel = if ($ExplicitEnv) { Split-Path -Leaf $EnvPath } else { "os-apps\.env" }
# Installer file name prefix: the env file's name (letters, digits, '.', '_', '-' only).
$Prefix = if ($ExplicitEnv) { ([IO.Path]::GetFileNameWithoutExtension($EnvPath) -replace '[^A-Za-z0-9._-]+', '-').Trim('-') } else { "" }
if ($ExplicitEnv) { Write-Host "Using settings from $EnvLabel" -ForegroundColor Cyan }

function Get-EnvValue([string]$Key) {
  if (-not $ExplicitEnv) {
    $fromEnv = [Environment]::GetEnvironmentVariable($Key)
    if ($fromEnv) { return $fromEnv.Trim() }
  }
  return Read-EnvKey $EnvPath $Key
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
$CfgTestPoll = Get-EnvValue "NAM_TEST_POLL_SECONDS"   # testing only: poll every N seconds
if ($CfgTestPoll -and ($CfgTestPoll -notmatch '^\d+$' -or [int]$CfgTestPoll -lt 5 -or [int]$CfgTestPoll -gt 3600)) {
  throw "NAM_TEST_POLL_SECONDS in $EnvLabel must be 5-3600 seconds, or empty (got '$CfgTestPoll')"
}
if ($CfgTestPoll -and $Target -ne "Admin") {
  Write-Warning "TEST BUILD: the service will poll every $CfgTestPoll s (NAM_TEST_POLL_SECONDS). Remove it from $EnvLabel before building for real PCs."
}
if ($Installer) {
  if ($CfgCode -match '["'']' -or $CfgCode.Length -gt 64) { throw "CODE_NUMBER in $EnvLabel must be at most 64 characters, without quotes" }
  if ($CfgServer -notmatch '^https?://[^\s"'']+$') { throw "ADMIN_SERVER in $EnvLabel must be an http(s):// URL (got '$CfgServer')" }
  if ($Target -ne "Admin") {
    if ($CfgToken -notmatch '^nat_[^\s"'']+$' -or $CfgToken.Length -gt 512) {
      throw "ACCESS_TOKE in $EnvLabel must be the organization access token (nat_...). Admin console: Organizations > Generate token."
    }
    if ($CfgCache -notmatch '^\d+$' -or [int]$CfgCache -lt 1 -or [int]$CfgCache -gt 1440) {
      throw "CACHE_EXPIRATION_TIME_IN_MINUTE in $EnvLabel must be 1-1440 (got '$CfgCache')"
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
    Set-Content -Encoding UTF8 $serviceCfg ($shared + "#define CfgToken `"$CfgToken`"" + "#define CfgTestPoll `"$CfgTestPoll`"")
    $built = @()
    foreach ($app in $apps) {
      $base = "SoftProIt-Network-$($app.Name)-$BuildVersion-setup"
      if ($Prefix) { $base = "$Prefix-$base" }
      & $iscc /Q "/DAppVersion=$BuildVersion" "/F$base" $app.Iss
      if ($LASTEXITCODE -ne 0) { throw "ISCC ($($app.Name)) failed" }
      $out = Join-Path $Root "installer\Output\$base.exe"
      $built += $out
      Write-Host "Installer: $out"
    }
    # The double-click wrappers copy exactly these files to Downloads.
    Set-Content -Encoding UTF8 (Join-Path $Root "build\last-installers.txt") $built
  } finally {
    Remove-Item -Force $adminCfg, $serviceCfg -ErrorAction SilentlyContinue  # holds the token
  }
  Write-Host "Baked in (from $EnvLabel): ADMIN_SERVER=$CfgServer, CACHE_EXPIRATION_TIME_IN_MINUTE=$CfgCache, CODE_NUMBER=$CfgCode$(if ($Target -ne 'Admin') { ', ACCESS_TOKE=nat_...' })"
}
