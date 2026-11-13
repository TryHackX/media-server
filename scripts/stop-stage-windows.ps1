[CmdletBinding()]
param(
    [string] $TaskName = 'TryHackX Media Transfer Stage'
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $ProjectRoot 'config\config.local.toml'
$RuntimePath = Join-Path $ProjectRoot 'runtime'

if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw 'Brak prywatnego config\config.local.toml.'
}

$InServer = $false
$ServerPort = $null
foreach ($Line in Get-Content -LiteralPath $ConfigPath -Encoding UTF8) {
    if ($Line -match '^\s*\[([^]]+)\]\s*$') {
        $InServer = $Matches[1] -eq 'server'
        continue
    }
    if ($InServer -and $Line -match '^\s*port\s*=\s*([0-9]{1,5})\s*$') {
        $ServerPort = [int] $Matches[1]
    }
}
if (-not $ServerPort -or $ServerPort -gt 65535) {
    throw 'Cannot read the staging port.'
}

$Listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $ServerPort -State Listen -ErrorAction SilentlyContinue
if (-not $Listener) {
    Remove-Item -LiteralPath (Join-Path $RuntimePath 'transfer-stage.pid') -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $RuntimePath 'transfer-stage.json') -Force -ErrorAction SilentlyContinue
    Write-Output "Service on 127.0.0.1:$ServerPort is already stopped."
    exit 0
}

$ScheduledTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($ScheduledTask -and $ScheduledTask.State -eq 'Running') {
    $TaskArguments = [string] $ScheduledTask.Actions[0].Arguments
    if (-not $TaskArguments.Contains('run-stage-supervisor-windows.ps1')) {
        throw "Scheduled task $TaskName does not use the expected staging supervisor."
    }
    Stop-ScheduledTask -TaskName $TaskName
    for ($Attempt = 0; $Attempt -lt 40; $Attempt++) {
        $Remaining = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $ServerPort -State Listen -ErrorAction SilentlyContinue
        if (-not $Remaining) {
            break
        }
        Start-Sleep -Milliseconds 250
    }
    if (Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $ServerPort -State Listen -ErrorAction SilentlyContinue) {
        throw "Scheduled staging task stopped, but a listener still owns the configured port."
    }
    Remove-Item -LiteralPath (Join-Path $RuntimePath 'transfer-stage.pid') -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $RuntimePath 'transfer-stage.json') -Force -ErrorAction SilentlyContinue
    Write-Output "Stopped supervised task $TaskName on 127.0.0.1:$ServerPort."
    exit 0
}

$ServerProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($Listener.OwningProcess)"
$CommandLine = [string] $ServerProcess.CommandLine
$NormalizedConfig = $ConfigPath.Replace('/', '\')
if ($ServerProcess.Name -ne 'python.exe' -or
    -not $CommandLine.Contains('-m media_server') -or
    -not $CommandLine.Replace('/', '\').Contains($NormalizedConfig)) {
    throw "Odmowa zatrzymania: PID $($Listener.OwningProcess) nie jest procesem tego stagingu."
}

$ScheduledTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($ScheduledTask) {
    $TaskArguments = [string] $ScheduledTask.Actions[0].Arguments
    if (-not $TaskArguments.Contains('run-stage-supervisor-windows.ps1')) {
        throw "Scheduled task $TaskName does not use the expected staging supervisor."
    }
    if ($ScheduledTask.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $TaskName
        for ($Attempt = 0; $Attempt -lt 40; $Attempt++) {
            $Remaining = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $ServerPort -State Listen -ErrorAction SilentlyContinue
            if (-not $Remaining) {
                break
            }
            Start-Sleep -Milliseconds 250
        }
        if (Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $ServerPort -State Listen -ErrorAction SilentlyContinue) {
            throw "Scheduled staging task did not stop within the expected time."
        }
        Remove-Item -LiteralPath (Join-Path $RuntimePath 'transfer-stage.pid') -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath (Join-Path $RuntimePath 'transfer-stage.json') -Force -ErrorAction SilentlyContinue
        Write-Output "Stopped supervised task $TaskName on 127.0.0.1:$ServerPort."
        exit 0
    }
}

$ParentProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($ServerProcess.ParentProcessId)" -ErrorAction SilentlyContinue
Stop-Process -Id $ServerProcess.ProcessId
$ServerProcessId = $ServerProcess.ProcessId
for ($Attempt = 0; $Attempt -lt 20; $Attempt++) {
    if (-not (Get-Process -Id $ServerProcessId -ErrorAction SilentlyContinue)) {
        break
    }
    Start-Sleep -Milliseconds 250
}
if (Get-Process -Id $ServerProcessId -ErrorAction SilentlyContinue) {
    throw "Process $ServerProcessId did not stop within the expected time."
}

if ($ParentProcess -and
    $ParentProcess.Name -eq 'python.exe' -and
    ([string] $ParentProcess.CommandLine).Contains('-m media_server')) {
    Stop-Process -Id $ParentProcess.ProcessId -ErrorAction SilentlyContinue
}

Remove-Item -LiteralPath (Join-Path $RuntimePath 'transfer-stage.pid') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $RuntimePath 'transfer-stage.json') -Force -ErrorAction SilentlyContinue
Write-Output "Zatrzymano TryHackX Media Server na 127.0.0.1:$ServerPort (PID $ServerProcessId)."
