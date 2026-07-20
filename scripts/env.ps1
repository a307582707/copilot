# Load portable Node.js (repo-local under tools/node) into the current PowerShell session.
# This avoids requiring a global Node install.

$repoRoot = Split-Path -Parent $PSScriptRoot
$nodeRoot = Join-Path $repoRoot 'tools\node'

$nodeDir = Get-ChildItem -Path $nodeRoot -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like 'node-v*-win-x64' } |
  Sort-Object Name -Descending |
  Select-Object -First 1

if (-not $nodeDir) {
  Write-Error "Portable Node not found: $nodeRoot\\node-v*-win-x64. Please install Node first."
  exit 1
}

$env:Path = "$($nodeDir.FullName);" + $env:Path

node --version | Out-Host
npm --version | Out-Host
