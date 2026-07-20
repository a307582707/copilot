param(
  [int]$BackendPort = 8030,
  [int]$FrontendPort = 5173,
  [switch]$FallbackWeb = $false,
  [switch]$AutoInstallDeps = $false
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Test-HttpOk {
  param([string]$Url, [int]$TimeoutSeconds = 2)
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSeconds
    return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300)
  } catch {
    return $false
  }
}

function Test-TcpPortFree {
  param([int]$Port)
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $c.Connect('127.0.0.1', $Port)
    $c.Close()
    return $false
  } catch {
    return $true
  }
}

function Test-CargoAvailable {
  try {
    $null = Get-Command cargo -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

function Add-RustToPathIfPresent {
  # Common rustup install location
  $cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
  $cargoExe = Join-Path $cargoBin "cargo.exe"
  if (Test-Path $cargoExe) {
    if ($env:Path -notlike "*$cargoBin*") {
      $env:Path = "$cargoBin;$env:Path"
    }
    return $true
  }
  return $false
}

function Test-WingetAvailable {
  try {
    $null = Get-Command winget -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

function Install-DesktopDepsViaWinget {
  if (-not (Test-WingetAvailable)) {
    Write-Warning "winget not found. Please install Rust (rustup) and Visual Studio Build Tools manually."
    return $false
  }

  Write-Host "Installing Rust (rustup) via winget..."
  winget install -e --id Rustlang.Rustup --accept-package-agreements --accept-source-agreements | Out-Host

  Write-Host "Installing Visual Studio 2022 Build Tools via winget (MSVC toolchain)..."
  winget install -e --id Microsoft.VisualStudio.2022.BuildTools --accept-package-agreements --accept-source-agreements | Out-Host

  # Try to pick up cargo in current session
  Add-RustToPathIfPresent | Out-Null
  return $true
}

Write-Host ("BackendPort=" + $BackendPort + " FrontendPort=" + $FrontendPort)

# Ensure frontend port is free (Vite default)
if (-not (Test-TcpPortFree -Port $FrontendPort)) {
  Write-Error "Port $FrontendPort is in use. Run: netstat -ano | findstr :$FrontendPort  then: taskkill /PID <PID> /F"
  exit 1
}

# Start backend in separate minimized window (non-blocking)
$healthUrl = "http://127.0.0.1:$BackendPort/health"
if (-not (Test-HttpOk -Url $healthUrl -TimeoutSeconds 1)) {
  Write-Host "Starting backend (minimized window)..."
  Start-Process -FilePath "powershell" -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", (Join-Path $PSScriptRoot 'start-backend.ps1'),
    "-Port", "$BackendPort"
  ) -WorkingDirectory $root -WindowStyle Minimized | Out-Null
} else {
  Write-Host "Backend already healthy, skip starting a new backend process."
}

Write-Host "Waiting for backend health..."
for ($i = 0; $i -lt 60; $i++) {
  if (Test-HttpOk -Url $healthUrl -TimeoutSeconds 2) {
    Write-Host "Backend is healthy: $healthUrl"
    break
  }
  Start-Sleep -Milliseconds 500
}

if (-not (Test-HttpOk -Url $healthUrl -TimeoutSeconds 2)) {
  Write-Warning "Backend not healthy yet: $healthUrl . Desktop can still start, but API calls may fail until backend is ready."
}

# Start Tauri dev (blocks current window; shows logs)
Write-Host "Starting Tauri desktop client (this window will show logs)..."

. (Join-Path $PSScriptRoot 'env.ps1')
Set-Location (Join-Path $root 'frontend')

if (-not (Test-Path .\node_modules)) {
  Write-Host 'node_modules not found, running npm install...'
  npm install
}

# Tauri requires Rust toolchain (cargo)
Add-RustToPathIfPresent | Out-Null
if (-not (Test-CargoAvailable)) {
  Write-Warning "Tauri desktop needs Rust (cargo) but 'cargo' was not found in PATH."

  if ($AutoInstallDeps) {
    Install-DesktopDepsViaWinget | Out-Null
  }

  Add-RustToPathIfPresent | Out-Null
  if (-not (Test-CargoAvailable)) {
    Write-Host "Fix options:"
    Write-Host "  - Auto (recommended): scripts\\desktop-doctor.ps1 -Fix"
    Write-Host "  - winget: winget install -e --id Rustlang.Rustup --accept-package-agreements --accept-source-agreements"
    Write-Host "  - winget: winget install -e --id Microsoft.VisualStudio.2022.BuildTools --accept-package-agreements --accept-source-agreements"
    Write-Host "Then open a NEW PowerShell and verify: cargo --version"

    if ($FallbackWeb) {
      Write-Warning "FallbackWeb enabled: starting Web UI (Vite) as a temporary workaround."
      npm run dev -- --host 127.0.0.1 --port $FrontendPort
      exit $LASTEXITCODE
    }

    Write-Error "Desktop deps missing. Install them and re-run: scripts\\start-desktop.cmd"
    exit 1
  }
}

# Tauri will start the Vite dev server and open the desktop window.
npm run desktop:dev


