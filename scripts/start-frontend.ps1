param(
  [int]$Port = 5173,
  [string]$BindHost = '127.0.0.1'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# Load portable node into PATH (current session)
. (Join-Path $PSScriptRoot 'env.ps1')

Set-Location (Join-Path $root 'frontend')

if (-not (Test-Path .\node_modules)) {
  Write-Host 'node_modules not found, running npm install...'
  npm install
}

Write-Host ("Starting Vite dev server on http://" + ${BindHost} + ":" + $Port + " ...")

npm run dev -- --host $BindHost --port $Port
