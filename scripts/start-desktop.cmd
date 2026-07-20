@echo off
setlocal
set SCRIPT=%~dp0start-desktop.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
endlocal