@echo off
setlocal
cd /d "%~dp0.."
set "MEDIA_PYTHON=.venv\Scripts\python.exe"
if not exist "%MEDIA_PYTHON%" (
  echo Brak .venv. Najpierw uruchom: python scripts\install.py
  exit /b 1
)
"%MEDIA_PYTHON%" -m media_server --config config\config.local.toml serve
