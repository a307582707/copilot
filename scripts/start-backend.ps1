param(
  [int]$Port = 8030,
  [string]$BindHost = '127.0.0.1'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root 'backend'

Set-Location $backend

if (-not (Test-Path .\.venv)) {
  python -m venv .venv
}

# IMPORTANT (Windows): console-script exes (e.g. uvicorn.exe) can end up bound to a different python interpreter.
# Always invoke the venv's python explicitly to ensure we run the correct environment.
$venvPy = Join-Path $backend '.venv\Scripts\python.exe'
& $venvPy -m pip install --upgrade pip
& $venvPy -m pip install -r requirements.txt

$env:PORT = "$Port"
& $venvPy -m uvicorn app.main:app --host $BindHost --port $Port


