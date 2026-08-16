<#
.SYNOPSIS
    Registers the daily maintenance run in Task Scheduler.

.DESCRIPTION
    One task beside the service supervisor does everything that should happen on
    its own: the catalogue scan, the metadata queue, the film lookups and the
    library digest. -MultipleInstances IgnoreNew matters here - a run longer
    than a day must not start a second one alongside itself, and that setting is
    the only thing preventing overlap (the code holds no lock of its own).

    Registration needs an elevated PowerShell/UAC once.

    Keep this file pure ASCII: Windows PowerShell 5.1 reads a .ps1 without a BOM
    using the system ANSI code page, and a stray accent breaks parsing.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string] $TaskName = 'TryHackX Media Maintenance',
    [string] $At = '04:15',
    [switch] $Replace
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$MediaPython = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
$ConfigPath = Join-Path $ProjectRoot 'config\config.local.toml'
$RunnerPath = Join-Path $PSScriptRoot 'run-maintenance-windows.ps1'

if (-not (Test-Path -LiteralPath $MediaPython)) {
    throw 'Missing .venv. Run python scripts\install.py first.'
}
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw 'Missing private config\config.local.toml.'
}
if (-not (Test-Path -LiteralPath $RunnerPath)) {
    throw 'Missing scripts\run-maintenance-windows.ps1.'
}

$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Existing -and -not $Replace) {
    throw "Scheduled task already exists: $TaskName. Use -Replace to recreate it."
}
if ($Existing -and $Replace -and $PSCmdlet.ShouldProcess($TaskName, 'replace scheduled task')) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$PowerShell = Join-Path $PSHOME 'powershell.exe'
$Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $RunnerPath +
    '" -ConfigPath "' + $ConfigPath + '"'
$Action = New-ScheduledTaskAction -Execute $PowerShell -Argument $Arguments -WorkingDirectory $ProjectRoot
$Trigger = New-ScheduledTaskTrigger -Daily -At $At -RandomDelay (New-TimeSpan -Minutes 15)
$Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$Principal = New-ScheduledTaskPrincipal -UserId $Identity -LogonType S4U -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 6) `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

if ($PSCmdlet.ShouldProcess($TaskName, 'register daily maintenance task')) {
    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $Action `
        -Trigger $Trigger `
        -Principal $Principal `
        -Settings $Settings `
        -Description 'Daily TryHackX Media Server maintenance: catalogue scan, metadata queue, film lookups, digest.' | Out-Null
    Write-Output "Registered scheduled task: $TaskName ($Identity, S4U, daily at $At)."
}
