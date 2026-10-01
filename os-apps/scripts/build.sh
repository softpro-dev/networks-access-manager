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
set -Eeuo pipefail
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

# Installer settings baked in from os-apps/.env (environment wins) so installing asks nothing.
# Checked before the slow build.
CFG_SERVER="${ADMIN_SERVER:-$(env_value ADMIN_SERVER)}"
CFG_TOKEN="${ACCESS_TOKE:-$(env_value ACCESS_TOKE)}"
CFG_CACHE="${CACHE_EXPIRATION_TIME_IN_MINUTE:-$(env_value CACHE_EXPIRATION_TIME_IN_MINUTE)}"
CFG_CACHE="${CFG_CACHE:-5}"
CFG_CODE="${CODE_NUMBER:-$(env_value CODE_NUMBER)}"   # display only: identifies the build
CFG_TEST_POLL="${NAM_TEST_POLL_SECONDS:-$(env_value NAM_TEST_POLL_SECONDS)}"   # testing only: poll every N s
if [ -n "$CFG_TEST_POLL" ]; then
  if ! [[ "$CFG_TEST_POLL" =~ ^[0-9]+$ ]] || [ "$CFG_TEST_POLL" -lt 5 ] || [ "$CFG_TEST_POLL" -gt 3600 ]; then
    echo "NAM_TEST_POLL_SECONDS in os-apps/.env must be 5-3600 seconds, or empty (got '$CFG_TEST_POLL')" >&2; exit 2
  fi
  echo "WARNING: TEST BUILD - the service will poll every ${CFG_TEST_POLL}s (NAM_TEST_POLL_SECONDS). Remove it before building for real Macs." >&2
