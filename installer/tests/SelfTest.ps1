<#
.SYNOPSIS
    Self-test of the wizard's logic - no window, no administrator rights, no WampServer.

.DESCRIPTION
    Run by tests\test_installer_wizard.py (and by hand:
    powershell -NoProfile -ExecutionPolicy Bypass -File installer\tests\SelfTest.ps1).

    It builds a small imitation of a WampServer tree in a temporary folder, points
    the sample environment of -Preview at it, and then:

      * checks the validators the pages rely on;
      * builds the plan for every access mode and for the maintenance flows;
      * runs every plan in dry-run mode and reads the transcript: the commands that
        must be there are there, no password is, and not a single file changed.

    The exit code is the number of failed checks. Keep this file pure ASCII.
#>
[CmdletBinding()]
param(
    [string] $Python = '',
    [string] $Work = ''
)

$ErrorActionPreference = 'Stop'
$InstallerDir = Split-Path -Parent $PSScriptRoot
$Repo = Split-Path -Parent $InstallerDir
foreach ($library in @('Common.ps1', 'Detect.ps1', 'Steps.ps1', 'State.ps1', 'Preview.ps1')) { . (Join-Path $InstallerDir ('lib\' + $library)) }
# The context first: it compiles the process runner that looking for Python relies on.
$script:Lines = New-Object System.Collections.ArrayList
$script:Failures = New-Object System.Collections.ArrayList
$script:Checks = 0
Initialize-SetupContext -InstallerDir $InstallerDir -Language 'en' -DryRun $true -Sink { param($message) if ($message.Type -eq 'log') { [void] $script:Lines.Add([string] $message.Text) } }
if (-not $Python) { $Python = (Find-SetupPython).Exe }
if (-not $Python) { Write-Output 'SKIP: no Python 3.11+ on this machine'; exit 0 }
if (-not $Work) { $Work = Join-Path ([System.IO.Path]::GetTempPath()) ('thx-selftest-' + [Guid]::NewGuid().ToString('N')) }
New-Item -ItemType Directory -Path $Work -Force | Out-Null

function Check {
    param([string] $Name, [bool] $Condition, [string] $Detail = '')
    $script:Checks++
    if (-not $Condition) { [void] $script:Failures.Add("$Name $Detail".Trim()); Write-Output "FAIL  $Name  $Detail" }
}

function Get-TreeDigest {
    <# Path, size and SHA-256 of every file under a folder: equal digests mean nothing was written. #>
    param([string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) { return '(absent)' }
    $entries = Get-ChildItem -LiteralPath $Path -Recurse -File | Sort-Object FullName | ForEach-Object {
        '{0}|{1}|{2}' -f $_.FullName.Substring($Path.Length), $_.Length, (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    }
    return (@($entries) -join "`n")
}

# -- an imitation of WampServer, enough for the text work ---------------------------------------
$wampRoot = Join-Path $Work 'wamp64'
$apacheDir = Join-Path $wampRoot 'bin\apache\apache2.4.62'
New-Item -ItemType Directory -Path (Join-Path $apacheDir 'conf\extra'), (Join-Path $apacheDir 'bin'), (Join-Path $wampRoot 'alias') -Force | Out-Null
$ascii = [System.Text.Encoding]::ASCII
[System.IO.File]::WriteAllText((Join-Path $apacheDir 'conf\httpd.conf'), (@(
            'ServerRoot "${SRVROOT}"', 'Listen 0.0.0.0:80', 'Listen [::0]:80',
            'LoadModule alias_module modules/mod_alias.so', 'LoadModule authz_core_module modules/mod_authz_core.so',
            'LoadModule authz_host_module modules/mod_authz_host.so', 'LoadModule dir_module modules/mod_dir.so',
            'LoadModule env_module modules/mod_env.so', 'LoadModule headers_module modules/mod_headers.so',
            'LoadModule mime_module modules/mod_mime.so', 'LoadModule proxy_module modules/mod_proxy.so',
            'LoadModule proxy_http_module modules/mod_proxy_http.so', '#LoadModule socache_shmcb_module modules/mod_socache_shmcb.so',
            '#LoadModule ssl_module modules/mod_ssl.so', 'Include conf/extra/httpd-vhosts.conf', 'IncludeOptional "${INSTALL_DIR}/alias/*"'
        ) -join "`r`n") + "`r`n", $ascii)
[System.IO.File]::WriteAllText((Join-Path $apacheDir 'conf\extra\httpd-vhosts.conf'), (@(
            '# Virtual Hosts', '#', '<VirtualHost _default_:80>', '  ServerName localhost', '  ServerAlias localhost',
            '  DocumentRoot "${INSTALL_DIR}/www"', '  <Directory "${INSTALL_DIR}/www/">', '    Require local', '  </Directory>', '</VirtualHost>'
        ) -join "`r`n") + "`r`n", $ascii)
[System.IO.File]::WriteAllText((Join-Path $wampRoot 'alias\adminer.conf'), "Alias /adminer `"c:/wamp64/apps/adminer/`"`r`n", $ascii)

function New-TestState {
    param([string] $Mode, [string] $Target)
    $state = New-SetupSampleState -SourceRoot $Repo -Variant 'ok'
    $state.SourceRoot = $Repo
    $state.TargetRoot = $Target
    $apache = $state.Env.Wamp.Apache
    $apache.Dir = $apacheDir
    $apache.Httpd = Join-Path $apacheDir 'bin\httpd.exe'
    $apache.Conf = Join-Path $apacheDir 'conf\httpd.conf'
    $apache.VhostsConf = Join-Path $apacheDir 'conf\extra\httpd-vhosts.conf'
    $apache.OpenSsl = Join-Path $apacheDir 'bin\openssl.exe'
    $apache.OpenSslConf = Join-Path $apacheDir 'conf\openssl.cnf'
    $state.Env.Wamp.InstallDir = $wampRoot
    $state.Env.Wamp.AliasDir = Join-Path $wampRoot 'alias'
    $state.Env.Python = @{ Found = $true; Ok = $true; Exe = $Python; Version = '3.x' }
    foreach ($root in $state.Roots) { if (-not $root.Id) { $root.Id = 'nagrania_z_wakacji' } }
    Set-SetupSampleAccess $state $Mode
    if ($Mode -eq 'direct') { $state.Access.SelfSigned = $true; $paths = Get-SetupPaths $state; $state.Access.CertificateFile = $paths.SelfCert; $state.Access.KeyFile = $paths.SelfKey }
    if ($Mode -eq 'vps') { $state.Access.AllowLan = $true }
    $state.Database.AppPassword = New-SetupPassword
    $state.Admin.Password = 'self-test-' + (New-SetupPassword).Substring(0, 12)
    $state.Database.AdminPassword = 'root-' + (New-SetupPassword).Substring(0, 12)
    foreach ($secret in @($state.Database.AppPassword, $state.Admin.Password, $state.Database.AdminPassword)) { Add-SetupSecret $secret }
    return $state
}

function Invoke-TestPlan {
    param([hashtable] $State)
    $script:Lines.Clear()
    $plan = @(Get-SetupPlan $State)
    $result = Invoke-SetupPlan -State $State -Plan $plan
    return @{ Plan = $plan; Result = $result; Text = (@($script:Lines) -join "`n") }
}

# -- 1. small functions the pages lean on ---------------------------------------------------------
Check 'argument quoting: plain' ((ConvertTo-NativeArgument 'abc') -eq 'abc')
Check 'argument quoting: space' ((ConvertTo-NativeArgument 'C:\Program Files\x') -eq '"C:\Program Files\x"')
Check 'argument quoting: trailing backslash' ((ConvertTo-NativeArgument 'C:\My Folder\') -eq '"C:\My Folder\\"')
Check 'argument quoting: quote' ((ConvertTo-NativeArgument 'say "hi"') -eq '"say \"hi\""')
Check 'argument quoting: empty' ((ConvertTo-NativeArgument '') -eq '""')
Check 'version order' ((Compare-SetupVersion '3.11.9' '3.11') -eq 1 -and (Compare-SetupVersion '8.0.40' '8.4') -eq -1 -and (Compare-SetupVersion '2.4' '2.4.0') -eq 0)
$generated = New-SetupPassword
Check 'generated password needs no escaping' ($generated -match '^[A-Za-z0-9_-]{43}$')
Add-SetupSecret 'correct-horse-battery'
Check 'registered secret is hidden' ((Protect-SetupText 'x correct-horse-battery y') -eq 'x ******** y')
Check 'password-looking value is hidden' ((Protect-SetupText 'password = "hunter2hunter2"') -notmatch 'hunter2')
Check 'identified-by is hidden' ((Protect-SetupText "CREATE USER 'a'@'b' IDENTIFIED BY 'p4ssw0rd-value';") -notmatch 'p4ssw0rd')
Add-SetupSecret 'q7z'
Check 'a short secret is hidden where it stands alone' ((Protect-SetupText 'user root, password q7z.') -eq 'user root, password ********.')
Check 'a short secret inside a word stays readable' ((Protect-SetupText 'folder q7zip') -eq 'folder q7zip')
Check 'a short password-looking value is hidden' ((Protect-SetupText 'pwd=ab1') -notmatch 'ab1')

Check 'admin: good' (@(Test-SetupAdminAccount -Username 'jan.k' -Email 'jan@example.org' -Password 'twelve-chars-ok' -Repeat 'twelve-chars-ok').Count -eq 0)
Check 'admin: short password' (@(Test-SetupAdminAccount -Username 'jan' -Email '' -Password 'short' -Repeat 'short').Count -eq 1)
Check 'admin: mismatch' (@(Test-SetupAdminAccount -Username 'jan' -Email '' -Password 'twelve-chars-ok' -Repeat 'twelve-chars-no').Count -eq 1)
Check 'admin: bad name and mail' (@(Test-SetupAdminAccount -Username 'j' -Email 'no-at-sign' -Password 'twelve-chars-ok' -Repeat 'twelve-chars-ok').Count -eq 2)

$sampleWamp = (Get-SetupSampleEnvironment 'ok').Wamp
Check 'target: relative refused' (@(Test-SetupTargetFolder -Path 'MediaServer' -SourceRoot $Repo -Wamp $sampleWamp).Count -gt 0)
Check 'target: web root refused' (@(Test-SetupTargetFolder -Path 'C:\wamp64\www\media' -SourceRoot $Repo -Wamp $sampleWamp).Count -gt 0)
Check 'target: non-ASCII refused' (@(Test-SetupTargetFolder -Path ('C:\Serwer' + [char] 0x017C) -SourceRoot $Repo -Wamp $sampleWamp).Count -gt 0)
Check 'target: Windows folder refused' (@(Test-SetupTargetFolder -Path (Join-Path $env:SystemRoot 'Media') -SourceRoot $Repo -Wamp $sampleWamp).Count -gt 0)
Check 'target: non-empty folder refused' (@(Test-SetupTargetFolder -Path $wampRoot -SourceRoot $Repo -Wamp $sampleWamp | Where-Object { $_ }).Count -gt 0)
Check 'target: new folder accepted' (@(Test-SetupTargetFolder -Path (Join-Path $Work 'brand-new') -SourceRoot $Repo -Wamp $sampleWamp | Where-Object { $_ -notmatch 'drive' }).Count -eq 0)
Check 'target: square brackets refused' (@(Test-SetupTargetFolder -Path 'C:\Media[1]\Server' -SourceRoot $Repo -Wamp $sampleWamp | Where-Object { $_ -match 'brackets' }).Count -eq 1)
Check 'target: a folder inside the package refused' (@(Test-SetupTargetFolder -Path (Join-Path $Repo 'nested-copy') -SourceRoot $Repo -Wamp $sampleWamp | Where-Object { $_ -match 'inside the package' }).Count -eq 1)

# A backup is never overwritten: "Try again" must not replace the saved original with the wizard's own file.
$backupState = @{ TargetRoot = (Join-Path $Work 'backup-target'); Backups = $null; BackupDir = $null }
$firstFile = Join-Path $Work 'one\site.conf'; $secondFile = Join-Path $Work 'two\site.conf'
foreach ($file in @($firstFile, $secondFile)) { New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force | Out-Null; [System.IO.File]::WriteAllText($file, 'x', $ascii) }
$copyOne = Backup-SetupFile $backupState $firstFile
$copyAgain = Backup-SetupFile $backupState $firstFile
$copyTwo = Backup-SetupFile $backupState $secondFile
Check 'backup: a second copy of one file keeps the first' ($copyOne -eq $copyAgain -and @($backupState.Backups).Count -eq 2)
Check 'backup: two files of one name get two copies' ($copyTwo -ne $copyOne -and $copyTwo -match 'site\.2\.conf$')

# Files a package dropped are removed by the previous list, but never from a git working copy.
$gitTree = Join-Path $Work 'git-tree'
New-Item -ItemType Directory -Path (Join-Path $gitTree '.git'), (Join-Path $gitTree 'runtime') -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $gitTree 'runtime\installer-files.txt'), "tracked.py`r`n", $ascii)
[System.IO.File]::WriteAllText((Join-Path $gitTree 'tracked.py'), 'x', $ascii)
$script:Lines.Clear()
Remove-SetupStaleFiles @{} $gitTree @('other.py')
$logged = (@($script:Lines) -join "`n")
Check 'update: a git working copy loses nothing' (-not ($logged -match 'tracked\.py') -and $logged -match 'git working copy')

# The connection test reads its answers by label, whatever else the client printed.
$answer = ConvertFrom-SetupDatabaseAnswer @('WARNING: option --ssl-verify-server-cert is disabled', 'version=8.4.7', 'create=2', 'schema=1', 'tables=48', 'user=1')
Check 'database test: labels, not positions' ($answer.Ok -and $answer.Version -eq '8.4.7' -and $answer.CanCreate -and $answer.DatabaseExists -and $answer.Tables -eq 48 -and $answer.UserExists)
Check 'database test: a missing answer is no answer' (-not (ConvertFrom-SetupDatabaseAnswer @('version=8.4.7', 'create=2', 'schema=x', 'tables=0', 'user=0')).Ok)

# A newer Python is not a better one: the locked packages have wheels for 3.11-3.14.
Check 'python: 3.14 preferred to 3.15' ((Get-SetupPythonRank @{ Is64 = $true; Version = '3.14.2' }) -gt (Get-SetupPythonRank @{ Is64 = $true; Version = '3.15.0' }))
Check 'python: 32-bit last' ((Get-SetupPythonRank @{ Is64 = $false; Version = '3.13.1' }) -eq 0 -and (Get-SetupPythonRank @{ Is64 = $true; Version = '3.10.11' }) -eq 1)

# The language files are read as data, past the 500 keys Import-PowerShellDataFile allows on 5.1.
$strings = Import-SetupStrings (Join-Path $InstallerDir 'lang\pl.psd1')
Check 'texts: every key loads' ($strings.Count -gt 500 -and $strings['app.title'])
$hostile = Join-Path $Work 'hostile.psd1'
[System.IO.File]::WriteAllText($hostile, "@{`r`n    'a' = `"`$(Get-Date)`"`r`n}`r`n", $ascii)
$refused = $false
try { [void] (Import-SetupStrings $hostile) } catch { $refused = $true }
Check 'texts: an expression is refused, not run' $refused

$mediaA = Join-Path $Work 'media\Muzyka'; $mediaB = Join-Path $Work 'media\Muzyka\Jazz'
New-Item -ItemType Directory -Path $mediaB -Force | Out-Null
$project = Join-Path $Work 'project'; New-Item -ItemType Directory -Path (Join-Path $project 'inside') -Force | Out-Null
Check 'media: existing folder accepted' (@((Test-SetupMediaFolder -Path $mediaA -ProjectRoot $project).Errors).Count -eq 0)
Check 'media: missing folder refused' (@((Test-SetupMediaFolder -Path (Join-Path $Work 'nope') -ProjectRoot $project).Errors).Count -eq 1)
Check 'media: relative path refused' (@((Test-SetupMediaFolder -Path 'Muzyka' -ProjectRoot $project).Errors).Count -eq 1)
Check 'media: folder inside the project refused' (@((Test-SetupMediaFolder -Path (Join-Path $project 'inside') -ProjectRoot $project).Errors).Count -ge 1)
Check 'media: folder containing the project refused' (@((Test-SetupMediaFolder -Path $Work -ProjectRoot $project).Errors).Count -ge 1)
Check 'media: nested folders refused' (@((Test-SetupMediaFolder -Path $mediaB -ProjectRoot $project -Others @($mediaA)).Errors).Count -eq 1)
Check 'media: duplicate refused' (@((Test-SetupMediaFolder -Path $mediaA -ProjectRoot $project -Others @($mediaA + '\')).Errors).Count -eq 1)
Check 'media: drive root needs a confirmation' (@((Test-SetupMediaFolder -Path ([System.IO.Path]::GetPathRoot($Work)) -ProjectRoot $project).Warnings).Count -ge 1)
Check 'media: Windows folder refused' (@((Test-SetupMediaFolder -Path $env:SystemRoot -ProjectRoot $project).Errors).Count -ge 1)
Check 'kind guess' ((Get-SetupGuessedKind 'E:\Muzyka') -eq 'music' -and (Get-SetupGuessedKind 'E:\Filmy Video') -eq 'movies' -and (Get-SetupGuessedKind 'D:\Archiwum') -eq 'mixed')

# -- 2. the requirements page as data -----------------------------------------------------------
$rows = @{}
foreach ($row in @(Get-SetupRequirements -Environment (Get-SetupSampleEnvironment 'ok') -AccessMode 'local')) { $rows[$row.Id] = $row }
Check 'requirements: all ok' (@($rows.Values | Where-Object { $_.Status -ne 'ok' }).Count -eq 0) (@($rows.Values | Where-Object { $_.Status -ne 'ok' } | ForEach-Object { $_.Id }) -join ',')
$rows = @{}
foreach ($row in @(Get-SetupRequirements -Environment (Get-SetupSampleEnvironment 'ok') -AccessMode 'vps')) { $rows[$row.Id] = $row }
Check 'requirements: TLS modules are a fix, not an error' ($rows['apache'].Status -eq 'fix' -and $rows['apache'].Detail -match 'ssl_module')
$rows = @{}
foreach ($row in @(Get-SetupRequirements -Environment (Get-SetupSampleEnvironment 'missing') -AccessMode 'local')) { $rows[$row.Id] = $row }
Check 'requirements: missing Python blocks' ($rows['python'].Status -eq 'error' -and @($rows['python'].Actions | Where-Object { $_.Id -eq 'winget-python' }).Count -eq 1)
Check 'requirements: missing FFmpeg warns' ($rows['ffmpeg'].Status -eq 'warn' -and @($rows['ffmpeg'].Actions).Count -eq 3)
Check 'requirements: busy service port moves' ($rows['ports'].Status -eq 'fix' -and $rows['ports'].Detail -match '8766')
Check 'requirements: optional PHP extension warns' ($rows['php'].Status -eq 'warn')
$rows = @{}
foreach ($row in @(Get-SetupRequirements -Environment (Get-SetupSampleEnvironment 'nowamp') -AccessMode 'local')) { $rows[$row.Id] = $row }
Check 'requirements: no WampServer blocks, with a way out' ($rows['wamp'].Status -eq 'error' -and @($rows['wamp'].Actions).Count -eq 2 -and -not $rows.ContainsKey('apache'))
$busy = Get-SetupSampleEnvironment 'ok'
$busy.Ports.Https = @{ Port = 443; InUse = $true; Process = 'vmware-hostd.exe'; Path = 'C:\Program Files\VMware\vmware-hostd.exe'; ProcessId = 5555 }
$rows = @{}
foreach ($row in @(Get-SetupRequirements -Environment $busy -AccessMode 'local')) { $rows[$row.Id] = $row }
Check 'requirements: a busy 443 only warns' ($rows['ports'].Status -eq 'ok' -and $rows['https-port'].Status -eq 'warn')
$busy.Ports.Http = @{ Port = 80; InUse = $true; Process = 'Skype.exe'; Path = 'C:\Program Files\Skype\Skype.exe'; ProcessId = 5556 }
$rows = @{}
foreach ($row in @(Get-SetupRequirements -Environment $busy -AccessMode 'local')) { $rows[$row.Id] = $row }
Check 'requirements: a busy 80 blocks, and says how to free it' ($rows['ports'].Status -eq 'error' -and $rows['ports'].Detail -match 'Skype\.exe' -and $rows['ports'].Detail -match 'Check again')

# The interface: a release package carries it built; a clone of the repository is built here.
$rows = @{}
foreach ($row in @(Get-SetupRequirements -Environment (Get-SetupSampleEnvironment 'missing') -AccessMode 'local')) { $rows[$row.Id] = $row }
Check 'requirements: a clone without Node.js blocks, offers winget, names the packs' ($rows['frontend'].Status -eq 'error' -and @($rows['frontend'].Actions | Where-Object { $_.Id -eq 'winget-node' }).Count -eq 1 -and $rows['frontend'].Detail -match 'avs-presets')
$cloneEnvironment = Get-SetupSampleEnvironment 'missing'
$cloneEnvironment.Frontend.Node = @{ Found = $true; Ok = $true; Exe = 'C:\Program Files\nodejs\node.exe'; Npm = 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js'; Version = '24.11.1' }
$rows = @{}
foreach ($row in @(Get-SetupRequirements -Environment $cloneEnvironment -AccessMode 'local')) { $rows[$row.Id] = $row }
Check 'requirements: a clone with Node.js is a fix' ($rows['frontend'].Status -eq 'fix' -and $rows['frontend'].Detail -match '24\.11\.1')
# A clone an earlier run built: after `git pull` that build is the old interface, so it is built again.
$cloneEnvironment.Frontend.Built = $true
$rows = @{}
foreach ($row in @(Get-SetupRequirements -Environment $cloneEnvironment -AccessMode 'local')) { $rows[$row.Id] = $row }
Check 'requirements: a clone that has a build from an earlier run is built again' ($rows['frontend'].Status -eq 'fix')
$cloneEnvironment.Frontend.Built = $false
$cloneEnvironment.Frontend.Node.Version = '20.18.0'; $cloneEnvironment.Frontend.Node.Ok = $false
$rows = @{}
foreach ($row in @(Get-SetupRequirements -Environment $cloneEnvironment -AccessMode 'local')) { $rows[$row.Id] = $row }
Check 'requirements: too old a Node.js blocks' ($rows['frontend'].Status -eq 'error' -and $rows['frontend'].Detail -match '20\.18\.0')
$rows = @{}
foreach ($row in @(Get-SetupRequirements -Environment $cloneEnvironment -Mode 'maintain' -AccessMode 'local')) { $rows[$row.Id] = $row }
Check 'requirements: on an installation from a clone, a missing Node.js only warns (folders, access, repair do not build)' ($rows['frontend'].Status -eq 'warn')
Check 'node: the versions Vite runs on' ((Test-SetupNodeVersion '20.19.2') -and (Test-SetupNodeVersion '22.12.0') -and (Test-SetupNodeVersion '24.11.1') -and -not (Test-SetupNodeVersion '20.18.0') -and -not (Test-SetupNodeVersion '21.7.3') -and -not (Test-SetupNodeVersion '22.11.0') -and -not (Test-SetupNodeVersion '18.20.4') -and -not (Test-SetupNodeVersion ''))

$packageTree = Join-Path $Work 'tree-package'
New-Item -ItemType Directory -Path (Join-Path $packageTree 'public\assets\build') -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $packageTree 'public\assets\build\index.html'), '<html>', $ascii)
$frontendInfo = Get-SetupFrontend $packageTree
Check 'frontend: a package is built and looks for no Node.js' ($frontendInfo.Built -and -not $frontendInfo.NeedsBuild -and -not $frontendInfo.Node.Found)
$cloneTree = Join-Path $Work 'tree-clone'
New-Item -ItemType Directory -Path (Join-Path $cloneTree 'frontend\vendor\milkdrop-presets'), (Join-Path $cloneTree 'frontend\vendor\avs-presets'), (Join-Path $cloneTree 'frontend\vendor\.git'), (Join-Path $cloneTree 'docs\frontend') -Force | Out-Null
foreach ($file in @('frontend\package-lock.json', 'docs\frontend\notes.md', 'README.md')) { [System.IO.File]::WriteAllText((Join-Path $cloneTree $file), 'x', $ascii) }
$frontendInfo = Get-SetupFrontend $cloneTree
Check 'frontend: a clone is built, with the packs cloned into frontend\vendor' ($frontendInfo.NeedsBuild -and (@($frontendInfo.Packs) -join ',') -eq 'avs-presets,milkdrop-presets')
New-Item -ItemType Directory -Path (Join-Path $cloneTree 'public\assets\build') -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $cloneTree 'public\assets\build\index.html'), '<html>', $ascii)
$frontendInfo = Get-SetupFrontend $cloneTree
Check 'frontend: a clone is built again when an earlier run left a build in it' ($frontendInfo.Built -and $frontendInfo.NeedsBuild)
$listed = Get-SetupPackageFiles $cloneTree   # one array, as Remove-SetupStaleFiles takes it
Check 'copy: frontend\ stays behind, a folder of that name deeper down does not' ($listed -notcontains 'frontend\package-lock.json' -and $listed -contains 'docs\frontend\notes.md' -and $listed -contains 'README.md')

# -- 3. what each access mode means -----------------------------------------------------------------
$values = Get-SetupAccessValues @{ Mode = 'vps'; HostName = 'media.example.org'; VpsAddresses = @('203.0.113.10', '2001:db8::10') }
Check 'access values: vps' ($values.BaseUrl -eq 'https://media.example.org/' -and $values.Trusted -eq '203.0.113.10, 2001:db8::10' -and $values.RequireHttps)
$values = Get-SetupAccessValues @{ Mode = 'lan' }
Check 'access values: lan' ($null -eq $values.BaseUrl -and $null -eq $values.Trusted -and -not $values.RequireHttps)
Check 'firewall: local opens nothing' (@(Get-SetupFirewallRules @{ Mode = 'local' }).Count -eq 0)
$rules = @(Get-SetupFirewallRules @{ Mode = 'lan' })
Check 'firewall: lan is port 80 from the local subnet' ($rules.Count -eq 1 -and $rules[0].Port -eq 80 -and $rules[0].Remote[0] -eq 'LocalSubnet')
$rules = @(Get-SetupFirewallRules @{ Mode = 'vps'; VpsAddresses = @('203.0.113.10'); AllowLan = $false })
Check 'firewall: vps is port 443 from the VPS only' ($rules.Count -eq 1 -and $rules[0].Port -eq 443 -and (@($rules[0].Remote) -join ',') -eq '203.0.113.10')
$rules = @(Get-SetupFirewallRules @{ Mode = 'direct' })
Check 'firewall: direct opens 80 and 443' ($rules.Count -eq 2)
$rules = @(Get-SetupFirewallRules @{ Mode = 'lan' }) + @(Get-SetupFirewallRules @{ Mode = 'vps'; VpsAddresses = @('203.0.113.10'); AllowLan = $true })
Check 'firewall: a home-network rule holds on private networks only' (@($rules | Where-Object { $_.Remote -contains 'LocalSubnet' -and $_.Profile -ne 'Private' }).Count -eq 0 -and @($rules | Where-Object { $_.Remote -contains '203.0.113.10' -and $_.Profile -eq 'Any' }).Count -eq 1)
$lanOnPublic = @{ Access = @{ Mode = 'lan' }; Env = @{ Lan = @{ Category = 'Public' } } }
Check 'firewall: a public network is pointed out' ((Test-SetupLanRulePublic $lanOnPublic) -and -not (Test-SetupLanRulePublic @{ Access = @{ Mode = 'lan' }; Env = @{ Lan = @{ Category = 'Private' } } }))

# -- 4. a dry run of an installation in every mode ------------------------------------------------
$wampBefore = Get-TreeDigest $wampRoot
foreach ($mode in @('local', 'lan', 'direct', 'vps')) {
    $target = Join-Path $Work ('install-' + $mode)
    $state = New-TestState $mode $target
    $state.Flow = 'install'
    $run = Invoke-TestPlan $state
    $text = $run.Text
    Check "install/$mode finishes" ([bool] $run.Result.Ok) ([string] $run.Result.Error)
    Check "install/$mode writes nothing" (-not (Test-Path -LiteralPath $target) -and (Get-TreeDigest $wampRoot) -eq $wampBefore)
    foreach ($secret in @($state.Database.AppPassword, $state.Admin.Password, $state.Database.AdminPassword)) {
        Check "install/$mode keeps secrets out of the log" (-not $text.Contains($secret))
    }
    Check "install/$mode has no undescribed step" (@($script:Lines | Where-Object { $_ -match '^\S+\s+\[X\]' }).Count -eq 0)
    foreach ($needle in @('robocopy.exe', 'scripts\install.py --non-interactive', 'MEDIA_SERVER_DB_PASSWORD=********', 'CREATE DATABASE IF NOT EXISTS media_server',
            'migrate --as-user root --password-stdin', 'roots sync --disable-unconfigured --kind muzyka=music', 'account-create --username jan',
            'httpd.exe -t', 'Restart-Service -Name wampapache64', 'register-stage-task-windows.ps1', 'register-maintenance-task-windows.ps1', '-MetadataLimit 5000', 'installer.local.json')) {
        Check "install/$mode log has: $needle" ($text.Contains($needle))
    }
    $ids = @($run.Plan | ForEach-Object { $_.Id })
    switch ($mode) {
        'local' {
            Check 'install/local: no certificate, no bundle' ($ids -notcontains 'certificate' -and $ids -notcontains 'bundle' -and $ids -notcontains 'apache-modules')
            Check 'install/local: Require local only' ($text -match 'access: Require local\s*$' -or $text -match 'access: Require local\r?\n')
            Check 'install/local: firewall untouched' (-not $text.Contains('New-NetFirewallRule') -and -not $text.Contains('Disable-NetFirewallRule'))
            Check 'install/local: no public values' ($text.Contains('base_url = /; [proxy] trusted = -; [session] require_https = true'))
        }
        'lan' {
            Check 'install/lan: plain HTTP is a deliberate setting' ($text.Contains('[session] require_https = false'))
            Check 'install/lan: port 80 from the local subnet' ($text.Contains('-LocalPort 80 -RemoteAddress LocalSubnet'))
            Check 'install/lan: private ranges in Apache' ($text.Contains('Require ip 10.0.0.0/8'))
            Check 'install/lan: general rule switched off' ($text.Contains('Disable-NetFirewallRule'))
        }
        'direct' {
            Check 'install/direct: TLS modules switched on' ($ids -contains 'apache-modules' -and $text -match 'ssl_module' -and $text -match 'socache_shmcb_module')
            Check 'install/direct: self-signed certificate names the host' ($text.Contains('-subj /CN=media.example.org') -and $text.Contains('subjectAltName=DNS:media.example.org'))
            Check 'install/direct: a server certificate, not an authority' ($text -match '-config \S*tryhackx-certificate-[0-9a-f]{32}\.cnf')
            Check 'install/direct: ports 80 and 443 for everybody' ($text.Contains('-LocalPort 80 -RemoteAddress Any') -and $text.Contains('-LocalPort 443 -RemoteAddress Any'))
            Check 'install/direct: full address, no proxy' ($text.Contains('base_url = https://media.example.org/; [proxy] trusted = -'))
            Check 'install/direct: general rules left alone' (-not $text.Contains('Disable-NetFirewallRule'))
        }
        'vps' {
            Check 'install/vps: origin certificate names nobody' ($text.Contains('-subj /CN=origin ') -and -not $text.Contains('subjectAltName'))
            Check 'install/vps: a server certificate, not an authority' ($text -match '-config \S*tryhackx-certificate-[0-9a-f]{32}\.cnf')
            Check 'install/vps: 443 from the VPS only' ($text.Contains('-LocalPort 443 -RemoteAddress 203.0.113.10'))
            Check 'install/vps: home network on request' ($text.Contains('-LocalPort 443 -RemoteAddress LocalSubnet'))
            Check 'install/vps: no port 80 rule' (-not $text.Contains('-LocalPort 80 '))
            Check 'install/vps: proxy is trusted' ($text.Contains('[proxy] trusted = 203.0.113.10'))
            Check 'install/vps: Apache admits the VPS' ($text.Contains('Require ip 203.0.113.10'))
            Check 'install/vps: bundle listed' ($ids -contains 'bundle' -and $text.Contains('INSTRUKCJA-VPS.md') -and $text.Contains('origin.crt'))
            Check 'install/vps: general rule switched off' ($text.Contains('Disable-NetFirewallRule'))
        }
    }
}

# A clone of the repository: the interface is built first, and frontend\ is not copied.
$target = Join-Path $Work 'install-clone'
$state = New-TestState 'local' $target
$state.Flow = 'install'
$state.Env.Frontend = @{ Built = $false; Sources = $true; NeedsBuild = $true; Packs = @('avs-presets', 'milkdrop-presets')
    Node = @{ Found = $true; Ok = $true; Exe = 'C:\Program Files\nodejs\node.exe'; Npm = 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js'; Version = '24.11.1' } }
$run = Invoke-TestPlan $state
$text = $run.Text
$ids = @($run.Plan | ForEach-Object { $_.Id })
Check 'install/clone finishes' ([bool] $run.Result.Ok) ([string] $run.Result.Error)
Check 'install/clone writes nothing' (-not (Test-Path -LiteralPath $target))
Check 'install/clone: the interface is built first' ($ids[0] -eq 'frontend' -and $ids[1] -eq 'copy')
Check 'install/clone: npm ci, then the build' ($text.Contains('npm-cli.js" ci --no-audit --no-fund') -and $text.Contains('npm-cli.js" run build') -and $text.IndexOf(' ci --no-audit') -lt $text.IndexOf(' run build'))
Check 'install/clone: the packs are named' ($text.Contains('avs-presets, milkdrop-presets'))
$copyLine = @($script:Lines | Where-Object { $_ -match 'robocopy\.exe' } | Select-Object -First 1)
Check 'install/clone: frontend\ is left out of the copy' ($copyLine.Count -eq 1 -and $copyLine[0].Contains((Join-Path $Repo 'frontend')))
$state.Flow = 'update'
$state.Options.BackupDatabase = $false
$ids = @(Get-SetupPlan $state | ForEach-Object { $_.Id })
Check 'update/clone: built before the service stops' ($ids[0] -eq 'frontend' -and $ids[1] -eq 'stop')

# -- 5. an existing, wizard-made installation: change, repair, remove ------------------------------
$installed = Join-Path $Work 'installed'
New-Item -ItemType Directory -Path (Join-Path $installed 'config'), (Join-Path $installed 'scripts') -Force | Out-Null
$config = Join-Path $installed 'config\config.local.toml'
$key = [Convert]::ToBase64String((New-Object byte[] 32)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
[System.IO.File]::WriteAllText($config, (@(
            '[server]', 'port = 8765', '', '[security]', "transfer_key = `"$key`"", '', '[database]', 'host = "127.0.0.1"', 'port = 3306',
            'name = "media_server"', 'user = "media_server"', 'password = "config-file-password-value"', '',
            '[mail]', 'host = "smtp.example.org"', '', '[roots.muzyka]', ('path = "' + $mediaA.Replace('\', '\\') + '"')
        ) -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false))
foreach ($name in @('stop-stage-windows.ps1', 'start-stage-windows.ps1')) { [System.IO.File]::WriteAllText((Join-Path $installed "scripts\$name"), "exit 0`r`n", $ascii) }
$state = New-TestState 'vps' $installed
# Let the helper write the wizard's two Apache artefacts into the imitation tree, as an installation would have.
$alias = Join-Path $wampRoot 'alias\tryhackx-media-server.conf'
$null = Invoke-SetupHelper -Python $Python -Command 'apache-render' -Request @{
    template = (Get-SetupPaths $state).Template; output = $alias
    conf = @{ root = $installed; mode = 'vps'; vps_addresses = @('203.0.113.10'); certificate_file = 'C:\x\cert.pem'; certificate_key_file = 'C:\x\key.pem'; add_listen_443 = $true }
}
$vhosts = Join-Path $apacheDir 'conf\extra\httpd-vhosts.conf'
$original = [System.IO.File]::ReadAllBytes($vhosts)
$edited = Join-Path $Work 'edited-vhosts.conf'
$answer = Invoke-SetupHelper -Python $Python -Command 'apache-vhosts-set' -Request @{ path = $vhosts; document_root = (Join-Path $installed 'public\assets\build'); output = $edited }
Check 'helper: document root changed through an output file' ([bool] $answer.changed -and (Test-Path -LiteralPath $edited))
Copy-Item -LiteralPath $edited -Destination $vhosts -Force
$state.Env.Existing = @{ Found = $true; Root = $installed; SameTree = $true; Config = $config; HasVenv = $false; Port = 8765
    Aliases = @(@{ File = $alias; Root = $installed; Managed = $true }); Alias = @{ File = $alias; Root = $installed; Managed = $true }
    ServiceTask = @{ Exists = $true; Name = $script:SetupNames.ServiceTask }; MaintenanceTask = @{ Exists = $true; Name = $script:SetupNames.MaintenanceTask } }
$state.SavedState = @{ access = @{ mode = 'vps' }; firewall = @{ disabled_rules = @('{RULE-THE-WIZARD-SWITCHED-OFF}') }; services_autostart = @('wampapache64') }
$state.Mode = 'maintain'
$state.ExistingRoots = @(@{ id = 'muzyka'; path = $mediaA })
$state.Env.Wamp.Apache.Modules = @($state.Env.Wamp.Apache.Modules + @('ssl_module', 'socache_shmcb_module'))
$state.Env.Firewall.Ours = @(@{ Name = 'TryHackX-Media-HTTPS-VPS'; DisplayName = 'TryHackX Media Server - HTTPS from the VPS only'; Enabled = $true })
# What an earlier version left: its list of files, one file the new version dropped, one kept, one
# somebody added by hand, and a copy of the configuration the folders flow made.
New-Item -ItemType Directory -Path (Join-Path $installed 'runtime'), (Join-Path $installed 'src\media_server') -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $installed 'runtime\installer-files.txt'), "src\media_server\cli.py`r`nsrc\media_server\gone_module.py`r`n..\outside-the-tree.txt`r`n", $ascii)
[System.IO.File]::WriteAllText((Join-Path $installed 'src\media_server\gone_module.py'), "# dropped`n", $ascii)
[System.IO.File]::WriteAllText((Join-Path $installed 'src\media_server\cli.py'), "# kept`n", $ascii)
[System.IO.File]::WriteAllText((Join-Path $installed 'my-own-notes.txt'), "mine`n", $ascii)
[System.IO.File]::WriteAllText((Join-Path $Work 'outside-the-tree.txt'), "not ours`n", $ascii)
[System.IO.File]::WriteAllText((Join-Path $installed 'config\config.backup-20260101-000000.local.toml'), "[database]`npassword = `"old-copy`"`n", $ascii)
$installedBefore = Get-TreeDigest $installed
$wampBefore = Get-TreeDigest $wampRoot

$summary = (Invoke-SetupHelper -Python $Python -Command 'config-summary' -Request @{ config = $config }).summary
Check 'summary: no secret leaves the helper' (-not ((ConvertTo-Json $summary -Depth 6) -match 'config-file-password-value|transfer_key'))
Check 'summary: database and folders' ($summary.database.name -eq 'media_server' -and @($summary.roots).Count -eq 1 -and $summary.mail_configured)

$state.Flow = 'folders'
$mediaC = Join-Path $Work 'media\Filmy'; New-Item -ItemType Directory -Path $mediaC -Force | Out-Null
$state.Roots = @(@{ Id = 'muzyka'; Path = $mediaA; Kind = 'music' }, @{ Id = ''; Path = $mediaC; Kind = 'movies' })
Set-SetupRootIds $state
Check 'folders: a known folder keeps its identifier, a new one gets a readable one' ((@($state.Roots | ForEach-Object { $_.Id }) -join ',') -eq 'muzyka,filmy')
$run = Invoke-TestPlan $state
Check 'folders: finishes' ([bool] $run.Result.Ok) ([string] $run.Result.Error)
Check 'folders: says what changes, and only that' ($run.Text.Contains('[roots.filmy]') -and -not $run.Text.Contains('[roots.muzyka]') -and -not $run.Text.Contains('config-file-password-value'))
Check 'folders: the service is restarted' ($run.Text.Contains('stop-stage-windows.ps1') -and $run.Text.Contains('start-stage-windows.ps1'))

$state.Flow = 'access'
Set-SetupSampleAccess $state 'lan'
$run = Invoke-TestPlan $state
Check 'access vps->lan: finishes' ([bool] $run.Result.Ok) ([string] $run.Result.Error)
Check 'access vps->lan: configuration follows' ($run.Text.Contains('[session] require_https = false'))
Check 'access vps->lan: old rules go, the new one comes' ($run.Text.Contains("Remove-NetFirewallRule -Group 'TryHackX Media Server'") -and $run.Text.Contains('-LocalPort 80 -RemoteAddress LocalSubnet'))

$state.Flow = 'access'
Set-SetupSampleAccess $state 'local'
$run = Invoke-TestPlan $state
Check 'access ->local: rules the wizard switched off come back' ($run.Text.Contains("Enable-NetFirewallRule -Name '{RULE-THE-WIZARD-SWITCHED-OFF}'"))

$state.Flow = 'uninstall'
Set-SetupSampleAccess $state 'vps'
$state.InPlace = $true
$state.Uninstall = @{ DropDatabase = $true; RemoveData = $true; RemoveConfig = $false; ConfirmText = 'media_server' }
$run = Invoke-TestPlan $state
$text = $run.Text
Check 'uninstall: finishes' ([bool] $run.Result.Ok) ([string] $run.Result.Error)
Check 'uninstall: tasks' ($text.Contains('unregister-stage-task-windows.ps1') -and $text.Contains('unregister-maintenance-task-windows.ps1'))
Check 'uninstall: alias file and document root' ($text.Contains('tryhackx-media-server.conf') -and $text -match 'httpd-vhosts\.conf: restoring the previous DocumentRoot')
Check 'uninstall: firewall and services go back' ($text.Contains("Enable-NetFirewallRule -Name '{RULE-THE-WIZARD-SWITCHED-OFF}'") -and $text.Contains('Set-Service -Name wampapache64 -StartupType Manual'))
Check 'uninstall: database only with its name typed' ($text.Contains('DROP DATABASE media_server; DROP USER media_server@localhost'))
Check 'uninstall: media folders are never named for deletion' (-not ($text -match 'Remove-Item[^\n]*media\\'))
$state.Uninstall.ConfirmText = 'wrong'
$run = Invoke-TestPlan $state
Check 'uninstall: a wrong name stops before the database' (-not [bool] $run.Result.Ok -and $run.Result.FailedStep -eq 'drop-database')
$state.Uninstall = @{ DropDatabase = $false; RemoveData = $true; RemoveConfig = $true; ConfirmText = '' }
$run = Invoke-TestPlan $state
Check 'uninstall with the configuration: its copies go too' ([bool] $run.Result.Ok -and $run.Text.Contains('config.backup-20260101-000000.local.toml') -and $run.Text.Contains('config.local.toml'))

$state.Flow = 'repair'
$run = Invoke-TestPlan $state
$text = $run.Text
Check 'repair: finishes' ([bool] $run.Result.Ok) ([string] $run.Result.Error)
Check 'repair: private files closed again' ($text -match 'config\.local\.toml /inheritance:r /grant:r' -and $text -match 'config\.backup-20260101-000000\.local\.toml /inheritance:r')
Check 'repair: services start with Windows again' (@($run.Plan | Where-Object { $_.Id -eq 'services' }).Count -eq 1)
Check 'repair: the folder is not hardened when the installation never was' (@($run.Plan | Where-Object { $_.Id -eq 'harden' }).Count -eq 0)

$state.Flow = 'update'
$state.InPlace = $false
$state.SourceRoot = $Repo
$state.Options.BackupDatabase = $true
$run = Invoke-TestPlan $state
$text = $run.Text
Check 'update: finishes' ([bool] $run.Result.Ok) ([string] $run.Result.Error)
Check 'update: the database is copied before it is migrated' ($text.Contains('mysqldump --single-transaction') -and $text.IndexOf('mysqldump') -lt $text.IndexOf('migrate --as-user') -and $text.Contains('backups\database'))
Check 'update: a file the new version dropped goes, by the list' ($text.Contains('gone_module.py'))
Check 'update: nothing off the list and nothing outside the tree' (-not $text.Contains('my-own-notes.txt') -and -not $text.Contains('outside-the-tree.txt') -and -not ($text -match 'not have: \S*cli\.py'))
Check 'update: Apache file, tasks and record laid out again' ($text.Contains('httpd.exe -t') -and $text.Contains('register-stage-task-windows.ps1') -and $text.Contains('installer.local.json'))
$state.Options.BackupDatabase = $false
Check 'update: the copy can be declined' (@(Get-SetupPlan $state | Where-Object { $_.Id -eq 'db-backup' }).Count -eq 0)
$state.InPlace = $true

Check 'maintenance dry runs write nothing' ((Get-TreeDigest $installed) -eq $installedBefore -and (Get-TreeDigest $wampRoot) -eq $wampBefore)

# The document root can be put back byte for byte.
$restored = Join-Path $Work 'restored-vhosts.conf'
$answer = Invoke-SetupHelper -Python $Python -Command 'apache-vhosts-restore' -Request @{ path = $vhosts; output = $restored }
Check 'helper: document root restored byte for byte' ([bool] $answer.restored_document_root -and [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($restored)) -eq [Convert]::ToBase64String($original))

Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
Write-Output ("checks: {0}, failed: {1}" -f $script:Checks, $script:Failures.Count)
exit $script:Failures.Count
