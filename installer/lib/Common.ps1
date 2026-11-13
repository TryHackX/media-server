<#
    Common ground of the TryHackX Media Server wizard: the log (which never shows a
    secret), running other programs, and the one rule every change obeys - in a dry
    run it is described instead of made.

    This file is dot-sourced by Setup.ps1 and again by every background runspace,
    so it must not create windows or depend on the user interface.

    Keep this file pure ASCII; translated text lives in installer\lang\*.psd1.
#>

$script:SetupContext = @{
    DryRun     = $false
    Secrets    = New-Object System.Collections.ArrayList
    Sink       = $null      # ConcurrentQueue (user interface) or a script block (console)
    LogFile    = $null
    Strings    = @{}
    Fallback   = @{}
    Language   = 'pl'
    InstallerDir = $null
    Cancel     = $null      # synchronized hashtable with a 'Requested' flag
}

function Initialize-SetupContext {
    param(
        [string] $InstallerDir,
        [string] $Language = 'pl',
        [bool] $DryRun = $false,
        $Sink = $null,
        [string] $LogFile = $null,
        [string[]] $Secrets = @(),
        $Cancel = $null
    )
    $script:SetupContext.InstallerDir = $InstallerDir
    $script:SetupContext.DryRun = $DryRun
    $script:SetupContext.Sink = $Sink
    $script:SetupContext.LogFile = $LogFile
    $script:SetupContext.Cancel = $Cancel
    $script:SetupContext.Secrets = New-Object System.Collections.ArrayList
    foreach ($secret in $Secrets) { Add-SetupSecret $secret }
    Set-SetupLanguage $Language
    if (-not ('TryHackX.Setup.ProcessRunner' -as [type])) {
        $source = [System.IO.File]::ReadAllText((Join-Path $InstallerDir 'lib\Native.cs'), [System.Text.Encoding]::UTF8)
        Add-Type -TypeDefinition $source -Language CSharp
    }
}

function Import-SetupStrings {
    <#
        A language file read as data: the parser's tree, text constants only, so nothing in it
        can run. Import-PowerShellDataFile did the same until the files passed 500 keys - Windows
        PowerShell 5.1 refuses a larger table outright ("dynamic expressions").
    #>
    param([string] $Path)
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref] $tokens, [ref] $errors)
    if ($errors -and $errors.Count -gt 0) { throw ('{0}: {1}' -f $Path, $errors[0].Message) }
    $table = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.HashtableAst] }, $true)
    if (-not $table) { throw ('{0}: no table of texts' -f $Path) }
    $strings = @{}
    foreach ($pair in $table.KeyValuePairs) {
        $key = $pair.Item1 -as [System.Management.Automation.Language.StringConstantExpressionAst]
        $value = $null
        $statement = $pair.Item2 -as [System.Management.Automation.Language.PipelineAst]
        if ($statement -and $statement.PipelineElements.Count -eq 1) {
            $command = $statement.PipelineElements[0] -as [System.Management.Automation.Language.CommandExpressionAst]
            if ($command) { $value = $command.Expression -as [System.Management.Automation.Language.StringConstantExpressionAst] }
        }
        if (-not $key -or -not $value) { throw ('{0}:{1}: a text must be a plain string' -f $Path, $pair.Item1.Extent.StartLineNumber) }
        $strings[$key.Value] = $value.Value
    }
    return $strings
}

function Set-SetupLanguage {
    param([string] $Language)
    $dir = Join-Path $script:SetupContext.InstallerDir 'lang'
    $script:SetupContext.Fallback = Import-SetupStrings (Join-Path $dir 'pl.psd1')
    $file = Join-Path $dir ($Language + '.psd1')
    if ($Language -ne 'pl' -and (Test-Path -LiteralPath $file)) {
        $script:SetupContext.Strings = Import-SetupStrings $file
    } else {
        $Language = 'pl'
        $script:SetupContext.Strings = $script:SetupContext.Fallback
    }
    $script:SetupContext.Language = $Language
}

function T {
    <# The text for a key in the current language, with {0}-style arguments filled in. #>
    param([Parameter(Mandatory)] [string] $Key, [Parameter(ValueFromRemainingArguments)] $Arguments)
    $text = $script:SetupContext.Strings[$Key]
    if ($null -eq $text) { $text = $script:SetupContext.Fallback[$Key] }
    if ($null -eq $text) { return "[$Key]" }
    if ($Arguments -and @($Arguments).Count -gt 0) {
        try { return [string]::Format([string] $text, [object[]] @($Arguments)) } catch { return [string] $text }
    }
    return [string] $text
}

# -- secrets and the log ---------------------------------------------------------------------

