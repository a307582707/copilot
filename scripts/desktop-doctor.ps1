param(
  [switch]$Fix = $false,
  [switch]$LoadPortableNode = $true
)

$ErrorActionPreference = 'Stop'

function Has-Command {
  param([string]$Name)
  try { $null = Get-Command $Name -ErrorAction Stop; return $true } catch { return $false }
}

function Add-RustToPathIfPresent {
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

function Run-Check {
  param([string]$Name, [scriptblock]$Check)
  try {
    $ok = & $Check
    if ($ok) {
      Write-Host "[OK] $Name"
    } else {
      Write-Host "[NO] $Name"
    }
    return [bool]$ok
  } catch {
    Write-Host "[ERR] $Name : $($_.Exception.Message)"
    return $false
  }
}

function Install-WithWinget {
  param([string]$Id)
  if (-not (Has-Command winget)) {
    Write-Warning "winget not found; cannot auto-install $Id"
    return $false
  }
  winget install -e --id $Id --accept-package-agreements --accept-source-agreements | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "winget install exited with code $LASTEXITCODE for $Id"
    return $false
  }
  return $true
}

function Try-FixWingetSources {
  if (-not (Has-Command winget)) { return $false }
  Write-Host "Resetting winget sources..."
  winget source reset --force | Out-Host
  if ($LASTEXITCODE -ne 0) { return $false }
  Write-Host "Updating winget sources..."
  winget source update | Out-Host
  if ($LASTEXITCODE -ne 0) { return $false }
  return $true
}

function Install-RustupDirect {
  $url = "https://win.rustup.rs/x86_64"
  $tmp = Join-Path $env:TEMP "rustup-init.exe"
  Write-Host "Downloading rustup-init.exe..."
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $tmp
  Write-Host "Running rustup-init.exe (silent)..."
  Start-Process -FilePath $tmp -ArgumentList @("-y") -Wait
  Add-RustToPathIfPresent | Out-Null
  return (Has-Command cargo)
}

function Install-VSBuildToolsDirect {
  # Official Microsoft bootstrapper
  $url = "https://aka.ms/vs/17/release/vs_BuildTools.exe"
  $tmp = Join-Path $env:TEMP "vs_BuildTools.exe"
  Write-Host "Downloading vs_BuildTools.exe..."
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $tmp

  # Install MSVC toolchain required by Rust/Tauri (silent)
  # Note: This can take a long time and may require admin privileges.
  $args = @(
    "--quiet",
    "--wait",
    "--norestart",
    "--nocache",
    "--add", "Microsoft.VisualStudio.Workload.VCTools",
    "--includeRecommended"
  )
  Write-Host "Running Visual Studio Build Tools installer (silent)..."
  $p = Start-Process -FilePath $tmp -ArgumentList $args -Wait -PassThru
  return ($p.ExitCode -eq 0)
}

Write-Host "=== Desktop Doctor (Tauri/Windows) ==="
Write-Host "Tip: run with -Fix to auto-install via winget when possible."
Write-Host ""

# Load portable node into PATH for accurate checks (same as start-frontend/start-desktop)
if ($LoadPortableNode) {
  $envScript = Join-Path $PSScriptRoot "env.ps1"
  if (Test-Path $envScript) {
    try {
      . $envScript
    } catch {
      Write-Warning "Failed to load $envScript : $($_.Exception.Message)"
    }
  }
}

# Best-effort: if rustup already installed, ensure cargo is visible in this session
Add-RustToPathIfPresent | Out-Null

$hasWinget = Run-Check "winget available" { Has-Command winget }
$hasCargo  = Run-Check "cargo (Rust toolchain) available" { Has-Command cargo }
$hasRustc  = Run-Check "rustc available" { Has-Command rustc }
$hasNode   = Run-Check "node available" { Has-Command node }
$hasNpm    = Run-Check "npm available" { Has-Command npm }

Write-Host ""
if (-not $hasCargo -or -not $hasRustc) {
  Write-Host "Rust is required for Tauri desktop builds."
  Write-Host "Install:"
  Write-Host "  - winget install -e --id Rustlang.Rustup --accept-package-agreements --accept-source-agreements"
  Write-Host "  - or manual: https://rustup.rs/"
}

Write-Host ""
Write-Host "MSVC Build Tools are required on Windows."
Write-Host "Install:"
Write-Host "  - winget install -e --id Microsoft.VisualStudio.2022.BuildTools --accept-package-agreements --accept-source-agreements"
Write-Host "Note: after installing, you may need to reboot or at least open a NEW terminal."

if ($Fix) {
  Write-Host ""
  Write-Host "=== Attempting auto-fix ==="
  Try-FixWingetSources | Out-Null

  if (-not $hasCargo -or -not $hasRustc) {
    if (-not (Install-WithWinget -Id "Rustlang.Rustup")) {
      Write-Warning "Falling back to direct Rust install (rustup-init.exe)."
      Install-RustupDirect | Out-Null
    }
    Add-RustToPathIfPresent | Out-Null
  }
  if (-not (Install-WithWinget -Id "Microsoft.VisualStudio.2022.BuildTools")) {
    Write-Warning "Falling back to direct VS Build Tools install (vs_BuildTools.exe)."
    Install-VSBuildToolsDirect | Out-Null
  }

  Write-Host ""
  Write-Host "=== Re-check ==="
  Add-RustToPathIfPresent | Out-Null
  Run-Check "cargo (Rust toolchain) available" { Has-Command cargo } | Out-Null
  Run-Check "rustc available" { Has-Command rustc } | Out-Null
}

Write-Host ""
Write-Host "Next step: run scripts\\start-desktop.cmd"


