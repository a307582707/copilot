@echo off
setlocal
set SCRIPT=%~dp0build-web.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
endlocal