function Add-SetupSecret {
    <# Anything registered here is replaced by dots wherever the log would show it. #>
    param([string] $Value)
    if ($Value -and -not $script:SetupContext.Secrets.Contains($Value)) {
        [void] $script:SetupContext.Secrets.Add($Value)
    }
}

function Protect-SetupText {
    param([string] $Text)
    if (-not $Text) { return $Text }
    foreach ($secret in $script:SetupContext.Secrets) {
        if (-not $Text.Contains($secret)) { continue }
        if ($secret.Length -ge 4) { $Text = $Text.Replace($secret, '********'); continue }
        # A short password still must not show, but replacing every "ab" inside other words would
        # make the log unreadable: hide it only where it stands on its own (audit P3-15).
        $Text = [regex]::Replace($Text, '(?<![\p{L}\p{N}_])' + [regex]::Escape($secret) + '(?![\p{L}\p{N}_])', '********')
    }
    # Values that look like credentials even when nobody registered them.
    $Text = [regex]::Replace($Text, '(?i)((?:password|passwd|pwd|transfer_key|secret)\s*[=:]\s*)("?)[^"\s,;]+("?)', '$1$2********$3')
    $Text = [regex]::Replace($Text, "(?i)(IDENTIFIED BY\s+')[^']*(')", '$1********$2')
    return $Text
}

function Send-SetupEvent {
    param([hashtable] $Data)
    $sink = $script:SetupContext.Sink
    if ($null -eq $sink) { return }
    if ($sink -is [scriptblock]) { & $sink $Data } else { $sink.Enqueue($Data) }
}

function Write-SetupLog {
    <# Level: info | cmd | out | ok | warn | error | dry #>
    param([string] $Message, [string] $Level = 'info')
    $safe = Protect-SetupText $Message
    $stamp = (Get-Date).ToString('HH:mm:ss')
    $prefix = switch ($Level) {
        'cmd'   { '  $ ' }
        'out'   { '    ' }
        'ok'    { '[OK] ' }
        'warn'  { '[!]  ' }
        'error' { '[X]  ' }
        'dry'   { '[DRY-RUN] ' }
        default { '' }
    }
    $line = "$stamp  $prefix$safe"
    if ($script:SetupContext.LogFile) {
        try {
            [System.IO.File]::AppendAllText($script:SetupContext.LogFile, $line + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding $false))
        } catch { }
    }
    Send-SetupEvent @{ Type = 'log'; Level = $Level; Text = $line }
}

$script:SetupPythonProbes = @{}

function Test-SetupPythonStarts {
    <#
        Does this interpreter start at all? A .venv whose base Python was upgraded or removed
        answers "No Python at ..." to everything, and every helper call and every repair
        failed on it. Asked once per path and run, unless -Fresh.
    #>
    param([string] $Exe, [switch] $Fresh)
    if (-not $Exe -or -not (Test-Path -LiteralPath $Exe -PathType Leaf)) { return $false }
    if (-not $Fresh -and $script:SetupPythonProbes.ContainsKey($Exe)) { return [bool] $script:SetupPythonProbes[$Exe] }
    $works = $false
    try {
        $result = Invoke-SetupProcess -File $Exe -Arguments @('-c', 'import sys') -Quiet -TimeoutSeconds 30
        $works = ($result.ExitCode -eq 0)
    } catch { $works = $false }
    $script:SetupPythonProbes[$Exe] = $works
    return $works
}

function Test-SetupCancelled {
    $cancel = $script:SetupContext.Cancel
    return ($null -ne $cancel -and $cancel.Requested)
}

# -- other programs ----------------------------------------------------------------------------

