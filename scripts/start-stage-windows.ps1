[CmdletBinding()]
param(
    [ValidateRange(1, 120)]
    [int] $WaitSeconds = 30,
    [string] $TaskName = 'TryHackX Media Transfer Stage'
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$MediaPython = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
$ConfigPath = Join-Path $ProjectRoot 'config\config.local.toml'
$RuntimePath = Join-Path $ProjectRoot 'runtime'
$LogsPath = Join-Path $ProjectRoot 'logs'

if (-not (Test-Path -LiteralPath $MediaPython)) {
    throw 'Brak .venv. Najpierw uruchom: python scripts\install.py'
}
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw 'Brak prywatnego config\config.local.toml.'
}

$InServer = $false
$ServerHost = $null
$ServerPort = $null
foreach ($Line in Get-Content -LiteralPath $ConfigPath -Encoding UTF8) {
    if ($Line -match '^\s*\[([^]]+)\]\s*$') {
        $InServer = $Matches[1] -eq 'server'
        continue
    }
    if (-not $InServer) {
        continue
    }
    if ($Line -match '^\s*host\s*=\s*"([^"]+)"\s*$') {
        $ServerHost = $Matches[1]
    }
    if ($Line -match '^\s*port\s*=\s*([0-9]{1,5})\s*$') {
        $ServerPort = [int] $Matches[1]
    }
}
if ($ServerHost -ne '127.0.0.1' -or -not $ServerPort -or $ServerPort -gt 65535) {
    throw 'Staging Windows wymaga poprawnego bindu 127.0.0.1 i portu 1..65535.'
}

$Existing = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $ServerPort -State Listen -ErrorAction SilentlyContinue
if ($Existing) {
    try {
        $Health = Invoke-RestMethod -Uri "http://127.0.0.1:$ServerPort/health/live" -TimeoutSec 3
    } catch {
        throw "Port $ServerPort is occupied by another or unhealthy process (PID $($Existing.OwningProcess))."
    }
    if ($Health.status -eq 'ok') {
        Write-Output "Service is already running on 127.0.0.1:$ServerPort (PID $($Existing.OwningProcess))."
        exit 0
    }
}

$ScheduledTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($ScheduledTask) {
    $TaskArguments = [string] $ScheduledTask.Actions[0].Arguments
    if (-not $TaskArguments.Contains('run-stage-supervisor-windows.ps1')) {
        throw "Scheduled task $TaskName does not use the expected staging supervisor."
    }
    if ($ScheduledTask.State -ne 'Running') {
        Start-ScheduledTask -TaskName $TaskName
    }
    $Deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
    $Listener = $null
    while ([DateTime]::UtcNow -lt $Deadline) {
        try {
            $Health = Invoke-RestMethod -Uri "http://127.0.0.1:$ServerPort/health/live" -TimeoutSec 2
            if ($Health.status -eq 'ok') {
                $Listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $ServerPort -State Listen -ErrorAction Stop
                break
            }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    if (-not $Listener) {
        throw "Scheduled staging task did not pass its healthcheck within $WaitSeconds seconds."
    }
    Write-Output "Started supervised task $TaskName on 127.0.0.1:$ServerPort (PID $($Listener.OwningProcess))."
    exit 0
}

New-Item -ItemType Directory -Path $RuntimePath, $LogsPath -Force | Out-Null
$StdoutPath = Join-Path $LogsPath 'transfer-stage.out.log'
$StderrPath = Join-Path $LogsPath 'transfer-stage.err.log'
$Process = Start-Process -FilePath $MediaPython `
    -ArgumentList @('-m', 'media_server', '--config', $ConfigPath, 'serve') `
    -WorkingDirectory $ProjectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $StdoutPath `
    -RedirectStandardError $StderrPath `
    -PassThru

$Deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
$Listener = $null
while ([DateTime]::UtcNow -lt $Deadline) {
    if ($Process.HasExited) {
        break
    }
    try {
        $Health = Invoke-RestMethod -Uri "http://127.0.0.1:$ServerPort/health/live" -TimeoutSec 2
        if ($Health.status -eq 'ok') {
            $Listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $ServerPort -State Listen -ErrorAction Stop
            break
        }
    } catch {
        Start-Sleep -Milliseconds 500
    }
}

if (-not $Listener) {
    if (-not $Process.HasExited) {
        Stop-Process -Id $Process.Id -Force
    }
    Get-Content -LiteralPath $StderrPath -Tail 40 -ErrorAction SilentlyContinue
    throw 'Transfer service did not pass its healthcheck.'
}

$State = [ordered]@{
    launcher_pid = $Process.Id
    listener_pid = $Listener.OwningProcess
    address = "127.0.0.1:$ServerPort"
    started_at_utc = [DateTime]::UtcNow.ToString('o')
}
$StateJson = $State | ConvertTo-Json
[IO.File]::WriteAllText(
    (Join-Path $RuntimePath 'transfer-stage.json'),
    $StateJson,
    [Text.UTF8Encoding]::new($false)
)
Set-Content -LiteralPath (Join-Path $RuntimePath 'transfer-stage.pid') -Value $Process.Id -Encoding ASCII
Write-Output ($State | ConvertTo-Json -Compress)
