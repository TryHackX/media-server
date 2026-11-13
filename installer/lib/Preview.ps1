<#
    -Preview: every page of every mode, drawn with sample data and saved as PNG.

    Nothing on the machine is read except the files of the wizard itself, and
    nothing is written except the pictures. The sample values are the documentation
    ones (example.org, 203.0.113.10, 198.51.100.7), so a screenshot can be shown to
    anybody.

    Keep this file pure ASCII; translated text lives in installer\lang\*.psd1.
#>

function Get-SetupSampleEnvironment {
    <# Variant: ok | missing | nowamp #>
    param([string] $Variant = 'ok')
    $apacheDir = 'C:\wamp64\bin\apache\apache2.4.62'
    $modules = @('alias_module', 'authz_core_module', 'authz_host_module', 'dir_module', 'env_module', 'headers_module', 'mime_module',
        'proxy_module', 'proxy_http_module', 'php_module', 'rewrite_module')
    if ($Variant -eq 'missing') { $modules = @($modules | Where-Object { $_ -ne 'proxy_http_module' -and $_ -ne 'headers_module' }) }
    $extensions = @('Core', 'ctype', 'curl', 'iconv', 'json', 'mbstring', 'openssl', 'PDO', 'pdo_mysql', 'session', 'SimpleXML')
    if ($Variant -eq 'missing') { $extensions = @($extensions | Where-Object { $_ -ne 'curl' }) }
    $running = @{ Name = 'wampapache64'; Exists = $true; Running = $true; StartMode = 'Manual' }
    $wamp = @{
        Found = ($Variant -ne 'nowamp'); InstallDir = 'C:\wamp64'; Version = '3.3.7'; AliasDir = 'C:\wamp64\alias'; WwwDir = 'C:\wamp64\www'
        Apache = @{ Found = $true; Httpd = "$apacheDir\bin\httpd.exe"; Dir = $apacheDir; Conf = "$apacheDir\conf\httpd.conf"
            VhostsConf = "$apacheDir\conf\extra\httpd-vhosts.conf"; OpenSsl = "$apacheDir\bin\openssl.exe"; OpenSslConf = "$apacheDir\conf\openssl.cnf"
            Version = '2.4.62'; Modules = $modules; Available = @($modules + @('ssl_module', 'socache_shmcb_module', 'proxy_http_module', 'headers_module'))
            ConfigOk = $true; ConfigError = ''; Service = $running; HttpsHosts = @() }
        Php = @{ Found = $true; Exe = 'C:\wamp64\bin\php\php8.3.14\php.exe'; Dir = 'C:\wamp64\bin\php\php8.3.14'; Version = '8.3.14'; Extensions = $extensions }
        Databases = @(
            @{ Engine = 'mysql'; Label = 'MySQL 8.4.3'; Version = '8.4.3'; Client = 'C:\wamp64\bin\mysql\mysql8.4.3\bin\mysql.exe'; Port = 3306
                Service = @{ Name = 'wampmysqld64'; Exists = $true; Running = $true; StartMode = 'Manual' }; Enabled = $true; Supported = $true },
            @{ Engine = 'mariadb'; Label = 'MariaDB 11.5.2'; Version = '11.5.2'; Client = 'C:\wamp64\bin\mariadb\mariadb11.5.2\bin\mysql.exe'; Port = 3307
                Service = @{ Name = 'wampmariadb64'; Exists = $true; Running = $false; StartMode = 'Manual' }; Enabled = $true; Supported = $true }
        )
    }
    $free = @{ InUse = $false; Process = ''; Path = ''; ProcessId = 0 }
    $environment = @{
        Os = @{ Caption = 'Microsoft Windows 11 Home'; Build = 26100; Is64 = $true; Ok = $true }
        Admin = $true
        Winget = $true
        Wamp = $wamp
        Database = $wamp.Databases[0]
        Existing = @{ Found = $false; Aliases = @(); ServiceTask = @{ Exists = $false }; MaintenanceTask = @{ Exists = $false } }
        Python = @{ Found = $true; Ok = $true; Exe = 'C:\Program Files\Python313\python.exe'; Version = '3.13.1'; Is64 = $true }
        Ffmpeg = @{ Found = $true; Path = 'C:\ffmpeg\bin\ffmpeg.exe'; Version = '7.1'; HasProbe = $true }
        Frontend = @{ Built = $true; Sources = $false; NeedsBuild = $false; Packs = @(); Node = @{ Found = $false; Ok = $false; Exe = $null; Npm = $null; Version = '' } }
        Ports = @{
            Http = @{ Port = 80; InUse = $true; Process = 'httpd.exe'; Path = "$apacheDir\bin\httpd.exe"; ProcessId = 4321 }
            Https = (@{ Port = 443 } + $free)
            Service = (@{ Port = 8765 } + $free)
            ServiceSuggested = 8765
        }
        Disk = @{ Drive = 'C:\'; FreeBytes = [long] (182GB); Ready = $true; Type = 'Fixed' }
        Lan = @{ Found = $true; Address = '192.168.1.20'; Prefix = 24; Gateway = '192.168.1.1' }
        Firewall = @{ Available = $true; Ours = @(); Generic = @(@{ Name = '{4C1B7A8E-0000-4000-8000-000000000001}'; DisplayName = 'Apache HTTP Server'; Enabled = $true; Profile = 'Private, Public' }) }
    }
    if ($Variant -eq 'missing') {
        $environment.Python = @{ Found = $false; Ok = $false; Exe = $null; Version = '' }
        $environment.Ffmpeg = @{ Found = $false; Path = $null; Version = ''; HasProbe = $false }
        # A clone of the repository with the private packs, on a machine without Node.js.
        $environment.Frontend = @{ Built = $false; Sources = $true; NeedsBuild = $true; Packs = @('avs-presets', 'fontawesome-pro', 'milkdrop-presets')
            Node = @{ Found = $false; Ok = $false; Exe = $null; Npm = $null; Version = '' } }
        $environment.Ports.Service = @{ Port = 8765; InUse = $true; Process = 'node.exe'; Path = 'C:\Program Files\nodejs\node.exe'; ProcessId = 9876 }
        $environment.Ports.ServiceSuggested = 8766
        $environment.Disk.FreeBytes = [long] (3.4GB)
        $environment.Admin = $false
    }
    if ($Variant -eq 'nowamp') {
        $environment.Database = $null
        $environment.Wamp.Databases = @()
        $environment.Ports.Http = (@{ Port = 80 } + $free)
        $environment.Ffmpeg = @{ Found = $false; Path = $null; Version = ''; HasProbe = $false }
    }
    return $environment
}

function New-SetupSampleState {
    param([string] $SourceRoot, [string] $Variant = 'ok')
    $state = New-SetupState -SourceRoot $SourceRoot -Environment (Get-SetupSampleEnvironment $Variant)
    $state.Preview = $true
    $state.SourceRoot = 'C:\Users\Jan\Downloads\TryHackX-Media-Server-' + $state.Version + '-windows'
    $state.TargetRoot = 'C:\TryHackX\MediaServer'
    $state.Database.Tested = $true
    $state.Database.Test = @{ Ok = $true; Message = ''; Version = '8.4.3'; CanCreate = $true; DatabaseExists = $false; Tables = 0; UserExists = $false }
    $state.Database.AppPassword = 'sample-not-a-real-password-000000000000000'
    $state.Roots = @(
        @{ Id = 'muzyka'; Path = 'E:\Muzyka'; Kind = 'music' },
        @{ Id = 'filmy'; Path = 'E:\Filmy'; Kind = 'movies' },
        @{ Id = ''; Path = 'D:\Nagrania z wakacji'; Kind = 'mixed' }
    )
    $state.Admin = @{ Username = 'jan'; Email = 'jan@example.org'; Password = 'przykladowe-haslo' }
    return $state
}

function Set-SetupSampleAccess {
    param([hashtable] $State, [string] $Mode)
    $paths = Get-SetupPaths $State
    $access = $State.Access
    $access.Mode = $Mode
    $access.HostName = if ($Mode -eq 'vps' -or $Mode -eq 'direct') { 'media.example.org' } else { '' }
    $access.VpsAddresses = if ($Mode -eq 'vps') { @('203.0.113.10') } else { @() }
    $access.HomeAddress = if ($Mode -eq 'vps') { '198.51.100.7' } else { '' }
    $access.AllowLan = $false
    $access.SelfSigned = $false
    if ($Mode -eq 'vps') { $access.CertificateFile = $paths.OriginCert; $access.KeyFile = $paths.OriginKey }
    elseif ($Mode -eq 'direct') { $access.CertificateFile = 'C:\TryHackX\certs\media.example.org-chain.pem'; $access.KeyFile = 'C:\TryHackX\certs\media.example.org-key.pem' }
    else { $access.CertificateFile = ''; $access.KeyFile = '' }
}

function Set-SetupSampleMaintain {
    <# Turns a sample state into "an installation is already here". Variant: ok | problem #>
    param([hashtable] $State, [string] $Variant = 'ok')
    $root = 'C:\TryHackX\MediaServer'
    $problem = ($Variant -eq 'problem')
    $State.Mode = 'maintain'
    $State.Flow = 'status'
    $State.TargetRoot = $root
    $State.InPlace = $false
    Set-SetupSampleAccess $State 'vps'
    $State.Access.Inferred = $false
    $State.Access.ShowRegenerate = $true
    $State.Roots = @(
        @{ Id = 'muzyka'; Path = 'E:\Muzyka'; Kind = 'music'; Known = $true },
        @{ Id = 'filmy'; Path = 'E:\Filmy'; Kind = 'movies'; Known = $true; Gone = $problem }
    )
    $State.ExistingRoots = @(@{ id = 'muzyka'; path = 'E:\Muzyka' }, @{ id = 'filmy'; path = 'E:\Filmy' })
    $State.SavedState = @{ version = 1; access = @{ mode = 'vps' }; firewall = @{ disabled_rules = @() }; database = @{ created_by_wizard = $true } }
    $State.Env.Existing = @{
        Found = $true; Root = $root; SameTree = $false; Config = "$root\config\config.local.toml"; VenvPython = "$root\.venv\Scripts\python.exe"; HasVenv = $true; VenvWorks = $true
        OpenSecrets = $(if ($problem) { @("$root\config\config.local.toml") } else { @() })
        Version = $(if ($problem) { '0.1.0' } else { $State.Version }); State = $State.SavedState; Port = 8765
        Health = @{ Running = (-not $problem); Ready = (-not $problem) }
        Alias = @{ File = 'C:\wamp64\alias\tryhackx-media-server.conf'; Root = $root; Managed = $true }
        Aliases = @(@{ File = 'C:\wamp64\alias\tryhackx-media-server.conf'; Root = $root; Managed = $true })
        ServiceTask = @{ Name = $script:SetupNames.ServiceTask; Exists = $true; State = $(if ($problem) { 'Ready' } else { 'Running' }); Root = $root; UsesScript = $true }
        MaintenanceTask = @{ Name = $script:SetupNames.MaintenanceTask; Exists = $true; State = 'Ready'; Root = $root; UsesScript = $true }
    }
    $State.Env.Firewall.Ours = @(@{ Name = 'TryHackX-Media-HTTPS-VPS'; DisplayName = 'TryHackX Media Server - HTTPS from the VPS only'; Enabled = $true })
    $State.Env.Wamp.Apache.Modules = @($State.Env.Wamp.Apache.Modules + @('ssl_module', 'socache_shmcb_module'))
}

function Set-SetupSampleProgress {
    <# A run caught half way (or just failed) at the named step, with the log lines it would have written. #>
    param([hashtable] $State, [string] $StepId, [bool] $Failed)
    Set-SetupSampleAccess $State 'vps'
    foreach ($root in $State.Roots) { if (-not $root.Id) { $root.Id = 'nagrania_z_wakacji' } }
    $State.Plan = @(Get-SetupPlan $State)
    $count = $State.Plan.Count
    $at = 1
    for ($i = 0; $i -lt $count; $i++) { if ($State.Plan[$i].Id -eq $StepId) { $at = $i + 1 } }
    $head = { param($index) ('--- [{0}/{1}] {2}' -f $index, $count, $State.Plan[$index - 1].Title) }
    $log = New-Object System.Collections.ArrayList
    if ($Failed) {
        [void] $log.Add('12:06:40  ' + (& $head $at))
        [void] $log.Add('12:06:40    $ C:\wamp64\bin\apache\apache2.4.62\bin\httpd.exe -t')
        [void] $log.Add('12:06:41  [X]  AH00526: Syntax error on line 512 of C:/wamp64/bin/apache/apache2.4.62/conf/httpd.conf:')
        [void] $log.Add('12:06:41  [!]  ' + (T 'log.file.restored' 'C:\wamp64\bin\apache\apache2.4.62\conf\extra\httpd-vhosts.conf'))
        [void] $log.Add('12:06:41  [!]  ' + (T 'log.file.restored' 'C:\wamp64\alias\tryhackx-media-server.conf'))
        $problem = T 'error.apache.syntax' 'AH00526: Syntax error on line 512 of C:/wamp64/bin/apache/apache2.4.62/conf/httpd.conf'
        $State.PreviewProgress = @{ At = $at; Failed = $true; Error = $problem; Log = @($log) }
        return
    }
    [void] $log.Add('12:04:11  ' + (& $head ($at - 1)))
    [void] $log.Add('12:04:11    $ mysql --host=127.0.0.1 --port=3306 --user=root   <<< CREATE DATABASE IF NOT EXISTS media_server (utf8mb4); CREATE USER media_server@localhost, media_server@127.0.0.1; GRANT SELECT, INSERT, UPDATE, DELETE ON media_server.*')
    [void] $log.Add('12:04:12  ' + (& $head $at))
    [void] $log.Add('12:04:12    $ C:\TryHackX\MediaServer\.venv\Scripts\python.exe -m media_server --config C:\TryHackX\MediaServer\config\config.local.toml migrate --as-user root --password-stdin   <<< ' + (T 'log.stdin.adminPassword'))
    $State.PreviewProgress = @{ At = $at; Failed = $false; Log = @($log) }
}

function Get-SetupPreviewShots {
    <# Name, sample variant, flow, page, and what to arrange before the page is drawn. #>
    $shot = { param($name, $flow, $page, $arrange, $variant) @{ Name = $name; Flow = $flow; Page = $page; Arrange = $arrange; Variant = $(if ($variant) { $variant } else { 'ok' }) } }
    return @(
        (& $shot '01-welcome' 'install' 'welcome' $null),
        (& $shot '02-requirements' 'install' 'requirements' $null),
        (& $shot '02-requirements-missing' 'install' 'requirements' $null 'missing'),
        (& $shot '02-requirements-no-wamp' 'install' 'requirements' $null 'nowamp'),
        (& $shot '03-location' 'install' 'location' $null),
        (& $shot '04-database' 'install' 'database' $null),
        (& $shot '04-database-error' 'install' 'database' { param($s) $s.Database.Tested = $false; $s.Database.Test = @{ Ok = $false; Message = "ERROR 1045 (28000): Access denied for user 'root'@'localhost' (using password: YES)" } }),
        (& $shot '05-media' 'install' 'media' $null),
        (& $shot '05-media-problem' 'install' 'media' { param($s)
                $s.Roots = @(
                    @{ Id = 'muzyka'; Path = 'E:\Muzyka'; Kind = 'music' },
                    @{ Id = ''; Path = 'F:\'; Kind = 'movies'; Sample = @{ Errors = @(); Warnings = @((T 'media.warn.driveRoot' 'F:\')) } },
                    @{ Id = ''; Path = 'Z:\Filmy'; Kind = 'movies'; Sample = @{ Errors = @((T 'media.error.mapped' 'Z:\')); Warnings = @() } })
            }),
        (& $shot '06-access-local' 'install' 'access' { param($s) Set-SetupSampleAccess $s 'local' }),
        (& $shot '06-access-lan' 'install' 'access' { param($s) Set-SetupSampleAccess $s 'lan' }),
        (& $shot '06-access-direct' 'install' 'access' { param($s) Set-SetupSampleAccess $s 'direct' }),
        (& $shot '06-access-vps' 'install' 'access' { param($s) Set-SetupSampleAccess $s 'vps' }),
        (& $shot '06-access-vps-https' 'install' 'access' { param($s) Set-SetupSampleAccess $s 'vps'; $s.Env.Wamp.Apache.HttpsHosts = @('home.example.org') }),
        (& $shot '06-access-lan-public' 'install' 'access' { param($s) Set-SetupSampleAccess $s 'lan'; $s.Env.Lan.Category = 'Public' }),
        (& $shot '02-requirements-port443' 'install' 'requirements' { param($s)
                $s.Env.Ports.Https = @{ Port = 443; InUse = $true; Process = 'vmware-hostd.exe'; Path = 'C:\Program Files (x86)\VMware\vmware-hostd.exe'; ProcessId = 5555 }
            }),
        (& $shot '07-admin' 'install' 'admin' $null),
        (& $shot '08-summary' 'install' 'summary' { param($s) Set-SetupSampleAccess $s 'vps'; foreach ($root in $s.Roots) { if (-not $root.Id) { $root.Id = 'nagrania_z_wakacji' } } }),
        (& $shot '09-progress-running' 'install' 'progress' { param($s) Set-SetupSampleProgress $s 'db-migrate' $false }),
        (& $shot '09-progress-failed' 'install' 'progress' { param($s) Set-SetupSampleProgress $s 'apache-test' $true }),
        (& $shot '10-finish' 'install' 'finish' { param($s)
                Set-SetupSampleAccess $s 'vps'
                $guide = if ($script:SetupContext.Language -eq 'en') { 'VPS-GUIDE.txt' } else { 'INSTRUKCJA-VPS.txt' }
                $s.Results = @{ BundleDir = 'C:\TryHackX\MediaServer\runtime\vps-bundle'; GuideFile = ('C:\TryHackX\MediaServer\runtime\vps-bundle\' + $guide)
                    ScanStarted = $true; Warnings = (New-Object System.Collections.ArrayList) }
            }),
        (& $shot '20-status' 'status' 'status' { param($s) Set-SetupSampleMaintain $s 'ok' }),
        (& $shot '20-status-problem' 'status' 'status' { param($s) Set-SetupSampleMaintain $s 'problem' }),
        (& $shot '21-folders' 'folders' 'media' { param($s) Set-SetupSampleMaintain $s 'ok' }),
        (& $shot '22-access' 'access' 'access' { param($s) Set-SetupSampleMaintain $s 'ok' }),
        (& $shot '22-access-https' 'access' 'access' { param($s) Set-SetupSampleMaintain $s 'ok'; $s.Env.Wamp.Apache.HttpsHosts = @('home.example.org') }),
        (& $shot '23-admin' 'admin' 'admin' { param($s) Set-SetupSampleMaintain $s 'ok'; $s.Admin = @{ Username = 'anna'; Email = ''; Password = 'przykladowe-haslo' } }),
        (& $shot '24-update' 'update' 'update' { param($s) Set-SetupSampleMaintain $s 'problem'; $s.Database.Tested = $false; $s.Database.Test = $null }),
        (& $shot '25-repair-summary' 'repair' 'summary' { param($s) Set-SetupSampleMaintain $s 'ok'; $s.InPlace = $true }),
        (& $shot '26-uninstall' 'uninstall' 'uninstall' { param($s) Set-SetupSampleMaintain $s 'ok'; $s.Uninstall = @{ DropDatabase = $true; RemoveData = $true; RemoveConfig = $false; ConfirmText = 'media_server' } }),
        (& $shot '27-uninstall-summary' 'uninstall' 'summary' { param($s) Set-SetupSampleMaintain $s 'ok'; $s.InPlace = $true; $s.Uninstall = @{ DropDatabase = $true; RemoveData = $true; RemoveConfig = $false; ConfirmText = 'media_server' } })
    )
}

function Invoke-SetupPreview {
    param([string] $SourceRoot, [string] $ScreenshotDir, [string[]] $Only = @())
    if (-not (Test-Path -LiteralPath $ScreenshotDir)) { New-Item -ItemType Directory -Path $ScreenshotDir -Force | Out-Null }
    $script:Ui.Preview = $true
    $form = New-SetupWindow
    $form.StartPosition = 'Manual'
    $form.Location = New-UiPoint -32000 -32000
    $form.ShowInTaskbar = $false
    $form.Show()
    $written = @()
    try {
        foreach ($shot in @(Get-SetupPreviewShots)) {
            if ($Only.Count -gt 0 -and $Only -notcontains $shot.Name) { continue }
            $state = New-SetupSampleState -SourceRoot $SourceRoot -Variant $shot.Variant
            $state.Flow = $shot.Flow
            if ($shot.Flow -ne 'install' -and $shot.Flow -ne 'status') { $state.Mode = 'maintain' }
            if ($shot.Arrange) { & $shot.Arrange $state }
            $state.Flow = $shot.Flow
            if (@('summary', 'progress') -notcontains $shot.Page -and -not $state.Plan) { $state.Plan = @() }
            $script:Ui.State = $state
            $pages = @(Get-SetupFlowPages $shot.Flow)
            $index = 0
            for ($i = 0; $i -lt $pages.Count; $i++) { if ($pages[$i].Id -eq $shot.Page -or ($shot.Page -eq 'finish' -and $pages[$i].Id -eq 'done')) { $index = $i } }
            $script:Ui.Flow = $pages
            Show-SetupPage $index
            $file = Join-Path $ScreenshotDir ($shot.Name + '.png')
            Save-SetupScreenshot $file
            $written += $file
        }
    } finally {
        $script:Ui.Closing = $true
        $form.Close()
        $form.Dispose()
    }
    return $written
}
