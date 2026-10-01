@echo off
rem Double-click to build SoftProIt-Network-Service-<BUILD_VERSION>-setup.exe (Windows x64).
rem Version: BUILD_VERSION in os-apps\.env (default 1.0.0). Output: os-apps\installer\Output\
rem Needs 64-bit Python 3.11+ and Inno Setup 6 (winget install JRSoftware.InnoSetup).
setlocal
title Build SoftProIt Network Service setup
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\os-apps\scripts\build.ps1" -Target Service -Installer %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (echo Done: os-apps\installer\Output\SoftProIt-Network-Service-*-setup.exe) else (echo Build FAILED with exit code %RC%.)
pause
exit /b %RC%
