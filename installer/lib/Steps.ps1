<#
    What the wizard does, one step at a time.

    A plan is a list of steps built from the answers (Get-SetupPlan). The summary
    page shows it, the progress page runs it, and a dry run runs it too - with
    every change replaced by the line that describes it. There is one code path
    for all three, so what the summary promises is what the progress page does.

    Every step can be run again: nothing here assumes it is the first attempt.

    Keep this file pure ASCII; translated text lives in installer\lang\*.psd1.
#>

function Get-SetupPaths {
    param([hashtable] $State)
    $root = $State.TargetRoot
    return @{
        Root        = $root
        Config      = Join-Path $root 'config\config.local.toml'
        # $State.VenvPython names an environment that lives elsewhere (the tests use it
        # to run the database steps without building a second environment).
        VenvPython  = $(if ($State.VenvPython) { [string] $State.VenvPython } else { Join-Path $root '.venv\Scripts\python.exe' })
        Build       = Join-Path $root 'public\assets\build'
        OriginCert  = Join-Path $root 'config\origin\origin-cert.pem'
        OriginKey   = Join-Path $root 'config\origin\origin-key.pem'
        SelfCert    = Join-Path $root 'config\tls\selfsigned-cert.pem'
        SelfKey     = Join-Path $root 'config\tls\selfsigned-key.pem'
        BundleDir   = Join-Path $root 'runtime\vps-bundle'
        StateFile   = Join-Path $root $script:SetupNames.StateFile
        Scripts     = Join-Path $root 'scripts'
        # Templates are read from the tree the wizard runs from: before the copy
        # step (and in a dry run) the target does not have them yet.
        Template    = Join-Path $State.SourceRoot 'deploy\apache\media-next-stage-wamp.conf.example'
        VpsTemplates = Join-Path $State.SourceRoot 'installer\templates\vps'
    }
}

function Get-SetupHelperPython {
    param([hashtable] $State)
    $venv = (Get-SetupPaths $State).VenvPython
    if (Test-SetupPythonStarts $venv) { return $venv }
    if ($State.Env.Python -and $State.Env.Python.Exe) { return $State.Env.Python.Exe }
    throw (T 'error.noPython')
}

# Windows PowerShell writes to a pipe in the console's OEM code page (852 on Polish Windows), so
# its children are read with -OemOutput: a localised system error must not arrive garbled (audit P3-5).
# The scripts it runs are plain ASCII, so nothing of ours is lost on the way.
function Get-SetupPowerShell { return (Join-Path $PSHOME 'powershell.exe') }

function Get-SetupAccessValues {
    <# What an access mode means for the private configuration. #>
    param([hashtable] $Access)
    switch ($Access.Mode) {
        'vps'    { return @{ BaseUrl = "https://$($Access.HostName)/"; Trusted = (@($Access.VpsAddresses) -join ', '); RequireHttps = $true } }
        'direct' { return @{ BaseUrl = "https://$($Access.HostName)/"; Trusted = $null; RequireHttps = $true } }
        'lan'    { return @{ BaseUrl = $null; Trusted = $null; RequireHttps = $false } }
        default  { return @{ BaseUrl = $null; Trusted = $null; RequireHttps = $true } }
    }
}

# -- MySQL / MariaDB as the administrator ------------------------------------------------------

function New-SetupSecretFile {
    <# A temporary file only this account (and SYSTEM) can read, created empty and filled afterwards. #>
    param([string] $Content)
    $path = Join-Path ([System.IO.Path]::GetTempPath()) ('thx-' + [Guid]::NewGuid().ToString('N') + '.cnf')
    [System.IO.File]::WriteAllBytes($path, (New-Object byte[] 0))
    $security = New-Object System.Security.AccessControl.FileSecurity
    $security.SetAccessRuleProtection($true, $false)
    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'
    foreach ($who in @($me, $system)) {
        $security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($who, 'FullControl', 'Allow')))
    }
    [System.IO.File]::SetAccessControl($path, $security)
    [System.IO.File]::WriteAllText($path, $Content, (New-Object System.Text.UTF8Encoding $false))
    return $path
}

