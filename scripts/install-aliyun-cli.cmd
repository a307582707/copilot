@echo off
setlocal
set SCRIPT=%~dp0install-aliyun-cli.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
endlocal