function ConvertTo-NativeArgument {
    <# One argument quoted by the rules of the Microsoft C runtime (what python.exe, httpd.exe and friends parse). #>
    param([string] $Value)
    if ($null -eq $Value -or $Value -eq '') { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    $builder = New-Object System.Text.StringBuilder
    [void] $builder.Append('"')
    $backslashes = 0
    [char] $slash = 92
    [char] $quote = 34
    foreach ($ch in $Value.ToCharArray()) {
        if ($ch -eq $slash) { $backslashes++; continue }
        if ($ch -eq $quote) {
            # Backslashes before a quote are doubled, and the quote itself is escaped.
            [void] $builder.Append($slash, $backslashes * 2 + 1).Append($quote)
        } else {
            [void] $builder.Append($slash, $backslashes).Append($ch)
        }
        $backslashes = 0
    }
    [void] $builder.Append($slash, $backslashes * 2).Append($quote)
    return $builder.ToString()
}

function Join-NativeArguments {
    param([string[]] $Arguments)
    return (@($Arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' ')
}

function Invoke-SetupProcess {
    <#
        Runs a program and returns @{ ExitCode; Output } - Output being every line it
        wrote, standard error included, in order. Lines are logged as they arrive
        unless -Quiet. Standard input, when given, is sent as UTF-8 bytes: that is
        how passwords travel, never on a command line.

        This function always runs the program. A step that changes something calls
        Invoke-SetupCommand instead, which a dry run turns into a line in the log.
    #>
    param(
        [Parameter(Mandatory)] [string] $File,
        [string[]] $Arguments = @(),
        [string] $WorkingDirectory = '',
        [hashtable] $Environment = $null,
        [string] $StdinText = $null,
        [switch] $OemOutput,
        [switch] $Quiet,
        [int] $TimeoutSeconds = 0,
        # A program that must not be stopped half way (a migration, an Apache restart):
        # a cancel request waits for it, and the plan stops before the next step.
        [switch] $Uninterruptible
    )
    $runner = New-Object TryHackX.Setup.ProcessRunner
    $output = New-Object System.Collections.ArrayList
    $stdin = $null
    if ($null -ne $StdinText) { $stdin = (New-Object System.Text.UTF8Encoding $false).GetBytes($StdinText) }
    $deadline = if ($TimeoutSeconds -gt 0) { [DateTime]::UtcNow.AddSeconds($TimeoutSeconds) } else { [DateTime]::MaxValue }
    try {
        $runner.Start($File, (Join-NativeArguments $Arguments), $WorkingDirectory, $Environment, $stdin, [bool] $OemOutput)
        $line = $null
        while ($true) {
            $drained = $false
            while ($runner.Lines.TryDequeue([ref] $line)) {
                $drained = $true
                [void] $output.Add($line)
                if (-not $Quiet -and $line.Trim()) { Write-SetupLog $line 'out' }
            }
            if ($runner.Finished -and $runner.Lines.IsEmpty) { break }
            if ([DateTime]::UtcNow -gt $deadline) {
                $runner.Kill()
                throw (T 'error.timeout' ([System.IO.Path]::GetFileName($File)) $TimeoutSeconds)
            }
            if (-not $Uninterruptible -and (Test-SetupCancelled)) {
                $runner.Kill()
                throw (T 'error.cancelled')
            }
            if (-not $drained) { Start-Sleep -Milliseconds 40 }
        }
        return @{ ExitCode = $runner.ExitCode; Output = @($output) }
    } finally {
        $runner.Dispose()
    }
}

function Invoke-SetupCommand {
    <#
        A program run that changes the machine. In a dry run the command line is
        logged and nothing is started; otherwise a non-zero exit code is an error
        carrying the last lines of output.
    #>
    param(
        [Parameter(Mandatory)] [string] $File,
        [string[]] $Arguments = @(),
        [string] $WorkingDirectory = '',
        [hashtable] $Environment = $null,
        [string] $StdinText = $null,
        [string] $StdinNote = '',
        [switch] $OemOutput,
        [int[]] $SuccessCodes = @(0),
        [int] $TimeoutSeconds = 0,
        [switch] $Uninterruptible
    )
    $shown = (ConvertTo-NativeArgument $File) + ' ' + (Join-NativeArguments $Arguments)
    if ($Environment) {
        # Only what looks like a credential is hidden; the rest is worth reading.
        $pairs = @($Environment.Keys | Sort-Object | ForEach-Object {
                if ($_ -match '(?i)PASSWORD|SECRET|TOKEN|KEY') { "$_=********" } else { "$_=$($Environment[$_])" }
            })
        $shown = ($pairs -join ' ') + ' ' + $shown
    }
    if ($StdinNote) { $shown += "   <<< $StdinNote" }
    if ($script:SetupContext.DryRun) {
        Write-SetupLog $shown 'dry'
        return @{ ExitCode = 0; Output = @(); DryRun = $true }
    }
    Write-SetupLog $shown 'cmd'
    $result = Invoke-SetupProcess -File $File -Arguments $Arguments -WorkingDirectory $WorkingDirectory `
        -Environment $Environment -StdinText $StdinText -OemOutput:$OemOutput -TimeoutSeconds $TimeoutSeconds -Uninterruptible:$Uninterruptible
    if ($SuccessCodes -notcontains $result.ExitCode) {
        $tail = (@($result.Output | Where-Object { $_ -and $_.Trim() } | Select-Object -Last 12) -join [Environment]::NewLine)
        throw (T 'error.command' ([System.IO.Path]::GetFileName($File)) $result.ExitCode (Protect-SetupText $tail))
    }
    return $result
}

function Invoke-SetupChange {
    <# A change made by PowerShell itself (a file, a rule, a service): described in a dry run, done otherwise. #>
    param([Parameter(Mandatory)] [string] $What, [Parameter(Mandatory)] [scriptblock] $Do)
    if ($script:SetupContext.DryRun) {
        Write-SetupLog $What 'dry'
        return $null
    }
    Write-SetupLog $What 'cmd'
    return (& $Do)
}

function Invoke-SetupHelper {
    <#
        Asks installer\helper.py (see installer\setup_helper\cli.py). The request and
        the answer are JSON; a refusal comes back as an exception with the helper's
        own sentence. Read-only by itself: commands that write take a 'dry_run' or an
        'output' field, and the caller decides.
    #>
    param(
        [Parameter(Mandatory)] [string] $Python,
        [Parameter(Mandatory)] [string] $Command,
        [hashtable] $Request = @{}
    )
    $helper = Join-Path $script:SetupContext.InstallerDir 'helper.py'
    $json = ConvertTo-Json -InputObject $Request -Depth 8 -Compress
    # -B: no __pycache__ in the unpacked package (a dry run included); -I ignores PYTHONDONTWRITEBYTECODE.
    $result = Invoke-SetupProcess -File $Python -Arguments @('-I', '-B', '-X', 'utf8', $helper, $Command) -StdinText $json -Quiet -TimeoutSeconds 120
    $text = (@($result.Output) -join "`n").Trim()
    if ($result.ExitCode -ne 0 -or -not $text) {
        throw (T 'error.helper' $Command (Protect-SetupText $text))
    }
    # The answer is the last line: anything a module printed while importing stays above it.
    $last = @($result.Output | Where-Object { $_ -and $_.Trim().StartsWith('{') } | Select-Object -Last 1)
    if ($last.Count -eq 0) { throw (T 'error.helper' $Command (Protect-SetupText $text)) }
    $answer = ConvertFrom-Json -InputObject $last[0]
    if (-not $answer.ok) { throw [string] $answer.error }
    return $answer
}

# -- files -------------------------------------------------------------------------------------

function Get-SetupStamp { return (Get-Date).ToString('yyyyMMdd-HHmmss') }

function Get-SetupBackupDir {
    <# One folder per wizard run, inside the project's git-ignored backups\ directory. #>
    param([Parameter(Mandatory)] [hashtable] $State)
    if (-not $State.BackupDir) {
        $State.BackupDir = Join-Path $State.TargetRoot ('backups\installer\' + (Get-SetupStamp))
    }
    return $State.BackupDir
}

function Backup-SetupFile {
    <# Copies a file about to be changed into this run's backup folder; returns the copy's path (or $null). #>
    param([Parameter(Mandatory)] [hashtable] $State, [Parameter(Mandatory)] [string] $Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    if (-not $State.Backups) { $State.Backups = New-Object System.Collections.ArrayList }
    # "Try again" runs the plan a second time: by then the file holds the wizard's own
    # version, and copying it would replace the saved original (audit P3-4). The first copy stays.
    foreach ($saved in $State.Backups) {
        if ($saved.Original -ieq $Path -and $saved.Copy) { return $saved.Copy }
    }
    $dir = Get-SetupBackupDir $State
    $name = [System.IO.Path]::GetFileName($Path)
    $target = Join-Path $dir $name
    # Two files of one name (two vhosts.conf from different places) each get their own copy.
    $taken = @($State.Backups | ForEach-Object { $_.Copy })
    $number = 1
    while (($taken -icontains $target) -or (Test-Path -LiteralPath $target)) {
        $number++
        $target = Join-Path $dir ('{0}.{1}{2}' -f [System.IO.Path]::GetFileNameWithoutExtension($name), $number, [System.IO.Path]::GetExtension($name))
    }
    Invoke-SetupChange -What (T 'log.backup' $Path $target) -Do {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Copy-Item -LiteralPath $Path -Destination $target
    } | Out-Null
    [void] $State.Backups.Add(@{ Original = $Path; Copy = $target; Existed = $true })
    return $target
}

function Write-SetupTextFile {
    <# UTF-8 without a byte-order mark. #>
    param([string] $Path, [string] $Text)
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding $false))
}

function Test-SetupAdmin {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object System.Security.Principal.WindowsPrincipal $identity).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function New-SetupPassword {
    <# 32 random bytes as base64url: letters, digits, '-' and '_' only, so it needs no escaping in SQL or TOML. #>
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function ConvertTo-SetupHashtable {
    <# ConvertFrom-Json gives objects; state files are easier to work with as nested hashtables. #>
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $table = @{}
        foreach ($property in $Value.PSObject.Properties) { $table[$property.Name] = ConvertTo-SetupHashtable $property.Value }
        return $table
    }
    if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
        return ,@($Value | ForEach-Object { ConvertTo-SetupHashtable $_ })
    }
    return $Value
}
