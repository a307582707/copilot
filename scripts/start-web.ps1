param(
  [int]$Port = 8030,
  [string]$BindHost = '127.0.0.1',
  [switch]$Build = $false
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if ($Build) {
  & (Join-Path $PSScriptRoot 'build-web.ps1') | Out-Host
}

# Enable "single-process web mode" (FastAPI serves frontend/dist)
$env:SERVE_FRONTEND = '1'

Write-Host ("Starting web mode on http://" + $BindHost + ":" + $Port + " ...")
Write-Host ("- UI:  http://" + $BindHost + ":" + $Port + "/")
Write-Host ("- API: http://" + $BindHost + ":" + $Port + "/api/health")

& (Join-Path $PSScriptRoot 'start-backend.ps1') -Port $Port -BindHost $BindHost










