<#
.SYNOPSIS
    TryHackX Media Server - installer and configurator for Windows (WampServer).

.DESCRIPTION
    Started by Zainstaluj.cmd in the root of the project. Three ways to run it:

      (no switches)   The wizard. Asks for administrator rights (UAC), looks at the
                      machine, and either installs or - when an installation is
                      already here - shows its state and lets you change it.

      -DryRun         The same wizard, but nothing is changed: every command and
                      every file edit is written to the log instead of being made.
                      Needs no administrator rights. With -AnswerFile <json> it
                      runs without a window and prints the transcript.

      -Preview        Draws every page of every mode with sample data and saves
                      them as PNG files in -ScreenshotDir. Reads and changes
                      nothing on the machine.

    Windows PowerShell 5.1 syntax throughout. Keep this file pure ASCII;
    translated text lives in installer\lang\*.psd1.

.EXAMPLE
    Zainstaluj.cmd -Preview -ScreenshotDir C:\Temp\shots -Language en

.EXAMPLE
    Zainstaluj.cmd -DryRun -AnswerFile installer\examples\answers-vps.json
#>
[CmdletBinding()]
param(
    [switch] $Preview,
    [string] $ScreenshotDir = '',
    [ValidateSet('', 'pl', 'en')]
    [string] $Language = '',
    [switch] $DryRun,
    [string] $AnswerFile = '',
    # Layout scale for -Preview (1 = 100 %, 1.5 = 150 %). 0 follows the display.
    [double] $Scale = 0,
    [string] $LogFile = '',
    # -Preview: only these screenshots (names without .png).
    [string[]] $Only = @(),
    [switch] $NoElevate
)

