@echo off
rem TryHackX Media Server - instalator i konfigurator dla Windows (WampServer).
rem Dwuklik uruchamia kreator; o uprawnienia administratora (UAC) poprosi sam.
rem
rem   Zainstaluj.cmd                         kreator (instalacja albo zmiana ustawien)
rem   Zainstaluj.cmd -DryRun                 kreator, ktory niczego nie zmienia - tylko pokazuje
rem   Zainstaluj.cmd -Preview                zrzuty wszystkich stron do scratch\renders\installer
rem   Zainstaluj.cmd -Language en            English
rem
rem Polityka wykonywania skryptow jest pomijana wylacznie dla tego jednego procesu.
rem Plik celowo bez polskich znakow: cmd.exe czyta go w stronie kodowej konsoli.
setlocal
rem Uruchomiony z PowerShell 7 dostalby jego PSModulePath (najpierw moduly 7), a Windows PowerShell 5.1
rem wzialby wtedy nie swoj Microsoft.PowerShell.Utility. Bez tej zmiennej 5.1 sklada wlasna, domyslna.
set "PSModulePath="
title TryHackX Media Server
set "SETUP=%~dp0installer\Setup.ps1"
if not exist "%SETUP%" (
  echo.
  echo Nie znaleziono installer\Setup.ps1.
  echo Rozpakuj cale archiwum i uruchom Zainstaluj.cmd z rozpakowanego folderu.
  echo.
  echo installer\Setup.ps1 was not found.
  echo Extract the whole archive and run Zainstaluj.cmd from the extracted folder.
  echo.
  pause
  exit /b 1
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File "%SETUP%" %*
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" if "%~1"=="" (
  echo.
  echo Kreator zakonczyl sie bledem ^(kod %CODE%^). / The wizard ended with an error ^(code %CODE%^).
  pause
)
exit /b %CODE%
