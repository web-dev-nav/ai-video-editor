#!/usr/bin/env bash
# Start the AI Video Editor GUI (Linux / WSL2 / macOS) and open it in your browser.
#   ./gui/run.sh              start + open browser
#   ./gui/run.sh --no-browser start only
# Runs ./install.sh first if the virtualenv is missing.
set -e
cd "$(dirname "$0")/.."
if [ ! -x .venv/bin/python ]; then
  echo "No .venv found — running ./install.sh first…"
  ./install.sh
fi
command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg is not installed (see README → Requirements)"; exit 1; }
exec .venv/bin/python gui/server.py "$@"
