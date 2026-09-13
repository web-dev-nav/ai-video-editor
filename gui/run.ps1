# Start the AI Video Editor GUI on native Windows.
#   .\gui\run.ps1              start + open browser
#   .\gui\run.ps1 --no-browser start only
Set-Location (Join-Path $PSScriptRoot "..")
if (-not (Test-Path ".venv\Scripts\python.exe")) {
    Write-Host "No .venv found - running install.ps1 first..."
    powershell -ExecutionPolicy Bypass -File install.ps1
}
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { Write-Host "ffmpeg is not installed (see README)"; exit 1 }
& .venv\Scripts\python.exe gui\server.py @args
