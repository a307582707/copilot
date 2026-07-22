# LEGACY: superseded by scripts/build-desktop-installer-csharp-wizard.ps1
# Do not use for releases. Kept for reference only.

param(
  [string]$OutExe = '',
  [string]$AppName = 'CodeSprite',
  [string]$Publisher = 'CodeSprite contributors',
  [string]$Version = '0.1.0',
  [string]$DownloadZipUrl = 'https://downloads.example.com/codesprite-windows-debug.zip',
  [switch]$ShowUi = $true
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$defaultArtifactDir = Join-Path $PSScriptRoot 'deploy-artifacts'

if ([string]::IsNullOrWhiteSpace($OutExe)) { $OutExe = Join-Path $defaultArtifactDir 'CodeSpriteSetup_legacy_win_v3.exe' }
$artifactDir = $defaultArtifactDir
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null

$csPath = Join-Path $artifactDir 'CodeSpriteInstaller.cs'

$showUiStr = if ($ShowUi) { "true" } else { "false" }

# 仅使用 ASCII（C# Unicode 转义）避免 PowerShell 脚本在不同代码页下出现乱码导致解析失败
$zhInstallTitle = '"\u5b89\u88c5"' # 安装
$zhPreparing    = '"\u51c6\u5907\u5b89\u88c5...\n\u5b89\u88c5\u76ee\u5f55\uff1a"' # 准备安装...\n安装目录：
$zhDownloading  = '"\u6b63\u5728\u4e0b\u8f7d..."' # 正在下载...
$zhExtracting   = '"\u6b63\u5728\u89e3\u538b..."' # 正在解压...
$zhInstalling   = '"\u6b63\u5728\u5b89\u88c5..."' # 正在安装...
$zhInstalled    = '"\u5b89\u88c5\u5b8c\u6210"' # 安装完成
$zhDoneBtn      = '"\u5b8c\u6210"' # 完成

$cs = @'
using System;
using System.IO;
using System.Net;
using System.IO.Compression;
using Microsoft.Win32;
using System.Windows.Forms;
using System.Threading;

class Program
{
  static int Main(string[] args)
  {
    try
    {
      string appName = "${AppName}";
      string publisher = "${Publisher}";
      string version = "${Version}";
      string zipUrl = "${DownloadZipUrl}";
      bool showUi = ${showUiStr};
      bool silent = false;
      for (int i = 0; i < args.Length; i++)
      {
        if (args[i].Equals("--silent", StringComparison.OrdinalIgnoreCase) || args[i].Equals("/S", StringComparison.OrdinalIgnoreCase))
        {
          silent = true;
        }
      }

      string installDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Programs",
        appName
      );

      string startMenuDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "Microsoft", "Windows", "Start Menu", "Programs", appName
      );

      string desktopDir = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
      string appExe = Path.Combine(installDir, "codesprite.exe");
      string uninstallExe = Path.Combine(installDir, "Uninstall.exe");

      bool isUninstall = args.Length > 0 && args[0].Equals("--uninstall", StringComparison.OrdinalIgnoreCase);

      if (isUninstall)
      {
        SafeDeleteFile(Path.Combine(desktopDir, appName + ".lnk"));
        SafeDeleteDir(startMenuDir);
        SafeDeleteDir(installDir);
        DeleteUninstallRegistry(appName);
        return 0;
      }

      Directory.CreateDirectory(installDir);
      Directory.CreateDirectory(startMenuDir);

      ProgressUi ui = null;
      if (showUi && !silent)
      {
        ui = new ProgressUi(appName, installDir);
        ui.Show();
        Application.DoEvents();
      }

      // Download zip to temp
      string tmpZip = Path.Combine(Path.GetTempPath(), "codesprite_" + Guid.NewGuid().ToString("N") + ".zip");
      if (ui != null) ui.SetPhase($zhDownloading, 0, 100, false);
      DownloadWithProgress(zipUrl, tmpZip, ui);

      // Extract zip (contains codesprite.exe)
      string tmpDir = Path.Combine(Path.GetTempPath(), "codesprite_extract_" + Guid.NewGuid().ToString("N"));
      Directory.CreateDirectory(tmpDir);
      if (ui != null) ui.SetPhase($zhExtracting, 0, 100, true);
      ExtractZipWithProgress(tmpZip, tmpDir, ui);

      // Find an exe inside zip and copy as codesprite.exe
      string[] exes = Directory.GetFiles(tmpDir, "*.exe", SearchOption.AllDirectories);
      if (exes.Length == 0) throw new Exception("No .exe found in downloaded zip.");
      if (ui != null) ui.SetPhase($zhInstalling, 0, 100, true);
      File.Copy(exes[0], appExe, true);

      // Copy self as uninstaller
      File.Copy(Application.ExecutablePath, uninstallExe, true);

      // Shortcuts
      CreateShortcut(Path.Combine(startMenuDir, appName + ".lnk"), appExe, installDir, "");
      CreateShortcut(Path.Combine(desktopDir, appName + ".lnk"), appExe, installDir, "");
      CreateShortcut(Path.Combine(startMenuDir, "Uninstall " + appName + ".lnk"), uninstallExe, installDir, "--uninstall");

      // Register in “Programs and Features” (per-user)
      WriteUninstallRegistry(appName, publisher, version, installDir, appExe, uninstallExe);

      // Cleanup temp
      SafeDeleteFile(tmpZip);
      SafeDeleteDir(tmpDir);

      if (ui != null)
      {
        ui.SetPhase($zhInstalled, 100, 100, false);
        ui.SetDone(uninstallExe);
        Application.Run(ui);
      }

      return 0;
    }
    catch (Exception ex)
    {
      try
      {
        MessageBox.Show(ex.ToString(), "${AppName} Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
      }
      catch { }
      return 1;
    }
  }

  static void SafeDeleteFile(string path)
  {
    try { if (File.Exists(path)) File.Delete(path); } catch { }
  }

  static void SafeDeleteDir(string path)
  {
    try { if (Directory.Exists(path)) Directory.Delete(path, true); } catch { }
  }

  static void CreateShortcut(string lnkPath, string targetPath, string workingDir, string arguments)
  {
    // Late-bound WScript.Shell to avoid COM reference
    Type t = Type.GetTypeFromProgID("WScript.Shell");
    dynamic shell = Activator.CreateInstance(t);
    dynamic sc = shell.CreateShortcut(lnkPath);
    sc.TargetPath = targetPath;
    sc.WorkingDirectory = workingDir;
    if (!string.IsNullOrEmpty(arguments)) sc.Arguments = arguments;
    sc.Save();
  }

  static void DownloadWithProgress(string url, string outFile, ProgressUi ui)
  {
    using (var wc = new WebClient())
    {
      wc.Headers.Add("User-Agent", "CodeSpriteSetup");
      int last = 0;
      AutoResetEvent done = new AutoResetEvent(false);
      Exception err = null;
      wc.DownloadProgressChanged += (s, e) =>
      {
        if (ui != null)
        {
          int p = e.ProgressPercentage;
          if (p != last)
          {
            last = p;
          ui.UpdateProgress($zhDownloading + " " + p + "%", p);
          }
        }
        Application.DoEvents();
      };
      wc.DownloadFileCompleted += (s, e) =>
      {
        if (e.Error != null) err = e.Error;
        if (e.Cancelled) err = new Exception("Download cancelled.");
        done.Set();
      };
      wc.DownloadFileAsync(new Uri(url), outFile);
      while (!done.WaitOne(100))
      {
        Application.DoEvents();
      }
      if (err != null) throw err;
    }
  }

  static void ExtractZipWithProgress(string zipPath, string outDir, ProgressUi ui)
  {
    using (var za = ZipFile.OpenRead(zipPath))
    {
      int total = za.Entries.Count;
      int i = 0;
      foreach (var entry in za.Entries)
      {
        // 目录条目
        if (string.IsNullOrEmpty(entry.Name))
        {
          Directory.CreateDirectory(Path.Combine(outDir, entry.FullName));
          continue;
        }

        string dest = Path.Combine(outDir, entry.FullName);
        Directory.CreateDirectory(Path.GetDirectoryName(dest));
        entry.ExtractToFile(dest, true);

        i++;
        if (ui != null && total > 0)
        {
          int p = (int)Math.Round(i * 100.0 / total);
          ui.UpdateProgress($zhExtracting + " " + p + "%", p);
        }
        Application.DoEvents();
      }
    }
  }

  static string UninstallRegPath(string appName)
  {
    return @"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + appName;
  }

  static void WriteUninstallRegistry(string appName, string publisher, string version, string installDir, string appExe, string uninstallExe)
  {
    using (var key = Registry.CurrentUser.CreateSubKey(UninstallRegPath(appName)))
    {
      if (key == null) return;
      key.SetValue("DisplayName", appName);
      key.SetValue("DisplayVersion", version);
      key.SetValue("Publisher", publisher);
      key.SetValue("InstallLocation", installDir);
      key.SetValue("DisplayIcon", appExe);
      key.SetValue("UninstallString", "\"" + uninstallExe + "\" --uninstall");
      key.SetValue("QuietUninstallString", "\"" + uninstallExe + "\" --uninstall");
      key.SetValue("NoModify", 1, RegistryValueKind.DWord);
      key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
    }
  }

  static void DeleteUninstallRegistry(string appName)
  {
    try
    {
      Registry.CurrentUser.DeleteSubKeyTree(UninstallRegPath(appName), false);
    }
    catch { }
  }
}

