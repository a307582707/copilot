param(
  [string]$OutDir = "",
  [switch]$Zip = $true
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

Write-Host 'Building web frontend (vite build)...'
npm run build

$dist = Join-Path (Get-Location) 'dist'
if (-not (Test-Path $dist)) {
  Write-Error "frontend/dist not found after build."
  exit 1
}

if (-not $OutDir) {
  $OutDir = Join-Path $root 'dist-web'
}

if (-not (Test-Path $OutDir)) {
  New-Item -ItemType Directory -Path $OutDir | Out-Null
}

$target = Join-Path $OutDir 'web'
if (Test-Path $target) {
  Remove-Item -Recurse -Force $target
}

Write-Host ("Copying dist -> " + $target)
Copy-Item -Recurse -Force $dist $target

if ($Zip) {
  $zipPath = Join-Path $OutDir 'cursor-like-web.zip'
  if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
  Write-Host ("Creating zip: " + $zipPath)
  Compress-Archive -Path (Join-Path $target '*') -DestinationPath $zipPath -Force
}

Write-Host ""
Write-Host "OK"
Write-Host ("Web dist dir: " + $target)
if ($Zip) { Write-Host ("Web zip:     " + (Join-Path $OutDir 'cursor-like-web.zip')) }










