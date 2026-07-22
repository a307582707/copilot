param(
  [string]$OutExe = '',
  # Internal app id used for registry key / upgrade detection (ASCII recommended)
  [string]$AppId = 'CodeSprite',
  # Display name shown to users
  [string]$DisplayName = '码灵',
  [string]$Publisher = 'CodeSprite contributors',
  [string]$Version = '',
  [string]$DownloadUrl = 'https://downloads.example.com/codesprite.exe',
  [switch]$ShowUi
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$defaultArtifactDir = Join-Path $PSScriptRoot 'deploy-artifacts'

if ([string]::IsNullOrWhiteSpace($OutExe)) { $OutExe = Join-Path $defaultArtifactDir 'CodeSpriteSetup.exe' }

$artifactDir = $defaultArtifactDir
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
$csPath = Join-Path $artifactDir 'CodeSpriteInstaller.cs'

$showUiStr = if ($ShowUi) { 'true' } else { 'false' }

if ([string]::IsNullOrWhiteSpace($Version)) {
  $confPath = Join-Path $repoRoot 'frontend\src-tauri\tauri.conf.json'
  if (Test-Path $confPath) {
    try { $Version = ((Get-Content -Raw $confPath) | ConvertFrom-Json).version } catch { }
  }
  if ([string]::IsNullOrWhiteSpace($Version)) { $Version = '0.0.0' }
}

$cs = @'
using System;
using System.IO;
using System.Net;
using System.IO.Compression;
using Microsoft.Win32;
using System.Windows.Forms;
using System.Drawing;
using System.Threading;
using System.Security.Principal;

class Program
{
  static string LogPath()
  {
    try { return Path.Combine(Path.GetTempPath(), "CodeSpriteSetup.log"); }
    catch { return "CodeSpriteSetup.log"; }
  }

  static void Log(string line)
  {
    try
    {
      File.AppendAllText(LogPath(), "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + line + "\r\n");
    }
    catch { }
  }

  static bool IsAdministrator()
  {
    try
    {
      WindowsIdentity id = WindowsIdentity.GetCurrent();
      WindowsPrincipal p = new WindowsPrincipal(id);
      return p.IsInRole(WindowsBuiltInRole.Administrator);
    }
    catch { return false; }
  }

  // --- UI strings (C# unicode escapes, keep source ASCII) ---
  public const string ZH_TITLE_INSTALL = "\u5b89\u88c5";
  public const string ZH_TITLE_WELCOME = "\u6b22\u8fce";
  public const string ZH_TITLE_LICENSE = "\u8bb8\u53ef\u534f\u8bae";
  public const string ZH_TITLE_OPTIONS = "\u5b89\u88c5\u9009\u9879";
  public const string ZH_BACK = "\u4e0a\u4e00\u6b65";
  public const string ZH_NEXT = "\u4e0b\u4e00\u6b65";
  public const string ZH_CANCEL = "\u53d6\u6d88";
  public const string ZH_INSTALL = "\u5b89\u88c5";
  public const string ZH_FINISH = "\u5b8c\u6210";
  public const string ZH_BROWSE = "\u6d4f\u89c8...";
  public const string ZH_CREATE_DESKTOP = "\u521b\u5efa\u684c\u9762\u5feb\u6377\u65b9\u5f0f";
  public const string ZH_CREATE_STARTMENU = "\u521b\u5efa\u5f00\u59cb\u83dc\u5355\u5feb\u6377\u65b9\u5f0f";
  public const string ZH_AUTOSTART = "\u5f00\u673a\u81ea\u542f\u52a8";
  public const string ZH_RUN_AFTER = "\u5b89\u88c5\u5b8c\u6210\u540e\u542f\u52a8\u7a0b\u5e8f";
  public const string ZH_WELCOME_TEXT = "\u6b22\u8fce\u4f7f\u7528\u5b89\u88c5\u5411\u5bfc\uff0c\u5c06\u5b89\u88c5\u5230\u60a8\u7684\u7535\u8111\u3002";
  public const string ZH_DIR_TITLE = "\u9009\u62e9\u5b89\u88c5\u76ee\u5f55";
  public const string ZH_CONFIRM_TITLE = "\u786e\u8ba4\u5b89\u88c5";
  public const string ZH_PROGRESS_TITLE = "\u6b63\u5728\u5b89\u88c5...";
  public const string ZH_DONE_TITLE = "\u5b89\u88c5\u5b8c\u6210";
  public const string ZH_DOWNLOADING = "\u6b63\u5728\u4e0b\u8f7d...";
  public const string ZH_EXTRACTING = "\u6b63\u5728\u89e3\u538b...";
  public const string ZH_INSTALLING = "\u6b63\u5728\u5b89\u88c5...";
  public const string ZH_PROGRESS = "\u8fdb\u5ea6";
  public const string ZH_OK = "\u786e\u5b9a";
  public const string ZH_CONFIRM = "\u786e\u5b9a";
  public const string ZH_CANCEL_BTN = "\u53d6\u6d88";
  public const string ZH_CONFIGURING = "\u6b63\u5728\u914d\u7f6e...";
  public const string ZH_ERR_TITLE = "\u5b89\u88c5\u7a0b\u5e8f\u51fa\u9519";
  public const string ZH_LICENSE_ACCEPT = "\u6211\u5df2\u9605\u8bfb\u5e76\u540c\u610f\u4e0a\u8ff0\u8bb8\u53ef\u534f\u8bae";
  public const string ZH_UPGRADE_DETECTED = "\u68c0\u6d4b\u5230\u5df2\u5b89\u88c5\u7684\u7248\u672c\uff0c\u5c06\u8986\u76d6\u5b89\u88c5\u4e14\u4fdd\u7559\u539f\u6709\u8bbe\u7f6e\u548c\u6570\u636e\u3002";
  public const string ZH_KEEP_DATA_NOTE = "\u63d0\u793a\uff1a\u672c\u5b89\u88c5\u4ec5\u8986\u76d6\u7a0b\u5e8f\u6587\u4ef6\uff0c\u4e0d\u4f1a\u5220\u9664\u7528\u6237\u7684\u914d\u7f6e\u548c\u6570\u636e\u3002";
  public const string ZH_ERR_APP_IN_USE = "\u65e0\u6cd5\u8986\u76d6\u7a0b\u5e8f\u6587\u4ef6\uff0c\u53ef\u80fd\u5ba2\u6237\u7aef\u6b63\u5728\u8fd0\u884c\u3002\u8bf7\u5148\u9000\u51fa\u5ba2\u6237\u7aef\u540e\u91cd\u8bd5\u3002";
  public const string ZH_UPGRADE_PROMPT_TITLE = "\u662f\u5426\u8986\u76d6\u5b89\u88c5";
  public const string ZH_UPGRADE_PROMPT_BODY = "\u68c0\u6d4b\u5230\u60a8\u4e4b\u524d\u5df2\u5b89\u88c5\u8fc7\u5ba2\u6237\u7aef\u3002\r\n\r\n\u662f\u5426\u8981\u8986\u76d6\u66f4\u65b0\uff1f\r\n\r\n\u8bf4\u660e\uff1a\u8986\u76d6\u5b89\u88c5\u53ea\u4f1a\u66f4\u65b0\u7a0b\u5e8f\u6587\u4ef6\uff0c\u4e0d\u4f1a\u5220\u9664\u539f\u6709\u7684\u8bbe\u7f6e\u548c\u6570\u636e\u3002";

  public static string GetLicenseText(string appName)
  {
    return "\u672c\u8f6f\u4ef6\u4ec5\u4f9b\u5185\u90e8\u6d4b\u8bd5\u548c\u6f14\u793a\u4f7f\u7528\u3002\r\n\r\n" +
           "\u4f7f\u7528\u8005\u9700\u786e\u4fdd\u5728\u5408\u6cd5\u5408\u89c4\u7684\u524d\u63d0\u4e0b\u4f7f\u7528\u672c\u8f6f\u4ef6\uff0c\u5e76\u81ea\u884c\u627f\u62c5\u7531\u6b64\u4ea7\u751f\u7684\u6240\u6709\u98ce\u9669\u4e0e\u8d23\u4efb\u3002\r\n\r\n" +
           "\u672c\u5b89\u88c5\u7a0b\u5e8f\u4f1a\u4ece\u670d\u52a1\u5668\u4e0b\u8f7d\u5ba2\u6237\u7aef\u6587\u4ef6\uff0c\u8bf7\u786e\u4fdd\u7f51\u7edc\u7545\u901a\u3002\r\n\r\n" +
           "\u8f6f\u4ef6\u540d\u79f0\uff1a" + appName + "\r\n";
  }

  [STAThread]
  static int Main(string[] args)
  {
    try
    {
      string appId = "${AppId}";
      string displayName = "${DisplayName}";
      string publisher = "${Publisher}";
      string version = "${Version}";
      string downloadUrl = "${DownloadUrl}";
      // showUi kept for backward compatibility, but UI is enforced unless --silent.
      bool showUi = ${showUiStr};

      bool silent = false;
      bool isUninstall = false;
      string customDir = null;
      bool createDesktop = true;
      bool createStartMenu = true;
      bool autoStart = false;

      for (int i = 0; i < args.Length; i++)
      {
        if (args[i].Equals("--silent", StringComparison.OrdinalIgnoreCase) || args[i].Equals("/S", StringComparison.OrdinalIgnoreCase))
          silent = true;
        if (args[i].Equals("--uninstall", StringComparison.OrdinalIgnoreCase))
          isUninstall = true;
        if (args[i].Equals("--dir", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
        {
          customDir = args[i + 1];
          i++;
        }
        if (args[i].Equals("--no-desktop", StringComparison.OrdinalIgnoreCase))
          createDesktop = false;
        if (args[i].Equals("--no-startmenu", StringComparison.OrdinalIgnoreCase))
          createStartMenu = false;
        if (args[i].Equals("--autostart", StringComparison.OrdinalIgnoreCase))
          autoStart = true;
      }

      Log("===== START =====");
      Log("AppId=" + appId + " DisplayName=" + displayName + " Version=" + version);
      Log("DownloadUrl=" + downloadUrl);
      Log("IsAdmin=" + IsAdministrator());
      try { Log("Args=" + string.Join(" ", args ?? new string[0])); } catch { }

      string defaultInstallDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Programs",
        appId
      );

      // For uninstall: use registry InstallLocation if exists
      string regInstall = ReadInstallLocationFromRegistry(appId);
      string installDir = !string.IsNullOrEmpty(regInstall) ? regInstall : (string.IsNullOrEmpty(customDir) ? defaultInstallDir : customDir);
      bool isUpgrade = !string.IsNullOrEmpty(regInstall);

      if (isUninstall)
      {
        Log("Mode=uninstall InstallDir=" + installDir);
        DoUninstall(appId, displayName, installDir);
        return 0;
      }

      // Always show wizard UI unless silent. (User expects detailed Chinese wizard.)
      if (!silent)
      {
        Log("Mode=wizard DefaultDir=" + defaultInstallDir);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        // If already installed, default to existing InstallLocation to do in-place overwrite upgrade.
        var wizard = new WizardForm(appId, displayName, publisher, version, downloadUrl, installDir, createDesktop, createStartMenu, autoStart, isUpgrade);
        Application.Run(wizard);
        Log("WizardExitCode=" + wizard.ExitCode);
        return wizard.ExitCode;
      }

      // silent install
      Log("Mode=silent InstallDir=" + installDir);
      DoInstall(appId, displayName, publisher, version, downloadUrl, installDir, createDesktop, createStartMenu, autoStart, null);
      return 0;
    }
    catch (Exception ex)
    {
      Log("FATAL: " + ex.ToString());
      try
      {
        MessageBox.Show(ex.ToString(), ZH_ERR_TITLE, MessageBoxButtons.OK, MessageBoxIcon.Error);
      }
      catch { }
      return 1;
    }
  }

  public static void DoInstall(string appId, string displayName, string publisher, string version, string downloadUrl, string installDir, bool createDesktop, bool createStartMenu, bool autoStart, IProgressSink ui)
  {
    Directory.CreateDirectory(installDir);

    string startMenuDir = Path.Combine(
      Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
      "Microsoft", "Windows", "Start Menu", "Programs", displayName
    );
    if (createStartMenu) Directory.CreateDirectory(startMenuDir);

    string desktopDir = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
    string appExe = Path.Combine(installDir, "codesprite.exe");
    string uninstallExe = Path.Combine(installDir, "Uninstall.exe");

    // download
    bool isExe = downloadUrl.EndsWith(".exe", StringComparison.OrdinalIgnoreCase);
    bool isZip = downloadUrl.EndsWith(".zip", StringComparison.OrdinalIgnoreCase);
    if (!isExe && !isZip) isExe = true; // default: treat as exe

    if (isExe)
    {
      string tmpExe = Path.Combine(Path.GetTempPath(), "codesprite_" + Guid.NewGuid().ToString("N") + ".exe");
      if (ui != null) ui.SetPhase(ZH_DOWNLOADING, 0, 100, false);
      DownloadWithProgress(downloadUrl, tmpExe, ui);
      if (ui != null) ui.SetPhase(ZH_INSTALLING, 0, 100, true);
      try
      {
        File.Copy(tmpExe, appExe, true);
      }
      catch (Exception ex)
      {
        if (ui != null) ui.Log("Copy failed: " + ex.Message);
        throw new Exception(ZH_ERR_APP_IN_USE);
      }
      SafeDeleteFile(tmpExe);
    }
    else
    {
      string tmpZip = Path.Combine(Path.GetTempPath(), "codesprite_" + Guid.NewGuid().ToString("N") + ".zip");
      if (ui != null) ui.SetPhase(ZH_DOWNLOADING, 0, 100, false);
      DownloadWithProgress(downloadUrl, tmpZip, ui);

      // extract
      string tmpDir = Path.Combine(Path.GetTempPath(), "codesprite_extract_" + Guid.NewGuid().ToString("N"));
      Directory.CreateDirectory(tmpDir);
      if (ui != null) ui.SetPhase(ZH_EXTRACTING, 0, 100, true);
      ExtractZipWithProgress(tmpZip, tmpDir, ui);

      // install files
      string[] exes = Directory.GetFiles(tmpDir, "*.exe", SearchOption.AllDirectories);
      if (exes.Length == 0) throw new Exception("No .exe found in downloaded zip.");
      if (ui != null) ui.SetPhase(ZH_INSTALLING, 0, 100, true);
      try
      {
        File.Copy(exes[0], appExe, true);
      }
      catch (Exception ex)
      {
        if (ui != null) ui.Log("Copy failed: " + ex.Message);
        throw new Exception(ZH_ERR_APP_IN_USE);
      }

      // cleanup
      SafeDeleteFile(tmpZip);
      SafeDeleteDir(tmpDir);
    }

    // self as uninstaller
    File.Copy(Application.ExecutablePath, uninstallExe, true);

    // shortcuts
    if (createStartMenu)
      CreateShortcut(Path.Combine(startMenuDir, displayName + ".lnk"), appExe, installDir, "");
    if (createDesktop)
      CreateShortcut(Path.Combine(desktopDir, displayName + ".lnk"), appExe, installDir, "");
    if (createStartMenu)
      CreateShortcut(Path.Combine(startMenuDir, "\u5378\u8f7d " + displayName + ".lnk"), uninstallExe, installDir, "--uninstall");

    // autostart
    if (ui != null) ui.Log(ZH_CONFIGURING + " Autostart");
    SetAutoStart(appId, autoStart, appExe);

    // ARP entry (per-user)
    WriteUninstallRegistry(appId, displayName, publisher, version, installDir, appExe, uninstallExe);
    CleanupLegacyUninstallKeys();
  }

  public static void DoUninstall(string appId, string displayName, string installDir)
  {
    string startMenuDir = Path.Combine(
      Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
      "Microsoft", "Windows", "Start Menu", "Programs", displayName
    );
    string desktopDir = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);

    SafeDeleteFile(Path.Combine(desktopDir, displayName + ".lnk"));
    SafeDeleteDir(startMenuDir);
    SafeDeleteDir(installDir);
    DeleteUninstallRegistry(appId);
    CleanupLegacyUninstallKeys();
  }

  static void SafeDeleteFile(string path) { try { if (File.Exists(path)) File.Delete(path); } catch { } }
  static void SafeDeleteDir(string path) { try { if (Directory.Exists(path)) Directory.Delete(path, true); } catch { } }

  static void DownloadWithProgress(string url, string outFile, IProgressSink ui)
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
            ui.UpdateProgress(ZH_PROGRESS + "\uff1a" + p + "%", p);
          }
        }
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

  static void ExtractZipWithProgress(string zipPath, string outDir, IProgressSink ui)
  {
    using (var za = ZipFile.OpenRead(zipPath))
    {
      int total = za.Entries.Count;
      int i = 0;
      foreach (var entry in za.Entries)
      {
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
          ui.UpdateProgress(ZH_PROGRESS + "\uff1a" + p + "%", p);
        }
        Application.DoEvents();
      }
    }
  }

  static void CreateShortcut(string lnkPath, string targetPath, string workingDir, string arguments)
  {
    Type t = Type.GetTypeFromProgID("WScript.Shell");
    dynamic shell = Activator.CreateInstance(t);
    dynamic sc = shell.CreateShortcut(lnkPath);
    sc.TargetPath = targetPath;
    sc.WorkingDirectory = workingDir;
    if (!string.IsNullOrEmpty(arguments)) sc.Arguments = arguments;
    sc.Save();
  }

  static string UninstallRegPath(string appId) { return @"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + appId; }

  static void WriteUninstallRegistry(string appId, string displayName, string publisher, string version, string installDir, string appExe, string uninstallExe)
  {
    using (var key = Registry.CurrentUser.CreateSubKey(UninstallRegPath(appId)))
    {
      if (key == null) return;
      key.SetValue("DisplayName", displayName);
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

  static string ReadInstallLocationFromRegistry(string appId)
  {
    try
    {
      // 1) current appId
      using (var key = Registry.CurrentUser.OpenSubKey(UninstallRegPath(appId)))
      {
        if (key != null)
        {
          var v = key.GetValue("InstallLocation") as string;
          if (!string.IsNullOrEmpty(v)) return v;
        }
      }
      // 2) legacy ids (older product names used during development)
      foreach (var legacy in LegacyAppIds())
      {
        using (var k2 = Registry.CurrentUser.OpenSubKey(UninstallRegPath(legacy)))
        {
          if (k2 == null) continue;
          var v2 = k2.GetValue("InstallLocation") as string;
          if (!string.IsNullOrEmpty(v2)) return v2;
        }
      }
      return null;
    }
    catch { return null; }
  }

  static void DeleteUninstallRegistry(string appId)
  {
    try { Registry.CurrentUser.DeleteSubKeyTree(UninstallRegPath(appId), false); } catch { }
  }

  static string[] LegacyAppIds()
  {
    return new string[] { "Copilot", "CursorLike", "Cursor-like" };
  }

  static void CleanupLegacyUninstallKeys()
  {
    foreach (var legacy in LegacyAppIds())
    {
      try { Registry.CurrentUser.DeleteSubKeyTree(UninstallRegPath(legacy), false); } catch { }
    }
  }

  static void SetAutoStart(string appName, bool enable, string appExe)
  {
    try
    {
      using (var rk = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
      {
        if (rk == null) return;
        if (enable) rk.SetValue(appName, "\"" + appExe + "\"");
        else rk.DeleteValue(appName, false);
      }
    }
    catch { }
  }
}

public interface IProgressSink
{
  void SetPhase(string text, int min, int max, bool marquee);
  void UpdateProgress(string text, int value);
  void Log(string line);
}

public class WizardForm : Form, IProgressSink
{
  public int ExitCode = 1;

  private string _appId, _displayName, _publisher, _version, _downloadUrl, _defaultDir;
  private string _installDir;
  private bool _createDesktop;
  private bool _createStartMenu;
  private bool _autoStart;
  private bool _isUpgrade;
  private bool _upgradePrompted = false;

  private Panel _pWelcome, _pLicense, _pDir, _pOptions, _pConfirm, _pProgress, _pDone;
  private Button _btnBack, _btnNext, _btnCancel;
  private TextBox _txtDir;
  private CheckBox _chkDesktop;
  private CheckBox _chkStartMenu;
  private CheckBox _chkAutoStart;
  private CheckBox _chkLicense;
  private Label _lblConfirm;
  private ProgressBar _bar;
  private Label _lblProgress;
  private TextBox _txtLog;
  private CheckBox _chkRun;
  private int _step = 0;

  public WizardForm(string appId, string displayName, string publisher, string version, string downloadUrl, string defaultDir, bool defaultDesktop, bool defaultStartMenu, bool defaultAutoStart, bool isUpgrade)
  {
    _appId = appId; _displayName = displayName; _publisher = publisher; _version = version; _downloadUrl = downloadUrl; _defaultDir = defaultDir;
    _installDir = defaultDir;
    _createDesktop = defaultDesktop;
    _createStartMenu = defaultStartMenu;
    _autoStart = defaultAutoStart;
    _isUpgrade = isUpgrade;

    Text = _displayName + " " + _version + " " + Program.ZH_TITLE_INSTALL;
    Width = 720; Height = 460;
    FormBorderStyle = FormBorderStyle.FixedDialog;
    MaximizeBox = false; MinimizeBox = false;
    StartPosition = FormStartPosition.CenterScreen;
    Shown += (s,e)=> {
      // Only when previously installed: ask for overwrite confirm (OK/Cancel).
      if (_isUpgrade && !_upgradePrompted)
      {
        _upgradePrompted = true;
        var ok = ShowUpgradePrompt();
        if (!ok)
        {
          ExitCode = 2;
          try { Close(); } catch { }
          return;
        }
      }
      try { TopMost = true; } catch { }
      try { Activate(); BringToFront(); } catch { }
      try { TopMost = false; } catch { }
    };

    BuildPages();
    BuildButtons();
    ShowStep(0);
  }

  private void BuildButtons()
  {
    _btnBack = new Button(){ Left=420, Top=380, Width=90, Text=Program.ZH_BACK };
    _btnNext = new Button(){ Left=520, Top=380, Width=90, Text=Program.ZH_NEXT };
    _btnCancel = new Button(){ Left=620, Top=380, Width=75, Text=Program.ZH_CANCEL };

    _btnBack.Click += (s,e)=> { if(_step>0) ShowStep(_step-1); };
    _btnCancel.Click += (s,e)=> { Close(); };
    _btnNext.Click += async (s,e)=> {
      if(_step==2){
        _installDir = _txtDir.Text.Trim();
      }
      if(_step==3){
        _createDesktop = _chkDesktop.Checked;
        _createStartMenu = _chkStartMenu.Checked;
        _autoStart = _chkAutoStart.Checked;
      }
      if(_step==4){
        _btnBack.Enabled=false; _btnNext.Enabled=false; _btnCancel.Enabled=false;
        ShowStep(5);
        try {
          await System.Threading.Tasks.Task.Run(()=> Program.DoInstall(_appId,_displayName,_publisher,_version,_downloadUrl,_installDir,_createDesktop,_createStartMenu,_autoStart,this));
          ExitCode = 0;
          ShowStep(6);
        } catch(Exception ex){
          MessageBox.Show(ex.ToString(), _displayName + " " + Program.ZH_TITLE_INSTALL, MessageBoxButtons.OK, MessageBoxIcon.Error);
          ExitCode = 1;
          Close();
        }
        return;
      }
      if(_step==6){
        if(_chkRun.Checked){
          try { System.Diagnostics.Process.Start(Path.Combine(_installDir,"codesprite.exe")); } catch { }
        }
        Close();
        return;
      }
      ShowStep(_step+1);
    };

    Controls.Add(_btnBack); Controls.Add(_btnNext); Controls.Add(_btnCancel);
  }

  private void BuildPages()
  {
    _pWelcome = new Panel(){ Left=0, Top=0, Width=700, Height=360 };
    var wTitle = new Label(){ Left=30, Top=30, Width=650, Height=28, Font=new Font("Segoe UI",14), Text=_displayName + " " + _version + " " + Program.ZH_TITLE_WELCOME };
    var wText = new Label(){ Left=30, Top=80, Width=650, Height=60, Text=Program.ZH_WELCOME_TEXT };
    _pWelcome.Controls.Add(wTitle); _pWelcome.Controls.Add(wText);

    _pLicense = new Panel(){ Left=0, Top=0, Width=700, Height=360 };
    var lTitle = new Label(){ Left=30, Top=30, Width=650, Height=28, Font=new Font("Segoe UI",12), Text=Program.ZH_TITLE_LICENSE };
    var lText = new TextBox(){ Left=30, Top=70, Width=620, Height=210, Multiline=true, ReadOnly=true, ScrollBars=ScrollBars.Vertical, Text=Program.GetLicenseText(_displayName) };
    _chkLicense = new CheckBox(){ Left=30, Top=290, Width=520, Checked=false, Text=Program.ZH_LICENSE_ACCEPT };
    _pLicense.Controls.Add(lTitle); _pLicense.Controls.Add(lText); _pLicense.Controls.Add(_chkLicense);

    _pDir = new Panel(){ Left=0, Top=0, Width=700, Height=360 };
    var dTitle = new Label(){ Left=30, Top=30, Width=650, Height=28, Font=new Font("Segoe UI",12), Text=Program.ZH_DIR_TITLE };
    _txtDir = new TextBox(){ Left=30, Top=90, Width=520, Text=_defaultDir };
    var btnBrowse = new Button(){ Left=560, Top=88, Width=90, Text=Program.ZH_BROWSE };
    btnBrowse.Click += (s,e)=> { var f=new FolderBrowserDialog(); f.SelectedPath=_txtDir.Text; if(f.ShowDialog()==DialogResult.OK){ _txtDir.Text=f.SelectedPath; } };
    _pDir.Controls.Add(dTitle); _pDir.Controls.Add(_txtDir); _pDir.Controls.Add(btnBrowse);

    _pOptions = new Panel(){ Left=0, Top=0, Width=700, Height=360 };
    var oTitle = new Label(){ Left=30, Top=30, Width=650, Height=28, Font=new Font("Segoe UI",12), Text=Program.ZH_TITLE_OPTIONS };
    var oHint = new Label(){ Left=30, Top=70, Width=650, Height=40, Text="\u60a8\u53ef\u4ee5\u4fee\u6539\u5feb\u6377\u65b9\u5f0f\u4e0e\u81ea\u542f\u52a8\u7b49\u9009\u9879\u3002" };
    _chkDesktop = new CheckBox(){ Left=30, Top=120, Width=360, Checked=_createDesktop, Text=Program.ZH_CREATE_DESKTOP };
    _chkStartMenu = new CheckBox(){ Left=30, Top=150, Width=420, Checked=_createStartMenu, Text=Program.ZH_CREATE_STARTMENU };
    _chkAutoStart = new CheckBox(){ Left=30, Top=180, Width=360, Checked=_autoStart, Text=Program.ZH_AUTOSTART };
    _pOptions.Controls.Add(oTitle); _pOptions.Controls.Add(oHint); _pOptions.Controls.Add(_chkDesktop); _pOptions.Controls.Add(_chkStartMenu); _pOptions.Controls.Add(_chkAutoStart);

    _pConfirm = new Panel(){ Left=0, Top=0, Width=700, Height=360 };
    var cTitle = new Label(){ Left=30, Top=30, Width=650, Height=28, Font=new Font("Segoe UI",12), Text=Program.ZH_CONFIRM_TITLE };
    _lblConfirm = new Label(){ Left=30, Top=80, Width=650, Height=120, Text="" };
    _pConfirm.Controls.Add(cTitle); _pConfirm.Controls.Add(_lblConfirm);

    _pProgress = new Panel(){ Left=0, Top=0, Width=700, Height=360 };
    var pTitle = new Label(){ Left=30, Top=30, Width=650, Height=28, Font=new Font("Segoe UI",12), Text=Program.ZH_PROGRESS_TITLE };
    _lblProgress = new Label(){ Left=30, Top=90, Width=650, Height=30, Text=Program.ZH_PROGRESS + "\uff1a0%" };
    _bar = new ProgressBar(){ Left=30, Top=130, Width=620, Height=18, Minimum=0, Maximum=100, Value=0 };
    _txtLog = new TextBox(){ Left=30, Top=160, Width=620, Height=170, Multiline=true, ReadOnly=true, ScrollBars=ScrollBars.Vertical, Text="" };
    _pProgress.Controls.Add(pTitle); _pProgress.Controls.Add(_lblProgress); _pProgress.Controls.Add(_bar); _pProgress.Controls.Add(_txtLog);

    _pDone = new Panel(){ Left=0, Top=0, Width=700, Height=360 };
    var fTitle = new Label(){ Left=30, Top=30, Width=650, Height=28, Font=new Font("Segoe UI",12), Text=Program.ZH_DONE_TITLE };
    var fText = new Label(){ Left=30, Top=80, Width=650, Height=40, Text="\u5df2\u6210\u529f\u5b89\u88c5\u3002" };
    _chkRun = new CheckBox(){ Left=30, Top=130, Width=360, Checked=true, Text=Program.ZH_RUN_AFTER };
    _pDone.Controls.Add(fTitle); _pDone.Controls.Add(fText); _pDone.Controls.Add(_chkRun);

    Controls.Add(_pWelcome); Controls.Add(_pLicense); Controls.Add(_pDir); Controls.Add(_pOptions); Controls.Add(_pConfirm); Controls.Add(_pProgress); Controls.Add(_pDone);
  }

  private void ShowStep(int step)
  {
    _step = step;
    _pWelcome.Visible = step==0;
    _pLicense.Visible = step==1;
    _pDir.Visible = step==2;
    _pOptions.Visible = step==3;
    _pConfirm.Visible = step==4;
    _pProgress.Visible = step==5;
    _pDone.Visible = step==6;

    _btnBack.Enabled = step>0 && step<5;
    _btnCancel.Enabled = step<5;

    // license gate
    if(step==1){
      _btnNext.Enabled = _chkLicense.Checked;
      _chkLicense.CheckedChanged += (s,e)=>{ _btnNext.Enabled = _chkLicense.Checked; };
    } else {
      _btnNext.Enabled = true;
    }

    // Progress page: forbid any navigation during install to prevent accidental clicks.
    if (step==5)
    {
      _btnBack.Enabled = false;
      _btnNext.Enabled = false;
      _btnCancel.Enabled = false;
    }

    if(step==4){
      _btnNext.Text = Program.ZH_INSTALL;
      _lblConfirm.Text =
        "\u4e0b\u8f7d\u5730\u5740\uff1a " + _downloadUrl + "\n" +
        "\u5b89\u88c5\u76ee\u5f55\uff1a " + _txtDir.Text + "\n" +
        Program.ZH_CREATE_DESKTOP + "\uff1a " + (_chkDesktop.Checked ? "\u662f" : "\u5426") + "\n" +
        Program.ZH_CREATE_STARTMENU + "\uff1a " + (_chkStartMenu.Checked ? "\u662f" : "\u5426") + "\n" +
        Program.ZH_AUTOSTART + "\uff1a " + (_chkAutoStart.Checked ? "\u662f" : "\u5426");
    } else if(step==6){
      _btnNext.Text = Program.ZH_FINISH;
      _btnNext.Enabled = true;
      _btnBack.Enabled = false;
      _btnCancel.Enabled = false;
    } else {
      _btnNext.Text = Program.ZH_NEXT;
    }
  }

  public void SetPhase(string text, int min, int max, bool marquee)
  {
    if (InvokeRequired) { BeginInvoke(new Action(()=>SetPhase(text,min,max,marquee))); return; }
    _lblProgress.Text = text;
    _bar.Minimum = min; _bar.Maximum = max;
    _bar.Style = marquee ? ProgressBarStyle.Marquee : ProgressBarStyle.Continuous;
    _bar.MarqueeAnimationSpeed = marquee ? 30 : 0;
    if (!marquee) _bar.Value = min;
  }

  public void UpdateProgress(string text, int value)
  {
    if (InvokeRequired) { BeginInvoke(new Action(()=>UpdateProgress(text,value))); return; }
    _lblProgress.Text = text;
    if (_bar.Style != ProgressBarStyle.Continuous) { _bar.Style = ProgressBarStyle.Continuous; _bar.MarqueeAnimationSpeed = 0; }
    if (value < _bar.Minimum) value = _bar.Minimum;
    if (value > _bar.Maximum) value = _bar.Maximum;
    _bar.Value = value;
  }

  public void Log(string line)
  {
    if (InvokeRequired) { BeginInvoke(new Action(()=>Log(line))); return; }
    if (_txtLog == null) return;
    _txtLog.AppendText("[" + DateTime.Now.ToString("HH:mm:ss") + "] " + line + "\r\n");
  }

  private bool ShowUpgradePrompt()
  {
    try
    {
      using (var f = new Form())
      {
        f.Text = Program.ZH_UPGRADE_PROMPT_TITLE;
        f.Width = 520; f.Height = 260;
        f.FormBorderStyle = FormBorderStyle.FixedDialog;
        f.MaximizeBox = false; f.MinimizeBox = false;
        f.StartPosition = FormStartPosition.CenterParent;
        f.ShowInTaskbar = false;

        var lbl = new Label(){ Left=18, Top=18, Width=470, Height=140, Text=Program.ZH_UPGRADE_PROMPT_BODY };
        var btnOk = new Button(){ Left=300, Top=170, Width=80, Text=Program.ZH_CONFIRM, DialogResult=DialogResult.OK };
        var btnCancel = new Button(){ Left=392, Top=170, Width=80, Text=Program.ZH_CANCEL_BTN, DialogResult=DialogResult.Cancel };

        f.Controls.Add(lbl);
        f.Controls.Add(btnOk);
        f.Controls.Add(btnCancel);
        f.AcceptButton = btnOk;
        f.CancelButton = btnCancel;

        var r = f.ShowDialog(this);
        return r == DialogResult.OK;
      }
    }
    catch
    {
      // If dialog fails for any reason, default to allow install to proceed.
      return true;
    }
  }
}
'@

$cs = $cs.Replace('${AppId}', $AppId)
$cs = $cs.Replace('${DisplayName}', $DisplayName)
$cs = $cs.Replace('${Publisher}', $Publisher)
$cs = $cs.Replace('${Version}', $Version)
$cs = $cs.Replace('${DownloadUrl}', $DownloadUrl)
$cs = $cs.Replace('${showUiStr}', $showUiStr)

[System.IO.File]::WriteAllText($csPath, $cs, (New-Object System.Text.UTF8Encoding($false)))

# 如果输出文件被占用，先尝试删除，避免 CS0016
if (Test-Path $OutExe) { try { Remove-Item -Force $OutExe -ErrorAction SilentlyContinue } catch { } }

# Compile with .NET Framework csc.exe
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if(-not (Test-Path $csc)){ $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if(-not (Test-Path $csc)){ throw "csc.exe not found" }

$refs = '/r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll'
$cscArgs = "/nologo /optimize /target:winexe /codepage:65001 /out:$OutExe $csPath $refs"

$log = Join-Path $artifactDir 'CodeSpriteInstaller.compile.log'
if (Test-Path $log) { Remove-Item -Force $log -ErrorAction SilentlyContinue }
New-Item -ItemType File -Force -Path $log | Out-Null

# 用 cmd.exe 重定向到文件，避免 stdout/stderr buffer 导致 csc 卡死
$cmd = '""' + $csc + '" ' + $cscArgs + ' 1>"' + $log + '" 2>&1"'
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'cmd.exe'
$psi.Arguments = '/c ' + $cmd
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$p = [System.Diagnostics.Process]::Start($psi)
$exited = $p.WaitForExit(55000)
if(-not $exited){ try { $p.Kill() } catch {}; $p.WaitForExit() }
if($p.ExitCode -ne 0){
  $txt = if(Test-Path $log){ (Get-Content -Raw $log) } else { '(no log created)' }
  throw ('csc failed exit=' + $p.ExitCode + ' cmd=' + $cmd + ' output=' + $txt)
}

Get-Item $OutExe | Select-Object FullName,Length,LastWriteTime | Format-List | Out-String


