# One-shot installer for AI Video Editor on native Windows (PowerShell).
#
#   git clone https://github.com/web-dev-nav/ai-video-editor.git
#   cd ai-video-editor
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# Idempotent. Installs uv, Python 3.12, PyTorch (CPU unless an NVIDIA GPU is
# found), the app + GUI deps, checks ffmpeg, creates .env.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$PyVersion = if ($env:PY_VERSION) { $env:PY_VERSION } else { "3.12" }

function Say($m)  { Write-Host "==> $m" -ForegroundColor Blue }
function Ok($m)   { Write-Host " ✓ $m" -ForegroundColor Green }
function Warn($m) { Write-Host " ! $m" -ForegroundColor Yellow }

# 1. uv
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Say "Installing uv…"
    Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
    $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
}
Ok ("uv " + (uv --version))

# 2. venv
if (-not (Test-Path ".venv\Scripts\python.exe")) {
    Say "Creating .venv with Python $PyVersion…"
    uv venv --python $PyVersion .venv
}
$Py = ".venv\Scripts\python.exe"

# 3. torch
$flavor = $env:FORCE_TORCH
if (-not $flavor) {
    $flavor = if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { "cuda" } else { "cpu" }
}
if ($flavor -eq "cpu") {
    Say "Installing PyTorch (CPU wheel — no GPU detected)…"
    uv pip install --python $Py --index-url https://download.pytorch.org/whl/cpu "torch>=2.1" "torchaudio>=2.1"
} else {
    Say "Installing PyTorch (CUDA wheel)…"
    uv pip install --python $Py "torch>=2.1" "torchaudio>=2.1"
}

# 4. app
Say "Installing ai-video-editor + GUI dependencies…"
uv pip install --python $Py -e ".[gui]"
& $Py -c "import faster_whisper, torchaudio, mcp.server.fastmcp, anthropic, openai, starlette, uvicorn, yaml, typer; print('imports ok')"

# 5. ffmpeg
if (Get-Command ffmpeg -ErrorAction SilentlyContinue) {
    Ok "ffmpeg found"
} else {
    Warn "ffmpeg not found. Install it with:  winget install Gyan.FFmpeg   (then open a new terminal)"
}

# 6. .env
if (-not (Test-Path ".env")) { Copy-Item ".env.example" ".env"; Ok "created .env" }
New-Item -ItemType Directory -Force -Path "uploads" | Out-Null

Say "Install complete."
Write-Host "   Start the GUI:   .\gui\run.ps1      (opens http://localhost:8765)"
Write-Host "   Use the CLI:     .venv\Scripts\ai-video-editor.exe --help"
