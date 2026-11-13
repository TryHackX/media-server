[CmdletBinding(SupportsShouldProcess)]
param(
    [string] $TaskName = 'TryHackX Media Transfer Stage'
)

$ErrorActionPreference = 'Stop'
$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $Existing) {
    Write-Output "Scheduled task is already absent: $TaskName."
    exit 0
}
if ($PSCmdlet.ShouldProcess($TaskName, 'unregister scheduled task')) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Write-Output "Unregistered scheduled task: $TaskName."
