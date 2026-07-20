param(
  # Default install dir aligns with existing repo convention (E:\tools\*)
  [string]$InstallDir = "E:\\tools\\aliyun-cli",
  [string]$Url = "https://aliyuncli.alicdn.com/aliyun-cli-windows-latest-amd64.zip",
  [switch]$AddToUserPath = $true,
  [switch]$Force = $false
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$msg) {
  Write-Host ("[aliyun-cli] " + $msg)
}

function Ensure-Dir([string]$dir) {
  if (-not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir | Out-Null
  }
}

function Add-ToUserPath([string]$dir) {
  $dirNorm = $dir.TrimEnd('\')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $userPath) { $userPath = "" }

  $parts = $userPath.Split(';') | Where-Object { $_ -and $_.Trim() -ne "" } | ForEach-Object { $_.TrimEnd('\') }
  if ($parts -contains $dirNorm) {
    Write-Step "User PATH already contains: $dirNorm"
  } else {
    $newUserPath = ($parts + @($dirNorm)) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
    Write-Step "Added to User PATH: $dirNorm (takes effect in new terminals)"
  }

  # Also add to current session for immediate use
  if ($env:Path -notlike "*$dirNorm*") {
    $env:Path = "$dirNorm;$env:Path"
  }
}

Write-Step "InstallDir=$InstallDir"
Write-Step "Url=$Url"

Ensure-Dir $InstallDir

$exe = Join-Path $InstallDir 'aliyun.exe'
if ((Test-Path $exe) -and (-not $Force)) {
  Write-Step "aliyun.exe already exists. Re-run with -Force to overwrite."
  Write-Host ""
  Write-Host "Verify:"
  Write-Host "  aliyun version"
  exit 0
}

$tmpRoot = Join-Path $env:TEMP ("aliyun-cli-" + [Guid]::NewGuid().ToString("n"))
Ensure-Dir $tmpRoot
$zipPath = Join-Path $tmpRoot "aliyun-cli.zip"

Write-Step "Downloading..."
Invoke-WebRequest -Uri $Url -OutFile $zipPath -UseBasicParsing

Write-Step "Extracting..."
$extractDir = Join-Path $tmpRoot "extract"
Ensure-Dir $extractDir
Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

$foundExe = Get-ChildItem -Path $extractDir -Recurse -File -Filter "aliyun.exe" | Select-Object -First 1
if (-not $foundExe) {
  Write-Error "aliyun.exe not found inside archive. Please check URL: $Url"
}

Write-Step ("Installing: " + $foundExe.FullName + " -> " + $exe)
Copy-Item -Force $foundExe.FullName $exe

if ($AddToUserPath) {
  Add-ToUserPath $InstallDir
}

Write-Step "Verifying..."
& $exe version

Write-Host ""
Write-Host "OK. Aliyun CLI installed."
Write-Host ("- Path: " + $exe)
Write-Host ("- Configure: aliyun configure")
Write-Host ""
Write-Host "Rollback (manual):"
Write-Host ("- Delete: " + $InstallDir)
Write-Host "- Remove the PATH entry from User environment variables (new terminal required)."










