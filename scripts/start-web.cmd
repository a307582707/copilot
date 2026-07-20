@echo off
setlocal
set SCRIPT=%~dp0start-web.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
endlocal