function New-SetupMySqlOptions {
    <# The administrator's sign-in as a private option file ([client] is read by mysql and mysqldump alike). Delete it after use. #>
    param([hashtable] $Database)
    $escape = { param($value) ([string] $value).Replace('\', '\\').Replace('"', '\"') }
    $options = "[client]`nuser=`"$(& $escape $Database.AdminUser)`"`npassword=`"$(& $escape $Database.AdminPassword)`"`nhost=$($Database.Host)`nport=$($Database.Port)`nprotocol=tcp`n"
    return (New-SetupSecretFile $options)
}

function Invoke-SetupMySql {
    <#
        Runs SQL through WampServer's own mysql client as the administrator.
        The password goes into a private option file and the statements go in on
        standard input, so neither is ever on a command line or in the log.
        Returns the output lines. -Change marks statements that modify the server:
        a dry run logs -Note instead of running them.
    #>
    param([hashtable] $Database, [string] $Sql, [switch] $Change, [string] $Note = '')
    $shown = "mysql --host=$($Database.Host) --port=$($Database.Port) --user=$($Database.AdminUser)   <<< $Note"
    if ($Change) {
        if ($script:SetupContext.DryRun) { Write-SetupLog $shown 'dry'; return @() }
        Write-SetupLog $shown 'cmd'
    }
    $file = New-SetupMySqlOptions $Database
    try {
        $result = Invoke-SetupProcess -File $Database.Client -Arguments @(
            "--defaults-extra-file=$file", '--batch', '--skip-column-names', '--default-character-set=utf8mb4', '--connect-timeout=8'
        ) -StdinText $Sql -Quiet -TimeoutSeconds 120
    } finally {
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    }
    $lines = @($result.Output | Where-Object { $_ -and $_ -notmatch 'Using a password on the command line' })
    if ($result.ExitCode -ne 0) {
        throw (Protect-SetupText ((@($lines | Select-Object -Last 3) -join ' ').Trim()))
    }
    return $lines
}

function Test-SetupDatabase {
    <#
        The "Test connection" button: signs in as the administrator and looks at what
        is already there. Read-only. Returns @{ Ok; Message; Version; CanCreate;
        DatabaseExists; Tables; UserExists }.
    #>
    param([hashtable] $Database)
    $name = [string] $Database.Name
    $user = [string] $Database.User
    if ($name -notmatch '^[A-Za-z0-9_]{1,64}$') { return @{ Ok = $false; Message = (T 'db.error.name') } }
    if ($user -notmatch '^[A-Za-z0-9_]{1,32}$') { return @{ Ok = $false; Message = (T 'db.error.user') } }
    # Every answer carries its own label: the client's warnings arrive in the same stream (a
    # MariaDB client warns on stderr about SSL), so counting lines would read a warning as a number.
    $sql = @"
SELECT CONCAT('version=', VERSION());
SELECT CONCAT('create=', COUNT(*)) FROM information_schema.user_privileges WHERE privilege_type IN ('CREATE', 'CREATE USER') AND REPLACE(grantee, '''', '') = CURRENT_USER();
SELECT CONCAT('schema=', COUNT(*)) FROM information_schema.schemata WHERE schema_name = '$name';
SELECT CONCAT('tables=', COUNT(*)) FROM information_schema.tables WHERE table_schema = '$name';
SELECT CONCAT('user=', COUNT(*)) FROM mysql.user WHERE user = '$user';
"@
    try {
        $lines = @(Invoke-SetupMySql -Database $Database -Sql $sql | Where-Object { $_.Trim() })
    } catch {
        return @{ Ok = $false; Message = [string] $_.Exception.Message }
    }
    return (ConvertFrom-SetupDatabaseAnswer $lines)
}

function ConvertFrom-SetupDatabaseAnswer {
    <# The labelled lines of the connection test, read by label; anything missing or not a number is "no answer". #>
    param([string[]] $Lines)
    $values = @{}
    foreach ($line in @($Lines)) {
        if ($line -match '^\s*(version|create|schema|tables|user)=(.*)$') { $values[$Matches[1]] = $Matches[2].Trim() }
    }
    $numbers = @{}
    foreach ($key in @('create', 'schema', 'tables', 'user')) {
        $number = 0
        if (-not $values.ContainsKey($key) -or -not [int]::TryParse([string] $values[$key], [ref] $number)) {
            return @{ Ok = $false; Message = (T 'db.error.answer') }
        }
        $numbers[$key] = $number
    }
    if (-not $values['version']) { return @{ Ok = $false; Message = (T 'db.error.answer') } }
    return @{
        Ok = $true; Message = ''
        Version = [string] $values['version']
        CanCreate = ($numbers['create'] -ge 2)
        DatabaseExists = ($numbers['schema'] -gt 0)
        Tables = $numbers['tables']
        UserExists = ($numbers['user'] -gt 0)
    }
}

# -- validation shared by the pages and the unattended run ---------------------------------------

function Test-SetupMediaFolder {
    <# Problems with one media folder: @{ Errors = @(...); Warnings = @(...) }. Reads only. #>
    param([string] $Path, [string] $ProjectRoot, [string[]] $Others = @())
    $errors = @(); $warnings = @()
    $trimmed = ([string] $Path).Trim()
    if (-not $trimmed) { return @{ Errors = @((T 'media.error.empty')); Warnings = @() } }
    if ($trimmed -notmatch '^[A-Za-z]:\\' -and $trimmed -notmatch '^\\\\[^\\]+\\[^\\]+') {
        return @{ Errors = @((T 'media.error.relative' $trimmed)); Warnings = @() }
    }
    $full = $trimmed
    try { $full = [System.IO.Path]::GetFullPath($trimmed) } catch { return @{ Errors = @((T 'media.error.invalid' $trimmed)); Warnings = @() } }
    if (-not (Test-Path -LiteralPath $full -PathType Container)) { $errors += (T 'media.error.missing' $full) }
    $normal = $full.TrimEnd('\') + '\'
    if ($ProjectRoot) {
        $project = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\') + '\'
        if ($normal.StartsWith($project, [StringComparison]::OrdinalIgnoreCase) -or $project.StartsWith($normal, [StringComparison]::OrdinalIgnoreCase)) {
            $errors += (T 'media.error.project' $full)
        }
    }
    foreach ($system in @($env:SystemRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($system -and $normal.StartsWith($system.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { $errors += (T 'media.error.system' $full) }
    }
    foreach ($other in $Others) {
        if (-not $other) { continue }
        $otherNormal = $other.TrimEnd('\') + '\'
        if ($otherNormal -ieq $normal) { $errors += (T 'media.error.duplicate' $full) }
        elseif ($normal.StartsWith($otherNormal, [StringComparison]::OrdinalIgnoreCase) -or $otherNormal.StartsWith($normal, [StringComparison]::OrdinalIgnoreCase)) {
            $errors += (T 'media.error.nested' $full $other)
        }
    }
    if ($full.StartsWith('\\')) { $warnings += (T 'media.warn.network') }
    else {
        $root = [System.IO.Path]::GetPathRoot($full)
        if ($root -ieq $full -or $root -ieq ($full + '\')) { $warnings += (T 'media.warn.driveRoot' $root) }
        try { if ((New-Object System.IO.DriveInfo $root).DriveType -eq 'Network') { $errors += (T 'media.error.mapped' $root) } } catch { }
    }
    return @{ Errors = @($errors); Warnings = @($warnings) }
}

function Test-SetupTargetFolder {
    <# Problems with the installation folder: a list of sentences, empty when it is fine. #>
    param([string] $Path, [string] $SourceRoot, $Wamp, [string] $ResumeRoot = '')
    $trimmed = ([string] $Path).Trim()
    if ($trimmed -notmatch '^[A-Za-z]:\\.+') { return @((T 'location.error.absolute')) }
    if ($trimmed -match '[^\x20-\x7E]') { return @((T 'location.error.ascii')) }
    if ($trimmed -match '["<>|?*]' -or $trimmed.Substring(2).Contains(':')) { return @((T 'location.error.characters')) }
    # Apache reads [ ] in a <Directory> path as a pattern, so the rules would miss the folder (audit P3-3).
    if ($trimmed -match '[\[\]]') { return @((T 'location.error.brackets')) }
    $full = $trimmed
    try { $full = [System.IO.Path]::GetFullPath($trimmed).TrimEnd('\') } catch { return @((T 'location.error.characters')) }
    $problems = @()
    $sourceFull = [System.IO.Path]::GetFullPath($SourceRoot).TrimEnd('\')
    # Copying a folder into itself makes robocopy nest a half copy inside the copy.
    if ($full -ine $sourceFull -and ($full + '\').StartsWith($sourceFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
        $problems += (T 'location.error.inside' $sourceFull)
    }
    if ($Wamp -and $Wamp.Found) {
        $www = (Join-Path $Wamp.InstallDir 'www').TrimEnd('\') + '\'
        if (($full + '\').StartsWith($www, [StringComparison]::OrdinalIgnoreCase)) { $problems += (T 'location.error.webroot' $www) }
    }
    foreach ($system in @($env:SystemRoot)) {
        if ($system -and ($full + '\').StartsWith($system.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { $problems += (T 'location.error.system') }
    }
    $same = ($full -ieq $sourceFull)
    # Finishing an installation that stopped half way: its folder is the one to use.
    $resuming = ($ResumeRoot -and $full -ieq $ResumeRoot.TrimEnd('\'))
    if (-not $same -and -not $resuming -and (Test-Path -LiteralPath $full)) {
        if (Test-Path -LiteralPath (Join-Path $full 'config\config.local.toml')) { $problems += (T 'location.error.installed' $full) }
        elseif (@(Get-ChildItem -LiteralPath $full -Force -ErrorAction SilentlyContinue | Select-Object -First 1).Count -gt 0) { $problems += (T 'location.error.notEmpty' $full) }
    }
    try { if ((New-Object System.IO.DriveInfo ([System.IO.Path]::GetPathRoot($full))).DriveType -ne 'Fixed') { $problems += (T 'location.error.drive') } } catch { }
    return @($problems)
}

function Test-SetupAdminAccount {
    <# The application's own rules (src/media_server/accounts.py), checked before anything is installed. #>
    param([string] $Username, [string] $Email, [string] $Password, [string] $Repeat)
    $problems = @()
    if ($Username -notmatch '^[A-Za-z0-9._-]{3,32}$') { $problems += (T 'admin.error.username') }
    if ($Email) {
        $at = $Email.LastIndexOf('@')
        if ($at -lt 1 -or $Email.Substring($at + 1) -notmatch '\.' -or $Email -match '\s' -or $Email.Length -gt 254) { $problems += (T 'admin.error.email') }
    }
    $bytes = [System.Text.Encoding]::UTF8.GetByteCount([string] $Password)
    if ($bytes -lt 12) { $problems += (T 'admin.error.short') }
    elseif ($bytes -gt 4096) { $problems += (T 'admin.error.long') }
    elseif ($Password -ne $Repeat) { $problems += (T 'admin.error.mismatch') }
    return @($problems)
}

# -- the steps ---------------------------------------------------------------------------------

# Private files and everything a machine builds for itself stay behind: the target gets its
# own environment, its own configuration and its own caches. Shared by the copy and its file list.
$script:SetupCopyExcludeDirs = @('.git', '.venv', 'node_modules', 'runtime', 'logs', 'scratch', 'dist', 'backups', '.pytest_cache', '.ruff_cache', '__pycache__', '.claude', '.idea', '.vscode')
$script:SetupCopyExcludeFiles = @('*.local.toml', '*.local.php', '*.local.json', 'installer.pending.json', '*.pyc', '*.log', '*.pid')

# Folders left behind only where they stand at the top of the tree. frontend\ holds the
# interface's sources, the packs of frontend\vendor and node_modules - what Step-BuildFrontend
# builds public\assets\build from; the installation needs the result, not the material (a GB).
$script:SetupCopyExcludeTopDirs = @('frontend')

function Get-SetupPackageFiles {
    <# Every file the copy brings, as paths relative to the package root (the same exclusions as robocopy's). #>
    param([string] $Source)
    $root = [System.IO.Path]::GetFullPath($Source).TrimEnd('\')
    $files = New-Object System.Collections.Generic.List[string]
    $pending = New-Object System.Collections.Generic.Stack[string]
    $pending.Push($root)
    while ($pending.Count -gt 0) {
        $folder = $pending.Pop()
        foreach ($entry in @(Get-ChildItem -LiteralPath $folder -Force -ErrorAction SilentlyContinue)) {
            if ($entry.PSIsContainer) {
                $top = ($folder -eq $root -and $script:SetupCopyExcludeTopDirs -contains $entry.Name)
                if (-not $top -and $script:SetupCopyExcludeDirs -notcontains $entry.Name) { $pending.Push($entry.FullName) }
                continue
            }
            $skip = $false
            foreach ($pattern in $script:SetupCopyExcludeFiles) { if ($entry.Name -like $pattern) { $skip = $true; break } }
            if (-not $skip) { $files.Add($entry.FullName.Substring($root.Length + 1)) }
        }
    }
    $files.Sort([System.StringComparer]::OrdinalIgnoreCase)
    return , $files.ToArray()
}

function Remove-SetupStaleFiles {
    <#
        An update copies over the old version, so a file the new one dropped (a module, a
        migration) would stay and still be loaded (audit P3-12). The previous update's list says
        what the package brought; what is on it and not in the new package goes. Nothing that
        was never on a list - a file somebody added - is touched, and a first update only writes the list.
    #>
    param([hashtable] $State, [string] $Target, [string[]] $NewFiles)
    # A git working copy is git's to keep: a file left out of a package may well be tracked there.
    if (Test-Path -LiteralPath (Join-Path $Target '.git')) { Write-SetupLog (T 'log.copy.gitTree' $Target) 'ok'; return }
    $manifest = Join-Path $Target 'runtime\installer-files.txt'
    if (Test-Path -LiteralPath $manifest -PathType Leaf) {
        $keep = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($relative in $NewFiles) { [void] $keep.Add($relative) }
        $rootPrefix = [System.IO.Path]::GetFullPath($Target).TrimEnd('\') + '\'
        foreach ($relative in [System.IO.File]::ReadAllLines($manifest)) {
            $relative = $relative.Trim()
            if (-not $relative -or $keep.Contains($relative) -or $relative -like '*.local.*') { continue }
            $path = [System.IO.Path]::GetFullPath((Join-Path $Target $relative))
            # A list is a file on disk: whatever it says, nothing outside the installation is deleted.
            if (-not $path.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { continue }
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
            Invoke-SetupChange -What (T 'log.copy.stale' $path) -Do { Remove-Item -LiteralPath $path -Force -ErrorAction Stop } | Out-Null
        }
    }
    Invoke-SetupChange -What (T 'log.copy.manifest' $manifest $NewFiles.Count) -Do {
        Write-SetupTextFile $manifest (($NewFiles -join "`r`n") + "`r`n")
    } | Out-Null
}

function Step-BuildFrontend {
    <#
        A clone of the repository has no built interface: `npm ci` and `npm run build` in its own
        frontend\ folder, before anything is copied - with whatever packs a clone of the private
        vendor repository put in frontend\vendor. The copy then takes public\assets\build and leaves
        frontend\ behind. npm runs as `node npm-cli.js`; the folder of that node goes first on PATH,
        because npm's scripts start tsc and vite through node, and a Node.js installed a minute ago
        (winget) is not on this process's PATH yet.
    #>
    param([hashtable] $State)
    $frontend = $State.Env.Frontend
    $node = $frontend.Node
    if (-not $node -or -not $node.Ok) { throw (T 'error.frontend.node') }
    $packs = @($frontend.Packs)
    if ($packs.Count -gt 0) { Write-SetupLog (T 'plan.frontend.packs' ($packs -join ', ')) 'ok' } else { Write-SetupLog (T 'plan.frontend.public') 'ok' }
    $folder = Join-Path $State.SourceRoot 'frontend'
    $nodeDir = Split-Path -Parent $node.Exe
    # NO_COLOR: the log window shows text, not the terminal colour codes Vite would add.
    $environment = @{ npm_config_update_notifier = 'false'; npm_config_fund = 'false'; npm_config_audit = 'false'; NO_COLOR = '1' }
    if (@($env:Path.Split(';') | Where-Object { $_.TrimEnd('\') -ieq $nodeDir.TrimEnd('\') }).Count -eq 0) { $environment['PATH'] = $nodeDir + ';' + $env:Path }
    Invoke-SetupCommand -File $node.Exe -Arguments @($node.Npm, 'ci', '--no-audit', '--no-fund') -WorkingDirectory $folder -Environment $environment -TimeoutSeconds 1800 | Out-Null
    Invoke-SetupCommand -File $node.Exe -Arguments @($node.Npm, 'run', 'build') -WorkingDirectory $folder -Environment $environment -TimeoutSeconds 3600 | Out-Null
    $index = Join-Path $State.SourceRoot 'public\assets\build\index.html'
    if (-not $script:SetupContext.DryRun -and -not (Test-Path -LiteralPath $index -PathType Leaf)) { throw (T 'error.frontend.noBuild' $index) }
}

function Step-CopyFiles {
    param([hashtable] $State)
    if ($State.InPlace) { Write-SetupLog (T 'log.copy.inPlace' $State.TargetRoot); return }
    $robocopy = Join-Path $env:SystemRoot 'System32\robocopy.exe'
    $source = $State.SourceRoot.TrimEnd('\')
    $target = $State.TargetRoot.TrimEnd('\')
    # A name in /XD matches at any depth; a full path matches that one folder only.
    $excludeDirs = @($script:SetupCopyExcludeDirs) + @($script:SetupCopyExcludeTopDirs | ForEach-Object { Join-Path $source $_ })
    $excludeFiles = $script:SetupCopyExcludeFiles
    $arguments = @($source, $target, '/E', '/R:2', '/W:2', '/NP', '/NFL', '/NDL', '/NJH', '/XD') + $excludeDirs + @('/XF') + $excludeFiles
    Invoke-SetupCommand -File $robocopy -Arguments $arguments -OemOutput -SuccessCodes @(0, 1, 2, 3, 4, 5, 6, 7) | Out-Null
    if ($State.Flow -eq 'update') {
        # The built frontend names its files after their content; without mirroring,
        # every update would leave the previous version's files beside the new ones.
        $build = 'public\assets\build'
        Invoke-SetupCommand -File $robocopy -Arguments @((Join-Path $source $build), (Join-Path $target $build), '/MIR', '/R:2', '/W:2', '/NP', '/NFL', '/NDL', '/NJH') `
            -OemOutput -SuccessCodes @(0, 1, 2, 3, 4, 5, 6, 7) | Out-Null
    }
    Remove-SetupStaleFiles $State $target (Get-SetupPackageFiles $source)
}

function Get-SetupServiceAccountSids {
    <#
        The accounts the server's tasks run as. The tasks are registered for whoever runs the
        wizard, so that account always; on an existing installation also the accounts its tasks
        name now - a maintenance task kept as the owner made it keeps its own. The tasks run with
        limited rights (S4U), where the Administrators group does not count: each account needs
        its own entry, or a repair by another administrator locks the service out of its files.
    #>
    param([hashtable] $State)
    $sids = New-Object System.Collections.ArrayList
    [void] $sids.Add([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
    if ($State.Mode -eq 'maintain' -and $State.Env -and $State.Env.Existing) {
        foreach ($task in @($State.Env.Existing.ServiceTask, $State.Env.Existing.MaintenanceTask)) {
            if (-not $task -or -not $task.Exists -or -not $task.UserId) { continue }
            try {
                $sid = [string] (New-Object System.Security.Principal.NTAccount ([string] $task.UserId)).Translate([System.Security.Principal.SecurityIdentifier]).Value
                if (-not $sids.Contains($sid)) { [void] $sids.Add($sid) }
            } catch { }
        }
    }
    return @($sids)
}

function Step-HardenFolder {
    param([hashtable] $State)
    $grants = @(Get-SetupServiceAccountSids $State | ForEach-Object { "*${_}:(OI)(CI)M" })
    # A folder created under C:\ lets every signed-in user change it. This one holds
    # code that Apache runs as SYSTEM, so it is closed to everybody but the
    # administrators, SYSTEM and the account that installs (and later runs) the server.
    Invoke-SetupCommand -File (Join-Path $env:SystemRoot 'System32\icacls.exe') -OemOutput -Arguments (@(
            $State.TargetRoot.TrimEnd('\'), '/inheritance:r', '/grant:r', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F') + $grants + @('/Q')
    ) | Out-Null
    # Remembered, so that a repair puts it back after a move or a restore took it away.
    $State.Results.Hardened = $true
}

function Step-ProtectSecrets {
    <#
        Repair: the private configuration, its copies and the keys are closed again to all but the
        administrators, SYSTEM (Apache) and the service's account. Moving the tree with
        robocopy /MOVE or restoring it from a backup leaves only inherited rights (audit P2-9, P2-10).
    #>
    param([hashtable] $State)
    $paths = Get-SetupPaths $State
    $grants = @(Get-SetupServiceAccountSids $State | ForEach-Object { "*${_}:(F)" })
    $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
    foreach ($folder in @('config\origin', 'config\tls')) {
        $path = Join-Path $paths.Root $folder
        if (Test-Path -LiteralPath $path -PathType Container) {
            Invoke-SetupChange -What (T 'log.cert.folder' $path) -Do { Protect-SetupFolder $path } | Out-Null
        }
    }
    $files = @(Get-SetupSecretFiles $paths.Root)
    foreach ($file in $files) {
        Invoke-SetupCommand -File $icacls -OemOutput -Arguments (@($file, '/inheritance:r', '/grant:r') + $grants + @('*S-1-5-18:(F)', '*S-1-5-32-544:(F)', '/Q')) | Out-Null
    }
    if ($files.Count -eq 0) { Write-SetupLog (T 'log.secrets.none') 'ok' }
}

function Step-PythonEnvironment {
    param([hashtable] $State)
    $paths = Get-SetupPaths $State
    $python = $State.Env.Python.Exe
    $arguments = @((Join-Path $paths.Scripts 'install.py'), '--non-interactive', '--port', [string] $State.ServicePort)
    $environment = @{ PYTHONIOENCODING = 'utf-8'; PYTHONUTF8 = '1' }
    $venvDir = Join-Path $paths.Root '.venv'
    if ((Test-Path -LiteralPath $paths.VenvPython) -and -not (Test-SetupPythonStarts $paths.VenvPython -Fresh)) {
        # install.py builds the environment only where there is none; one that no longer
        # starts (its Python was upgraded or removed) has to go first, or Repair cannot help.
        Invoke-SetupChange -What (T 'log.venv.broken' $venvDir) -Do { Remove-Item -LiteralPath $venvDir -Recurse -Force } | Out-Null
    }
    if ($State.Flow -eq 'install') {
        # The folder is an installation in progress until Step-SaveState removes this: a run
        # that stops half way (a failed download, a closed window) is offered to be finished
        # next time instead of being taken for a finished installation (Detect, PagesInstall).
        $pending = Join-Path $paths.Root 'config\installer.pending.json'
        if (-not (Test-Path -LiteralPath $pending)) {
            $marker = ConvertTo-Json -InputObject @{ started = (Get-Date).ToString('s'); source = [string] $State.SourceRoot } -Depth 2
            Invoke-SetupChange -What (T 'log.pending.write' $pending) -Do {
                New-Item -ItemType Directory -Path (Split-Path -Parent $pending) -Force | Out-Null
                Write-SetupTextFile $pending $marker
            } | Out-Null
        }
    }
    if ($State.Flow -eq 'install' -and ($State.Results.ConfigCreated -or $State.ResumeRoot) -and (Test-Path -LiteralPath $paths.Config)) {
        # A second attempt of the same installation: the user may have gone back and
        # changed the database or the folders, and install.py never rewrites a
        # configuration that exists. The one from the first attempt is ours - no service
        # has used its key yet - so it is made again from the current answers.
        Invoke-SetupChange -What (T 'log.config.redo' $paths.Config) -Do { Remove-Item -LiteralPath $paths.Config -Force } | Out-Null
    }
    $fresh = -not (Test-Path -LiteralPath $paths.Config)
    if ($fresh) {
        $database = $State.Database
        $arguments += @('--db-host', [string] $database.Host, '--db-port', [string] $database.Port, '--db-name', [string] $database.Name, '--db-user', [string] $database.User)
        $ffmpeg = if ($State.FfmpegPath) { $State.FfmpegPath } else { 'ffmpeg' }
        $arguments += @('--ffmpeg-path', $ffmpeg)
        foreach ($root in @($State.Roots)) { $arguments += @('--root', ('{0}={1}' -f $root.Id, $root.Path)) }
        # install.py takes the password from the environment of its own process and
        # from nowhere else; it is not an argument and it is not ours to keep.
        $environment['MEDIA_SERVER_DB_PASSWORD'] = [string] $database.AppPassword
    }
    try {
        Invoke-SetupCommand -File $python -Arguments $arguments -WorkingDirectory $paths.Root -Environment $environment -TimeoutSeconds 2400 | Out-Null
    } finally {
        # install.py writes the configuration first and builds the environment after:
        # when the download fails, the file is already there, and it is this run's.
        if ($fresh -and -not $script:SetupContext.DryRun -and (Test-Path -LiteralPath $paths.Config)) { $State.Results.ConfigCreated = $true }
    }
    if (-not $script:SetupContext.DryRun) {
        if (-not (Test-Path -LiteralPath $paths.Config)) { throw (T 'error.noConfig' $paths.Config) }
        if (-not (Test-Path -LiteralPath $paths.VenvPython)) { throw (T 'error.noVenv' $paths.VenvPython) }
    }
}

function Step-ConfigAccess {
    param([hashtable] $State)
    $paths = Get-SetupPaths $State
    $values = Get-SetupAccessValues $State.Access
    $exists = Test-Path -LiteralPath $paths.Config
    if (-not $exists) {
        # Only a dry run of a fresh installation gets here: the file is not there to compare with.
        Write-SetupLog (T 'log.config.access' $paths.Config ($(if ($values.BaseUrl) { $values.BaseUrl } else { '/' })) ($(if ($values.Trusted) { $values.Trusted } else { '-' })) ($(if ($values.RequireHttps) { 'true' } else { 'false' }))) 'dry'
        return
    }
    $answer = Invoke-SetupHelper -Python (Get-SetupHelperPython $State) -Command 'config-access' -Request @{
        config = $paths.Config; project_root = $State.SourceRoot; base_url = $values.BaseUrl; proxy_trusted = $values.Trusted
        require_https = $values.RequireHttps; dry_run = [bool] $script:SetupContext.DryRun
    }
    if (-not $answer.changed) { Write-SetupLog (T 'log.config.unchanged') 'ok'; return }
    $level = if ($script:SetupContext.DryRun) { 'dry' } else { 'ok' }
    foreach ($change in @($answer.changes)) { Write-SetupLog ("config.local.toml: $change") $level }
    if ($answer.backup) { Write-SetupLog (T 'log.config.backup' $answer.backup) }
}

function Step-ConfigRoots {
    param([hashtable] $State)
    $paths = Get-SetupPaths $State
    $roots = @($State.Roots | ForEach-Object { @{ id = [string] $_.Id; path = [string] $_.Path } })
    $answer = Invoke-SetupHelper -Python (Get-SetupHelperPython $State) -Command 'config-roots' -Request @{
        config = $paths.Config; project_root = $State.SourceRoot; roots = $roots; dry_run = [bool] $script:SetupContext.DryRun
    }
    if (-not $answer.changed) { Write-SetupLog (T 'log.config.unchanged') 'ok'; return }
    $level = if ($script:SetupContext.DryRun) { 'dry' } else { 'ok' }
    foreach ($change in @($answer.changes)) { Write-SetupLog ("config.local.toml: $change") $level }
    if ($answer.backup) { Write-SetupLog (T 'log.config.backup' $answer.backup) }
}

function Step-DatabaseCreate {
    param([hashtable] $State)
    $database = $State.Database
    $name = [string] $database.Name; $user = [string] $database.User; $password = [string] $database.AppPassword
    if ($name -notmatch '^[A-Za-z0-9_]{1,64}$' -or $user -notmatch '^[A-Za-z0-9_]{1,32}$' -or $password -notmatch '^[A-Za-z0-9_-]{20,}$') {
        throw (T 'db.error.name')
    }
    # Two accounts with one password: a server set to skip name resolution sees the
    # application arrive from 127.0.0.1, any other sees it arrive from localhost.
    # Data rights only - the schema is changed by the administrator, never by the app.
    $sql = "CREATE DATABASE IF NOT EXISTS ``$name`` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`n"
    foreach ($origin in @('localhost', '127.0.0.1')) {
        $sql += "CREATE USER IF NOT EXISTS '$user'@'$origin' IDENTIFIED BY '$password';`n"
        $sql += "ALTER USER '$user'@'$origin' IDENTIFIED BY '$password';`n"
        $sql += "GRANT SELECT, INSERT, UPDATE, DELETE ON ``$name``.* TO '$user'@'$origin';`n"
    }
    $note = "CREATE DATABASE IF NOT EXISTS $name (utf8mb4); CREATE USER $user@localhost, $user@127.0.0.1; GRANT SELECT, INSERT, UPDATE, DELETE ON $name.*"
    Invoke-SetupMySql -Database $database -Sql $sql -Change -Note $note | Out-Null
    $State.Results.DatabaseCreated = $true
}

function Step-DatabaseMigrate {
    param([hashtable] $State)
    $paths = Get-SetupPaths $State
    $database = $State.Database
    Invoke-SetupCommand -File $paths.VenvPython -WorkingDirectory $paths.Root -Environment @{ PYTHONIOENCODING = 'utf-8' } -Arguments @(
        '-m', 'media_server', '--config', $paths.Config, 'migrate', '--as-user', [string] $database.AdminUser, '--password-stdin'
    ) -StdinText ([string] $database.AdminPassword + "`n") -StdinNote (T 'log.stdin.adminPassword') -Uninterruptible | Out-Null
    # No time limit and no cancel half way: DDL is not transactional in MySQL, and a migration
    # killed in the middle leaves a schema no later run can apply cleanly.
}

function Get-SetupDumpTool {
    <# mysqldump.exe (or mariadb-dump.exe) beside the client WampServer's database server came with. #>
    param([hashtable] $Database)
    if (-not $Database.Client) { return $null }
    $folder = Split-Path -Parent ([string] $Database.Client)
    foreach ($name in @('mysqldump.exe', 'mariadb-dump.exe')) {
        $candidate = Join-Path $folder $name
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

function Step-DatabaseBackup {
    <#
        Before an update migrates anything: the whole database, dumped with the administrator's
        sign-in into backups\database, a folder only the administrators, SYSTEM and this account
        can open (audit P3-12). A migration that goes wrong is then a restore, not a loss:
        mysql -u root <database> < <file>.
    #>
    param([hashtable] $State)
    $paths = Get-SetupPaths $State
    $database = $State.Database
    $name = [string] $database.Name
    if ($name -notmatch '^[A-Za-z0-9_]{1,64}$') { throw (T 'db.error.name') }
    $folder = Join-Path $paths.Root 'backups\database'
    $file = Join-Path $folder ('{0}-{1}-before-{2}.sql' -f $name, (Get-SetupStamp), ([string] $State.Version -replace '[^0-9A-Za-z.+_-]', '_'))
    $tool = Get-SetupDumpTool $database
    $shown = "mysqldump --single-transaction --no-tablespaces --hex-blob --result-file=`"$file`" $name   <<< " + (T 'log.stdin.optionsFile')
    if ($script:SetupContext.DryRun) { Write-SetupLog $shown 'dry'; return }
    if (-not $tool) { throw (T 'error.noDump' $(if ($database.Client) { Split-Path -Parent ([string] $database.Client) } else { 'WampServer' })) }
    Write-SetupLog $shown 'cmd'
    Protect-SetupFolder $folder
    $options = New-SetupMySqlOptions $database
    try {
        $result = Invoke-SetupProcess -File $tool -Quiet -Arguments @(
            "--defaults-extra-file=$options", '--single-transaction', '--no-tablespaces', '--hex-blob', '--default-character-set=utf8mb4', "--result-file=$file", $name)
        if ($result.ExitCode -ne 0) {
            $tail = (@($result.Output | Where-Object { $_ -and $_.Trim() } | Select-Object -Last 3) -join ' ').Trim()
            throw (T 'error.dump' $result.ExitCode (Protect-SetupText $tail))
        }
    } catch {
        # Half a dump is worse than none: it looks like a backup.
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
        throw
    } finally {
        Remove-Item -LiteralPath $options -Force -ErrorAction SilentlyContinue
    }
    $megabytes = [Math]::Round((Get-Item -LiteralPath $file).Length / 1MB, 1)
    $State.Results.DatabaseBackup = $file
    Write-SetupLog (T 'log.db.backup' $file $megabytes) 'ok'
}

function Step-RegisterRoots {
    param([hashtable] $State)
    $paths = Get-SetupPaths $State
    $arguments = @('-m', 'media_server', '--config', $paths.Config, 'roots', 'sync', '--disable-unconfigured')
    foreach ($root in @($State.Roots)) { $arguments += @('--kind', ('{0}={1}' -f $root.Id, $root.Kind)) }
    Invoke-SetupCommand -File $paths.VenvPython -WorkingDirectory $paths.Root -Environment @{ PYTHONIOENCODING = 'utf-8' } -Arguments $arguments -TimeoutSeconds 120 | Out-Null
}

function Step-CreateAdmin {
    param([hashtable] $State)
    $paths = Get-SetupPaths $State
    $admin = $State.Admin
    if ($State.Results.AdminCreated -and $State.Results.AdminCreated -eq [string] $admin.Username) {
        # "Try again" after a later step failed: the account is already there.
        Write-SetupLog (T 'log.admin.exists' $admin.Username) 'ok'
        return
    }
    if ($State.ResumeRoot) {
        # Finishing an installation that stopped after this step: the account may exist already.
        $name = [string] $admin.Username; $db = [string] $State.Database.Name
        if ($name -match '^[A-Za-z0-9._-]{3,32}$' -and $db -match '^[A-Za-z0-9_]{1,64}$') {
            try {
                $count = @(Invoke-SetupMySql -Database $State.Database -Sql "SELECT COUNT(*) FROM ``$db``.users WHERE username = '$name';" |
                    Where-Object { $_ -match '^\s*\d+\s*$' } | Select-Object -First 1)
                if ($count.Count -gt 0 -and [int] $count[0] -gt 0) {
                    Write-SetupLog (T 'log.admin.kept' $name) 'ok'
                    $State.Results.AdminCreated = $name
                    return
                }
            } catch { }
        }
    }
    $arguments = @('-m', 'media_server', '--config', $paths.Config, 'account-create', '--username', [string] $admin.Username, '--role', 'super_admin', '--password-stdin', '--php', [string] $State.Env.Wamp.Php.Exe)
    if ($admin.Email) { $arguments += @('--email', [string] $admin.Email) }
    Invoke-SetupCommand -File $paths.VenvPython -WorkingDirectory $paths.Root -Environment @{ PYTHONIOENCODING = 'utf-8' } -Arguments $arguments `
        -StdinText ([string] $admin.Password + "`n") -StdinNote (T 'log.stdin.accountPassword') -TimeoutSeconds 120 | Out-Null
    $State.Results.AdminCreated = [string] $admin.Username
}

function Protect-SetupFolder {
    <# A folder for private keys: no inherited permissions; this account, SYSTEM and the administrators only. #>
    param([string] $Path)
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    $security = New-Object System.Security.AccessControl.DirectorySecurity
    $security.SetAccessRuleProtection($true, $false)
    $inherit = [System.Security.AccessControl.InheritanceFlags] 'ContainerInherit, ObjectInherit'
    $none = [System.Security.AccessControl.PropagationFlags]::None
    foreach ($sid in @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')) {
        $who = New-Object System.Security.Principal.SecurityIdentifier $sid
        $security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($who, 'FullControl', $inherit, $none, 'Allow')))
    }
    [System.IO.Directory]::SetAccessControl($Path, $security)
}

function Find-SetupAdoptableOrigin {
    <#
        A self-signed certificate an HTTPS host in WampServer's file already serves - an
        origin made by hand and pinned on a VPS. Taking it over keeps that VPS working; a
        new one would show its maintenance page until the new certificate is installed there.
    #>
    param([hashtable] $State)
    foreach ($entry in @($State.Env.Wamp.Apache.HttpsCertificates)) {
        if (-not $entry -or -not $entry.Certificate -or -not $entry.Key -or ([string] $entry.Certificate).Contains('${')) { continue }
        if (-not (Test-Path -LiteralPath $entry.Certificate -PathType Leaf) -or -not (Test-Path -LiteralPath $entry.Key -PathType Leaf)) { continue }
        try {
            $certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (, [System.IO.File]::ReadAllBytes($entry.Certificate))
        } catch { continue }
        if ($certificate.Subject -eq $certificate.Issuer -and $certificate.NotAfter -gt (Get-Date).AddDays(30)) { return $entry }
    }
    return $null
}

function Step-Certificate {
    param([hashtable] $State)
    $paths = Get-SetupPaths $State
    $access = $State.Access
    $apache = $State.Env.Wamp.Apache
    if ($access.Mode -eq 'vps') {
        $certificate = $paths.OriginCert; $key = $paths.OriginKey
        # The name says nothing about the site or the program on purpose: this certificate is
        # what a scanner sees if it ever reaches the home address.
        $subject = '/CN=origin'
        $extra = @()
    } elseif ($access.Mode -eq 'direct' -and $access.SelfSigned) {
        $certificate = $paths.SelfCert; $key = $paths.SelfKey
        $subject = "/CN=$($access.HostName)"
        $extra = @('-addext', "subjectAltName=DNS:$($access.HostName)")
    } else {
        foreach ($file in @($access.CertificateFile, $access.KeyFile)) {
            if (-not $script:SetupContext.DryRun -and -not (Test-Path -LiteralPath $file -PathType Leaf)) { throw (T 'error.noCertificate' $file) }
        }
        Write-SetupLog (T 'log.cert.own' $access.CertificateFile) 'ok'
        return
    }
    $access.CertificateFile = $certificate
    $access.KeyFile = $key
    $folder = Split-Path -Parent $certificate
    if ((Test-Path -LiteralPath $certificate) -and (Test-Path -LiteralPath $key) -and -not $access.Regenerate) {
        # Kept, but its folder still private: a restore or a hand copy brings it back with inherited rights.
        Invoke-SetupChange -What (T 'log.cert.folder' $folder) -Do { Protect-SetupFolder $folder } | Out-Null
        Write-SetupLog (T 'log.cert.kept' $certificate) 'ok'
        return
    }
    if ($access.Mode -eq 'vps' -and -not $access.Regenerate) {
        $adopted = Find-SetupAdoptableOrigin $State
        if ($adopted) {
            Invoke-SetupChange -What (T 'log.cert.adopt' $adopted.Certificate $certificate) -Do {
                Protect-SetupFolder $folder
                Copy-Item -LiteralPath $adopted.Certificate -Destination $certificate -Force
                Copy-Item -LiteralPath $adopted.Key -Destination $key -Force
            } | Out-Null
            $State.Results.CertificateAdopted = $true
            return
        }
    }
    Invoke-SetupChange -What (T 'log.cert.folder' $folder) -Do { Protect-SetupFolder $folder } | Out-Null
    # A server certificate, not an authority. `req -x509` with WampServer's openssl.cnf adds its
    # v3_ca extensions (CA:TRUE), and Firefox refuses a CA certificate presented by a server with no
    # way to proceed (MOZILLA_PKIX_ERROR_CA_CERT_USED_AS_END_ENTITY): for a self-signed site that is
    # every Firefox visitor, for the origin certificate whoever opens the home address directly. So
    # a minimal config of our own (no extension in it twice, which OpenSSL 1.1.1 refuses with
    # -addext); the VPS pins the certificate itself, so CA:FALSE changes nothing there.
    $config = Join-Path ([System.IO.Path]::GetTempPath()) ('tryhackx-certificate-' + [guid]::NewGuid().ToString('N') + '.cnf')
    # No keyUsage: OpenSSL before 1.1.1h (Ubuntu 20.04 on a VPS) does not accept a self-issued
    # certificate whose keyUsage lacks keyCertSign as its own trust anchor, and the pin is exactly that.
    # authorityKeyIdentifier, as on Debian: while a VPS trusts the old and the new certificate at once
    # (a replacement without downtime), two "CN=origin" without it make OpenSSL reject the first one in
    # the file - measured with WampServer's OpenSSL 3.5.1 on 13.11.2026; with it both verify in either order.
    $configText = @('[req]', 'distinguished_name = dn', 'prompt = no', 'x509_extensions = server', '[dn]', 'CN = origin', '[server]',
        'basicConstraints = critical, CA:FALSE', 'extendedKeyUsage = serverAuth', 'subjectKeyIdentifier = hash',
        'authorityKeyIdentifier = keyid:always', '') -join "`n"
    # A dry run writes nothing, not even a temporary file: the command is only shown.
    if (-not $script:SetupContext.DryRun) { [System.IO.File]::WriteAllText($config, $configText, (New-Object System.Text.UTF8Encoding($false))) }
    try {
        $arguments = @('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-sha256', '-days', '3650',
            '-subj', $subject, '-keyout', $key, '-out', $certificate, '-config', $config) + $extra
        Invoke-SetupCommand -File $apache.OpenSsl -Arguments $arguments -TimeoutSeconds 120 | Out-Null
    } finally {
        Remove-Item -LiteralPath $config -Force -ErrorAction SilentlyContinue
    }
    $State.Results.CertificateCreated = $true
}

function Update-SetupServerFile {
    <# Puts a file the helper prepared in place of one of WampServer's, keeping a copy for the rollback. #>
    param([hashtable] $State, [string] $Path, [string] $NewFile)
    $existed = Test-Path -LiteralPath $Path -PathType Leaf
    $backup = if ($existed) { Backup-SetupFile $State $Path } else { $null }
    Write-SetupLog (T 'log.file.write' $Path) 'cmd'
    Copy-Item -LiteralPath $NewFile -Destination $Path -Force
    [void] $State.ApacheChanges.Add(@{ Path = $Path; Backup = $backup; Existed = $existed })
}

function Restore-SetupServerFiles {
    <# The rollback: every WampServer file this run touched goes back to what it was. #>
    param([hashtable] $State)
    $changes = @($State.ApacheChanges)
    [array]::Reverse($changes)
    foreach ($change in $changes) {
        try {
            if ($change.Existed -and $change.Backup) { Copy-Item -LiteralPath $change.Backup -Destination $change.Path -Force }
            elseif (-not $change.Existed) { Remove-Item -LiteralPath $change.Path -Force -ErrorAction SilentlyContinue }
            Write-SetupLog (T 'log.file.restored' $change.Path) 'warn'
        } catch {
            Write-SetupLog (T 'log.file.restoreFailed' $change.Path $_.Exception.Message) 'error'
        }
    }
    $State.ApacheChanges.Clear()
}

function Get-SetupAliasTarget {
    <# The file in WampServer's alias folder this installation owns (an existing one keeps its name). #>
    param([hashtable] $State)
    $wamp = $State.Env.Wamp
    $root = [System.IO.Path]::GetFullPath($State.TargetRoot).TrimEnd('\')
    foreach ($alias in @($State.Env.Existing.Aliases)) {
        if ($alias -and ([System.IO.Path]::GetFullPath($alias.Root).TrimEnd('\') -ieq $root)) { return $alias.File }
    }
    return (Join-Path $wamp.AliasDir $script:SetupNames.AliasFile)
}

function Step-ApacheModules {
    param([hashtable] $State)
    $apache = $State.Env.Wamp.Apache
    $missing = @(Get-SetupRequiredModules $State.Access.Mode | Where-Object { $apache.Modules -notcontains $_ })
    if ($missing.Count -eq 0) { Write-SetupLog (T 'log.apache.modulesOk') 'ok'; return }
    $request = @{ path = $apache.Conf; modules = $missing }
    $newFile = Join-Path (Get-SetupBackupDir $State) 'new\httpd.conf'
    if (-not $script:SetupContext.DryRun) { $request.output = $newFile }
    $answer = Invoke-SetupHelper -Python (Get-SetupHelperPython $State) -Command 'apache-modules' -Request $request
    if (@($answer.missing).Count -gt 0) { throw (T 'error.apache.noModule' (@($answer.missing) -join ', ')) }
    if (@($answer.enabled).Count -eq 0) { Write-SetupLog (T 'log.apache.modulesOk') 'ok'; return }
    if ($script:SetupContext.DryRun) {
        Write-SetupLog (T 'log.apache.enable' $apache.Conf (@($answer.enabled) -join ', ')) 'dry'
        return
    }
    Update-SetupServerFile $State $apache.Conf $newFile
    Write-SetupLog (T 'log.apache.enable' $apache.Conf (@($answer.enabled) -join ', ')) 'ok'
    $State.Results.ModulesEnabled = @($answer.enabled)
    $State.ApacheChanged = $true
}

function Set-SetupServerQuiet {
    <#
        Public modes (VPS, own domain): Apache and PHP stop naming themselves. Stock
        WampServer sends "Apache/2.4.x (Win64) OpenSSL/... PHP/..." in every answer and signs
        its error pages. Each file is backed up and rolled back with the rest of the Apache
        changes; the bytes around the edited lines stay as they were (Latin-1 round trip).
    #>
    param([hashtable] $State)
    $edits = @(
        @{ Path = [string] $State.Env.Wamp.Apache.Conf; Pairs = @(@('ServerTokens', 'ServerTokens Prod'), @('ServerSignature', 'ServerSignature Off')) },
        @{ Path = [string] $State.Env.Wamp.Php.Ini; Pairs = @(@('expose_php', 'expose_php = Off')) }
    )
    $latin = [System.Text.Encoding]::GetEncoding(28591)
    foreach ($edit in $edits) {
        if (-not $edit.Path -or -not (Test-Path -LiteralPath $edit.Path -PathType Leaf)) { continue }
        $original = $latin.GetString([System.IO.File]::ReadAllBytes($edit.Path))
        $text = $original
        $newline = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
        foreach ($pair in $edit.Pairs) {
            $pattern = '(?im)^[ \t]*' + [regex]::Escape($pair[0]) + '\b[^\r\n]*'
            if ([regex]::IsMatch($text, $pattern)) { $text = [regex]::Replace($text, $pattern, $pair[1]) }
            else { $text = $text.TrimEnd("`r", "`n") + $newline + $pair[1] + $newline }
        }
        if ($text -ceq $original) { Write-SetupLog (T 'log.apache.quietOk' $edit.Path) 'ok'; continue }
        if ($script:SetupContext.DryRun) { Write-SetupLog (T 'log.apache.quiet' $edit.Path) 'dry'; continue }
        $newFile = Join-Path (Join-Path (Get-SetupBackupDir $State) 'new') ([System.IO.Path]::GetFileName($edit.Path))
        New-Item -ItemType Directory -Path (Split-Path -Parent $newFile) -Force | Out-Null
        [System.IO.File]::WriteAllBytes($newFile, $latin.GetBytes($text))
        Update-SetupServerFile $State $edit.Path $newFile
        Write-SetupLog (T 'log.apache.quiet' $edit.Path) 'ok'
        $State.ApacheChanged = $true
    }
}

function Step-ApacheConfig {
    param([hashtable] $State)
    try {
        if (@('vps', 'direct') -contains [string] $State.Access.Mode) { Set-SetupServerQuiet $State }
        Invoke-SetupApacheConfig $State
    } catch {
        # A failure half way - the helper refusing a file after an alias was already removed
        # or written - must not leave untested files for the next WampServer start.
        if (-not $script:SetupContext.DryRun -and $State.ApacheChanges -and $State.ApacheChanges.Count -gt 0) { Restore-SetupServerFiles $State }
        throw
    }
}

function Invoke-SetupApacheConfig {
    param([hashtable] $State)
    $paths = Get-SetupPaths $State
    $wamp = $State.Env.Wamp
    $apache = $wamp.Apache
    $access = $State.Access
    $python = Get-SetupHelperPython $State
    $aliasFile = Get-SetupAliasTarget $State
    $State.Results.AliasFile = $aliasFile
    $dry = [bool] $script:SetupContext.DryRun
    $newDir = Join-Path (Get-SetupBackupDir $State) 'new'

    $inspect = Invoke-SetupHelper -Python $python -Command 'apache-inspect' -Request @{
        httpd_conf = $apache.Conf; vhosts_conf = $apache.VhostsConf; alias_dir = $wamp.AliasDir; our_alias = $aliasFile
    }
    $https = ($access.Mode -eq 'vps' -or $access.Mode -eq 'direct')
    $secureHosts = @($inspect.virtual_hosts | Where-Object { @($_.ports) -contains 443 })
    if ($https -and $secureHosts.Count -gt 0 -and -not $access.DisableExistingHttps) {
        throw (T 'error.apache.existingHttps' (@($secureHosts | ForEach-Object { $_.server_name }) -join ', '))
    }

    # Another alias file that defines the same routes for a different tree cannot
    # stay: Apache would serve whichever it read last.
    foreach ($alias in @($inspect.aliases)) {
        if ($alias.file -ieq $aliasFile) { continue }
        if ($dry) { Write-SetupLog (T 'log.apache.removeAlias' $alias.file) 'dry'; continue }
        $backup = Backup-SetupFile $State $alias.file
        Write-SetupLog (T 'log.apache.removeAlias' $alias.file) 'cmd'
        Remove-Item -LiteralPath $alias.file -Force
        [void] $State.ApacheChanges.Add(@{ Path = $alias.file; Backup = $backup; Existed = $true })
        $State.ApacheChanged = $true
    }

    $conf = @{
        root = $paths.Root; service_port = [int] $State.ServicePort; mode = [string] $access.Mode
        host_name = $access.HostName; vps_addresses = @($access.VpsAddresses); allow_lan = [bool] $access.AllowLan
        certificate_file = $access.CertificateFile; certificate_key_file = $access.KeyFile
        add_listen_443 = ($https -and -not $inspect.listen_443)
        generated = (Get-Date).ToString('yyyy-MM-dd HH:mm')
    }
    $request = @{ template = $paths.Template; conf = $conf }
    $newAlias = Join-Path $newDir ([System.IO.Path]::GetFileName($aliasFile))
    if (-not $dry) { $request.output = $newAlias }
    $rendered = Invoke-SetupHelper -Python $python -Command 'apache-render' -Request $request
    $summary = (T 'log.apache.alias' $aliasFile $rendered.lines (@($rendered.access) -join '; '))
    if ($dry) { Write-SetupLog $summary 'dry' }
    else {
        Update-SetupServerFile $State $aliasFile $newAlias
        Write-SetupLog $summary 'ok'
        $State.ApacheChanged = $true
    }

    $vhostRequest = @{ path = $apache.VhostsConf; document_root = $paths.Build }
    if ($https -and $secureHosts.Count -gt 0 -and $access.DisableExistingHttps) { $vhostRequest.disable_port = 443 }
    $newVhosts = Join-Path $newDir 'httpd-vhosts.conf'
    if (-not $dry) { $vhostRequest.output = $newVhosts }
    $vhosts = Invoke-SetupHelper -Python $python -Command 'apache-vhosts-set' -Request $vhostRequest
    foreach ($name in @($vhosts.disabled_hosts)) { Write-SetupLog (T 'log.apache.hostOff' $name) $(if ($dry) { 'dry' } else { 'warn' }) }
    if ($vhosts.info.adopted) { Write-SetupLog (T 'log.apache.docrootAdopted' $apache.VhostsConf) 'ok' }
    elseif (-not $vhosts.changed) { Write-SetupLog (T 'log.apache.docrootOk' $apache.VhostsConf) 'ok' }
    elseif ($dry) { Write-SetupLog (T 'log.apache.docroot' $apache.VhostsConf $vhosts.info.previous $paths.Build) 'dry' }
    else {
        Update-SetupServerFile $State $apache.VhostsConf $newVhosts
        Write-SetupLog (T 'log.apache.docroot' $apache.VhostsConf $vhosts.info.previous $paths.Build) 'ok'
        $State.ApacheChanged = $true
    }
    $State.Results.VhostsManaged = ([bool] $vhosts.changed -or [bool] $vhosts.info.managed)
}

function Step-ApacheTest {
    param([hashtable] $State)
    $apache = $State.Env.Wamp.Apache
    # The configuration file is named, not left to the default: it is the one this run
    # edited, whatever ServerRoot the binary was built with.
    $arguments = @('-t', '-f', [string] $apache.Conf)
    $shown = (ConvertTo-NativeArgument $apache.Httpd) + ' ' + (Join-NativeArguments $arguments)
    if ($script:SetupContext.DryRun) { Write-SetupLog $shown 'dry'; return }
    Write-SetupLog $shown 'cmd'
    $result = Invoke-SetupProcess -File $apache.Httpd -Arguments $arguments -OemOutput -Quiet -TimeoutSeconds 60
    $lines = @($result.Output | Where-Object { $_ -and $_ -notmatch '^AH00112' })
    if ($result.ExitCode -ne 0) {
        foreach ($line in $lines) { Write-SetupLog $line 'error' }
        # Apache is still running the configuration it started with. Put the files
        # back before anything restarts it.
        Restore-SetupServerFiles $State
        throw (T 'error.apache.syntax' ((@($lines | Select-Object -Last 2) -join ' ').Trim()))
    }
    Write-SetupLog (T 'log.apache.syntaxOk') 'ok'
}

function Wait-SetupPort {
    param([int] $Port, [int] $Seconds = 30)
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (@(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue).Count -gt 0) { return $true }
        Start-Sleep -Milliseconds 400
    }
    return $false
}

function Step-ApacheRestart {
    param([hashtable] $State)
    $service = [string] $State.Env.Wamp.Apache.Service.Name
    if (-not $State.ApacheChanged -and $State.Env.Wamp.Apache.Service.Running -and -not $script:SetupContext.DryRun) {
        Write-SetupLog (T 'log.apache.noRestart') 'ok'
        return
    }
    $restart = {
        $current = Get-Service -Name $service -ErrorAction Stop
        if ($current.Status -eq 'Running') { Restart-Service -Name $service -Force -ErrorAction Stop } else { Start-Service -Name $service -ErrorAction Stop }
    }
    if ($script:SetupContext.DryRun) { Write-SetupLog "Restart-Service -Name $service" 'dry'; return }
    Write-SetupLog "Restart-Service -Name $service" 'cmd'
    $failure = $null
    try { & $restart } catch { $failure = [string] $_.Exception.Message }
    if (-not $failure -and -not (Wait-SetupPort 80 40)) { $failure = (T 'error.apache.noListen') }
    if ($failure) {
        # WampServer must not be left down because of us: back to the previous files, and start it again.
        Write-SetupLog $failure 'error'
        if ($State.ApacheChanges.Count -gt 0) {
            Restore-SetupServerFiles $State
            try { & $restart; [void] (Wait-SetupPort 80 40) } catch { Write-SetupLog ([string] $_.Exception.Message) 'error' }
        }
        throw (T 'error.apache.restart' $failure)
    }
    Write-SetupLog (T 'log.apache.restarted') 'ok'
}

function Get-SetupFirewallRules {
    <# The rules an access mode needs: data, so the summary page can list exactly what the step creates. #>
    param([hashtable] $Access)
    $rules = @()
    # A home-network rule holds on private networks only: "local subnet" on a hotel or
    # cafe network would otherwise open the server to everyone sitting there (audit P3-8).
    switch ($Access.Mode) {
        'lan'    { $rules += @{ Name = 'TryHackX-Media-HTTP-LAN'; DisplayName = 'TryHackX Media Server - HTTP from the home network'; Port = 80; Remote = @('LocalSubnet'); Profile = 'Private' } }
        'direct' {
            $rules += @{ Name = 'TryHackX-Media-HTTP'; DisplayName = 'TryHackX Media Server - HTTP (redirect to HTTPS)'; Port = 80; Remote = @('Any'); Profile = 'Any' }
            $rules += @{ Name = 'TryHackX-Media-HTTPS'; DisplayName = 'TryHackX Media Server - HTTPS'; Port = 443; Remote = @('Any'); Profile = 'Any' }
        }
        'vps'    {
            $rules += @{ Name = 'TryHackX-Media-HTTPS-VPS'; DisplayName = 'TryHackX Media Server - HTTPS from the VPS only'; Port = 443; Remote = @($Access.VpsAddresses); Profile = 'Any' }
            if ($Access.AllowLan) { $rules += @{ Name = 'TryHackX-Media-HTTPS-LAN'; DisplayName = 'TryHackX Media Server - HTTPS from the home network'; Port = 443; Remote = @('LocalSubnet'); Profile = 'Private' } }
        }
    }
    return @($rules)
}

function Test-SetupLanRulePublic {
    <# Whether a home-network rule is planned while Windows calls the current network public: it would not apply. #>
    param([hashtable] $State)
    $lanRule = @(Get-SetupFirewallRules $State.Access | Where-Object { $_.Profile -eq 'Private' }).Count -gt 0
    return ($lanRule -and $State.Env.Lan -and [string] $State.Env.Lan.Category -eq 'Public')
}

function Step-Firewall {
    param([hashtable] $State)
    $group = $script:SetupNames.FirewallGroup
    # Our own rules are always rebuilt from nothing. What is there is asked of Windows
    # now, not taken from the first look at the machine: a second attempt after a
    # failed one must not trip over rules the first attempt created.
    $existing = if ($script:SetupContext.DryRun) { @($State.Env.Firewall.Ours) } else { @(Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue) }
    if ($existing.Count -gt 0) {
        Invoke-SetupChange -What "Remove-NetFirewallRule -Group '$group'  ($($existing.Count))" -Do {
            Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction Stop
        } | Out-Null
    }
    foreach ($rule in @(Get-SetupFirewallRules $State.Access)) {
        $what = "New-NetFirewallRule -DisplayName '$($rule.DisplayName)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $($rule.Port) -RemoteAddress $(@($rule.Remote) -join ',') -Profile $($rule.Profile)"
        Invoke-SetupChange -What $what -Do {
            New-NetFirewallRule -Name $rule.Name -DisplayName $rule.DisplayName -Group $group -Direction Inbound -Action Allow `
                -Protocol TCP -LocalPort $rule.Port -RemoteAddress $rule.Remote -Profile $rule.Profile -ErrorAction Stop | Out-Null
        } | Out-Null
    }
    if (Test-SetupLanRulePublic $State) {
        Write-SetupLog (T 'log.firewall.publicNetwork') 'warn'
        [void] $State.Results.Warnings.Add((T 'log.firewall.publicNetwork'))
    }
    $previously = @()
    if ($State.SavedState -and $State.SavedState.firewall -and $State.SavedState.firewall.disabled_rules) { $previously = @($State.SavedState.firewall.disabled_rules) }
    $disabled = New-Object System.Collections.ArrayList
    foreach ($name in $previously) { [void] $disabled.Add([string] $name) }
    $narrow = ($State.Access.Mode -eq 'vps' -or $State.Access.Mode -eq 'lan')
    if (-not $narrow) {
        # "This computer only" leaves the firewall alone and "own domain" opens the ports to
        # everybody anyway: either way, rules an earlier, narrower mode switched off come back.
        foreach ($name in $previously) {
            Invoke-SetupChange -What "Enable-NetFirewallRule -Name '$name'" -Do { Enable-NetFirewallRule -Name $name -ErrorAction SilentlyContinue } | Out-Null
        }
        $disabled.Clear()
    } elseif ($State.Options.DisableGenericRules) {
        foreach ($rule in @($State.Env.Firewall.Generic | Where-Object { $_.Enabled })) {
            Invoke-SetupChange -What "Disable-NetFirewallRule -Name '$($rule.Name)'   # $($rule.DisplayName), $($rule.Profile)" -Do {
                Disable-NetFirewallRule -Name $rule.Name -ErrorAction Stop
            } | Out-Null
            if (-not $disabled.Contains([string] $rule.Name)) { [void] $disabled.Add([string] $rule.Name) }
        }
    }
    $State.Results.DisabledRules = @($disabled)
}

function Step-StopService {
    param([hashtable] $State)
    $paths = Get-SetupPaths $State
    $stopScript = Join-Path $paths.Scripts 'stop-stage-windows.ps1'
    if (-not (Test-Path -LiteralPath $paths.Config) -or -not (Test-Path -LiteralPath $stopScript)) {
        Write-SetupLog (T 'log.service.nothingToStop') 'ok'
        return
    }
    Invoke-SetupCommand -File (Get-SetupPowerShell) -WorkingDirectory $paths.Root -OemOutput -TimeoutSeconds 120 -Arguments @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $stopScript, '-TaskName', [string] $State.Names.ServiceTask
    ) | Out-Null
}

function Step-Tasks {
    param([hashtable] $State)
    $paths = Get-SetupPaths $State
    $powershell = Get-SetupPowerShell
    $common = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File')
    # Re-registering a running task leaves its process behind, holding the port.
    Step-StopService $State
    Invoke-SetupCommand -File $powershell -WorkingDirectory $paths.Root -OemOutput -TimeoutSeconds 120 -Uninterruptible -Arguments ($common + @(
            (Join-Path $paths.Scripts 'register-stage-task-windows.ps1'), '-TaskName', [string] $State.Names.ServiceTask, '-Replace')) | Out-Null
    # An installation set up by hand keeps its periodic run exactly as it was made: a repair
    # brings back what is broken, it does not start what the owner chose not to run (the
    # weekly digest comes with -PhpPath).
    $manual = (-not ($State.SavedState -and $State.SavedState.access))
    $existing = $State.Env.Existing.MaintenanceTask
    if (@('repair', 'update') -contains $State.Flow -and $manual -and $existing -and $existing.Exists) {
        Write-SetupLog (T 'log.tasks.keptMaintenance' $State.Names.MaintenanceTask) 'ok'
        return
    }
    $maintenance = $common + @((Join-Path $paths.Scripts 'register-maintenance-task-windows.ps1'), '-TaskName', [string] $State.Names.MaintenanceTask, '-Replace', '-MetadataLimit', '5000')
    if ($State.Env.Wamp.Php.Exe) { $maintenance += @('-PhpPath', [string] $State.Env.Wamp.Php.Exe) }
    Invoke-SetupCommand -File $powershell -WorkingDirectory $paths.Root -OemOutput -TimeoutSeconds 120 -Uninterruptible -Arguments $maintenance | Out-Null
}

function Step-Services {
    param([hashtable] $State)
    $names = @([string] $State.Env.Wamp.Apache.Service.Name)
    if ($State.Database -and $State.Database.Service) { $names += [string] $State.Database.Service }
    $changed = @()
    foreach ($name in @($names | Where-Object { $_ } | Select-Object -Unique)) {
        $info = Get-SetupServiceInfo $name
        if (-not $info.Exists) { continue }
        if ($info.StartMode -eq 'Auto') { Write-SetupLog (T 'log.services.already' $name) 'ok'; continue }
        Invoke-SetupChange -What "Set-Service -Name $name -StartupType Automatic" -Do { Set-Service -Name $name -StartupType Automatic -ErrorAction Stop } | Out-Null
        $changed += $name
    }
    $State.Results.ServicesAutoStart = @($changed)
}

function Step-StartService {
    param([hashtable] $State)
    $paths = Get-SetupPaths $State
    Invoke-SetupCommand -File (Get-SetupPowerShell) -WorkingDirectory $paths.Root -OemOutput -TimeoutSeconds 180 -Arguments @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $paths.Scripts 'start-stage-windows.ps1'),
        '-TaskName', [string] $State.Names.ServiceTask, '-WaitSeconds', '60'
    ) | Out-Null
    if ($script:SetupContext.DryRun) { return }
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    $health = @{ Ready = $false }
    while ([DateTime]::UtcNow -lt $deadline) {
        $health = Get-SetupHealth ([int] $State.ServicePort)
        if ($health.Ready) { break }
        Start-Sleep -Milliseconds 700
    }
    if ($health.Ready) { Write-SetupLog (T 'log.service.ready' $State.ServicePort) 'ok' }
    else {
        Write-SetupLog (T 'log.service.notReady' $State.ServicePort) 'warn'
        [void] $State.Results.Warnings.Add((T 'log.service.notReady' $State.ServicePort))
    }
}

function Step-VpsBundle {
    param([hashtable] $State)
    $paths = Get-SetupPaths $State
    $access = $State.Access
    $request = @{
        template_dir = $paths.VpsTemplates; output_dir = $paths.BundleDir; host_name = [string] $access.HostName
        home_address = [string] $access.HomeAddress; vps_addresses = @($access.VpsAddresses); lan_address = [string] $State.Env.Lan.Address
        certificate = $paths.OriginCert; generated = (Get-Date).ToString('yyyy-MM-dd'); dry_run = [bool] $script:SetupContext.DryRun
    }
    # The guide says "only the VPS gets in" only when that is true: no general Apache rule left on
    # and no firewall profile switched off (audit P2-6).
    $genericLeft = (-not $State.Options.DisableGenericRules) -and @($State.Env.Firewall.Generic | Where-Object { $_ -and $_.Enabled }).Count -gt 0
    $profilesOn = $true
    try { $profilesOn = @(Get-NetFirewallProfile -ErrorAction Stop | Where-Object { [string] $_.Enabled -eq 'False' }).Count -eq 0 } catch { }
    $request.firewall_managed = ([bool] $State.Env.Firewall.Available -and -not $genericLeft -and $profilesOn)
    $State.Results.BundleDir = $paths.BundleDir
    if (-not (Test-Path -LiteralPath $paths.OriginCert)) {
        # A dry run of a fresh installation: there is no certificate to read yet.
        Write-SetupLog (T 'log.bundle.files' $paths.BundleDir 'tryhackx-media.conf, tryhackx-media-ssl.conf, origin.crt, maintenance.html, INSTRUKCJA-VPS.md, VPS-GUIDE.md, vps-setup.sh') 'dry'
        return
    }
    try {
        $certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $paths.OriginCert
        $request.certificate_not_after = $certificate.NotAfter.ToString('yyyy-MM-dd')
        $State.Results.CertificateNotAfter = $request.certificate_not_after
    } catch { }
    $answer = Invoke-SetupHelper -Python (Get-SetupHelperPython $State) -Command 'vps-bundle' -Request $request
    $level = if ($script:SetupContext.DryRun) { 'dry' } else { 'ok' }
    Write-SetupLog (T 'log.bundle.files' $paths.BundleDir (@($answer.files) -join ', ')) $level
    $State.Results.CertificateFingerprint = [string] $answer.fingerprint
    # Windows opens nothing with a .md file; a .txt twin of each guide opens in Notepad with a
    # double-click, and the finish page has a button for it (audit P3-23).
    $guide = if ($script:SetupContext.Language -eq 'en') { 'VPS-GUIDE' } else { 'INSTRUKCJA-VPS' }
    foreach ($name in @('INSTRUKCJA-VPS', 'VPS-GUIDE')) {
        $markdown = Join-Path $paths.BundleDir ($name + '.md')
        if ($script:SetupContext.DryRun -or -not (Test-Path -LiteralPath $markdown)) { continue }
        Copy-Item -LiteralPath $markdown -Destination (Join-Path $paths.BundleDir ($name + '.txt')) -Force
    }
    $State.Results.GuideFile = Join-Path $paths.BundleDir ($guide + '.txt')
}

function Step-FirstScan {
    param([hashtable] $State)
    $task = [string] $State.Names.MaintenanceTask
    Invoke-SetupChange -What "Start-ScheduledTask -TaskName '$task'" -Do { Start-ScheduledTask -TaskName $task -ErrorAction Stop } | Out-Null
    $State.Results.ScanStarted = $true
}

function Step-SaveState {
    <# Everything the wizard wrote or switched, so that a later run - or an uninstall - can find it. #>
    param([hashtable] $State)
    $paths = Get-SetupPaths $State
    $saved = if ($State.SavedState) { $State.SavedState } else { @{} }
    $access = $State.Access
    $results = $State.Results
    $record = @{
        version = 1
        product_version = [string] $State.Version
        installed_at = $(if ($saved.installed_at) { $saved.installed_at } else { (Get-Date).ToString('s') })
        updated_at = (Get-Date).ToString('s')
        root = $paths.Root
        wamp = [string] $State.Env.Wamp.InstallDir
        service_port = [int] $State.ServicePort
        tasks = @{ service = [string] $State.Names.ServiceTask; maintenance = [string] $State.Names.MaintenanceTask }
        alias_file = $(if ($results.AliasFile) { $results.AliasFile } else { $saved.alias_file })
        vhosts_managed = $(if ($null -ne $results.VhostsManaged) { [bool] $results.VhostsManaged } else { [bool] $saved.vhosts_managed })
        modules_enabled = @(@($saved.modules_enabled) + @($results.ModulesEnabled) | Where-Object { $_ } | Select-Object -Unique)
        access = @{
            mode = [string] $access.Mode; host_name = $access.HostName; vps_addresses = @($access.VpsAddresses)
            home_address = $access.HomeAddress; allow_lan = [bool] $access.AllowLan
            certificate_file = $access.CertificateFile; key_file = $access.KeyFile; self_signed = [bool] $access.SelfSigned
        }
        firewall = @{ group = $script:SetupNames.FirewallGroup; disabled_rules = @($results.DisabledRules) }
        services_autostart = @(@($saved.services_autostart) + @($results.ServicesAutoStart) | Where-Object { $_ } | Select-Object -Unique)
        hardened = ([bool] $results.Hardened -or [bool] $saved.hardened)
        database = $(if ($State.Database) { @{
                    engine = [string] $State.Database.Engine; host = [string] $State.Database.Host; port = [int] $State.Database.Port
                    name = [string] $State.Database.Name; user = [string] $State.Database.User
                    created_by_wizard = ([bool] $results.DatabaseCreated -or ($saved.database -and [bool] $saved.database.created_by_wizard))
                } } else { $saved.database })
        bundle_dir = $(if ($results.BundleDir) { $results.BundleDir } else { $saved.bundle_dir })
    }
    $json = ConvertTo-Json -InputObject $record -Depth 6
    Invoke-SetupChange -What (T 'log.state.write' $paths.StateFile) -Do { Write-SetupTextFile $paths.StateFile $json } | Out-Null
    $pending = Join-Path $paths.Root 'config\installer.pending.json'
    if (Test-Path -LiteralPath $pending) {
        Invoke-SetupChange -What (T 'log.pending.remove' $pending) -Do { Remove-Item -LiteralPath $pending -Force } | Out-Null
    }
}

function Step-Verify {
    <# The last look: does the address answer, does the bridge answer, are the internal routes closed. #>
    param([hashtable] $State)
    if ($script:SetupContext.DryRun) { Write-SetupLog 'GET http://127.0.0.1/ ; GET http://127.0.0.1/media-next-api?action=auth_state ; GET http://127.0.0.1/media-transfer/health/ready (403)' 'dry'; return }
    $get = {
        param($url)
        try { $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 10; return @{ Status = [int] $response.StatusCode; Body = [string] $response.Content } }
        catch {
            $status = 0
            if ($_.Exception.Response) { $status = [int] $_.Exception.Response.StatusCode }
            return @{ Status = $status; Body = '' }
        }
    }
    $checks = @()
    $page = & $get 'http://127.0.0.1/'
    $checks += @{ Name = 'page'; Ok = ($page.Status -eq 200 -and $page.Body.Contains('media-app-base')); Detail = "http://127.0.0.1/ -> $($page.Status)" }
    $bridge = & $get 'http://127.0.0.1/media-next-api?action=auth_state'
    $checks += @{ Name = 'bridge'; Ok = ($bridge.Status -eq 200); Detail = "media-next-api -> $($bridge.Status)" }
    $internal = & $get 'http://127.0.0.1/media-transfer/health/ready'
    $checks += @{ Name = 'internal'; Ok = ($internal.Status -eq 403); Detail = "media-transfer/health/ready -> $($internal.Status) (403)" }
    foreach ($check in $checks) {
        if ($check.Ok) { Write-SetupLog (T ('log.verify.' + $check.Name)) 'ok' }
        else {
            $message = (T ('log.verify.' + $check.Name + '.failed') $check.Detail)
            Write-SetupLog $message 'warn'
            [void] $State.Results.Warnings.Add($message)
        }
    }
}

# -- uninstall ---------------------------------------------------------------------------------

function Step-RemoveTasks {
    param([hashtable] $State)
    Step-StopService $State
    $paths = Get-SetupPaths $State
    $powershell = Get-SetupPowerShell
    foreach ($pair in @(@('unregister-stage-task-windows.ps1', $State.Names.ServiceTask), @('unregister-maintenance-task-windows.ps1', $State.Names.MaintenanceTask))) {
        Invoke-SetupCommand -File $powershell -WorkingDirectory $paths.Root -OemOutput -TimeoutSeconds 120 -Arguments @(
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $paths.Scripts $pair[0]), '-TaskName', [string] $pair[1]
        ) | Out-Null
    }
}

function Step-RemoveApache {
    param([hashtable] $State)
    $apache = $State.Env.Wamp.Apache
    $aliasFile = Get-SetupAliasTarget $State
    $dry = [bool] $script:SetupContext.DryRun
    if (Test-Path -LiteralPath $aliasFile) {
        if ($dry) { Write-SetupLog (T 'log.apache.removeAlias' $aliasFile) 'dry' }
        else {
            $backup = Backup-SetupFile $State $aliasFile
            Write-SetupLog (T 'log.apache.removeAlias' $aliasFile) 'cmd'
            Remove-Item -LiteralPath $aliasFile -Force
            [void] $State.ApacheChanges.Add(@{ Path = $aliasFile; Backup = $backup; Existed = $true })
            $State.ApacheChanged = $true
        }
    }
    $request = @{ path = $apache.VhostsConf }
    $newFile = Join-Path (Get-SetupBackupDir $State) 'new\httpd-vhosts.conf'
    if (-not $dry) { $request.output = $newFile }
    $answer = Invoke-SetupHelper -Python (Get-SetupHelperPython $State) -Command 'apache-vhosts-restore' -Request $request
    if (-not $answer.changed) { Write-SetupLog (T 'log.apache.docrootNotOurs' $apache.VhostsConf) 'warn' }
    elseif ($dry) { Write-SetupLog (T 'log.apache.docrootRestore' $apache.VhostsConf) 'dry' }
    else {
        Update-SetupServerFile $State $apache.VhostsConf $newFile
        Write-SetupLog (T 'log.apache.docrootRestore' $apache.VhostsConf) 'ok'
        $State.ApacheChanged = $true
    }
}

function Step-RemoveFirewall {
    param([hashtable] $State)
    $group = $script:SetupNames.FirewallGroup
    Invoke-SetupChange -What "Remove-NetFirewallRule -Group '$group'" -Do {
        Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    } | Out-Null
    $saved = $State.SavedState
    if ($saved -and $saved.firewall) {
        foreach ($name in @($saved.firewall.disabled_rules)) {
            if (-not $name) { continue }
            Invoke-SetupChange -What "Enable-NetFirewallRule -Name '$name'" -Do { Enable-NetFirewallRule -Name $name -ErrorAction SilentlyContinue } | Out-Null
        }
    }
    if ($saved) {
        foreach ($name in @($saved.services_autostart)) {
            if (-not $name) { continue }
            Invoke-SetupChange -What "Set-Service -Name $name -StartupType Manual" -Do { Set-Service -Name $name -StartupType Manual -ErrorAction SilentlyContinue } | Out-Null
        }
    }
}

function Step-DropDatabase {
    param([hashtable] $State)
    $database = $State.Database
    $name = [string] $database.Name; $user = [string] $database.User
    if ($name -notmatch '^[A-Za-z0-9_]{1,64}$' -or $user -notmatch '^[A-Za-z0-9_]{1,32}$') { throw (T 'db.error.name') }
    if ($State.Uninstall.ConfirmText -cne $name) { throw (T 'uninstall.error.confirm') }
    $sql = "DROP DATABASE IF EXISTS ``$name``;`nDROP USER IF EXISTS '$user'@'localhost';`nDROP USER IF EXISTS '$user'@'127.0.0.1';`n"
    Invoke-SetupMySql -Database $database -Sql $sql -Change -Note "DROP DATABASE $name; DROP USER $user@localhost, $user@127.0.0.1" | Out-Null
}

function Step-RemoveData {
    <# Only inside the installation folder, and only what the server made for itself. Media folders are never opened. #>
    param([hashtable] $State)
    $root = [System.IO.Path]::GetFullPath($State.TargetRoot).TrimEnd('\')
    # What the server made for itself, by name. Anything else somebody put into
    # runtime\ (a bundled FFmpeg, for one) is not ours to delete.
    $targets = @('.venv', 'logs', 'runtime\thumbnails', 'runtime\subtitles', 'runtime\filmweb-cache', 'runtime\stats', 'runtime\vps-bundle',
        'runtime\transfer-stage.json', 'runtime\transfer-stage.pid')
    if ($State.Uninstall.RemoveConfig) {
        $targets += @('config\config.local.toml', 'config\origin', 'config\tls', 'config\installer.pending.json', $script:SetupNames.StateFile)
        # The copies the helper keeps before each change hold the same database password and
        # transfer key: "remove the configuration" means them too (audit P3-11).
        foreach ($copy in @(Get-ChildItem -LiteralPath (Join-Path $root 'config') -Filter 'config.backup-*.local.toml' -File -ErrorAction SilentlyContinue)) {
            $targets += ('config\' + $copy.Name)
        }
        # Earlier runs' copies of server files go; this run's own stay as the record of what it just changed.
        $current = if ($State.BackupDir) { [System.IO.Path]::GetFullPath($State.BackupDir).TrimEnd('\') } else { '' }
        foreach ($run in @(Get-ChildItem -LiteralPath (Join-Path $root 'backups\installer') -Directory -ErrorAction SilentlyContinue)) {
            if ($run.FullName.TrimEnd('\') -ine $current) { $targets += ('backups\installer\' + $run.Name) }
        }
    }
    foreach ($relative in $targets) {
        $path = Join-Path $root $relative
        if (-not (Test-Path -LiteralPath $path)) { continue }
        Invoke-SetupChange -What "Remove-Item -Recurse -Force '$path'" -Do { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop } | Out-Null
    }
    if (-not $State.Uninstall.RemoveConfig) {
        $stateFile = Join-Path $root $script:SetupNames.StateFile
        if (Test-Path -LiteralPath $stateFile) {
            Invoke-SetupChange -What "Remove-Item '$stateFile'" -Do { Remove-Item -LiteralPath $stateFile -Force -ErrorAction Stop } | Out-Null
        }
    }
}

# -- the plan ----------------------------------------------------------------------------------

function New-SetupStep {
    param([string] $Id, [string] $Run, [string[]] $Details = @())
    return @{ Id = $Id; Title = (T ('step.' + $Id)); Run = $Run; Details = @($Details) }
}

function Get-SetupApacheSteps {
    <# The four Apache steps, with what each will touch. Shared by install, access change, repair and uninstall. #>
    param([hashtable] $State)
    $wamp = $State.Env.Wamp
    $apache = $wamp.Apache
    $access = $State.Access
    $steps = @()
    $missing = @(Get-SetupRequiredModules $access.Mode | Where-Object { $apache.Modules -notcontains $_ })
    if ($missing.Count -gt 0) {
        $steps += New-SetupStep 'apache-modules' 'Step-ApacheModules' @((T 'plan.apache.modules' $apache.Conf ($missing -join ', ')))
    }
    $details = @(
        (T 'plan.apache.alias' (Get-SetupAliasTarget $State)),
        (T 'plan.apache.vhosts' $apache.VhostsConf)
    )
    foreach ($alias in @($State.Env.Existing.Aliases)) {
        if ($alias -and ($alias.File -ine (Get-SetupAliasTarget $State))) { $details += (T 'plan.apache.otherAlias' $alias.File) }
    }
    if ($access.DisableExistingHttps) { $details += (T 'plan.apache.httpsOff' $apache.VhostsConf) }
    if (@('vps', 'direct') -contains [string] $access.Mode) { $details += (T 'plan.apache.quiet' $apache.Conf $wamp.Php.Ini) }
    $steps += New-SetupStep 'apache-config' 'Step-ApacheConfig' $details
    $steps += New-SetupStep 'apache-test' 'Step-ApacheTest' @((T 'plan.apache.test'))
    $steps += New-SetupStep 'apache-restart' 'Step-ApacheRestart' @((T 'plan.apache.restart' $apache.Service.Name))
    return $steps
}

function Get-SetupFirewallDetails {
    param([hashtable] $State)
    $details = @()
    foreach ($rule in @(Get-SetupFirewallRules $State.Access)) {
        if ($rule.Profile -eq 'Private') { $details += (T 'plan.firewall.rulePrivate' $rule.Port (@($rule.Remote) -join ', ')) }
        else { $details += (T 'plan.firewall.rule' $rule.Port (@($rule.Remote) -join ', ')) }
    }
    if ($details.Count -eq 0) { $details += (T 'plan.firewall.none') }
    if (Test-SetupLanRulePublic $State) { $details += (T 'log.firewall.publicNetwork') }
    if ($State.Options.DisableGenericRules -and @('vps', 'lan') -contains $State.Access.Mode) {
        foreach ($rule in @($State.Env.Firewall.Generic | Where-Object { $_.Enabled })) { $details += (T 'plan.firewall.disable' $rule.DisplayName $rule.Profile) }
    }
    return $details
}

function Get-SetupPlan {
    <# The steps for a flow: install, folders, access, admin, update, repair or uninstall. #>
    param([hashtable] $State)
    $paths = Get-SetupPaths $State
    $access = $State.Access
    $steps = @()
    $https = ($access -and ($access.Mode -eq 'vps' -or ($access.Mode -eq 'direct')))
    $certificateDetails = @()
    if ($access -and $access.Mode -eq 'vps') {
        $haveOrigin = (Test-Path -LiteralPath $paths.OriginCert) -and (Test-Path -LiteralPath $paths.OriginKey)
        $adoptable = if (-not $haveOrigin -and -not $access.Regenerate) { Find-SetupAdoptableOrigin $State } else { $null }
        if ($adoptable) { $certificateDetails = @((T 'plan.cert.adopt' $adoptable.Certificate $paths.OriginCert)) }
        elseif ($haveOrigin -and -not $access.Regenerate) { $certificateDetails = @((T 'log.cert.kept' $paths.OriginCert)) }
        else {
            $certificateDetails = @((T 'plan.cert.origin' $paths.OriginCert))
            # A VPS already in front pins the certificate it has: a new one leaves it on its
            # maintenance page until the new origin.crt is installed there.
            if ($State.Summary -and $State.Summary.proxy_trusted) { $certificateDetails += (T 'plan.cert.vpsUpdate') }
        }
    }
    elseif ($access -and $access.Mode -eq 'direct' -and $access.SelfSigned) { $certificateDetails = @((T 'plan.cert.self' $paths.SelfCert)) }
    elseif ($access -and $access.Mode -eq 'direct') { $certificateDetails = @((T 'plan.cert.own' $access.CertificateFile)) }
    # A clone of the repository: the interface is built first - before the service stops, in an update.
    $buildStep = $null
    $frontend = $State.Env.Frontend
    if ($frontend -and $frontend.NeedsBuild) {
        $frontendPacks = @($frontend.Packs)
        $buildStep = New-SetupStep 'frontend' 'Step-BuildFrontend' @(
            (T 'plan.frontend.build' (Join-Path $State.SourceRoot 'frontend') $frontend.Node.Version),
            $(if ($frontendPacks.Count -gt 0) { T 'plan.frontend.packs' ($frontendPacks -join ', ') } else { T 'plan.frontend.public' }))
    }
    $accessValues = if ($access) { Get-SetupAccessValues $access } else { $null }
    $configAccessDetail = if ($accessValues) {
        T 'plan.config.access' ($(if ($accessValues.BaseUrl) { $accessValues.BaseUrl } else { '/' })) ($(if ($accessValues.Trusted) { $accessValues.Trusted } else { '-' })) ($(if ($accessValues.RequireHttps) { 'true' } else { 'false' }))
    } else { '' }

    switch ($State.Flow) {
        'install' {
            if ($buildStep) { $steps += $buildStep }
            if (-not $State.InPlace) {
                $steps += New-SetupStep 'copy' 'Step-CopyFiles' @((T 'plan.copy' $State.SourceRoot $State.TargetRoot))
                if ($State.Options.HardenFolder) { $steps += New-SetupStep 'harden' 'Step-HardenFolder' @((T 'plan.harden' $State.TargetRoot)) }
            }
            $steps += New-SetupStep 'python' 'Step-PythonEnvironment' @((T 'plan.python.venv' (Join-Path $paths.Root '.venv')), (T 'plan.python.config' $paths.Config))
            $steps += New-SetupStep 'config-access' 'Step-ConfigAccess' @($configAccessDetail)
            $steps += New-SetupStep 'db-create' 'Step-DatabaseCreate' @((T 'plan.db.create' $State.Database.Name $State.Database.User $State.Database.Label))
            $steps += New-SetupStep 'db-migrate' 'Step-DatabaseMigrate' @((T 'plan.db.migrate' $State.Database.AdminUser))
            $steps += New-SetupStep 'roots' 'Step-RegisterRoots' @(@($State.Roots) | ForEach-Object { T 'plan.roots.entry' $_.Path (T ('media.kind.' + $_.Kind)) $_.Id })
            $steps += New-SetupStep 'admin' 'Step-CreateAdmin' @((T 'plan.admin' $State.Admin.Username))
            if ($https) { $steps += New-SetupStep 'certificate' 'Step-Certificate' $certificateDetails }
            $steps += Get-SetupApacheSteps $State
            $steps += New-SetupStep 'firewall' 'Step-Firewall' (Get-SetupFirewallDetails $State)
            $steps += New-SetupStep 'tasks' 'Step-Tasks' @((T 'plan.tasks.service' $State.Names.ServiceTask), (T 'plan.tasks.maintenance' $State.Names.MaintenanceTask))
            if ($State.Options.AutoStartServices) { $steps += New-SetupStep 'services' 'Step-Services' @((T 'plan.services' $State.Env.Wamp.Apache.Service.Name $State.Database.Service)) }
            $steps += New-SetupStep 'start' 'Step-StartService' @((T 'plan.start' $State.ServicePort))
            if ($access.Mode -eq 'vps') { $steps += New-SetupStep 'bundle' 'Step-VpsBundle' @((T 'plan.bundle' $paths.BundleDir)) }
            if ($State.Options.StartScan) { $steps += New-SetupStep 'scan' 'Step-FirstScan' @((T 'plan.scan')) }
            $steps += New-SetupStep 'state' 'Step-SaveState' @((T 'plan.state' $paths.StateFile))
            $steps += New-SetupStep 'verify' 'Step-Verify' @((T 'plan.verify'))
        }
        'folders' {
            $steps += New-SetupStep 'config-roots' 'Step-ConfigRoots' @(@($State.Roots) | ForEach-Object { T 'plan.roots.entry' $_.Path (T ('media.kind.' + $_.Kind)) $_.Id })
            $steps += New-SetupStep 'roots' 'Step-RegisterRoots' @((T 'plan.roots.sync'))
            $steps += New-SetupStep 'stop' 'Step-StopService' @((T 'plan.restartService'))
            $steps += New-SetupStep 'start' 'Step-StartService' @((T 'plan.start' $State.ServicePort))
            if ($State.Options.StartScan) { $steps += New-SetupStep 'scan' 'Step-FirstScan' @((T 'plan.scan')) }
            $steps += New-SetupStep 'verify' 'Step-Verify' @((T 'plan.verify'))
        }
        'access' {
            $steps += New-SetupStep 'config-access' 'Step-ConfigAccess' @($configAccessDetail)
            if ($https) { $steps += New-SetupStep 'certificate' 'Step-Certificate' $certificateDetails }
            $steps += Get-SetupApacheSteps $State
            $steps += New-SetupStep 'firewall' 'Step-Firewall' (Get-SetupFirewallDetails $State)
            if ($access.Mode -eq 'vps') { $steps += New-SetupStep 'bundle' 'Step-VpsBundle' @((T 'plan.bundle' $paths.BundleDir)) }
            $steps += New-SetupStep 'state' 'Step-SaveState' @((T 'plan.state' $paths.StateFile))
            $steps += New-SetupStep 'verify' 'Step-Verify' @((T 'plan.verify'))
        }
        'admin' {
            $steps += New-SetupStep 'admin' 'Step-CreateAdmin' @((T 'plan.admin' $State.Admin.Username))
        }
        'update' {
            # A new version may bring a new Apache template, new task scripts and new migrations:
            # all of it is laid out again, and the database is copied before anything touches it (audit P3-12).
            $wizardMade = [bool] ($State.SavedState -and $State.SavedState.access)
            if ($buildStep) { $steps += $buildStep }
            $steps += New-SetupStep 'stop' 'Step-StopService' @((T 'plan.stop'))
            if ($State.Options.BackupDatabase) {
                $steps += New-SetupStep 'db-backup' 'Step-DatabaseBackup' @((T 'plan.db.backup' $State.Database.Name (Join-Path $paths.Root 'backups\database')))
            }
            if (-not $State.InPlace) { $steps += New-SetupStep 'copy' 'Step-CopyFiles' @((T 'plan.copy.update' $State.SourceRoot $State.TargetRoot), (T 'plan.copy.stale')) }
            $steps += New-SetupStep 'python' 'Step-PythonEnvironment' @((T 'plan.python.update'))
            $steps += New-SetupStep 'db-migrate' 'Step-DatabaseMigrate' @((T 'plan.db.migrate' $State.Database.AdminUser))
            if ($wizardMade) {
                # Only an installation the wizard set up: one made by hand keeps its Apache files.
                if ($https) { $steps += New-SetupStep 'certificate' 'Step-Certificate' $certificateDetails }
                $steps += Get-SetupApacheSteps $State
            }
            $steps += New-SetupStep 'tasks' 'Step-Tasks' @((T 'plan.tasks.service' $State.Names.ServiceTask), (T 'plan.tasks.maintenance' $State.Names.MaintenanceTask))
            $steps += New-SetupStep 'start' 'Step-StartService' @((T 'plan.start' $State.ServicePort))
            if ($wizardMade) { $steps += New-SetupStep 'state' 'Step-SaveState' @((T 'plan.state' $paths.StateFile)) }
            $steps += New-SetupStep 'verify' 'Step-Verify' @((T 'plan.verify'))
        }
        'repair' {
            $wizardMade = [bool] ($State.SavedState -and $State.SavedState.access)
            # What the installation set up and a move, a restore or an accident can take away (audit P2-9).
            if ($wizardMade -and $State.SavedState.hardened) { $steps += New-SetupStep 'harden' 'Step-HardenFolder' @((T 'plan.harden' $State.TargetRoot)) }
            $steps += New-SetupStep 'secrets' 'Step-ProtectSecrets' @((T 'plan.secrets' (Join-Path $paths.Root 'config')))
            $steps += New-SetupStep 'python' 'Step-PythonEnvironment' @((T 'plan.python.update'))
            if ($wizardMade) {
                if ($https) { $steps += New-SetupStep 'certificate' 'Step-Certificate' $certificateDetails }
                $steps += Get-SetupApacheSteps $State
                $steps += New-SetupStep 'firewall' 'Step-Firewall' (Get-SetupFirewallDetails $State)
            }
            $steps += New-SetupStep 'tasks' 'Step-Tasks' @((T 'plan.tasks.service' $State.Names.ServiceTask), (T 'plan.tasks.maintenance' $State.Names.MaintenanceTask))
            if ($wizardMade -and @($State.SavedState.services_autostart | Where-Object { $_ }).Count -gt 0) {
                $steps += New-SetupStep 'services' 'Step-Services' @((T 'plan.services' $State.Env.Wamp.Apache.Service.Name $State.Database.Service))
            }
            $steps += New-SetupStep 'start' 'Step-StartService' @((T 'plan.start' $State.ServicePort))
            # Only an installation the wizard made keeps a record; one set up by hand is not claimed.
            if ($State.SavedState -and $State.SavedState.access) { $steps += New-SetupStep 'state' 'Step-SaveState' @((T 'plan.state' $paths.StateFile)) }
            $steps += New-SetupStep 'verify' 'Step-Verify' @((T 'plan.verify'))
        }
        'uninstall' {
            $steps += New-SetupStep 'remove-tasks' 'Step-RemoveTasks' @((T 'plan.remove.tasks' $State.Names.ServiceTask $State.Names.MaintenanceTask))
            $steps += New-SetupStep 'remove-apache' 'Step-RemoveApache' @((T 'plan.remove.alias' (Get-SetupAliasTarget $State)), (T 'plan.remove.vhosts' $State.Env.Wamp.Apache.VhostsConf))
            $steps += New-SetupStep 'apache-test' 'Step-ApacheTest' @((T 'plan.apache.test'))
            $steps += New-SetupStep 'apache-restart' 'Step-ApacheRestart' @((T 'plan.apache.restart' $State.Env.Wamp.Apache.Service.Name))
            $steps += New-SetupStep 'remove-firewall' 'Step-RemoveFirewall' @((T 'plan.remove.firewall'))
            if ($State.Uninstall.DropDatabase) { $steps += New-SetupStep 'drop-database' 'Step-DropDatabase' @((T 'plan.remove.database' $State.Database.Name $State.Database.User)) }
            if ($State.Uninstall.RemoveData) {
                $what = if ($State.Uninstall.RemoveConfig) { T 'plan.remove.dataAndConfig' $State.TargetRoot } else { T 'plan.remove.data' $State.TargetRoot }
                $steps += New-SetupStep 'remove-data' 'Step-RemoveData' @($what)
            }
        }
    }
    return @($steps)
}

function Invoke-SetupPlan {
    <#
        Runs the steps in order and stops at the first that fails. Reports through
        the event sink: { Type = 'step'; Id; Status } and the log. Returns
        @{ Ok; FailedStep; Error }.
    #>
    param([hashtable] $State, [array] $Plan)
    if (-not $State.Results) { $State.Results = @{} }
    if (-not $State.Results.Warnings) { $State.Results.Warnings = New-Object System.Collections.ArrayList }
    if (-not $State.ApacheChanges) { $State.ApacheChanges = New-Object System.Collections.ArrayList }
    $index = 0
    foreach ($step in $Plan) {
        $index++
        if (Test-SetupCancelled) {
            Write-SetupLog (T 'error.cancelled') 'warn'
            return @{ Ok = $false; FailedStep = $step.Id; Error = (T 'error.cancelled'); Cancelled = $true }
        }
        Send-SetupEvent @{ Type = 'step'; Id = $step.Id; Status = 'running'; Index = $index; Count = $Plan.Count }
        Write-SetupLog ("--- [{0}/{1}] {2}" -f $index, $Plan.Count, $step.Title)
        try {
            & $step.Run $State
            Send-SetupEvent @{ Type = 'step'; Id = $step.Id; Status = 'done'; Index = $index; Count = $Plan.Count }
        } catch {
            $message = Protect-SetupText ([string] $_.Exception.Message)
            Write-SetupLog $message 'error'
            Send-SetupEvent @{ Type = 'step'; Id = $step.Id; Status = 'failed'; Index = $index; Count = $Plan.Count }
            return @{ Ok = $false; FailedStep = $step.Id; Error = $message }
        }
    }
    return @{ Ok = $true; FailedStep = $null; Error = $null }
}
