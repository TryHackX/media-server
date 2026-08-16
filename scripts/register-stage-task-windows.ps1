[CmdletBinding(SupportsShouldProcess)]
param(
    [string] $TaskName = 'TryHackX Media Transfer Stage',
    [switch] $Replace
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$MediaPython = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
$ConfigPath = Join-Path $ProjectRoot 'config\config.local.toml'
$SupervisorPath = Join-Path $PSScriptRoot 'run-stage-supervisor-windows.ps1'

if (-not (Test-Path -LiteralPath $MediaPython)) {
    throw 'Missing .venv. Run python scripts\install.py first.'
}
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw 'Missing private config\config.local.toml.'
}
if (-not (Test-Path -LiteralPath $SupervisorPath)) {
    throw 'Missing scripts\run-stage-supervisor-windows.ps1.'
}

$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Existing -and -not $Replace) {
    throw "Scheduled task already exists: $TaskName. Use -Replace to recreate it."
}
if ($Existing -and $Replace -and $PSCmdlet.ShouldProcess($TaskName, 'replace scheduled task')) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$PowerShell = Join-Path $PSHOME 'powershell.exe'
$Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $SupervisorPath +
    '" -ConfigPath "' + $ConfigPath + '"'
$Action = New-ScheduledTaskAction -Execute $PowerShell -Argument $Arguments -WorkingDirectory $ProjectRoot
$Trigger = New-ScheduledTaskTrigger -AtStartup -RandomDelay (New-TimeSpan -Seconds 30)
$Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$Principal = New-ScheduledTaskPrincipal -UserId $Identity -LogonType S4U -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

if ($PSCmdlet.ShouldProcess($TaskName, 'register supervised startup task')) {
    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $Action `
        -Trigger $Trigger `
        -Principal $Principal `
        -Settings $Settings `
        -Description 'Supervised local TryHackX Media Server transfer service; loopback only.' | Out-Null
    Write-Output "Registered scheduled task: $TaskName ($Identity, S4U, limited privileges)."
}
