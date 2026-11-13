<#
    The answers. One hashtable holds everything the wizard has learned and been
    told; pages write into it, the plan is built from it, and an unattended dry
    run fills it from a JSON file instead of from a window.

    Keep this file pure ASCII; translated text lives in installer\lang\*.psd1.
#>

function New-SetupState {
    param([string] $SourceRoot, [hashtable] $Environment)
    $state = @{
        Mode = 'install'; Flow = 'install'
        Version = Get-SetupVersion $SourceRoot
        SourceRoot = [System.IO.Path]::GetFullPath($SourceRoot).TrimEnd('\')
        TargetRoot = (Join-Path $env:SystemDrive '\TryHackX\MediaServer')
        InPlace = $false
        Env = $Environment
        ServicePort = 8765
        FfmpegPath = ''
        Database = @{ Engine = ''; Label = ''; Client = ''; Host = '127.0.0.1'; Port = 3306; Service = ''; AdminUser = 'root'; AdminPassword = ''
            Name = 'media_server'; User = 'media_server'; AppPassword = $null; Tested = $false; Test = $null }
        Roots = @()
        ExistingRoots = @()
        Access = @{ Mode = 'local'; HostName = ''; VpsAddresses = @(); HomeAddress = ''; AllowLan = $false; CertificateFile = ''; KeyFile = ''
            SelfSigned = $false; Regenerate = $false; DisableExistingHttps = $false }
        Admin = @{ Username = ''; Email = ''; Password = '' }
        Options = @{ HardenFolder = $true; AutoStartServices = $true; StartScan = $true; DisableGenericRules = $true; BackupDatabase = $true }
        Names = @{ ServiceTask = $script:SetupNames.ServiceTask; MaintenanceTask = $script:SetupNames.MaintenanceTask }
        Uninstall = @{ DropDatabase = $false; RemoveData = $false; RemoveConfig = $false; ConfirmText = '' }
        Results = @{}
        SavedState = $null
        Plan = @()
    }
    if ($Environment) { Set-SetupEnvironment $state $Environment }
    return $state
}

function Set-SetupEnvironment {
    <# Takes a fresh look at the machine into the state without losing what the user has already typed. #>
    param([hashtable] $State, [hashtable] $Environment)
    $State.Env = $Environment
    if ($Environment.Ports -and $Environment.Ports.ServiceSuggested -gt 0) { $State.ServicePort = [int] $Environment.Ports.ServiceSuggested }
    if ($Environment.Ffmpeg -and $Environment.Ffmpeg.Found) { $State.FfmpegPath = [string] $Environment.Ffmpeg.Path }
    $database = $State.Database
    $chosen = $null
    if ($database.Engine) { $chosen = @($Environment.Wamp.Databases | Where-Object { $_.Engine -eq $database.Engine }) | Select-Object -First 1 }
    if (-not $chosen) { $chosen = $Environment.Database }
    if ($chosen) { Set-SetupDatabaseServer $State $chosen }
}

function Set-SetupDatabaseServer {
    param([hashtable] $State, [hashtable] $Server)
    $database = $State.Database
    if ($database.Engine -ne $Server.Engine -or $database.Port -ne $Server.Port) { $database.Tested = $false; $database.Test = $null }
    $database.Engine = [string] $Server.Engine
    $database.Label = [string] $Server.Label
    $database.Client = [string] $Server.Client
    $database.Port = [int] $Server.Port
    $database.Service = [string] $Server.Service.Name
}

function Get-SetupAccessLabel {
    param([string] $Mode)
    return (T ('access.mode.' + $Mode + '.name'))
}

function Get-SetupInferredAccess {
    <# For an installation set up by hand: what its configuration says about how it is reached. #>
    param($Summary)
    $access = @{ Mode = 'local'; HostName = ''; VpsAddresses = @(); HomeAddress = ''; AllowLan = $false; CertificateFile = ''; KeyFile = ''
        SelfSigned = $false; Regenerate = $false; DisableExistingHttps = $false; Inferred = $true }
    if (-not $Summary) { return $access }
    $base = [string] $Summary.base_url
    if ($base -match '^https?://([^/:]+)') { $access.HostName = $Matches[1] }
    if ($Summary.proxy_trusted) {
        $access.Mode = 'vps'
        $access.VpsAddresses = @(([string] $Summary.proxy_trusted) -split '[\s,]+' | Where-Object { $_ })
    } elseif ($Summary.require_https -eq $false) { $access.Mode = 'lan' }
    elseif ($base -match '^https://') { $access.Mode = 'direct' }
    return $access
}

function Initialize-SetupMaintainState {
    <# Fills the state from an installation that is already there. Reads only. #>
    param([hashtable] $State)
    $existing = $State.Env.Existing
    $State.Mode = 'maintain'
    $State.TargetRoot = $existing.Root
    $State.InPlace = [bool] $existing.SameTree
    $State.ServicePort = [int] $existing.Port
    $State.SavedState = $existing.State
    $State.Summary = $null
    $State.SummaryError = ''
    $saved = $existing.State
    if ($saved -and $saved.tasks) {
        if ($saved.tasks.service) { $State.Names.ServiceTask = [string] $saved.tasks.service }
        if ($saved.tasks.maintenance) { $State.Names.MaintenanceTask = [string] $saved.tasks.maintenance }
    }
    # The slow part (two processes, one of them asking the database) was read during detection,
    # off the window's thread; only a caller that skipped detection reads it here.
    $details = $existing.Details
    if (-not $details) { $details = Get-SetupInstalledDetails $State.Env }
    $State.Summary = $details.Summary
    $State.SummaryError = [string] $details.SummaryError
    $summary = $State.Summary
    if ($summary) {
        $database = $State.Database
        $database.Host = [string] $summary.database.host
        $database.Port = [int] $summary.database.port
        $database.Name = [string] $summary.database.name
        $database.User = [string] $summary.database.user
        $server = @($State.Env.Wamp.Databases | Where-Object { $_.Port -eq $database.Port }) | Select-Object -First 1
        if ($server) { Set-SetupDatabaseServer $State $server; $database.Port = [int] $summary.database.port }
        if ($summary.ffmpeg_path -and -not $State.FfmpegPath) { $State.FfmpegPath = [string] $summary.ffmpeg_path }
    }
    # Folders: paths from the configuration, kinds from the catalogue (when the database answered).
    $kinds = if ($details.Kinds) { $details.Kinds } else { @{} }
    $roots = @()
    if ($summary) {
        foreach ($root in @($summary.roots)) {
            $id = [string] $root.id
            $kind = $kinds[$id]
            if (-not $kind) { $kind = Get-SetupGuessedKind ([string] $root.path) $id }
            $roots += @{ Id = $id; Path = ([string] $root.path).Replace('/', '\'); Kind = $kind; Known = [bool] $kinds[$id] }
        }
    }
    $State.Roots = @($roots)
    $State.ExistingRoots = @($roots | ForEach-Object { @{ id = $_.Id; path = $_.Path } })
    # Access: what the wizard wrote last time, else what the configuration implies.
    if ($saved -and $saved.access -and $saved.access.mode) {
        $access = $saved.access
        $State.Access = @{ Mode = [string] $access.mode; HostName = [string] $access.host_name; VpsAddresses = @($access.vps_addresses | Where-Object { $_ })
            HomeAddress = [string] $access.home_address; AllowLan = [bool] $access.allow_lan; CertificateFile = [string] $access.certificate_file
            KeyFile = [string] $access.key_file; SelfSigned = [bool] $access.self_signed; Regenerate = $false; DisableExistingHttps = $false; Inferred = $false }
    } else {
        $State.Access = Get-SetupInferredAccess $summary
    }
    $State.Options.HardenFolder = $false
    $State.Options.StartScan = $true
}

function Get-SetupGuessedKind {
    <# A first guess from a folder's name; the user confirms it on the page. #>
    param([string] $Path, [string] $Id = '')
    $name = ([System.IO.Path]::GetFileName($Path.TrimEnd('\')) + ' ' + $Id).ToLowerInvariant()
    if ($name -match 'muzy|music|audio|mp3|flac|album') { return 'music' }
    if ($name -match 'film|movie|video|wideo|serial|series|kino') { return 'movies' }
    return 'mixed'
}

function Set-SetupRootIds {
    <# Asks the helper for identifiers: readable ones for new folders, the existing one for a folder already known. #>
    param([hashtable] $State)
    $folders = @($State.Roots | ForEach-Object { $entry = @{ path = [string] $_.Path; kind = [string] $_.Kind }; if ($_.Id) { $entry.id = [string] $_.Id }; $entry })
    # Identifiers of libraries removed in earlier runs are still in the catalogue: never reused.
    $reserved = @()
    if ($State.Env -and $State.Env.Existing -and $State.Env.Existing.Details -and $State.Env.Existing.Details.CatalogIds) {
        $reserved = @($State.Env.Existing.Details.CatalogIds)
    }
    $answer = Invoke-SetupHelper -Python (Get-SetupHelperPython $State) -Command 'assign-ids' -Request @{ folders = $folders; existing = @($State.ExistingRoots); reserved = $reserved }
    $State.Roots = @($answer.roots | ForEach-Object { @{ Id = [string] $_.id; Path = [string] $_.path; Kind = [string] $_.kind } })
}

function Get-SetupAddresses {
    <# Where the application answers once the plan has run: for the last page and for the status page. #>
    param([hashtable] $State)
    $access = $State.Access
    $lan = [string] $State.Env.Lan.Address
    $addresses = @(@{ Label = (T 'finish.address.local'); Url = 'http://localhost/' })
    switch ($access.Mode) {
        'lan'    { if ($lan) { $addresses += @{ Label = (T 'finish.address.lan'); Url = "http://$lan/" } } }
        'direct' { $addresses += @{ Label = (T 'finish.address.public'); Url = "https://$($access.HostName)/" } }
        'vps'    {
            $addresses += @{ Label = (T 'finish.address.public'); Url = "https://$($access.HostName)/" }
            if ($access.AllowLan -and $lan) { $addresses += @{ Label = (T 'finish.address.lanSecure'); Url = "https://$lan/" } }
        }
    }
    return @($addresses)
}

function Test-SetupAccess {
    <# The access page's answers, checked the way the generators will check them. Returns sentences. #>
    param([hashtable] $State, [hashtable] $Access)
    $problems = @()
    if ($Access.Mode -eq 'local' -or $Access.Mode -eq 'lan') { return @() }
    if (-not $Access.HostName) { return @((T 'access.error.host')) }
    $request = @{ host_name = [string] $Access.HostName }
    if ($Access.Mode -eq 'vps') {
        if (@($Access.VpsAddresses).Count -eq 0) { return @((T 'access.error.vps')) }
        if (-not $Access.HomeAddress) { return @((T 'access.error.home')) }
        $request.vps_addresses = @($Access.VpsAddresses)
        $request.home_address = [string] $Access.HomeAddress
    }
    try {
        $answer = Invoke-SetupHelper -Python (Get-SetupHelperPython $State) -Command 'validate-access' -Request $request
        $Access.HostName = [string] $answer.host_name
        if ($Access.Mode -eq 'vps') {
            $Access.VpsAddresses = @($answer.vps_addresses)
            if ($answer.home_kind -ne 'name' -and (@($answer.vps_addresses) -contains ([string] $answer.home_target).Trim('[', ']'))) { $problems += (T 'access.error.same') }
        }
    } catch { return @([string] $_.Exception.Message) }
    if ($Access.Mode -eq 'direct' -and -not $Access.SelfSigned) {
        foreach ($pair in @(@($Access.CertificateFile, 'access.error.certificate'), @($Access.KeyFile, 'access.error.key'))) {
            if (-not $pair[0] -or -not (Test-Path -LiteralPath $pair[0] -PathType Leaf)) { $problems += (T $pair[1]) }
        }
        if ($problems.Count -eq 0) {
            try {
                $certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 ([string] $Access.CertificateFile)
                if ($certificate.NotAfter -lt (Get-Date)) { $problems += (T 'access.error.expired' $certificate.NotAfter.ToString('yyyy-MM-dd')) }
            } catch { $problems += (T 'access.error.notCertificate') }
        }
    }
    $apache = $State.Env.Wamp.Apache
    if ($apache -and @($apache.HttpsHosts).Count -gt 0 -and -not $Access.DisableExistingHttps) {
        $problems += (T 'access.error.existingHttps' (@($apache.HttpsHosts) -join ', '))
    }
    $https = if ($State.Env.Ports) { $State.Env.Ports.Https } else { $null }
    if ($https -and -not (Test-SetupOwnedByApache $https $State.Env)) {
        $problems += (T 'access.error.port443' $https.Process)
    }
    return @($problems)
}

function Import-SetupAnswers {
    <#
        An unattended dry run: the answers come from a JSON file instead of the pages.
        Only ever used together with -DryRun; a password in a file is not how a real
        installation should be given one.
    #>
    param([hashtable] $State, [string] $Path)
    $answers = ConvertTo-SetupHashtable (ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)))
    if ($answers.flow) { $State.Flow = [string] $answers.flow }
    # Paths may be written with forward slashes: in JSON a backslash has to be doubled.
    if ($answers.target) { $State.TargetRoot = ([string] $answers.target).Replace('/', '\') }
    if ($null -ne $answers.in_place) { $State.InPlace = [bool] $answers.in_place }
    if ($State.InPlace) { $State.TargetRoot = $State.SourceRoot }
    if ($answers.database) {
        foreach ($pair in @(@('name', 'Name'), @('user', 'User'), @('admin_user', 'AdminUser'))) {
            if ($answers.database[$pair[0]]) { $State.Database[$pair[1]] = [string] $answers.database[$pair[0]] }
        }
        if ($answers.database.engine) {
            $server = @($State.Env.Wamp.Databases | Where-Object { $_.Engine -eq $answers.database.engine }) | Select-Object -First 1
            if ($server) { Set-SetupDatabaseServer $State $server }
        }
    }
    if ($answers.folders) { $State.Roots = @($answers.folders | ForEach-Object { @{ Id = [string] $_.id; Path = ([string] $_.path).Replace('/', '\'); Kind = [string] $_.kind } }) }
    if ($answers.access) {
        $access = $answers.access
        $State.Access.Mode = [string] $access.mode
        foreach ($pair in @(@('host_name', 'HostName'), @('home_address', 'HomeAddress'), @('certificate_file', 'CertificateFile'), @('key_file', 'KeyFile'))) {
            if ($access[$pair[0]]) { $State.Access[$pair[1]] = [string] $access[$pair[0]] }
        }
        foreach ($key in @('CertificateFile', 'KeyFile')) {
            if ($State.Access[$key]) { $State.Access[$key] = ([string] $State.Access[$key]).Replace('/', '\') }
        }
        if ($access.vps_addresses) { $State.Access.VpsAddresses = @($access.vps_addresses) }
        foreach ($pair in @(@('allow_lan', 'AllowLan'), @('self_signed', 'SelfSigned'), @('disable_existing_https', 'DisableExistingHttps'))) {
            if ($null -ne $access[$pair[0]]) { $State.Access[$pair[1]] = [bool] $access[$pair[0]] }
        }
    }
    if ($answers.admin) {
        $State.Admin.Username = [string] $answers.admin.username
        $State.Admin.Email = [string] $answers.admin.email
    }
    if ($answers.options) {
        foreach ($pair in @(@('harden_folder', 'HardenFolder'), @('autostart_services', 'AutoStartServices'), @('start_scan', 'StartScan'), @('disable_generic_rules', 'DisableGenericRules'), @('backup_database', 'BackupDatabase'))) {
            if ($null -ne $answers.options[$pair[0]]) { $State.Options[$pair[1]] = [bool] $answers.options[$pair[0]] }
        }
    }
    if ($answers.uninstall) {
        foreach ($pair in @(@('drop_database', 'DropDatabase'), @('remove_data', 'RemoveData'), @('remove_config', 'RemoveConfig'))) {
            if ($null -ne $answers.uninstall[$pair[0]]) { $State.Uninstall[$pair[1]] = [bool] $answers.uninstall[$pair[0]] }
        }
        if ($State.Uninstall.DropDatabase) { $State.Uninstall.ConfirmText = [string] $State.Database.Name }
    }
    return $answers
}
