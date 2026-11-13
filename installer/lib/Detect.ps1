<#
    What is on this machine. Everything in this file only looks: it reads files,
    asks programs for their version and lists services, tasks and firewall rules.
    Nothing here changes anything, which is why a dry run and the requirements
    page can call it freely.

    Keep this file pure ASCII; translated text lives in installer\lang\*.psd1.
#>

$script:SetupNames = @{
    ServiceTask     = 'TryHackX Media Transfer Stage'
    MaintenanceTask = 'TryHackX Media Maintenance'
    FirewallGroup   = 'TryHackX Media Server'
    AliasFile       = 'tryhackx-media-server.conf'
    StateFile       = 'config\installer.local.json'
    WingetPython    = 'Python.Python.3.14'
    WingetFfmpeg    = 'Gyan.FFmpeg'
    WingetNode      = 'OpenJS.NodeJS.LTS'
    UrlNode         = 'https://nodejs.org/en/download'
    UrlWamp         = 'https://www.wampserver.com/en/'
    UrlVcRedist     = 'https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist'
    UrlPython       = 'https://www.python.org/downloads/windows/'
    UrlFfmpeg       = 'https://ffmpeg.org/download.html'
}

# Read from the code, not from memory: PDO with the MySQL driver (every bridge
# class), OpenSSL (TransferToken seals with AES-256-GCM), mbstring (names and
# search). The optional ones lose a feature each, not the server.
$script:SetupPhpRequired = @('pdo_mysql', 'openssl', 'mbstring')
$script:SetupPhpOptional = @('curl', 'SimpleXML', 'iconv')

function Get-SetupRequiredModules {
    <#
        Apache modules the generated configuration needs: the directives of
        deploy/apache/media-next-stage-wamp.conf.example, plus TLS for the two shapes
        that answer on port 443. Mirrors installer/setup_helper/apacheconf.py.
    #>
    param([string] $Mode)
    $modules = @('alias_module', 'authz_core_module', 'authz_host_module', 'dir_module', 'env_module', 'headers_module', 'mime_module', 'proxy_module', 'proxy_http_module')
    if ($Mode -eq 'vps' -or $Mode -eq 'direct') { $modules += @('ssl_module', 'socache_shmcb_module') }
    return $modules
}

function Read-SetupIni {
    <# A WampServer .conf file: [sections] and key = "value" lines. #>
    param([string] $Path)
    $data = @{}
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $data }
    $section = ''
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        if ($line -match '^\s*\[([^\]]+)\]\s*$') { $section = $Matches[1].Trim(); if (-not $data[$section]) { $data[$section] = @{} }; continue }
        if ($line -match '^\s*([A-Za-z0-9_]+)\s*=\s*"?([^"]*)"?\s*$' -and $section) { $data[$section][$Matches[1]] = $Matches[2].Trim() }
    }
    return $data
}

function Get-SetupVersion {
    param([string] $Root)
    $file = Join-Path $Root 'pyproject.toml'
    if (Test-Path -LiteralPath $file) {
        foreach ($line in [System.IO.File]::ReadAllLines($file)) {
            if ($line -match '^\s*version\s*=\s*"([^"]+)"') { return $Matches[1] }
        }
    }
    return '?'
}

function Compare-SetupVersion {
    <# -1, 0 or 1; compares the leading dotted numbers and ignores any suffix. #>
    param([string] $Left, [string] $Right)
    $a = @([regex]::Matches($Left, '\d+') | ForEach-Object { [int] $_.Value })
    $b = @([regex]::Matches($Right, '\d+') | ForEach-Object { [int] $_.Value })
    for ($i = 0; $i -lt [Math]::Max($a.Count, $b.Count); $i++) {
        $x = if ($i -lt $a.Count) { $a[$i] } else { 0 }
        $y = if ($i -lt $b.Count) { $b[$i] } else { 0 }
        if ($x -lt $y) { return -1 }
        if ($x -gt $y) { return 1 }
    }
    return 0
}

function Invoke-SetupProbe {
    <# Runs a program for its output only; never throws. Returns @{ Ok; ExitCode; Lines }. #>
    param([string] $File, [string[]] $Arguments = @(), [int] $TimeoutSeconds = 30, [switch] $Oem)
    try {
        $result = Invoke-SetupProcess -File $File -Arguments $Arguments -Quiet -TimeoutSeconds $TimeoutSeconds -OemOutput:$Oem
        return @{ Ok = ($result.ExitCode -eq 0); ExitCode = $result.ExitCode; Lines = @($result.Output) }
    } catch {
        return @{ Ok = $false; ExitCode = -1; Lines = @([string] $_.Exception.Message) }
    }
}

# -- WampServer ----------------------------------------------------------------------------