$ErrorActionPreference = 'Stop'
# An error before the window is up (a library that does not load, controls that do not compile)
# used to close the elevated console before anybody could read it (audit P3-16). It is shown
# in a message box - or on standard error for -AnswerFile and -Preview - and kept in a file.
trap {
    $failure = $_
    $text = ([string] $failure.Exception.Message) + [Environment]::NewLine + ([string] $failure.InvocationInfo.PositionMessage)
    if (Get-Command Protect-SetupText -ErrorAction SilentlyContinue) { $text = Protect-SetupText $text }
    $crash = Join-Path ([System.IO.Path]::GetTempPath()) ('tryhackx-media-setup-error-' + (Get-Date).ToString('yyyyMMdd-HHmmss') + '.txt')
    try { [System.IO.File]::WriteAllText($crash, $text + [Environment]::NewLine + [string] $failure.ScriptStackTrace, (New-Object System.Text.UTF8Encoding $false)) } catch { }
    if ($AnswerFile -or $Preview) { [Console]::Error.WriteLine($text) }
    else {
        try {
            Add-Type -AssemblyName System.Windows.Forms
            $shown = 'Instalator zatrzymal sie z bledem / The installer stopped with an error:' + [Environment]::NewLine + [Environment]::NewLine + $text + [Environment]::NewLine + $crash
            [void] [System.Windows.Forms.MessageBox]::Show($shown, 'TryHackX Media Server', 'OK', 'Error')
        } catch {
            [Console]::Error.WriteLine($text)
            Start-Sleep -Seconds 30
        }
    }
    exit 1
}
# powershell.exe -File hands an array over as one string: "a,b,c".
$Only = @($Only | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$InstallerDir = $PSScriptRoot
$SourceRoot = Split-Path -Parent $InstallerDir
if (-not $Language) { $Language = 'pl' }

foreach ($library in @('Common.ps1', 'Detect.ps1', 'Steps.ps1', 'State.ps1')) { . (Join-Path $InstallerDir ('lib\' + $library)) }

if ($AnswerFile -and -not $DryRun) {
    [Console]::Error.WriteLine('An answer file is accepted only together with -DryRun: it shows what the wizard would do, it does not install.')
    exit 2
}
if ($PSVersionTable.PSVersion.Major -lt 5) {
    [Console]::Error.WriteLine('Windows PowerShell 5.1 is required (it is part of Windows 10 and 11).')
    exit 2
}

# -- administrator rights ----------------------------------------------------------------------
# A real run changes Apache, the firewall and the Task Scheduler. A preview or a dry run
# changes nothing, so it asks for nothing.
if (-not $Preview -and -not $DryRun -and -not $NoElevate -and -not (Test-SetupAdmin)) {
    $arguments = @('-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Language', $Language)
    if ($LogFile) { $arguments += @('-LogFile', $LogFile) }
    try {
        Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -WorkingDirectory $SourceRoot -ArgumentList (Join-NativeArguments $arguments) | Out-Null
        exit 0
    } catch {
        Add-Type -AssemblyName System.Windows.Forms
        $text = "Instalator potrzebuje uprawnien administratora, zeby skonfigurowac Apache, zapore i zadania.`n`n" +
            'The installer needs administrator rights to configure Apache, the firewall and scheduled tasks.'
        [void] [System.Windows.Forms.MessageBox]::Show($text, 'TryHackX Media Server', 'OK', 'Warning')
        exit 1
    }
}
if ([System.Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA' -and -not $AnswerFile) {
    # Windows Forms dialogs (folder pickers) need a single-threaded apartment.
    $arguments = @('-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Language', $Language, '-NoElevate')
    if ($Preview) { $arguments += '-Preview' }
    if ($DryRun) { $arguments += '-DryRun' }
    if ($ScreenshotDir) { $arguments += @('-ScreenshotDir', $ScreenshotDir) }
    if ($Scale -gt 0) { $arguments += @('-Scale', [string] $Scale) }
    if ($LogFile) { $arguments += @('-LogFile', $LogFile) }
    $child = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList (Join-NativeArguments $arguments) -Wait -PassThru -NoNewWindow
    exit $child.ExitCode
}

if (-not $LogFile -and -not $Preview) {
    $LogFile = Join-Path ([System.IO.Path]::GetTempPath()) ('tryhackx-media-setup-' + (Get-SetupStamp) + '.log')
}
Initialize-SetupContext -InstallerDir $InstallerDir -Language $Language -DryRun ([bool] $DryRun) -LogFile $LogFile

# -- preview -----------------------------------------------------------------------------------
if ($Preview) {
    if (-not $ScreenshotDir) { $ScreenshotDir = Join-Path $SourceRoot ('scratch\renders\installer\' + $Language) }
    foreach ($library in @('Ui.ps1', 'PagesInstall.ps1', 'PagesMaintain.ps1', 'Preview.ps1')) { . (Join-Path $InstallerDir ('lib\' + $library)) }
    Initialize-SetupUi -Scale $(if ($Scale -gt 0) { $Scale } else { 1.0 })
    $written = Invoke-SetupPreview -SourceRoot $SourceRoot -ScreenshotDir $ScreenshotDir -Only $Only
    foreach ($file in $written) { Write-Output $file }
    exit 0
}

# -- unattended dry run ------------------------------------------------------------------------
if ($AnswerFile) {
    try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
    $script:SetupContext.Sink = { param($message) if ($message.Type -eq 'log') { [Console]::Out.WriteLine($message.Text) } }
    $answersPath = (Resolve-Path -LiteralPath $AnswerFile).Path
    $raw = ConvertTo-SetupHashtable (ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText($answersPath, [System.Text.Encoding]::UTF8)))
    # One run, one transcript: a file left by an earlier run would read as part of this one.
    if ($LogFile) { [System.IO.File]::WriteAllText($LogFile, '', (New-Object System.Text.UTF8Encoding $false)) }
    Write-SetupLog (T 'unattended.start' $answersPath)
    Write-SetupLog (T 'unattended.detect')
    $environment = Get-SetupEnvironment -SourceRoot $SourceRoot -AssumeFresh:([bool] $raw.assume_fresh)
    $state = New-SetupState -SourceRoot $SourceRoot -Environment $environment
    $flow = if ($raw.flow) { [string] $raw.flow } else { 'install' }
    if ($flow -ne 'install') {
        if (-not $environment.Existing.Found) { Write-SetupLog (T 'unattended.noInstallation') 'error'; exit 2 }
        Initialize-SetupMaintainState $state
        if ($flow -eq 'repair' -or $flow -eq 'uninstall') { $state.InPlace = $true }
    }
    [void] (Import-SetupAnswers -State $state -Path $answersPath)
    $state.Flow = $flow

    $problems = @()
    foreach ($row in @(Get-SetupRequirements -Environment $environment -Mode $state.Mode -AccessMode $state.Access.Mode)) {
        $level = switch ($row.Status) { 'ok' { 'ok' } 'error' { 'error' } default { 'warn' } }
        Write-SetupLog ("{0}: {1}" -f $row.Title, $row.Detail) $level
        if ($row.Status -eq 'error') { $problems += [string] $row.Detail }
    }
    if ($flow -eq 'install') {
        if (-not $state.InPlace) { $problems += @(Test-SetupTargetFolder -Path $state.TargetRoot -SourceRoot $SourceRoot -Wamp $environment.Wamp) }
        if (@($state.Roots).Count -eq 0) { $problems += (T 'media.error.none') }
        if ($state.Admin.Username -notmatch '^[A-Za-z0-9._-]{3,32}$') { $problems += (T 'admin.error.username') }
        if (-not $state.Database.AppPassword) { $state.Database.AppPassword = New-SetupPassword; Add-SetupSecret $state.Database.AppPassword }
    }
    if (@('install', 'folders') -contains $flow) {
        $paths = @($state.Roots | ForEach-Object { [string] $_.Path })
        for ($i = 0; $i -lt $paths.Count; $i++) {
            $others = @(for ($j = 0; $j -lt $paths.Count; $j++) { if ($j -ne $i) { $paths[$j] } })
            $checked = Test-SetupMediaFolder -Path $paths[$i] -ProjectRoot $state.TargetRoot -Others $others
            $problems += @($checked.Errors)
            foreach ($warning in @($checked.Warnings)) { Write-SetupLog $warning 'warn' }
        }
    }
    if ($problems.Count -eq 0 -and $environment.Python.Ok) {
        if (@('install', 'access') -contains $flow) { $problems += @(Test-SetupAccess -State $state -Access $state.Access) }
        if (@('install', 'folders') -contains $flow -and @($state.Roots | Where-Object { -not $_.Id }).Count -gt 0) { Set-SetupRootIds $state }
    }
    if ($problems.Count -gt 0) {
        foreach ($problem in $problems) { Write-SetupLog ([string] $problem) 'error' }
        Write-SetupLog (T 'unattended.stopped') 'error'
        exit 2
    }
    $paths = Get-SetupPaths $state
    if ($state.Access.Mode -eq 'vps') { $state.Access.CertificateFile = $paths.OriginCert; $state.Access.KeyFile = $paths.OriginKey }
    elseif ($state.Access.Mode -eq 'direct' -and $state.Access.SelfSigned) { $state.Access.CertificateFile = $paths.SelfCert; $state.Access.KeyFile = $paths.SelfKey }
    $plan = @(Get-SetupPlan $state)
    Write-SetupLog (T 'unattended.plan' $flow $plan.Count)
    foreach ($step in $plan) {
        Write-SetupLog ('  * ' + $step.Title)
        foreach ($detail in @($step.Details)) { if ($detail) { Write-SetupLog ('      ' + $detail) } }
    }
    $result = Invoke-SetupPlan -State $state -Plan $plan
    if ($result.Ok) { Write-SetupLog (T 'progress.doneDry') 'ok'; Write-SetupLog (T 'unattended.log' $LogFile); exit 0 }
    Write-SetupLog (T 'progress.failed') 'error'
    exit 1
}

# -- the wizard --------------------------------------------------------------------------------
foreach ($library in @('Ui.ps1', 'PagesInstall.ps1', 'PagesMaintain.ps1')) { . (Join-Path $InstallerDir ('lib\' + $library)) }
Initialize-SetupUi -Scale $Scale
$state = New-SetupState -SourceRoot $SourceRoot -Environment $null
$script:Ui.State = $state
$form = New-SetupWindow
[System.Windows.Forms.Application]::SetUnhandledExceptionMode([System.Windows.Forms.UnhandledExceptionMode]::CatchException)
[System.Windows.Forms.Application]::add_ThreadException({
        param($sender, $failure)
        $text = [string] $failure.Exception.Message
        try { Write-SetupLog $text 'error' } catch { }
        [void] [System.Windows.Forms.MessageBox]::Show((Protect-SetupText $text) + "`n`n" + $script:SetupContext.LogFile, 'TryHackX Media Server', 'OK', 'Error')
    })
$form.Add_Shown({
        # The console that started us has nothing to show once the window is up.
        if (-not $script:SetupContext.DryRun) { [TryHackX.Setup.NativeMethods]::ShowConsole($false) }
        Set-SetupFlow (Get-SetupFlowPages 'boot')
    })
Write-SetupLog ("TryHackX Media Server setup {0}  dry-run={1}  admin={2}" -f $state.Version, [bool] $DryRun, (Test-SetupAdmin))
[System.Windows.Forms.Application]::Run($form)
exit 0
