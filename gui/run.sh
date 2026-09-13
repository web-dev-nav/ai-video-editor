#!/usr/bin/env bash
# Start the AI Video Editor GUI and open it in your Windows browser.
# Usage: ~/ai-video-editor/gui/run.sh   (Ctrl+C to stop)
set -e
cd "$(dirname "$0")/.."
exec .venv/bin/python gui/server.py "$@"
