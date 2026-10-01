#!/usr/bin/env bash
# Build the macOS applications with PyInstaller and, optionally, their .dmg installers:
#   - service: SoftProIt.network.conducted (launchd daemon) -> SoftProIt-Network-Service-<ver>.dmg
#              (the DMG holds a .pkg: installs the daemon as root, asks for server URL + token)
#   - admin:   SoftProIt.network.admin.app (desktop wrapper) -> SoftProIt-Network-Admin-<ver>.dmg
#              (drag-to-Applications; embeds ADMIN_SERVER from os-apps/.env, no secrets)
#
# Usage: scripts/build.sh [--target all|admin|service] [--dmg] [--version 1.2.3] [--skip-tests]
#   version: --version, else $BUILD_VERSION, else BUILD_VERSION in os-apps/.env, else 1.0.0
#   SKIP_TESTS=1 is honoured as before.
#
# PyInstaller does NOT cross-compile: run this ON macOS (scripts\build.ps1 builds the Windows
# .exe). The DMGs are unsigned; codesign / notarize per installer/README-macos.md before
# distributing outside your organization.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

TARGET=all
MAKE_DMG=0
VERSION=""
SKIP_TESTS="${SKIP_TESTS:-0}"
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --dmg) MAKE_DMG=1; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
case "$TARGET" in all|admin|service) ;; *) echo "--target must be all, admin or service" >&2; exit 2 ;; esac
if [ "$(uname -s)" != "Darwin" ]; then
  echo "This builds the macOS apps and must run on macOS (use scripts\\build.ps1 on Windows)." >&2
  exit 1
fi

# Last KEY=value in os-apps/.env, quotes stripped ('' when absent).
env_value() {
  [ -f "$ROOT/.env" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$ROOT/.env" | tail -n 1 | tr -d "\r\"'"
}
VERSION="${VERSION:-${BUILD_VERSION:-$(env_value BUILD_VERSION)}}"
VERSION="${VERSION:-1.0.0}"
if ! [[ "$VERSION" =~ ^[0-9]+(\.[0-9]+){1,3}$ ]]; then
  echo "BUILD_VERSION '$VERSION' must look like 1.0.0" >&2
  exit 2
fi
want() { [ "$TARGET" = all ] || [ "$TARGET" = "$1" ]; }
echo "Building $TARGET version $VERSION"

if [ ! -d .venv ]; then
  echo "Creating virtual environment..."
  python3 -m venv .venv
fi
PY="$ROOT/.venv/bin/python"
"$PY" -m pip install --upgrade pip
"$PY" -m pip install -r requirements-dev.txt

if [ "$SKIP_TESTS" != "1" ]; then
  "$PY" -m pytest -q -p no:cacheprovider --basetemp "$ROOT/build/pytest"
fi

OUT="$ROOT/installer/Output"
mkdir -p "$OUT"

if want service; then
  rm -rf build/SoftProIt.network.conducted dist/SoftProIt.network.conducted
  "$PY" -m PyInstaller --noconfirm --clean "SoftProIt.network.conducted.spec"
  SVC="$ROOT/dist/SoftProIt.network.conducted/SoftProIt.network.conducted"
  "$SVC" --version
  echo "Built: $SVC"
fi

if want admin; then
  rm -rf build/SoftProIt.network.admin dist/SoftProIt.network.admin dist/SoftProIt.network.admin.app
  "$PY" -m PyInstaller --noconfirm --clean "SoftProIt.network.admin.spec"
  "$ROOT/dist/SoftProIt.network.admin/SoftProIt.network.admin" --version
  echo "Built: $ROOT/dist/SoftProIt.network.admin.app"
fi

[ "$MAKE_DMG" = 1 ] || exit 0

if want admin; then
  STAGE="$ROOT/build/dmg-admin"
  APP="$STAGE/SoftProIt Network Admin.app"
  rm -rf "$STAGE" && mkdir -p "$STAGE"
  cp -R "$ROOT/dist/SoftProIt.network.admin.app" "$APP"
  /usr/bin/plutil -replace CFBundleShortVersionString -string "$VERSION" "$APP/Contents/Info.plist"
  /usr/bin/plutil -replace CFBundleVersion -string "$VERSION" "$APP/Contents/Info.plist"
  # The app reads admin.env next to its executable: a dragged-in app cannot be configured by an
  # installer, and the service's agent.env is root-only. Server URL only — never the token.
  SERVER="${ADMIN_SERVER:-$(env_value ADMIN_SERVER)}"
  if [ -n "$SERVER" ]; then
    printf '# Embedded at build time. Server URL only; no secrets.\nADMIN_SERVER="%s"\n' "$SERVER" > "$APP/Contents/MacOS/admin.env"
    echo "Embedded ADMIN_SERVER=$SERVER"
  else
    echo "WARNING: ADMIN_SERVER is not set in os-apps/.env; the app will start unconfigured." >&2
  fi
  ln -s /Applications "$STAGE/Applications"
  DMG="$OUT/SoftProIt-Network-Admin-$VERSION.dmg"
  rm -f "$DMG"
  hdiutil create -volname "SoftProIt Network Admin $VERSION" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
  echo "DMG: $DMG"
fi

if want service; then
  STAGE="$ROOT/build/pkg-service"
  PAYLOAD="$STAGE/root/usr/local/softproit/SoftProIt.network.conducted"
  rm -rf "$STAGE" && mkdir -p "$PAYLOAD" "$STAGE/scripts" "$STAGE/dmg"
  cp -R "$ROOT/dist/SoftProIt.network.conducted/." "$PAYLOAD/"
  cp "$ROOT/installer/macos/preinstall" "$ROOT/installer/macos/postinstall" "$STAGE/scripts/"
  chmod 755 "$STAGE/scripts/preinstall" "$STAGE/scripts/postinstall"
  # Pre-fill for the install-time dialog (server URL only; the token is always asked for).
  printf 'DEFAULT_SERVER=%q\n' "${ADMIN_SERVER:-$(env_value ADMIN_SERVER)}" > "$STAGE/scripts/defaults.env"
  PKG="$STAGE/dmg/Install SoftProIt Network Service.pkg"
  pkgbuild --root "$STAGE/root" --scripts "$STAGE/scripts" \
    --identifier com.softproit.network.conducted --version "$VERSION" \
    --install-location / "$PKG" >/dev/null
  cp "$ROOT/installer/macos/README-service.txt" "$STAGE/dmg/README.txt"
  DMG="$OUT/SoftProIt-Network-Service-$VERSION.dmg"
  rm -f "$DMG"
  hdiutil create -volname "SoftProIt Network Service $VERSION" -srcfolder "$STAGE/dmg" -ov -format UDZO "$DMG" >/dev/null
  echo "DMG: $DMG"
fi