public class ProgressUi : Form
{
  private Label _label;
  private ProgressBar _bar;
  private Button _ok;
  private string _uninstallExe;

  public ProgressUi(string appName, string installDir)
  {
    Text = appName + " " + $zhInstallTitle;
    Width = 520;
    Height = 160;
    FormBorderStyle = FormBorderStyle.FixedDialog;
    MaximizeBox = false;
    MinimizeBox = false;
    StartPosition = FormStartPosition.CenterScreen;

    _label = new Label();
    _label.Left = 16;
    _label.Top = 16;
    _label.Width = 480;
    _label.Text = $zhPreparing + installDir;

    _bar = new ProgressBar();
    _bar.Left = 16;
    _bar.Top = 60;
    _bar.Width = 480;
    _bar.Height = 18;
    _bar.Minimum = 0;
    _bar.Maximum = 100;
    _bar.Value = 0;

    _ok = new Button();
    _ok.Left = 420;
    _ok.Top = 90;
    _ok.Width = 76;
    _ok.Text = $zhDoneBtn;
    _ok.Enabled = false;
    _ok.Click += (s, e) => { Close(); };

    Controls.Add(_label);
    Controls.Add(_bar);
    Controls.Add(_ok);
  }

  public void SetPhase(string text, int min, int max, bool marquee)
  {
    _label.Text = text;
    _bar.Minimum = min;
    _bar.Maximum = max;
    _bar.Value = min;
    _bar.Style = marquee ? ProgressBarStyle.Marquee : ProgressBarStyle.Continuous;
    _bar.MarqueeAnimationSpeed = marquee ? 30 : 0;
    Refresh();
  }

