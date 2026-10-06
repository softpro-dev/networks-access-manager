@echo off
rem Double-click to build SoftProIt-Network-Admin-<BUILD_VERSION>-setup.exe (Windows x64)
rem and copy it to your Downloads folder.
rem Version: BUILD_VERSION in os-apps\.env (default 1.0.0). Output: os-apps\installer\Output\
rem Needs 64-bit Python 3.11+ and Inno Setup 6 (winget install JRSoftware.InnoSetup).
setlocal
title Build SoftProIt Network Admin setup
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\os-apps\scripts\build.ps1" -Target Admin -Installer %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo Build FAILED with exit code %RC%.
  pause
  exit /b %RC%
)

rem Copy the newest installer to the Downloads known folder (works if Downloads was moved).
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $dl=(New-Object -ComObject Shell.Application).Namespace('shell:Downloads').Self.Path; $f=Get-ChildItem -LiteralPath '%~dp0..\os-apps\installer\Output' -Filter 'SoftProIt-Network-Admin-*-setup.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if (-not $f) { throw 'installer not found' }; Copy-Item -LiteralPath $f.FullName -Destination $dl -Force; Write-Host ('Copied to ' + (Join-Path $dl $f.Name))"
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (echo Done.) else (echo Built, but copying to Downloads FAILED. Find it in os-apps\installer\Output\)
pause
exit /b %RC%
