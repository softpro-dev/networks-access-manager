#!/usr/bin/env bash
# Cross-platform unit tests (macOS/Linux dev hosts). Windows: scripts\build.ps1 runs them too.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q -r requirements-dev.txt
.venv/bin/python -m pytest "$@"
