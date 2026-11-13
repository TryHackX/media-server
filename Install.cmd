@echo off
rem TryHackX Media Server - installer and configurator for Windows (WampServer).
rem The English twin of Zainstaluj.cmd: the same wizard, in English from the first page
rem (the language can still be switched there). Double-click it; it asks for UAC itself.
rem
rem   Install.cmd              the wizard (installation, or changing settings)
rem   Install.cmd -DryRun      a wizard that changes nothing - it only shows what it would do
rem
rem The execution policy is bypassed for this one process only.
setlocal
rem Started from PowerShell 7 it would inherit 7's PSModulePath (7's modules first), and Windows
rem PowerShell 5.1 would then pick 7's Microsoft.PowerShell.Utility. Without it, 5.1 builds its own default.
set "PSModulePath="
title TryHackX Media Server
set "SETUP=%~dp0installer\Setup.ps1"
if not exist "%SETUP%" (
  echo.
  echo installer\Setup.ps1 was not found.
  echo Extract the whole archive and run Install.cmd from the extracted folder.
  echo.
  pause
  exit /b 1
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File "%SETUP%" -Language en %*
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" if "%~1"=="" (
  echo.
  echo The wizard ended with an error ^(code %CODE%^).
  pause
)
exit /b %CODE%
