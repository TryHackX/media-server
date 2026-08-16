<#
.SYNOPSIS
    One scheduled run: catalogue scan, metadata queue, film lookups and the
    weekly library digest.

.DESCRIPTION
    This is the body of the Task Scheduler job registered by
    scripts\register-maintenance-task-windows.ps1. The two halves are
    deliberately independent: a Filmweb outage must not hold back the mail, and
    the mail must not hide a failed scan, so the digest runs even when the
    Python side reported an error and the exit code carries the sum of both.

    A scheduled task has no systemd journal, so both outputs are appended to
    logs\maintenance.log, which is trimmed so it cannot grow without end.

    Keep this file pure ASCII: Windows PowerShell 5.1 reads a .ps1 without a BOM
    using the system ANSI code page, and a stray accent breaks parsing.
#>
[CmdletBinding()]
param(
    [string] $ConfigPath,
    [int] $MetadataLimit = 500,
    [int] $TitlesLimit = 50,
    [switch] $SkipDigest
)

$ErrorActionPreference = 'Stop'
# Both children report in Polish. Python picks the console code page for a
# redirected stdout unless told otherwise, and PHP always writes UTF-8, so this
# makes the two agree before anything reaches the log.
$env:PYTHONIOENCODING = 'utf-8'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not $ConfigPath) { $ConfigPath = Join-Path $ProjectRoot 'config\config.local.toml' }
$Python = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
$LogDirectory = Join-Path $ProjectRoot 'logs'
$LogPath = Join-Path $LogDirectory 'maintenance.log'
$MaxLogBytes = 1MB
$KeepLines = 400

if (-not (Test-Path -LiteralPath $Python)) { throw "Missing $Python. Run python scripts\install.py first." }
if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "Missing private configuration: $ConfigPath" }
if (-not (Test-Path -LiteralPath $LogDirectory)) { New-Item -ItemType Directory -Path $LogDirectory | Out-Null }

# Add-Content -Encoding utf8 stamps a BOM into the middle of nothing on 5.1;
# the .NET writer appends plain UTF-8 the way every reader expects.
$Utf8 = New-Object System.Text.UTF8Encoding $false

function Add-Log {
    param([string] $Text)
    [System.IO.File]::AppendAllText($LogPath, $Text + [Environment]::NewLine, $Utf8)
}

function Write-Log {
    param([string] $Message)
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Add-Log "$stamp  $Message"
}

function Invoke-Step {
    <#
        Start-Process rather than a plain call: it yields the native exit code
        without folding stderr into the PowerShell pipeline, which in 5.1 turns
        every stderr line into an error record and breaks $?.
    #>
    param([string] $Label, [string] $Exe, [string[]] $Arguments)

    $stdout = [System.IO.Path]::GetTempFileName()
    $stderr = [System.IO.Path]::GetTempFileName()
    try {
        $quoted = $Arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }
        $process = Start-Process -FilePath $Exe -ArgumentList $quoted -WorkingDirectory $ProjectRoot `
            -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        $code = $process.ExitCode
        Write-Log "$Label - exit code $code"
        foreach ($file in @($stdout, $stderr)) {
            $text = (Get-Content -LiteralPath $file -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)
            if ($text) { Add-Log $text.TrimEnd() }
        }
        return $code
    } finally {
        Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
    }
}

Write-Log '--- maintenance run started ---'

$failures = 0
$maintenanceCode = Invoke-Step -Label 'maintenance' -Exe $Python -Arguments @(
    '-m', 'media_server', '--config', $ConfigPath, 'maintenance',
    '--metadata-limit', "$MetadataLimit", '--titles-limit', "$TitlesLimit"
)
if ($maintenanceCode -ne 0) { $failures++ }

if ($SkipDigest) {
    Write-Log 'digest - skipped (-SkipDigest)'
} else {
    $php = (Get-Command php -ErrorAction SilentlyContinue)
    if ($null -eq $php) {
        # Nobody is subscribed to the digest by default, so php missing from
        # PATH is not a server failure - but it has to be visible, not silent.
        Write-Log 'digest - SKIPPED: php is not on PATH'
    } else {
        $previous = $env:TRYHACKX_BRIDGE_CONFIG
        $env:TRYHACKX_BRIDGE_CONFIG = $ConfigPath
        try {
            $digestCode = Invoke-Step -Label 'digest' -Exe $php.Source -Arguments @(
                (Join-Path $ProjectRoot 'integrations\php\stage\digest.php')
            )
            if ($digestCode -ne 0) { $failures++ }
        } finally {
            $env:TRYHACKX_BRIDGE_CONFIG = $previous
        }
    }
}

Write-Log "--- maintenance run finished, failed steps: $failures ---"

if ((Get-Item -LiteralPath $LogPath).Length -gt $MaxLogBytes) {
    $tail = Get-Content -LiteralPath $LogPath -Tail $KeepLines -Encoding UTF8
    [System.IO.File]::WriteAllLines($LogPath, $tail, $Utf8)
}

exit $failures