  public void UpdateProgress(string text, int value)
  {
    _label.Text = text;
    if (_bar.Style != ProgressBarStyle.Continuous)
    {
      _bar.Style = ProgressBarStyle.Continuous;
      _bar.MarqueeAnimationSpeed = 0;
    }
    if (value < _bar.Minimum) value = _bar.Minimum;
    if (value > _bar.Maximum) value = _bar.Maximum;
    _bar.Value = value;
    Refresh();
  }

  public void SetDone(string uninstallExe)
  {
    _uninstallExe = uninstallExe;
    _ok.Enabled = true;
  }
}
'@

# 用字符串替换将 PowerShell 变量注入到 C# 模板中（避免 here-string 解析/编码问题）
$cs = $cs.Replace('${AppName}', $AppName)
$cs = $cs.Replace('${Publisher}', $Publisher)
$cs = $cs.Replace('${Version}', $Version)
$cs = $cs.Replace('${DownloadZipUrl}', $DownloadZipUrl)
$cs = $cs.Replace('${showUiStr}', $showUiStr)

$cs = $cs.Replace('$zhInstallTitle', $zhInstallTitle)
$cs = $cs.Replace('$zhPreparing', $zhPreparing)
$cs = $cs.Replace('$zhDownloading', $zhDownloading)
$cs = $cs.Replace('$zhExtracting', $zhExtracting)
$cs = $cs.Replace('$zhInstalling', $zhInstalling)
$cs = $cs.Replace('$zhInstalled', $zhInstalled)
$cs = $cs.Replace('$zhDoneBtn', $zhDoneBtn)

[System.IO.File]::WriteAllText($csPath, $cs, (New-Object System.Text.UTF8Encoding($true)))

# 如果输出文件被占用，先尝试删除，避免 CS0016
if (Test-Path $OutExe) {
  try { Remove-Item -Force $OutExe -ErrorAction SilentlyContinue } catch { }
}

# Compile with .NET Framework csc.exe (avoid PATH issues)
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if(-not (Test-Path $csc)){
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if(-not (Test-Path $csc)){
  throw "csc.exe not found under .NET Framework folders"
}
$refs = '/r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll'
# 强制按 UTF-8 编译输入源码，避免中文字符串在无 BOM/默认代码页下被误解析
$args = "/nologo /optimize /target:winexe /codepage:65001 /out:$OutExe $csPath $refs"

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $csc
$psi.Arguments = $args
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$p = [System.Diagnostics.Process]::Start($psi)
$exited = $p.WaitForExit(55000)
if(-not $exited){ try { $p.Kill() } catch {}; $p.WaitForExit() }
$out = $p.StandardOutput.ReadToEnd() + [Environment]::NewLine + $p.StandardError.ReadToEnd()
if($p.ExitCode -ne 0){ throw ('csc failed exit=' + $p.ExitCode + ' output=' + $out) }

Get-Item $OutExe | Select-Object FullName,Length,LastWriteTime | Format-List | Out-String