fi
# What installers show: the server only by its first 10 characters, never the token.
CFG_SERVER_SHORT="$CFG_SERVER"
[ "${#CFG_SERVER}" -gt 10 ] && CFG_SERVER_SHORT="${CFG_SERVER:0:10}..."
settings_text() { # $1 = heading
  printf '%s\n' "$1"
  printf '  ADMIN_SERVER:                     %s\n' "$CFG_SERVER_SHORT"
  printf '  CACHE_EXPIRATION_TIME_IN_MINUTE:  %s\n' "$CFG_CACHE"
  printf '  CODE_NUMBER:                      %s\n' "${CFG_CODE:-(not set)}"
  printf '  BUILD_VERSION:                    %s\n\n' "$VERSION"
  if [ -n "$CFG_TEST_POLL" ]; then
    printf 'TEST BUILD: checks for restrictions every %s seconds (NAM_TEST_POLL_SECONDS).\nDo not install on production computers.\n\n' "$CFG_TEST_POLL"
  fi
}
if [ "$MAKE_DMG" = 1 ]; then
  if [ "${#CFG_CODE}" -gt 64 ] || [[ "$CFG_CODE" == *[\"\']* ]]; then
    echo "CODE_NUMBER in os-apps/.env must be at most 64 characters, without quotes" >&2; exit 2
  fi
  if ! [[ "$CFG_SERVER" =~ ^https?://[^[:space:]\"\']+$ ]]; then
    echo "ADMIN_SERVER in os-apps/.env must be an http(s):// URL (got '$CFG_SERVER')" >&2; exit 2
  fi
  if want service; then
    if ! [[ "$CFG_TOKEN" =~ ^nat_[^[:space:]\"\']+$ ]] || [ "${#CFG_TOKEN}" -gt 512 ]; then
      echo "ACCESS_TOKE in os-apps/.env must be the organization access token (nat_...). Admin console: Organizations > Generate token." >&2; exit 2
    fi
    if ! [[ "$CFG_CACHE" =~ ^[0-9]+$ ]] || [ "$CFG_CACHE" -lt 1 ] || [ "$CFG_CACHE" -gt 1440 ]; then
      echo "CACHE_EXPIRATION_TIME_IN_MINUTE in os-apps/.env must be 1-1440 (got '$CFG_CACHE')" >&2; exit 2
    fi
  fi
fi
echo "Building $TARGET version $VERSION"

# Finder-launched Terminals may lack Homebrew paths; keep the user's PATH first.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"

# True when $1 runs and is Python 3.11+.
is_py311() { [ -n "$1" ] && "$1" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1; }

# The venv's interpreter for this OS layout (bin/ on macOS/Linux, Scripts/ on Windows), if usable.
venv_python() {
  local p
  for p in "$ROOT/.venv/bin/python3" "$ROOT/.venv/bin/python" "$ROOT/.venv/Scripts/python.exe"; do
    if is_py311 "$p"; then echo "$p"; return 0; fi
  done
  return 1
}

# A Python 3.11+ to create the venv with: $PYTHON, else the newest python3.x on PATH.
base_python() {
  local c
  for c in "${PYTHON:-}" python3.13 python3.12 python3.11 python3 python; do
    [ -n "$c" ] || continue
    c="$(command -v "$c" 2>/dev/null)" || continue
    if is_py311 "$c"; then echo "$c"; return 0; fi
  done
  return 1
}

if ! PY="$(venv_python)"; then
  # Missing, broken (e.g. left behind when .venv stopped being tracked in git) or from another OS.
  BASE="$(base_python)" || {
    echo "Python 3.11+ not found. Install it (e.g. 'brew install python@3.12') or set PYTHON=/path/to/python3." >&2
    exit 1
  }
  if [ -e .venv ]; then echo "Recreating .venv (no usable Python 3.11+ inside)..."; else echo "Creating .venv..."; fi
  rm -rf .venv
  "$BASE" -m venv .venv
  PY="$(venv_python)" || { echo "Created .venv but its interpreter does not run." >&2; exit 1; }
fi
echo "Using $PY ($("$PY" -c 'import sys; print(sys.version.split()[0])'))"
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

# Name the running step so a failure says where it happened (output is never hidden).
STEP=""
step() { STEP="$1"; echo; echo "==> $1"; }
trap '[ -n "$STEP" ] && echo "FAILED during: $STEP" >&2' ERR

# Staged copies must be readable/writable by the builder: PyInstaller keeps source permissions,
# and some Python distributions (e.g. Anaconda) ship read-only files.
stage_copy() { /usr/bin/ditto "$1" "$2" && chmod -R u+rwX,go+rX "$2"; }

# hdiutil into a fresh temp dir first (never over an existing/locked image), then move into place.
make_dmg() { # $1 volume name, $2 source folder, $3 output .dmg
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/softproit-dmg.XXXXXX")"
  /usr/bin/hdiutil create -volname "$1" -srcfolder "$2" -fs HFS+ -format UDZO -ov "$tmp/out.dmg" </dev/null
  rm -f "$3"
  mv "$tmp/out.dmg" "$3"
  rm -rf "$tmp"
  echo "DMG: $3"
}

if want admin; then
  step "Staging admin app"
  STAGE="$ROOT/build/dmg-admin"
  APP="$STAGE/SoftProIt Network Admin.app"
  rm -rf "$STAGE" && mkdir -p "$STAGE"
  stage_copy "$ROOT/dist/SoftProIt.network.admin.app" "$APP"
  /usr/bin/plutil -replace CFBundleShortVersionString -string "$VERSION" "$APP/Contents/Info.plist"
  /usr/bin/plutil -replace CFBundleVersion -string "$VERSION" "$APP/Contents/Info.plist"
  # The app reads admin.env next to its executable: a dragged-in app cannot be configured by an
  # installer, and the service's agent.env is root-only. Server URL only — never the token.
  printf '# Embedded at build time. Server URL only; no secrets.\nADMIN_SERVER="%s"\n' "$CFG_SERVER" > "$APP/Contents/MacOS/admin.env"
  echo "Embedded ADMIN_SERVER=$CFG_SERVER"
  ln -s /Applications "$STAGE/Applications"
  {
    settings_text "SoftProIt Network Admin is set up with:"
    printf 'Install: drag "SoftProIt Network Admin" onto Applications.\n'
    printf 'First start of an unsigned build: Control-click the app > Open > Open.\n'
  } > "$STAGE/README.txt"
  step "Creating admin DMG"
  make_dmg "SoftProIt Network Admin $VERSION" "$STAGE" "$OUT/SoftProIt-Network-Admin-$VERSION.dmg"
fi

if want service; then
  step "Staging service payload"
  STAGE="$ROOT/build/pkg-service"
  PAYLOAD="$STAGE/root/usr/local/softproit/SoftProIt.network.conducted"
  rm -rf "$STAGE" && mkdir -p "$(dirname "$PAYLOAD")" "$STAGE/scripts" "$STAGE/dmg"
  stage_copy "$ROOT/dist/SoftProIt.network.conducted" "$PAYLOAD"
  cp "$ROOT/installer/macos/preinstall" "$ROOT/installer/macos/postinstall" "$STAGE/scripts/"
  chmod 755 "$STAGE/scripts/preinstall" "$STAGE/scripts/postinstall"
  # Baked-in config the postinstall writes to agent.env (no questions at install time).
  # Lives in the .pkg's scripts, readable only by root when the package runs.
  ( umask 077
    printf 'CFG_SERVER=%q\nCFG_TOKEN=%q\nCFG_CACHE=%q\nCFG_TEST_POLL=%q\n' "$CFG_SERVER" "$CFG_TOKEN" "$CFG_CACHE" "$CFG_TEST_POLL" > "$STAGE/scripts/config.env" )
  echo "Baked in: ADMIN_SERVER=$CFG_SERVER, CACHE_EXPIRATION_TIME_IN_MINUTE=$CFG_CACHE, ACCESS_TOKE=nat_..."

  step "Building service .pkg (pkgbuild)"
  PKG="$STAGE/dmg/Install SoftProIt Network Service.pkg"
  /usr/bin/pkgbuild --root "$STAGE/root" --scripts "$STAGE/scripts" \
    --identifier com.softproit.network.conducted --version "$VERSION" \
    --install-location / "$PKG" </dev/null
  # README.txt starts with the identifying settings so you can see what a DMG is for.
  {
    settings_text "This package sets up the Mac with:"
    cat "$ROOT/installer/macos/README-service.txt"
  } > "$STAGE/dmg/README.txt"

  step "Creating service DMG"
  make_dmg "SoftProIt Network Service $VERSION" "$STAGE/dmg" "$OUT/SoftProIt-Network-Service-$VERSION.dmg"
fi
STEP=""
