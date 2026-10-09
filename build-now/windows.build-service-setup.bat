@echo off
rem Double-click to build the SoftProIt Network Service installer (Windows x64) and copy it to Downloads.
rem You choose the settings from a searchable list of os-apps\__all.env.for.build\*.env
rem (type to search, Up/Down, Enter). The installer is named after the chosen file:
rem   <env name>-SoftProIt-Network-Service-<BUILD_VERSION>-setup.exe   (in os-apps\installer\Output\)
rem Needs 64-bit Python 3.11+ and Inno Setup 6 (winget install JRSoftware.InnoSetup).
setlocal
title Build SoftProIt Network Service setup
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\os-apps\scripts\build.ps1" -Target Service -Installer -SelectEnv %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo Build FAILED or cancelled ^(exit code %RC%^).
  pause
  exit /b %RC%
)

rem Copy exactly the installer(s) this build produced (listed by build.ps1) to the Downloads known folder.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $dl=(New-Object -ComObject Shell.Application).Namespace('shell:Downloads').Self.Path; $list=Join-Path '%~dp0..\os-apps\build' 'last-installers.txt'; $files=@(Get-Content -LiteralPath $list | Where-Object { $_ -and (Test-Path -LiteralPath $_) }); if (-not $files) { throw 'installer not found' }; foreach ($f in $files) { Copy-Item -LiteralPath $f -Destination $dl -Force; Write-Host ('Copied to ' + (Join-Path $dl (Split-Path -Leaf $f))) }"
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (echo Done.) else (echo Built, but copying to Downloads FAILED. Find it in os-apps\installer\Output\)
pause
exit /b %RC%