function Find-SetupWampRoot {
    $candidates = New-Object System.Collections.ArrayList
    foreach ($name in @('wampapache64', 'wampapache')) {
        $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='$name'" -ErrorAction SilentlyContinue
        if ($service -and $service.PathName -match '^"?(.+?)\\bin\\apache\\[^\\]+\\bin\\httpd\.exe') { [void] $candidates.Add($Matches[1]) }
    }
    foreach ($key in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
        $entries = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Wampserver*' }
        foreach ($entry in @($entries)) { if ($entry.InstallLocation) { [void] $candidates.Add($entry.InstallLocation.TrimEnd('\')) } }
    }
    foreach ($drive in @([System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' })) {
        [void] $candidates.Add((Join-Path $drive.Name 'wamp64'))
    }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath (Join-Path $candidate 'bin\apache') -PathType Container)) { return $candidate }
    }
    return $null
}

function Get-SetupServiceInfo {
    param([string] $Name)
    if (-not $Name) { return @{ Name = $Name; Exists = $false; Running = $false; StartMode = '' } }
    $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='$Name'" -ErrorAction SilentlyContinue
    if (-not $service) { return @{ Name = $Name; Exists = $false; Running = $false; StartMode = '' } }
    return @{ Name = $Name; Exists = $true; Running = ($service.State -eq 'Running'); StartMode = [string] $service.StartMode; PathName = [string] $service.PathName }
}

function Get-SetupWamp {
    $root = Find-SetupWampRoot
    $wamp = @{ Found = $false; InstallDir = $root; Version = ''; Apache = $null; Php = $null; Databases = @() }
    if (-not $root) { return $wamp }
    $wamp.Found = $true
    $ini = Read-SetupIni (Join-Path $root 'wampmanager.conf')
    $main = if ($ini['main']) { $ini['main'] } else { @{} }
    $services = if ($ini['service']) { $ini['service'] } else { @{} }
    $wamp.Version = [string] $main['wampserverVersion']
    $wamp.AliasDir = Join-Path $root 'alias'
    $wamp.WwwDir = Join-Path $root 'www'

    # ---- Apache: the one the service runs, else the one WampServer says is current.
    $apacheService = Get-SetupServiceInfo ($(if ($services['ServiceApache']) { $services['ServiceApache'] } else { 'wampapache64' }))
    $httpd = $null
    if ($apacheService.Exists -and $apacheService.PathName -match '^"?(.+?\\httpd\.exe)') { $httpd = $Matches[1] }
    if (-not $httpd -or -not (Test-Path -LiteralPath $httpd)) {
        $version = if ($ini['apache']) { $ini['apache']['apacheVersion'] } else { '' }
        $candidate = Join-Path $root "bin\apache\apache$version\bin\httpd.exe"
        if ($version -and (Test-Path -LiteralPath $candidate)) { $httpd = $candidate }
        else {
            $found = Get-ChildItem -LiteralPath (Join-Path $root 'bin\apache') -Directory -ErrorAction SilentlyContinue |
                Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'bin\httpd.exe' } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
            $httpd = $found
        }
    }
    $apache = @{ Found = [bool] $httpd; Httpd = $httpd; Service = $apacheService; Version = ''; Modules = @(); ConfigOk = $true; ConfigError = '' }
    if ($httpd) {
        $apacheDir = Split-Path -Parent (Split-Path -Parent $httpd)
        $apache.Dir = $apacheDir
        $apache.Conf = Join-Path $apacheDir 'conf\httpd.conf'
        $apache.VhostsConf = Join-Path $apacheDir 'conf\extra\httpd-vhosts.conf'
        $apache.OpenSsl = Join-Path $apacheDir 'bin\openssl.exe'
        $apache.OpenSslConf = Join-Path $apacheDir 'conf\openssl.cnf'
        $probe = Invoke-SetupProbe -File $httpd -Arguments @('-v') -Oem
        foreach ($line in $probe.Lines) { if ($line -match 'Apache/([0-9.]+)') { $apache.Version = $Matches[1] } }
        $modules = Invoke-SetupProbe -File $httpd -Arguments @('-M') -Oem
        $apache.Modules = @($modules.Lines | ForEach-Object { if ($_ -match '^\s*([a-z0-9_]+_module)\s+\(') { $Matches[1] } })
        if (-not $modules.Ok) {
            # Apache cannot read its own configuration as it stands. Changing it further
            # would bury the original mistake under ours.
            $apache.ConfigOk = $false
            $apache.ConfigError = (@($modules.Lines | Where-Object { $_ -and $_ -notmatch '^AH00112' } | Select-Object -Last 3) -join ' ')
        }
        # The ports Apache listens on ("Listen 0.0.0.0:80", "Listen [::0]:80", "Listen 443"):
        # the wizard serves http://localhost/ from WampServer's port-80 host, and one moved to
        # another port used to fail at step 10, after the database and the account existed.
        $apache.ListenPorts = @()
        if (Test-Path -LiteralPath $apache.Conf) {
            $apache.ListenPorts = @([System.IO.File]::ReadAllLines($apache.Conf) | ForEach-Object {
                    if ($_ -match '^\s*Listen\s+(?:\S*:)?(\d+)\s*$') { [int] $Matches[1] }
                } | Select-Object -Unique)
        }
        # HTTPS hosts somebody already wrote into WampServer's own file: the access page
        # has to ask about them before the wizard adds its own.
        # Each host's certificate files too: a self-signed one made by hand for a VPS is
        # taken over instead of replaced (Step-Certificate), or the VPS loses the pin.
        $apache.HttpsHosts = @()
        $apache.HttpsCertificates = @()
        if (Test-Path -LiteralPath $apache.VhostsConf) {
            $inside = $false
            $current = $null
            foreach ($line in [System.IO.File]::ReadAllLines($apache.VhostsConf)) {
                if ($line -match '^\s*#') { continue }
                if ($line -match '^\s*<VirtualHost\s+[^>]*:443\s*>') {
                    $inside = $true; $apache.HttpsHosts += '(443)'
                    $current = @{ Host = '(443)'; Certificate = ''; Key = '' }; $apache.HttpsCertificates += $current
                    continue
                }
                if ($line -match '^\s*</VirtualHost>') { $inside = $false; $current = $null; continue }
                if (-not $inside) { continue }
                if ($line -match '^\s*ServerName\s+(\S+)') { $apache.HttpsHosts[$apache.HttpsHosts.Count - 1] = $Matches[1]; $current.Host = $Matches[1] }
                elseif ($line -match '^\s*SSLCertificateFile\s+"?([^"]+?)"?\s*$') { $current.Certificate = $Matches[1].Replace('/', '\') }
                elseif ($line -match '^\s*SSLCertificateKeyFile\s+"?([^"]+?)"?\s*$') { $current.Key = $Matches[1].Replace('/', '\') }
            }
        }
        # Modules that are present on disk but commented out: the wizard can switch them on.
        $apache.Available = @()
        if (Test-Path -LiteralPath $apache.Conf) {
            $apache.Available = @([System.IO.File]::ReadAllLines($apache.Conf) | ForEach-Object {
                if ($_ -match '^\s*#?\s*LoadModule\s+(\S+)\s+') { $Matches[1] }
            } | Select-Object -Unique)
        }
    }
    $wamp.Apache = $apache

    # ---- PHP: the version Apache loads, with the php.ini Apache uses.
    $php = @{ Found = $false; Exe = $null; Version = ''; Extensions = @(); Ini = $null }
    $phpDir = $null
    if ($apache.Conf -and (Test-Path -LiteralPath $apache.Conf)) {
        foreach ($line in [System.IO.File]::ReadAllLines($apache.Conf)) {
            if ($line -match '^\s*LoadModule\s+php\w*_module\s+"?([^"]+?)[\\/][^\\/"]+\.dll"?\s*$') {
                $phpDir = $Matches[1].Replace('${INSTALL_DIR}', $root).Replace('/', '\')
            }
        }
    }
    if (-not $phpDir -and $ini['php'] -and $ini['php']['phpVersion']) { $phpDir = Join-Path $root ('bin\php\php' + $ini['php']['phpVersion']) }
    if ($phpDir -and (Test-Path -LiteralPath (Join-Path $phpDir 'php.exe'))) {
        $php.Found = $true
        $php.Exe = Join-Path $phpDir 'php.exe'
        $php.Dir = $phpDir
        $apacheIni = if ($apache.Dir) { Join-Path $apache.Dir 'bin\php.ini' } else { $null }
        if ($apacheIni -and (Test-Path -LiteralPath $apacheIni)) { $php.Ini = $apacheIni }
        elseif (Test-Path -LiteralPath (Join-Path $phpDir 'phpForApache.ini')) { $php.Ini = Join-Path $phpDir 'phpForApache.ini' }
        $arguments = @()
        if ($php.Ini) { $arguments += @('-c', $php.Ini) }
        $list = Invoke-SetupProbe -File $php.Exe -Arguments ($arguments + @('-r', 'echo PHP_VERSION, "\n", implode(",", get_loaded_extensions());'))
        $clean = @($list.Lines | Where-Object { $_ -and $_ -notmatch '^(PHP )?(Warning|Notice|Deprecated)' })
        if ($clean.Count -ge 2) { $php.Version = $clean[0].Trim(); $php.Extensions = @($clean[1].Split(',') | ForEach-Object { $_.Trim() }) }
    }
    $wamp.Php = $php

    # ---- Databases: MySQL and MariaDB, each with its own service, port and client.
    $databases = New-Object System.Collections.ArrayList
    $options = if ($ini['options']) { $ini['options'] } else { @{} }
    foreach ($engine in @('mysql', 'mariadb')) {
        $section = if ($ini[$engine]) { $ini[$engine] } else { @{} }
        $version = [string] $section[$engine + 'Version']
        $dir = Join-Path $root "bin\$engine\$engine$version"
        if (-not $version -or -not (Test-Path -LiteralPath $dir)) {
            $newest = Get-ChildItem -LiteralPath (Join-Path $root "bin\$engine") -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
            if (-not $newest) { continue }
            $dir = $newest.FullName
            $version = $newest.Name -replace '^[a-z]+', ''
        }
        $client = @('bin\mysql.exe', 'bin\mariadb.exe') | ForEach-Object { Join-Path $dir $_ } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        $portKey = if ($engine -eq 'mysql') { 'mysqlPortUsed' } else { 'mariaPortUsed' }
        $portSection = if ($ini[$engine + 'options']) { $ini[$engine + 'options'] } else { @{} }
        $port = 0
        [void] [int]::TryParse([string] $portSection[$portKey], [ref] $port)
        if ($port -le 0) { $port = if ($engine -eq 'mysql') { 3306 } else { 3307 } }
        $serviceKey = if ($engine -eq 'mysql') { 'ServiceMysql' } else { 'ServiceMariadb' }
        $serviceName = if ($services[$serviceKey]) { $services[$serviceKey] } elseif ($engine -eq 'mysql') { 'wampmysqld64' } else { 'wampmariadb64' }
        $supportKey = if ($engine -eq 'mysql') { 'SupportMySQL' } else { 'SupportMariaDB' }
        # What the migrations use: DROP CONSTRAINT (MySQL 8.0.19), RENAME COLUMN (MariaDB 10.5.2).
        $minimum = if ($engine -eq 'mysql') { '8.0.19' } else { '10.5.2' }
        [void] $databases.Add(@{
            Engine = $engine
            Label = if ($engine -eq 'mysql') { "MySQL $version" } else { "MariaDB $version" }
            Version = $version
            Dir = $dir
            Client = $client
            Port = $port
            Service = Get-SetupServiceInfo $serviceName
            Enabled = ($options[$supportKey] -ne 'off')
            Supported = ((Compare-SetupVersion $version $minimum) -ge 0)
        })
    }
    $wamp.Databases = @($databases)
    return $wamp
}

function Select-SetupDatabase {
    <# The server a new installation should use: running and supported, preferring WampServer's default port. #>
    param($Databases)
    $usable = @($Databases | Where-Object { $_.Supported -and $_.Client -and $_.Service.Exists })
    $running = @($usable | Where-Object { $_.Service.Running })
    $pool = if ($running.Count -gt 0) { $running } else { $usable }
    $preferred = @($pool | Where-Object { $_.Port -eq 3306 })
    if ($preferred.Count -gt 0) { return $preferred[0] }
    if ($pool.Count -gt 0) { return $pool[0] }
    return $null
}

# -- Python and FFmpeg -----------------------------------------------------------------------

function Get-SetupPythonRank {
    <#
        2: 64-bit and within 3.11-3.14, the versions the locked packages have wheels for;
        1: 64-bit outside that range; 0: 32-bit. A newer Python is not better: a future 3.15
        would have to build pydantic-core and friends from source (audit P3-6).
    #>
    param([hashtable] $Entry)
    if (-not $Entry.Is64) { return 0 }
    if ((Compare-SetupVersion $Entry.Version '3.11') -ge 0 -and (Compare-SetupVersion $Entry.Version $script:SetupPythonCeiling) -lt 0) { return 2 }
    return 1
}

# The first Python version the locked dependencies are not known to have wheels for.
$script:SetupPythonCeiling = '3.15'

function Find-SetupPython {
    <# The newest 64-bit Python 3.11-3.14 that actually starts; another one only when there is none. #>
    $script = 'import sys;print(sys.executable);print("%d.%d.%d" % sys.version_info[:3]);print(sys.maxsize > 2**32)'
    $candidates = New-Object System.Collections.ArrayList
    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($launcher) {
        $listed = Invoke-SetupProbe -File $launcher.Source -Arguments @('-0p') -TimeoutSeconds 15
        foreach ($line in $listed.Lines) { if ($line -match '([A-Za-z]:\\[^*]+?python\.exe)\s*$') { [void] $candidates.Add($Matches[1].Trim()) } }
    }
    foreach ($hive in @('HKLM:\SOFTWARE\Python\PythonCore', 'HKCU:\SOFTWARE\Python\PythonCore')) {
        foreach ($key in @(Get-ChildItem -Path $hive -ErrorAction SilentlyContinue)) {
            $install = Get-ItemProperty -Path (Join-Path $key.PSPath 'InstallPath') -ErrorAction SilentlyContinue
            if ($install -and $install.ExecutablePath) { [void] $candidates.Add($install.ExecutablePath) }
            elseif ($install -and $install.'(default)') { [void] $candidates.Add((Join-Path $install.'(default)' 'python.exe')) }
        }
    }
    foreach ($pattern in @("$env:LOCALAPPDATA\Programs\Python\Python3*\python.exe", "$env:ProgramFiles\Python3*\python.exe", "$env:SystemDrive\Python3*\python.exe")) {
        foreach ($file in @(Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue)) { [void] $candidates.Add($file.FullName) }
    }
    foreach ($command in @(Get-Command python.exe -All -ErrorAction SilentlyContinue)) { [void] $candidates.Add($command.Source) }

    $best = $null
    $seen = @{}
    foreach ($candidate in $candidates) {
        if (-not $candidate -or $seen[$candidate.ToLowerInvariant()]) { continue }
        $seen[$candidate.ToLowerInvariant()] = $true
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        $probe = Invoke-SetupProbe -File $candidate -Arguments @('-I', '-c', $script) -TimeoutSeconds 15
        $lines = @($probe.Lines | Where-Object { $_ -and $_.Trim() })
        # The Store's placeholder python.exe exits without printing a version.
        if (-not $probe.Ok -or $lines.Count -lt 3 -or $lines[1] -notmatch '^\d+\.\d+\.\d+$') { continue }
        $entry = @{ Exe = $lines[0].Trim(); Version = $lines[1].Trim(); Is64 = ($lines[2].Trim() -eq 'True') }
        $entry.Rank = Get-SetupPythonRank $entry
        if (-not $best -or $entry.Rank -gt $best.Rank -or ($entry.Rank -eq $best.Rank -and (Compare-SetupVersion $entry.Version $best.Version) -gt 0)) { $best = $entry }
    }
    if (-not $best) { return @{ Found = $false; Ok = $false; Exe = $null; Version = '' } }
    $best.Found = $true
    $best.Ok = ($best.Rank -eq 2)
    $best.TooNew = ($best.Is64 -and (Compare-SetupVersion $best.Version $script:SetupPythonCeiling) -ge 0)
    return $best
}

function Test-SetupFfmpeg {
    <# Whether the given file is a working ffmpeg with ffprobe beside it. #>
    param([string] $Path)
    $result = @{ Found = $false; Path = $Path; Version = ''; HasProbe = $false }
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $result }
    $probe = Invoke-SetupProbe -File $Path -Arguments @('-hide_banner', '-version') -TimeoutSeconds 15
    $first = @($probe.Lines | Where-Object { $_ -match '^ffmpeg version' } | Select-Object -First 1)
    if (-not $probe.Ok -or $first.Count -eq 0) { return $result }
    $result.Found = $true
    if ($first[0] -match '^ffmpeg version\s+(\S+)') { $result.Version = $Matches[1] }
    $result.HasProbe = Test-Path -LiteralPath (Join-Path (Split-Path -Parent $Path) 'ffprobe.exe')
    return $result
}

function Find-SetupFfmpeg {
    param([string] $Root, [string] $Preferred = '')
    $candidates = New-Object System.Collections.ArrayList
    if ($Preferred) {
        $resolved = if ([System.IO.Path]::IsPathRooted($Preferred)) { $Preferred } elseif ($Preferred -match '[\\/]') { Join-Path $Root $Preferred } else { '' }
        if ($resolved) { [void] $candidates.Add($resolved) }
    }
    # PATH as the registry has it now: a program installed a minute ago is not in this process's copy.
    $paths = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'), $env:Path) -join ';'
    foreach ($dir in @($paths.Split(';') | Where-Object { $_ } | Select-Object -Unique)) {
        try { [void] $candidates.Add((Join-Path ([Environment]::ExpandEnvironmentVariables($dir)) 'ffmpeg.exe')) } catch { }
    }
    foreach ($pattern in @(
            (Join-Path $Root 'runtime\ffmpeg*\bin\ffmpeg.exe'),
            "$env:LOCALAPPDATA\Microsoft\WinGet\Links\ffmpeg.exe",
            "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.FFmpeg*\*\bin\ffmpeg.exe",
            "$env:ProgramFiles\ffmpeg*\bin\ffmpeg.exe",
            "$env:SystemDrive\ffmpeg*\bin\ffmpeg.exe")) {
        foreach ($file in @(Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue)) { [void] $candidates.Add($file.FullName) }
    }
    foreach ($candidate in $candidates) {
        $tested = Test-SetupFfmpeg $candidate
        if ($tested.Found) { return $tested }
    }
    return @{ Found = $false; Path = $null; Version = ''; HasProbe = $false }
}

# -- ports, disk, network --------------------------------------------------------------------

function Get-SetupPortOwner {
    param([int] $Port)
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) { return @{ Port = $Port; InUse = $false; Process = ''; Path = ''; ProcessId = 0 } }
    $processId = [int] $listeners[0].OwningProcess
    $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
    return @{
        Port = $Port; InUse = $true; ProcessId = $processId
        Process = if ($process) { [string] $process.Name } elseif ($processId -eq 4) { 'System (HTTP.sys / IIS)' } else { "PID $processId" }
        Path = if ($process) { [string] $process.ExecutablePath } else { '' }
        CommandLine = if ($process) { [string] $process.CommandLine } else { '' }
    }
}

function Get-SetupFreePort {
    param([int] $Start = 8765, [int] $End = 8799)
    for ($port = $Start; $port -le $End; $port++) {
        if (@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue).Count -eq 0) { return $port }
    }
    return 0
}

function Get-SetupLan {
    try {
        $config = Get-NetIPConfiguration -ErrorAction Stop | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1
        if ($config -and $config.IPv4Address) {
            $address = @($config.IPv4Address)[0]
            # Public, Private or DomainAuthenticated: a home-network firewall rule holds on private networks only.
            $category = ''
            try { $category = [string] (Get-NetConnectionProfile -InterfaceIndex $config.InterfaceIndex -ErrorAction Stop | Select-Object -First 1).NetworkCategory } catch { }
            return @{ Found = $true; Address = [string] $address.IPAddress; Prefix = [int] $address.PrefixLength; Gateway = [string] @($config.IPv4DefaultGateway)[0].NextHop; Category = $category }
        }
    } catch { }
    return @{ Found = $false; Address = ''; Prefix = 0; Gateway = ''; Category = '' }
}

function Get-SetupDisk {
    param([string] $Path)
    try {
        $root = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($Path))
        $drive = New-Object System.IO.DriveInfo $root
        return @{ Drive = $root; FreeBytes = [long] $drive.AvailableFreeSpace; Ready = $drive.IsReady; Type = [string] $drive.DriveType }
    } catch {
        return @{ Drive = ''; FreeBytes = [long] 0; Ready = $false; Type = '' }
    }
}

function Get-SetupFirewall {
    <# Our own rules, and the catch-all rules Windows created for httpd.exe the first time it listened. #>
    param([string] $Httpd)
    $result = @{ Available = $true; Ours = @(); Generic = @() }
    try {
        $result.Ours = @(Get-NetFirewallRule -Group $script:SetupNames.FirewallGroup -ErrorAction SilentlyContinue | ForEach-Object {
                @{ Name = [string] $_.Name; DisplayName = [string] $_.DisplayName; Enabled = ([string] $_.Enabled -eq 'True') }
            })
        if ($Httpd) {
            $filters = @(Get-NetFirewallApplicationFilter -Program $Httpd -ErrorAction SilentlyContinue)
            foreach ($filter in $filters) {
                $rule = $filter | Get-NetFirewallRule -ErrorAction SilentlyContinue
                if ($rule -and [string] $rule.Direction -eq 'Inbound' -and [string] $rule.Action -eq 'Allow' -and [string] $rule.Group -ne $script:SetupNames.FirewallGroup) {
                    $result.Generic += @{ Name = [string] $rule.Name; DisplayName = [string] $rule.DisplayName; Enabled = ([string] $rule.Enabled -eq 'True'); Profile = [string] $rule.Profile }
                }
            }
        }
    } catch {
        $result.Available = $false
    }
    return $result
}

# -- an installation that is already here ------------------------------------------------------

function Get-SetupTaskInfo {
    param([string] $Name, [string] $ScriptName)
    $info = @{ Name = $Name; Exists = $false; State = ''; Root = $null; UsesScript = $false }
    $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if (-not $task) { return $info }
    $info.Exists = $true
    $info.State = [string] $task.State
    # The account the task runs as: the private files must stay readable for it.
    $info.UserId = [string] $task.Principal.UserId
    $arguments = [string] @($task.Actions)[0].Arguments
    $info.UsesScript = $arguments.Contains($ScriptName)
    if ($arguments -match '-ConfigPath\s+"([^"]+)"') {
        $config = $Matches[1]
        $info.Root = Split-Path -Parent (Split-Path -Parent $config)
    }
    return $info
}

function Get-SetupSecretFiles {
    <# The files of an installation that hold secrets: the private configuration, its copies, the keys. #>
    param([string] $Root)
    $files = @()
    foreach ($relative in @('config\config.local.toml', 'integrations\php\stage\config.local.php')) {
        $path = Join-Path $Root $relative
        if (Test-Path -LiteralPath $path -PathType Leaf) { $files += $path }
    }
    $files += @(Get-ChildItem -LiteralPath (Join-Path $Root 'config') -Filter 'config.backup-*.local.toml' -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    foreach ($folder in @('config\origin', 'config\tls')) {
        $files += @(Get-ChildItem -LiteralPath (Join-Path $Root $folder) -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    }
    return @($files)
}

function Test-SetupPrivateFile {
    <#
        Whether a file with secrets is closed to the machine's other accounts: no rule lets in
        Everyone, Users, Authenticated Users or the like. A tree moved with robocopy /MOVE keeps
        only inherited rights (audit P2-10). Unreadable rights count as fine: nothing to report.
    #>
    param([string] $Path)
    try { $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop } catch { return $true }
    $broad = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-4', 'S-1-2-0', 'S-1-2-1', 'S-1-5-2', 'S-1-5-7', 'S-1-5-32-546')
    foreach ($rule in @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))) {
        if ([string] $rule.AccessControlType -ne 'Allow') { continue }
        if ($broad -contains $rule.IdentityReference.Value) { return $false }
    }
    return $true
}

function Read-SetupState {
    param([string] $Root)
    $file = Join-Path $Root $script:SetupNames.StateFile
    if (-not (Test-Path -LiteralPath $file)) { return $null }
    try {
        return ConvertTo-SetupHashtable (ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)))
    } catch { return $null }
}

function Find-SetupExisting {
    <# An installation on this machine: the tree the wizard was started from, or the one the tasks and Apache point at. #>
    param([string] $SourceRoot, $Wamp)
    $serviceTask = Get-SetupTaskInfo $script:SetupNames.ServiceTask 'run-stage-supervisor-windows.ps1'
    $maintenanceTask = Get-SetupTaskInfo $script:SetupNames.MaintenanceTask 'run-maintenance-windows.ps1'
    $aliases = New-Object System.Collections.ArrayList
    if ($Wamp -and $Wamp.Found -and (Test-Path -LiteralPath $Wamp.AliasDir)) {
        # Only what Apache loads (Include "${INSTALL_DIR}/alias/*.conf"): a .bak copy beside it
        # must not become "the wizard's file" (audit P3-10).
        foreach ($file in @(Get-ChildItem -LiteralPath $Wamp.AliasDir -File -Filter '*.conf' -ErrorAction SilentlyContinue | Where-Object { $_.Extension -ieq '.conf' })) {
            $text = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::GetEncoding(28591))
            if ($text -match '(?m)^\s*Define\s+TRYHACKX_MEDIA_ROOT\s+"?([^"\r\n]+?)"?\s*$') {
                [void] $aliases.Add(@{ File = $file.FullName; Root = $Matches[1].Replace('/', '\'); Managed = $text.Contains('# TRYHACKX-MEDIA-SERVER-MANAGED') })
            }
        }
    }
    $roots = New-Object System.Collections.ArrayList
    [void] $roots.Add($SourceRoot)
    if ($serviceTask.Root) { [void] $roots.Add($serviceTask.Root) }
    foreach ($alias in $aliases) { [void] $roots.Add($alias.Root) }
    $root = $null
    foreach ($candidate in $roots) {
        if ($candidate -and (Test-Path -LiteralPath (Join-Path $candidate 'config\config.local.toml'))) { $root = [System.IO.Path]::GetFullPath($candidate).TrimEnd('\'); break }
    }
    $existing = @{ Found = [bool] $root; Root = $root; Aliases = @($aliases); ServiceTask = $serviceTask; MaintenanceTask = $maintenanceTask }
    if (-not $root) { return $existing }
    $existing.Config = Join-Path $root 'config\config.local.toml'
    # Left by a first installation that never reached its end (Step-PythonEnvironment writes it,
    # Step-SaveState removes it): such a tree is offered to be finished, not maintained.
    $existing.Unfinished = Test-Path -LiteralPath (Join-Path $root 'config\installer.pending.json')
    $existing.VenvPython = Join-Path $root '.venv\Scripts\python.exe'
    $existing.HasVenv = Test-Path -LiteralPath $existing.VenvPython
    # Present is not working: a .venv whose base Python is gone answers nothing (P2-3).
    $existing.VenvWorks = $existing.HasVenv -and (Test-SetupPythonStarts $existing.VenvPython)
    $existing.Version = Get-SetupVersion $root
    $existing.State = Read-SetupState $root
    $existing.OpenSecrets = @(Get-SetupSecretFiles $root | Where-Object { -not (Test-SetupPrivateFile $_) })
    $existing.SameTree = ([System.IO.Path]::GetFullPath($SourceRoot).TrimEnd('\') -ieq $root)
    $alias = @($aliases | Where-Object { [System.IO.Path]::GetFullPath($_.Root).TrimEnd('\') -ieq $root } | Select-Object -First 1)
    $existing.Alias = if ($alias.Count -gt 0) { $alias[0] } else { $null }
    # The service port, read the same way the start script reads it.
    $port = 8765
    $inServer = $false
    foreach ($line in [System.IO.File]::ReadAllLines($existing.Config)) {
        if ($line -match '^\s*\[([^\]]+)\]\s*$') { $inServer = ($Matches[1] -eq 'server'); continue }
        if ($inServer -and $line -match '^\s*port\s*=\s*([0-9]{1,5})\s*$') { $port = [int] $Matches[1] }
    }
    $existing.Port = $port
    $existing.Health = Get-SetupHealth $port
    return $existing
}

function Get-SetupHealth {
    param([int] $Port)
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health/ready" -UseBasicParsing -TimeoutSec 4
        return @{ Running = $true; Ready = ($response.StatusCode -eq 200) }
    } catch {
        $status = 0
        if ($_.Exception.Response) { $status = [int] $_.Exception.Response.StatusCode }
        return @{ Running = ($status -gt 0); Ready = $false }
    }
}

function Get-SetupInstalledDetails {
    <# What an existing installation says about itself: its configuration (through the helper) and
       the kinds of its folders (from the catalogue, when the database answers). Reads only. It
       starts two processes and one of them waits for the database, so it belongs to detection,
       which runs in the background, and not to the window's thread. #>
    param($Environment)
    $details = @{ Summary = $null; SummaryError = ''; Kinds = @{} }
    $existing = $Environment.Existing
    if (-not $existing -or -not $existing.Found) { return $details }
    try {
        $python = $null
        if ($existing.VenvWorks) { $python = $existing.VenvPython }
        elseif ($Environment.Python -and $Environment.Python.Exe) { $python = $Environment.Python.Exe }
        if (-not $python) { throw (T 'error.noPython') }
        $details.Summary = (Invoke-SetupHelper -Python $python -Command 'config-summary' -Request @{ config = $existing.Config }).summary
    } catch { $details.SummaryError = [string] $_.Exception.Message }
    if ($existing.VenvWorks) {
        $kinds = $details.Kinds
        try {
            $listed = Invoke-SetupProcess -File $existing.VenvPython -WorkingDirectory $existing.Root -Quiet -TimeoutSeconds 30 `
                -Environment @{ PYTHONIOENCODING = 'utf-8' } -Arguments @('-m', 'media_server', '--config', $existing.Config, 'roots', 'list')
            if ($listed.ExitCode -eq 0) {
                $catalog = New-Object System.Collections.ArrayList
                foreach ($entry in @((ConvertFrom-Json -InputObject (@($listed.Output) -join "`n")).roots)) {
                    if ($entry.kind) { $kinds[[string] $entry.id] = [string] $entry.kind }
                    # Switched-off roots too: their identifiers stay taken (audit P3-2).
                    if ($entry.id) { [void] $catalog.Add([string] $entry.id) }
                }
                $details.CatalogIds = @($catalog)
            }
        } catch { }
    }
    return $details
}

# -- the web interface: built, or built here from a clone ----------------------------------------

function Test-SetupNodeVersion {
    <# What Vite (frontend\package.json) runs on: Node.js 20.19 or newer in the 20 line, 22.12 or newer after it. #>
    param([string] $Version)
    if ($Version -notmatch '^(\d+)\.\d+') { return $false }
    $major = [int] $Matches[1]
    if ($major -eq 20) { return ((Compare-SetupVersion $Version '20.19') -ge 0) }
    return ($major -ge 22 -and (Compare-SetupVersion $Version '22.12') -ge 0)
}

function Find-SetupNode {
    <#
        node.exe with npm beside it (node_modules\npm\bin\npm-cli.js), a supported version first,
        then the newest. npm is run as `node npm-cli.js`, never through npm.cmd: no cmd.exe between
        the wizard and the arguments.
    #>
    $candidates = New-Object System.Collections.ArrayList
    # PATH as the registry has it now: a Node.js installed a minute ago (winget) is not in this process's copy.
    $paths = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'), $env:Path) -join ';'
    foreach ($dir in @($paths.Split(';') | Where-Object { $_ } | Select-Object -Unique)) {
        try { [void] $candidates.Add((Join-Path ([Environment]::ExpandEnvironmentVariables($dir)) 'node.exe')) } catch { }
    }
    foreach ($fixed in @("$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) { [void] $candidates.Add($fixed) }
    $best = $null
    $seen = @{}
    foreach ($candidate in $candidates) {
        if (-not $candidate -or $seen[$candidate.ToLowerInvariant()]) { continue }
        $seen[$candidate.ToLowerInvariant()] = $true
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $npm = Join-Path (Split-Path -Parent $candidate) 'node_modules\npm\bin\npm-cli.js'
        if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) { continue }
        $probe = Invoke-SetupProbe -File $candidate -Arguments @('--version') -TimeoutSeconds 15
        $line = @($probe.Lines | Where-Object { $_ -match '^v?\d+\.\d+\.\d+' } | Select-Object -First 1)
        if (-not $probe.Ok -or $line.Count -eq 0) { continue }
        $version = $line[0].Trim() -replace '^v', ''
        $entry = @{ Found = $true; Exe = $candidate; Npm = $npm; Version = $version; Ok = (Test-SetupNodeVersion $version) }
        if (-not $best -or ($entry.Ok -and -not $best.Ok) -or ($entry.Ok -eq $best.Ok -and (Compare-SetupVersion $entry.Version $best.Version) -gt 0)) { $best = $entry }
    }
    if (-not $best) { return @{ Found = $false; Ok = $false; Exe = $null; Npm = $null; Version = '' } }
    return $best
}

function Get-SetupFrontend {
    <#
        The interface of the tree the wizard runs from. A release package carries it built
        (public\assets\build). A clone of the repository does not: it has the sources (frontend\)
        and, when the private packs were cloned into frontend\vendor, those too - the wizard builds
        it before installing (Step-BuildFrontend). Only a tree that has to be built looks for Node.js.
        A clone is built every time, also when an earlier run left a build in it: after `git pull`
        (of the code or of the packs) that build is the old interface, and Update must not install it.
    #>
    param([string] $SourceRoot)
    $built = Test-Path -LiteralPath (Join-Path $SourceRoot 'public\assets\build\index.html') -PathType Leaf
    $sources = Test-Path -LiteralPath (Join-Path $SourceRoot 'frontend\package-lock.json') -PathType Leaf
    $vendor = Join-Path $SourceRoot 'frontend\vendor'
    $packs = @()
    if (Test-Path -LiteralPath $vendor -PathType Container) {
        # The folders the build reads; dot folders (a clone's .git) are not packs.
        $packs = @(Get-ChildItem -LiteralPath $vendor -Directory -Force -ErrorAction SilentlyContinue |
            Where-Object { -not $_.Name.StartsWith('.') } | ForEach-Object { $_.Name } | Sort-Object)
    }
    $frontend = @{ Built = $built; Sources = $sources; NeedsBuild = $sources; Packs = $packs
        Node = @{ Found = $false; Ok = $false; Exe = $null; Npm = $null; Version = '' } }
    if ($frontend.NeedsBuild) { $frontend.Node = Find-SetupNode }
    return $frontend
}

# -- everything at once ------------------------------------------------------------------------

function Get-SetupEnvironment {
    param([string] $SourceRoot, [string] $TargetRoot = '', [string] $FfmpegHint = '', [switch] $AssumeFresh)
    $os = Get-CimInstance -ClassName Win32_OperatingSystem
    $build = [int] $os.BuildNumber
    $environment = @{
        Os = @{ Caption = [string] $os.Caption; Build = $build; Is64 = [Environment]::Is64BitOperatingSystem; Ok = ([Environment]::Is64BitOperatingSystem -and $build -ge 17763) }
        Admin = Test-SetupAdmin
        Winget = [bool] (Get-Command winget.exe -ErrorAction SilentlyContinue)
    }
    $environment.Wamp = Get-SetupWamp
    $environment.Database = Select-SetupDatabase $environment.Wamp.Databases
    $environment.Existing = if ($AssumeFresh) { @{ Found = $false; Aliases = @(); ServiceTask = @{ Exists = $false }; MaintenanceTask = @{ Exists = $false } } } else { Find-SetupExisting $SourceRoot $environment.Wamp }
    $environment.Python = Find-SetupPython
    if ($environment.Existing.Found) { $environment.Existing.Details = Get-SetupInstalledDetails $environment }
    $ffmpegRoot = if ($environment.Existing.Found) { $environment.Existing.Root } else { $SourceRoot }
    $environment.Ffmpeg = Find-SetupFfmpeg -Root $ffmpegRoot -Preferred $FfmpegHint
    $environment.Frontend = Get-SetupFrontend $SourceRoot
    $environment.Ports = @{ Http = Get-SetupPortOwner 80; Https = Get-SetupPortOwner 443 }
    $servicePort = if ($environment.Existing.Found) { $environment.Existing.Port } else { 8765 }
    $environment.Ports.Service = Get-SetupPortOwner $servicePort
    $environment.Ports.ServiceSuggested = $servicePort
    if ($environment.Ports.Service.InUse -and -not $environment.Existing.Found) { $environment.Ports.ServiceSuggested = Get-SetupFreePort }
    $diskPath = if ($TargetRoot) { $TargetRoot } else { $SourceRoot }
    $environment.Disk = Get-SetupDisk $diskPath
    $environment.Lan = Get-SetupLan
    $httpd = if ($environment.Wamp.Apache) { $environment.Wamp.Apache.Httpd } else { $null }
    $environment.Firewall = Get-SetupFirewall $httpd
    return $environment
}

function Test-SetupOwnedByApache {
    <# Whether the process holding a web port is this WampServer's own Apache. #>
    param($Owner, $Environment)
    if (-not $Owner.InUse) { return $true }
    $apache = $Environment.Wamp.Apache
    if (-not $apache -or -not $apache.Httpd) { return $false }
    if ($Owner.Path) { return ($Owner.Path -ieq [string] $apache.Httpd) }
    # Without elevation Windows does not tell the path of a SYSTEM process.
    return ($Owner.Process -ieq 'httpd.exe' -and $apache.Service.Running)
}

function Get-SetupRequirements {
    <#
        The requirements page as data: one row per check, with a status
        (ok | fix | warn | error) and the actions offered. 'fix' means the wizard
        will take care of it during installation; only 'error' stops the Next button.
    #>
    param([hashtable] $Environment, [string] $Mode = 'install', [string] $AccessMode = 'local')
    $rows = New-Object System.Collections.ArrayList
    $add = { param($id, $status, $title, $detail, $actions) [void] $rows.Add(@{ Id = $id; Status = $status; Title = $title; Detail = $detail; Actions = @($actions) }) }

    $os = $Environment.Os
    if ($os.Ok) { & $add 'os' 'ok' (T 'req.os') (T 'req.os.ok' $os.Caption $os.Build) @() }
    else { & $add 'os' 'error' (T 'req.os') (T 'req.os.bad' $os.Caption) @() }

    if ($Environment.Admin) { & $add 'admin' 'ok' (T 'req.admin') (T 'req.admin.ok') @() }
    else { & $add 'admin' 'warn' (T 'req.admin') (T 'req.admin.missing') @() }

    $wamp = $Environment.Wamp
    if (-not $wamp.Found) {
        & $add 'wamp' 'error' (T 'req.wamp') (T 'req.wamp.missing') @(@{ Id = 'open-wamp'; Label = (T 'req.action.wampSite') }, @{ Id = 'open-vcredist'; Label = (T 'req.action.vcredist') })
    } else {
        & $add 'wamp' 'ok' (T 'req.wamp') (T 'req.wamp.ok' $wamp.Version $wamp.InstallDir) @()

        $apache = $wamp.Apache
        if (-not $apache.Found) { & $add 'apache' 'error' (T 'req.apache') (T 'req.apache.missing') @() }
        elseif (-not $apache.ConfigOk) { & $add 'apache' 'error' (T 'req.apache') (T 'req.apache.broken' $apache.ConfigError) @() }
        elseif ((Compare-SetupVersion $apache.Version '2.4') -lt 0) { & $add 'apache' 'error' (T 'req.apache') (T 'req.apache.old' $apache.Version) @() }
        elseif (@($apache.ListenPorts | Where-Object { $_ }).Count -gt 0 -and @($apache.ListenPorts) -notcontains 80) {
            # Only when the ports were read: @($null) counts as one and would block every machine
            # whose Listen lines detection could not parse.
            & $add 'apache' 'error' (T 'req.apache') (T 'req.apache.port' (@($apache.ListenPorts | Where-Object { $_ }) -join ', ')) @()
        }
        else {
            $needed = @(Get-SetupRequiredModules $AccessMode)
            $missing = @($needed | Where-Object { $apache.Modules -notcontains $_ })
            $impossible = @($missing | Where-Object { $apache.Available -notcontains $_ })
            $running = if ($apache.Service.Running) { T 'req.running' } else { T 'req.stopped' }
            if ($impossible.Count -gt 0) { & $add 'apache' 'error' (T 'req.apache') (T 'req.apache.noModule' ($impossible -join ', ')) @() }
            elseif ($missing.Count -gt 0) { & $add 'apache' 'fix' (T 'req.apache') (T 'req.apache.enable' $apache.Version ($missing -join ', ')) @() }
            else { & $add 'apache' 'ok' (T 'req.apache') (T 'req.apache.ok' $apache.Version $running) @() }
        }

        $php = $wamp.Php
        if (-not $php.Found -or -not $php.Version) { & $add 'php' 'error' (T 'req.php') (T 'req.php.missing') @() }
        elseif ((Compare-SetupVersion $php.Version '8.1') -lt 0) { & $add 'php' 'error' (T 'req.php') (T 'req.php.old' $php.Version) @() }
        else {
            $lower = @($php.Extensions | ForEach-Object { $_.ToLowerInvariant() })
            $missing = @($script:SetupPhpRequired | Where-Object { $lower -notcontains $_.ToLowerInvariant() })
            $optional = @($script:SetupPhpOptional | Where-Object { $lower -notcontains $_.ToLowerInvariant() })
            if ($missing.Count -gt 0) { & $add 'php' 'error' (T 'req.php') (T 'req.php.noExtension' $php.Version ($missing -join ', ')) @() }
            elseif ($optional.Count -gt 0) { & $add 'php' 'warn' (T 'req.php') (T 'req.php.optional' $php.Version ($optional -join ', ')) @() }
            else { & $add 'php' 'ok' (T 'req.php') (T 'req.php.ok' $php.Version) @() }
        }

        $database = $Environment.Database
        if (-not $database) {
            $found = @($wamp.Databases | ForEach-Object { $_.Label }) -join ', '
            & $add 'database' 'error' (T 'req.database') (T 'req.database.missing' $found) @()
        } elseif (-not $database.Service.Running) {
            & $add 'database' 'error' (T 'req.database') (T 'req.database.stopped' $database.Label) @(@{ Id = 'start-services'; Label = (T 'req.action.startServices') })
        } else {
            & $add 'database' 'ok' (T 'req.database') (T 'req.database.ok' $database.Label $database.Port) @()
        }
    }

    $python = $Environment.Python
    $pythonActions = @()
    if ($Environment.Winget) { $pythonActions += @{ Id = 'winget-python'; Label = (T 'req.action.winget') } }
    $pythonActions += @{ Id = 'open-python'; Label = (T 'req.action.site') }
    if (-not $python.Found) { & $add 'python' 'error' (T 'req.python') (T 'req.python.missing') $pythonActions }
    elseif (-not $python.Ok -and $python.TooNew) { & $add 'python' 'error' (T 'req.python') (T 'req.python.new' $python.Version) $pythonActions }
    elseif (-not $python.Ok) { & $add 'python' 'error' (T 'req.python') (T 'req.python.old' $python.Version) $pythonActions }
    else { & $add 'python' 'ok' (T 'req.python') (T 'req.python.ok' $python.Version $python.Exe) @() }

    $ffmpeg = $Environment.Ffmpeg
    $ffmpegActions = @()
    if ($Environment.Winget) { $ffmpegActions += @{ Id = 'winget-ffmpeg'; Label = (T 'req.action.winget') } }
    $ffmpegActions += @(@{ Id = 'browse-ffmpeg'; Label = (T 'req.action.browse') }, @{ Id = 'open-ffmpeg'; Label = (T 'req.action.site') })
    if (-not $ffmpeg.Found) { & $add 'ffmpeg' 'warn' (T 'req.ffmpeg') (T 'req.ffmpeg.missing') $ffmpegActions }
    elseif (-not $ffmpeg.HasProbe) { & $add 'ffmpeg' 'warn' (T 'req.ffmpeg') (T 'req.ffmpeg.noProbe' $ffmpeg.Path) $ffmpegActions }
    else { & $add 'ffmpeg' 'ok' (T 'req.ffmpeg') (T 'req.ffmpeg.ok' $ffmpeg.Version $ffmpeg.Path) @(@{ Id = 'browse-ffmpeg'; Label = (T 'req.action.change') }) }

    # A release package brings the interface built; a clone of the repository is built here, every time.
    $frontend = $Environment.Frontend
    if ($frontend -and -not $frontend.NeedsBuild -and $frontend.Built) { & $add 'frontend' 'ok' (T 'req.frontend') (T 'req.frontend.ok') @() }
    elseif ($frontend -and -not $frontend.Sources) { & $add 'frontend' 'error' (T 'req.frontend') (T 'req.frontend.missing') @() }
    elseif ($frontend) {
        $packs = if (@($frontend.Packs).Count -gt 0) { T 'req.frontend.packs' (@($frontend.Packs) -join ', ') } else { T 'req.frontend.public' }
        $node = $frontend.Node
        $nodeActions = @()
        if ($Environment.Winget) { $nodeActions += @{ Id = 'winget-node'; Label = (T 'req.action.winget') } }
        $nodeActions += @{ Id = 'open-node'; Label = (T 'req.action.site') }
        # Only an installation or an update builds: the other actions on an installation made from a
        # clone (folders, access, repair...) do not stop for a Node.js they never use.
        $noNode = if ($Mode -eq 'maintain') { 'warn' } else { 'error' }
        if (-not $node.Found) { & $add 'frontend' $noNode (T 'req.frontend') ((T 'req.frontend.noNode') + ' ' + $packs) $nodeActions }
        elseif (-not $node.Ok) { & $add 'frontend' $noNode (T 'req.frontend') ((T 'req.frontend.oldNode' $node.Version) + ' ' + $packs) $nodeActions }
        else { & $add 'frontend' 'fix' (T 'req.frontend') ((T 'req.frontend.build' $node.Version) + ' ' + $packs) @() }
    }

    $ports = $Environment.Ports
    # Port 80 is needed by every mode; 443 only by "own domain" and "VPS", which the access page
    # checks once a mode is chosen - "this computer" must not be blocked by it (audit P3-23).
    if (-not (Test-SetupOwnedByApache $ports.Http $Environment)) {
        & $add 'ports' 'error' (T 'req.ports') (T 'req.ports.taken' $ports.Http.Port $ports.Http.Process) @()
    }
    elseif ($ports.Service.InUse -and -not $Environment.Existing.Found) {
        if ($ports.ServiceSuggested -gt 0) { & $add 'ports' 'fix' (T 'req.ports') (T 'req.ports.other' $ports.Service.Port $ports.Service.Process $ports.ServiceSuggested) @() }
        else { & $add 'ports' 'error' (T 'req.ports') (T 'req.ports.none') @() }
    } else { & $add 'ports' 'ok' (T 'req.ports') (T 'req.ports.ok' $ports.ServiceSuggested) @() }
    if ($ports.Https -and -not (Test-SetupOwnedByApache $ports.Https $Environment)) {
        & $add 'https-port' 'warn' (T 'req.ports.httpsTitle') (T 'req.ports.https' $ports.Https.Process) @()
    }

    $disk = $Environment.Disk
    $freeGb = [Math]::Round($disk.FreeBytes / 1GB, 1)
    if (-not $disk.Ready) { & $add 'disk' 'warn' (T 'req.disk') (T 'req.disk.unknown') @() }
    elseif ($disk.FreeBytes -lt 1GB) { & $add 'disk' 'error' (T 'req.disk') (T 'req.disk.low' $freeGb $disk.Drive) @() }
    elseif ($disk.FreeBytes -lt 5GB) { & $add 'disk' 'warn' (T 'req.disk') (T 'req.disk.tight' $freeGb $disk.Drive) @() }
    else { & $add 'disk' 'ok' (T 'req.disk') (T 'req.disk.ok' $freeGb $disk.Drive) @() }

    return @($rows)
}
