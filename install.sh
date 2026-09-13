#!/usr/bin/env bash
# One-shot installer for AI Video Editor (Linux, WSL2, macOS).
#
#   git clone https://github.com/web-dev-nav/ai-video-editor.git
#   cd ai-video-editor && ./install.sh
#
# What it does (idempotent — safe to re-run):
#   1. installs `uv` (fast Python package manager) if missing
#   2. provisions Python 3.12 and creates .venv
#   3. installs PyTorch — CPU wheel by default (~200 MB), CUDA wheel only if an
#      NVIDIA GPU is detected (or FORCE_TORCH=cuda|cpu is set)
#   4. installs the app + GUI dependencies with the pins this fork needs
#   5. checks ffmpeg and tells you how to install it if missing
#   6. creates .env from .env.example
set -euo pipefail

cd "$(dirname "$0")"
PY_VERSION="${PY_VERSION:-3.12}"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m ✗\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 1. uv
if ! command -v uv >/dev/null 2>&1; then
  say "Installing uv (Python package manager)…"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
  command -v uv >/dev/null 2>&1 || die "uv installed but not on PATH — open a new shell and re-run ./install.sh"
fi
ok "uv $(uv --version | awk '{print $2}')"

# ---------------------------------------------------------------- 2. venv
if [ ! -x .venv/bin/python ]; then
  say "Creating .venv with Python $PY_VERSION…"
  uv venv --python "$PY_VERSION" .venv
else
  ok ".venv exists ($(.venv/bin/python --version 2>&1))"
fi
PY=".venv/bin/python"

# ---------------------------------------------------------------- 3. torch
TORCH_FLAVOR="${FORCE_TORCH:-}"
if [ -z "$TORCH_FLAVOR" ]; then
  if [[ "$(uname -s)" == "Darwin" ]]; then
    TORCH_FLAVOR="default"           # macOS wheels are CPU/MPS already
  elif command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
    TORCH_FLAVOR="cuda"
  else
    TORCH_FLAVOR="cpu"
  fi
fi
case "$TORCH_FLAVOR" in
  cpu)     say "Installing PyTorch (CPU wheel — no GPU detected)…"
           uv pip install --python "$PY" --index-url https://download.pytorch.org/whl/cpu "torch>=2.1" "torchaudio>=2.1" ;;
  cuda)    say "Installing PyTorch (CUDA wheel — NVIDIA GPU detected)…"
           uv pip install --python "$PY" "torch>=2.1" "torchaudio>=2.1" ;;
  default) say "Installing PyTorch…"
           uv pip install --python "$PY" "torch>=2.1" "torchaudio>=2.1" ;;
  *)       die "FORCE_TORCH must be cpu or cuda" ;;
esac
ok "torch $($PY -c 'import torch;print(torch.__version__)')"

# ---------------------------------------------------------------- 4. app
say "Installing ai-video-editor + GUI dependencies…"
uv pip install --python "$PY" -e ".[gui]"
$PY - <<'EOF'
import importlib, sys
missing = []
for m in ("faster_whisper", "torchaudio", "mcp.server.fastmcp", "anthropic", "openai", "starlette", "uvicorn", "yaml", "typer"):
    try:
        importlib.import_module(m)
    except Exception as e:  # noqa: BLE001
        missing.append(f"{m}: {e}")
if missing:
    print("\n".join(missing)); sys.exit(1)
EOF
ok "python packages import cleanly"

# ---------------------------------------------------------------- 5. ffmpeg
if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
  ok "ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')"
else
  warn "ffmpeg/ffprobe not found — the app cannot run without it. Install it with:"
  if [[ "$(uname -s)" == "Darwin" ]]; then echo "      brew install ffmpeg"
  elif command -v apt-get >/dev/null 2>&1; then echo "      sudo apt-get update && sudo apt-get install -y ffmpeg"
  elif command -v dnf >/dev/null 2>&1; then echo "      sudo dnf install -y ffmpeg"
  elif command -v pacman >/dev/null 2>&1; then echo "      sudo pacman -S ffmpeg"
  else echo "      (use your distribution's package manager)"; fi
  FFMPEG_MISSING=1
fi

# ---------------------------------------------------------------- 6. .env
if [ ! -f .env ]; then
  cp .env.example .env
  ok "created .env (add your API keys there, or via the GUI's 'API keys' button)"
else
  ok ".env exists"
fi
mkdir -p uploads
chmod +x gui/run.sh 2>/dev/null || true

# ---------------------------------------------------------------- done
echo
say "Install complete."
echo "   Start the GUI:   ./gui/run.sh          (opens http://localhost:8765)"
echo "   Use the CLI:     source .venv/bin/activate && ai-video-editor --help"
[ -n "${FFMPEG_MISSING:-}" ] && warn "Remember to install ffmpeg first (see above)."
exit 0
