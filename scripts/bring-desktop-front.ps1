param(
  [string]$ProcessName = "cursor-like",
  [switch]$Move = $false,
  [int]$X = 80,
  [int]$Y = 80,
  [int]$W = 1200,
  [int]$H = 800
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
}
"@

$p = Get-Process -Name $ProcessName -ErrorAction Stop | Select-Object -First 1
$h = $p.MainWindowHandle
if ($h -eq 0) {
  Write-Error "Process '$ProcessName' has no MainWindowHandle (maybe still starting). Try again in a few seconds."
}

# 9 = SW_RESTORE
[Win32]::ShowWindowAsync($h, 9) | Out-Null
if ($Move) {
  [Win32]::MoveWindow($h, $X, $Y, $W, $H, $true) | Out-Null
}
[Win32]::SetForegroundWindow($h) | Out-Null

Write-Host "Brought '$ProcessName' to foreground. (pid=$($p.Id), hwnd=$h)"










