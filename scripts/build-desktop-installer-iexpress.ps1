# LEGACY: superseded by scripts/build-desktop-installer-csharp-wizard.ps1
# Do not use for releases. Kept for reference only.

param(
  # 输入：Tauri 可执行文件（当前用 debug 版，后续可替换为 release 版）
  [string]$SourceExe,

  # 输出：生成的安装包 exe
  [string]$OutExe,

  # 应用信息
  [string]$AppName,
  [string]$AppExeName
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$defaultArtifactDir = Join-Path $PSScriptRoot 'deploy-artifacts'

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

function Write-Ascii([string]$Path, [string]$Content) {
  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.Encoding]::ASCII)
}

if (-not $SourceExe) { $SourceExe = Join-Path $repoRoot 'frontend\src-tauri\target\debug\codesprite.exe' }
if (-not $OutExe) { $OutExe = Join-Path $defaultArtifactDir 'CodeSpriteSetup_legacy.exe' }
if (-not $AppName) { $AppName = 'CodeSprite' }
if (-not $AppExeName) { $AppExeName = 'codesprite.exe' }

if (-not (Test-Path $SourceExe)) {
  throw "SourceExe not found: $SourceExe"
}

$iexpress = Join-Path $env:SystemRoot "System32\iexpress.exe"
if (-not (Test-Path $iexpress)) {
  throw "iexpress.exe not found: $iexpress"
}

$workRoot = Join-Path $env:TEMP ("codesprite_iexpress_" + [Guid]::NewGuid().ToString("N"))
$packageDir = Join-Path $workRoot "package"
$stagingDir = Join-Path $workRoot "staging"
$null = New-Item -ItemType Directory -Force -Path $packageDir, $stagingDir

# 准备安装脚本（以当前用户权限安装到 LocalAppData）
$installPs1 = Join-Path $packageDir "install.ps1"
$uninstallPs1 = Join-Path $packageDir "uninstall.ps1"
$installCmd = Join-Path $packageDir "install.cmd"

$installContent = @"
`$ErrorActionPreference = 'Stop'

`$appName = '$AppName'
`$exeName = '$AppExeName'
`$installDir = Join-Path `$env:LOCALAPPDATA "Programs\`$appName"
`$startMenuDir = Join-Path `$env:APPDATA "Microsoft\Windows\Start Menu\Programs\`$appName"
`$desktopDir = [Environment]::GetFolderPath('Desktop')

New-Item -ItemType Directory -Force -Path `$installDir | Out-Null
Copy-Item -Force -Path (Join-Path `$PSScriptRoot `$exeName) -Destination (Join-Path `$installDir `$exeName)

function New-Shortcut([string]`$lnkPath, [string]`$targetPath, [string]`$workingDir, [string]`$arguments = '') {
  `$wsh = New-Object -ComObject WScript.Shell
  `$sc = `$wsh.CreateShortcut(`$lnkPath)
  `$sc.TargetPath = `$targetPath
  `$sc.WorkingDirectory = `$workingDir
  if (`$arguments) { `$sc.Arguments = `$arguments }
  `$sc.Save()
}

New-Item -ItemType Directory -Force -Path `$startMenuDir | Out-Null
`$target = Join-Path `$installDir `$exeName
New-Shortcut (Join-Path `$startMenuDir "`$appName.lnk") `$target `$installDir ''
New-Shortcut (Join-Path `$desktopDir "`$appName.lnk") `$target `$installDir ''

# 写卸载脚本到安装目录
Copy-Item -Force -Path (Join-Path `$PSScriptRoot 'uninstall.ps1') -Destination (Join-Path `$installDir 'uninstall.ps1')
New-Shortcut (Join-Path `$startMenuDir "Uninstall `$appName.lnk") "powershell.exe" `$installDir ("-NoProfile -ExecutionPolicy Bypass -File `"`$installDir\\uninstall.ps1`"")

exit 0
"@

$uninstallContent = @"
`$ErrorActionPreference = 'Stop'

`$appName = '$AppName'
`$installDir = Join-Path `$env:LOCALAPPDATA "Programs\`$appName"
`$startMenuDir = Join-Path `$env:APPDATA "Microsoft\Windows\Start Menu\Programs\`$appName"
`$desktopDir = [Environment]::GetFolderPath('Desktop')

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue `$installDir
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue `$startMenuDir
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path `$desktopDir "`$appName.lnk")

exit 0
"@

Write-Utf8NoBom $installPs1 $installContent
Write-Utf8NoBom $uninstallPs1 $uninstallContent

# 通过 install.cmd 执行 PowerShell 安装脚本，避免 IExpress 的 AppLaunched 解析带空格参数失败
$installCmdContent = @'
@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
exit /b %errorlevel%
'@
Write-Ascii $installCmd $installCmdContent

# 放入应用文件
Copy-Item -Force $SourceExe (Join-Path $packageDir $AppExeName)

# IExpress SED 配置（自解压 + 执行安装脚本）
$sedPath = Join-Path $stagingDir "cursorlike.sed"
# 使用 IExpress 的 %FILEn% 变量，避免部分系统下直接写文件名导致“创建进程 <> 参数错误”
$postCmd = "%FILE3%"

$sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3

[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$OutExe
FriendlyName=$AppName Setup
# InstallApp 场景：AppLaunched 用于启动安装程序
AppLaunched=$postCmd
InstallProgram=
PostInstallCmd=
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles

[Strings]
FILE0=$AppExeName
FILE1=install.ps1
FILE2=uninstall.ps1
FILE3=install.cmd

[SourceFiles]
SourceFiles0=$packageDir

[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=
%FILE3%=
"@

Write-Ascii $sedPath $sed

# 生成安装包（/N 不保存、/Q 静默）
if (Test-Path $OutExe) {
  Remove-Item -Force $OutExe -ErrorAction SilentlyContinue
}
& $iexpress /N /Q $sedPath | Out-Null

if (-not (Test-Path $OutExe)) {
  throw "Failed to create installer: $OutExe"
}

Get-Item $OutExe | Select-Object FullName,Length,LastWriteTime | Format-List | Out-String

