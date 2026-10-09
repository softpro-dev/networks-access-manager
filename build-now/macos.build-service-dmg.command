#!/bin/bash
# Double-click on macOS (Finder opens it in Terminal) to build the SoftProIt Network Service DMG
# and copy it to your Downloads folder.
# You choose the settings from a searchable list of os-apps/__all.env.for.build/*.env
# (type to search, Up/Down, Enter). The DMG is named after the chosen file:
#   <env name>-SoftProIt-Network-Service-<BUILD_VERSION>.dmg   (in os-apps/installer/Output/)
# Needs macOS with Python 3.11+ (python3) and the Xcode command line tools.
# Extra arguments are passed to os-apps/scripts/build.sh (e.g. --skip-tests).
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"

finish() {
  echo
  read -r -p "Press Enter to close..." _
  exit "$1"
}

if ! bash "$ROOT/os-apps/scripts/build.sh" --target service --dmg --select-env "$@"; then
  echo
  echo "Build FAILED or cancelled."
  finish 1
fi

LIST="$ROOT/os-apps/build/last-installers.txt"
if [ ! -s "$LIST" ]; then
  echo "Built, but no DMG was recorded. Look in os-apps/installer/Output/."
  finish 1
fi
mkdir -p "$HOME/Downloads"
RC=0
while IFS= read -r DMG; do
  [ -n "$DMG" ] || continue
  if cp -f "$DMG" "$HOME/Downloads/"; then
    echo "Copied to $HOME/Downloads/$(basename "$DMG")"
  else
    echo "Copying $(basename "$DMG") to Downloads FAILED. Find it in os-apps/installer/Output/"
    RC=1
  fi
done < "$LIST"
[ "$RC" = 0 ] && echo "Done."
finish "$RC"
