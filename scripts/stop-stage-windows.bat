@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-stage-windows.ps1" %*
exit /b %ERRORLEVEL%
