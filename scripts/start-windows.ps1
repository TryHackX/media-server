$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$MediaPython = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $MediaPython)) {
    throw 'Brak .venv. Najpierw uruchom: python scripts\install.py'
}
& $MediaPython -m media_server --config (Join-Path $ProjectRoot 'config\config.local.toml') serve
exit $LASTEXITCODE
