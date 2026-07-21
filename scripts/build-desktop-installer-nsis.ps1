# LEGACY: superseded by scripts/build-desktop-installer-csharp-wizard.ps1
# Do not use for releases. Kept for reference only.

param(
  [string]$SourceExe = '',
  [string]$AppName = 'CodeSprite',
  [string]$CompanyName = 'CodeSprite contributors',
  [string]$Version = '0.1.0',
  [string]$OutExe = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$defaultArtifactDir = Join-Path $PSScriptRoot 'deploy-artifacts'

if ([string]::IsNullOrWhiteSpace($SourceExe)) {
  $SourceExe = Join-Path $repoRoot 'frontend\src-tauri\target\debug\codesprite.exe'
}
if ([string]::IsNullOrWhiteSpace($OutExe)) {
  $OutExe = Join-Path $defaultArtifactDir 'CodeSpriteSetup_legacy_nsis.exe'
}

function Invoke-Proc([string]$File,[string]$Args,[int]$TimeoutMs=55000){
  $psi=New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName=$File
  $psi.Arguments=$Args
  $psi.RedirectStandardOutput=$true
  $psi.RedirectStandardError=$true
  $psi.UseShellExecute=$false
  $psi.CreateNoWindow=$true
  $p=New-Object System.Diagnostics.Process
  $p.StartInfo=$psi
  [void]$p.Start()
  $exited=$p.WaitForExit($TimeoutMs)
  if(-not $exited){ try { $p.Kill() } catch {}; $p.WaitForExit() }
  [pscustomobject]@{Exited=$exited; ExitCode=$p.ExitCode; Stdout=$p.StandardOutput.ReadToEnd(); Stderr=$p.StandardError.ReadToEnd()}
}

if(-not (Test-Path $SourceExe)){
  throw "SourceExe not found: $SourceExe"
}

$toolsRoot = Join-Path $repoRoot 'tools\nsis'
$null = New-Item -ItemType Directory -Force -Path $toolsRoot

# Portable NSIS zip (no admin)
$nsisVer = '3.10'
$zipName = "nsis-$nsisVer.zip"
$zipPath = Join-Path $toolsRoot $zipName
$nsisDir = Join-Path $toolsRoot "nsis-$nsisVer"
$makensis = Join-Path $nsisDir 'makensis.exe'

if(-not (Test-Path $makensis)){
  if(-not (Test-Path $zipPath)){
    $url = "https://downloads.sourceforge.net/project/nsis/NSIS%203/$nsisVer/nsis-$nsisVer.zip"
    Write-Host "Downloading portable NSIS $nsisVer ..."
    Invoke-WebRequest -Uri $url -OutFile $zipPath
  }
  if(Test-Path $nsisDir){ Remove-Item -Recurse -Force $nsisDir }
  Expand-Archive -Path $zipPath -DestinationPath $toolsRoot -Force
}

if(-not (Test-Path $makensis)){
  throw "makensis.exe not found under $toolsRoot"
}

$null = New-Item -ItemType Directory -Force -Path $defaultArtifactDir
$nsi = Join-Path $defaultArtifactDir 'CodeSpriteInstaller.nsi'
$appExeName = 'codesprite.exe'
$installDir = '$LOCALAPPDATA\Programs\CodeSprite'

@"
!define APP_NAME "$AppName"
!define COMPANY_NAME "$CompanyName"
!define APP_VERSION "$Version"
!define APP_EXE "$appExeName"
Unicode true
Name "${APP_NAME}"
OutFile "$OutExe"
InstallDir "$installDir"
RequestExecutionLevel user
SilentInstall normal

Page directory
Page instfiles

Section "Install"
  SetOutPath "$INSTDIR"
  File /oname=${APP_EXE} "$SourceExe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "UninstallString" "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\${APP_EXE}"
  Delete "$INSTDIR\Uninstall.exe"
  Delete "$SMPROGRAMS\${APP_NAME}.lnk"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"
SectionEnd
"@ | Set-Content -Path $nsi -Encoding UTF8

$r = Invoke-Proc $makensis ("/V2 `"$nsi`"")
$r.Stdout | Write-Host
$r.Stderr | Write-Host
if(-not $r.Exited -or $r.ExitCode -ne 0){
  throw "makensis failed: exit=$($r.ExitCode)"
}

if(-not (Test-Path $OutExe)){
  throw "installer not created: $OutExe"
}

Get-Item $OutExe | Select-Object FullName,Length,LastWriteTime | Format-List | Out-String
