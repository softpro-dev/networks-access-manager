#!/bin/bash
# Double-click on macOS (Finder opens it in Terminal) to build
# SoftProIt-Network-Admin-<BUILD_VERSION>.dmg and copy it to your Downloads folder.
# Version: BUILD_VERSION in os-apps/.env (default 1.0.0). Output: os-apps/installer/Output/
# Needs macOS with Python 3.11+ (python3) and the Xcode command line tools.
# Extra arguments are passed to os-apps/scripts/build.sh (e.g. --skip-tests).
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"

finish() {
  echo
  read -r -p "Press Enter to close..." _
  exit "$1"
}

if ! bash "$ROOT/os-apps/scripts/build.sh" --target admin --dmg "$@"; then
  echo
  echo "Build FAILED."
  finish 1
fi

DMG=$(ls -t "$ROOT"/os-apps/installer/Output/SoftProIt-Network-Admin-*.dmg 2>/dev/null | head -n 1)
if [ -z "$DMG" ]; then
  echo "Built, but no DMG found in os-apps/installer/Output/."
  finish 1
fi
mkdir -p "$HOME/Downloads"
if cp -f "$DMG" "$HOME/Downloads/"; then
  echo "Copied to $HOME/Downloads/$(basename "$DMG")"
  echo "Done."
  finish 0
fi
echo "Built, but copying to Downloads FAILED. Find it in os-apps/installer/Output/"
finish 1
