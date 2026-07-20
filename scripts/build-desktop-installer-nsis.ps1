param(
  [string]$SourceExe = 'E:\copilot\frontend\src-tauri\target\debug\cursor-like.exe',
  [string]$AppName = 'CursorLike',
  [string]$CompanyName = 'CodeSprite contributors',
  [string]$Version = '0.1.0',
  [string]$OutExe = 'E:\copilot\scripts\deploy-artifacts\CursorLikeSetup_nsis.exe'
)

$ErrorActionPreference = 'Stop'

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

$toolsRoot = 'E:\copilot\tools\nsis'
$null = New-Item -ItemType Directory -Force -Path $toolsRoot

# Portable NSIS zip (no admin)
$nsisVer = '3.10'
$zipName = "nsis-$nsisVer.zip"
$zipPath = Join-Path $toolsRoot $zipName
# GitHub Release 直链（速度与稳定性更好，避免 SourceForge HTML/慢下载）
$url = "https://github.com/kichik/nsis/releases/download/v$nsisVer/$zipName"

if(-not (Test-Path $zipPath)){
  # 避免 Windows curl.exe 在部分环境下参数解析异常，改用 Invoke-WebRequest（可控超时）
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zipPath -TimeoutSec 50
  # 简单校验 zip 头（PK）
  $head = [System.IO.File]::ReadAllBytes($zipPath)[0..1]
  if(-not ($head[0] -eq 0x50 -and $head[1] -eq 0x4B)){
    $preview = (Get-Content -Path $zipPath -TotalCount 5 -ErrorAction SilentlyContinue | Out-String)
    throw "downloaded file is not a zip (missing PK header). url=$url preview=$preview"
  }
}

$extractDir = Join-Path $toolsRoot "nsis-$nsisVer"
if(-not (Test-Path (Join-Path $extractDir 'makensis.exe'))){
  Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
  # zip 里通常是 NSIS\makensis.exe
  if(Test-Path (Join-Path $extractDir 'NSIS\makensis.exe')){
    $extractDir = Join-Path $extractDir 'NSIS'
  }
}

$makensis = Join-Path $extractDir 'makensis.exe'
if(-not (Test-Path $makensis)){
  throw "makensis.exe not found after extract. extractDir=$extractDir"
}

$artifactDir = 'E:\copilot\scripts\deploy-artifacts'
$null = New-Item -ItemType Directory -Force -Path $artifactDir

$nsi = Join-Path $artifactDir 'CursorLikeInstaller.nsi'
$appExeName = 'cursor-like.exe'
$installDir = '$LOCALAPPDATA\Programs\CursorLike'

# NSIS script (Unicode)
$nsiContent = @"
Unicode true
RequestExecutionLevel user

!define APP_NAME "$AppName"
!define COMPANY "$CompanyName"
!define APP_VERSION "$Version"
!define APP_EXE "$appExeName"

Name "\${APP_NAME} \${APP_VERSION}"
OutFile "$OutExe"
InstallDir "$installDir"

ShowInstDetails nevershow
ShowUninstDetails nevershow

Page directory
Page instfiles
UninstPage instfiles

Section "Install"
  SetOutPath "\$INSTDIR"
  File /oname=\${APP_EXE} "$SourceExe"

  ; Start Menu
  CreateDirectory "\$SMPROGRAMS\\\${APP_NAME}"
  CreateShortCut "\$SMPROGRAMS\\\${APP_NAME}\\\${APP_NAME}.lnk" "\$INSTDIR\\\${APP_EXE}"
  ; Desktop
  CreateShortCut "\$DESKTOP\\\${APP_NAME}.lnk" "\$INSTDIR\\\${APP_EXE}"

  ; Uninstaller
  WriteUninstaller "\$INSTDIR\\Uninstall.exe"
  CreateShortCut "\$SMPROGRAMS\\\${APP_NAME}\\Uninstall \${APP_NAME}.lnk" "\$INSTDIR\\Uninstall.exe"
SectionEnd

Section "Uninstall"
  Delete "\$DESKTOP\\\${APP_NAME}.lnk"
  RMDir /r "\$SMPROGRAMS\\\${APP_NAME}"
  RMDir /r "\$INSTDIR"
SectionEnd
"@

[System.IO.File]::WriteAllText($nsi, $nsiContent, (New-Object System.Text.UTF8Encoding($false)))

# Build installer
$r2 = Invoke-Proc $makensis ("`"$nsi`"") 55000
if($r2.ExitCode -ne 0){
  throw "makensis failed exit=$($r2.ExitCode)`n$($r2.Stdout)`n$($r2.Stderr)"
}

if(-not (Test-Path $OutExe)){
  throw "installer not created: $OutExe"
}

Get-Item $OutExe | Select-Object FullName,Length,LastWriteTime | Format-List | Out-String

