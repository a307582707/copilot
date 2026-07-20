@echo off
setlocal
set SCRIPT=%~dp0start-backend.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
endlocal
