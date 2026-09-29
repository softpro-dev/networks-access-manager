#!/usr/bin/env bash
# Build BOTH macOS applications with PyInstaller:
#   - SoftProIt.network.conducted   (the background service / launchd daemon)
#   - SoftProIt.network.admin(.app) (the desktop admin-console wrapper, WebKit)
#
# PyInstaller does NOT cross-compile: run this ON macOS to produce the macOS build,
# and scripts\build.ps1 ON Windows x64 to produce the .exe build. Signing and
# notarizing (codesign / notarytool) and the .pkg (see installer/README-macos.md)
# are done on macOS as separate, credentialed steps.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

SKIP_TESTS="${SKIP_TESTS:-0}"

if [ ! -d .venv ]; then
  echo "Creating virtual environment..."
  python3 -m venv .venv
fi
PY="$ROOT/.venv/bin/python"
"$PY" -m pip install --upgrade pip
"$PY" -m pip install -r requirements-dev.txt

if [ "$SKIP_TESTS" != "1" ]; then
  "$PY" -m pytest -q
fi

rm -rf build dist

"$PY" -m PyInstaller --noconfirm --clean "SoftProIt.network.conducted.spec"
"$PY" -m PyInstaller --noconfirm --clean "SoftProIt.network.admin.spec"

SVC="$ROOT/dist/SoftProIt.network.conducted/SoftProIt.network.conducted"
"$SVC" --version
echo "Built: $SVC"
echo "Built: $ROOT/dist/SoftProIt.network.admin.app (and ./dist/SoftProIt.network.admin/)"
echo
echo "Next (macOS, credentialed): codesign + notarize, then build the .pkg per installer/README-macos.md."
