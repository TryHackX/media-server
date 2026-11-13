<#
    The pages shown when an installation is already there: what state it is in,
    and the few things that can be changed without installing again.

    Keep this file pure ASCII; translated text lives in installer\lang\*.psd1.
#>

function New-UiTile {
    <# A large clickable card: an icon, a title, one line of explanation. Tag carries the flow it starts. #>
    param([int] $Glyph, [string] $Title, [string] $Text, [int] $Width, [int] $Height, [string] $Flow, [bool] $Enabled = $true)
    if ($Enabled) {
        # A tile is a button: Tab reaches it, Enter or Space starts it, a screen reader names it.
        $tile = New-Object TryHackX.Setup.TileSurface
        $tile.Fill = Get-UiColor 'Window'
        $tile.RestStroke = Get-UiColor 'Border'
        $tile.Stroke = $tile.RestStroke
        $tile.FocusStroke = Get-UiColor 'Accent'
        $tile.Radius = S 8
        $tile.BackColor = Get-UiColor 'Window'
        $tile.Size = New-UiSize $Width $Height
        $tile.AccessibleName = $Title
        $tile.AccessibleDescription = $Text
    } else {
        $tile = New-UiCard -Width $Width -Height $Height -Fill 'Surface'
    }
    $fill = $tile.Fill
    $icon = New-Object System.Windows.Forms.Label
    $icon.Font = $script:Ui.Fonts.IconLarge
    $icon.ForeColor = if ($Enabled) { Get-UiColor 'Accent' } else { Get-UiColor 'Disabled' }
    $icon.BackColor = $fill
    $icon.Text = Get-UiGlyph $Glyph
    $icon.AutoSize = $true
    $icon.Location = New-UiPoint (S 14) (S 14)
    $tile.Controls.Add($icon)
    $titleLabel = New-UiLabel -Text $Title -Width ($Width - (S 62)) -Font 'Strong' -Color $(if ($Enabled) { 'Text' } else { 'Muted' }) -BackColor $fill
    $titleLabel.Location = New-UiPoint (S 50) (S 11)
    $tile.Controls.Add($titleLabel)
    $body = New-UiLabel -Text $Text -Width ($Width - (S 62)) -Font 'Small' -Color 'Muted' -BackColor $fill
    $body.Location = New-UiPoint (S 50) ($titleLabel.Bottom + (S 1))
    $tile.Controls.Add($body)
    if ($Enabled) {
        foreach ($control in @($tile, $icon, $titleLabel, $body)) {
            $control.Tag = $Flow
            $control.Cursor = [System.Windows.Forms.Cursors]::Hand
            $control.Add_Click({ Start-MaintainFlow ([string] $this.Tag) })
        }
        foreach ($control in @($icon, $titleLabel, $body)) {
            $control.Add_MouseLeave({ $this.Parent.ChildMouseLeft() })
        }
    } else {
        $tile.AccessibleName = $Title
        $tile.AccessibleDescription = $Text
    }
    return $tile
}

function Get-MaintainStatusRows {
    <# The status page as data: @{ Status; Title; Detail }. #>
    param([hashtable] $State)
    $existing = $State.Env.Existing
    $rows = @()
    $health = $existing.Health
    if ($health.Ready) { $rows += @{ Status = 'ok'; Title = (T 'status.service'); Detail = (T 'status.service.ready' $existing.Port) } }
    elseif ($health.Running) { $rows += @{ Status = 'warn'; Title = (T 'status.service'); Detail = (T 'status.service.notReady' $existing.Port) } }
    else { $rows += @{ Status = 'error'; Title = (T 'status.service'); Detail = (T 'status.service.down' $existing.Port) } }

    $tasks = @($existing.ServiceTask, $existing.MaintenanceTask)
    $missing = @($tasks | Where-Object { -not $_.Exists })
    $elsewhere = @($tasks | Where-Object { $_.Exists -and $_.Root -and ([System.IO.Path]::GetFullPath($_.Root).TrimEnd('\') -ine $existing.Root) })
    if ($missing.Count -gt 0) { $rows += @{ Status = 'warn'; Title = (T 'status.tasks'); Detail = (T 'status.tasks.missing' (@($missing | ForEach-Object { $_.Name }) -join ', ')) } }
    elseif ($elsewhere.Count -gt 0) { $rows += @{ Status = 'warn'; Title = (T 'status.tasks'); Detail = (T 'status.tasks.elsewhere' $elsewhere[0].Root) } }
    else { $rows += @{ Status = 'ok'; Title = (T 'status.tasks'); Detail = (T 'status.tasks.ok' (T ('task.' + $existing.ServiceTask.State)) (T ('task.' + $existing.MaintenanceTask.State))) } }

    $apache = $State.Env.Wamp.Apache
    if (-not $existing.Alias) { $rows += @{ Status = 'error'; Title = (T 'status.apache'); Detail = (T 'status.apache.noAlias') } }
    elseif (-not $apache.Service.Running) { $rows += @{ Status = 'error'; Title = (T 'status.apache'); Detail = (T 'status.apache.stopped' $apache.Service.Name) } }
    elseif ($existing.Alias.Managed) { $rows += @{ Status = 'ok'; Title = (T 'status.apache'); Detail = (T 'status.apache.managed' ([System.IO.Path]::GetFileName($existing.Alias.File)) $apache.Version) } }
    else { $rows += @{ Status = 'info'; Title = (T 'status.apache'); Detail = (T 'status.apache.manual' ([System.IO.Path]::GetFileName($existing.Alias.File)) $apache.Version) } }

    $access = $State.Access
    $where = Get-SetupAccessLabel $access.Mode
    if ($access.HostName) { $where += "  -  https://$($access.HostName)/" }
    if ($access.Inferred) { $where += '  ' + (T 'status.access.inferred') }
    $rows += @{ Status = 'ok'; Title = (T 'status.access'); Detail = $where }

    # VPS and home-network modes promise that only those addresses get in: a catch-all rule
    # Windows made for httpd.exe breaks that promise silently (audit P2-6).
    $generic = @($State.Env.Firewall.Generic | Where-Object { $_ -and $_.Enabled })
    if (@('vps', 'lan') -contains [string] $access.Mode -and $generic.Count -gt 0) {
        $names = (@($generic | ForEach-Object { '{0} ({1})' -f $_.DisplayName, $_.Profile } | Select-Object -Unique) -join ', ')
        $rows += @{ Status = 'warn'; Title = (T 'status.firewall'); Detail = (T 'status.firewall.generic' $names) }
    }

    # The private configuration readable by every account on the machine (audit P2-10).
    $open = @($existing.OpenSecrets | Where-Object { $_ })
    if ($open.Count -gt 0) {
        $shown = (@($open | Select-Object -First 2 | ForEach-Object { [System.IO.Path]::GetFileName($_) }) -join ', ') + $(if ($open.Count -gt 2) { ', ...' } else { '' })
        $rows += @{ Status = 'warn'; Title = (T 'status.privacy'); Detail = (T 'status.privacy.open' $shown) }
    }

    # A .venv whose Python is gone: everything but update and repair needs it (audit P2-3).
    if ($existing.HasVenv -and -not $existing.VenvWorks) { $rows += @{ Status = 'error'; Title = (T 'status.python'); Detail = (T 'status.python.broken') } }
    elseif (-not $existing.HasVenv) { $rows += @{ Status = 'error'; Title = (T 'status.python'); Detail = (T 'status.python.missing') } }

    $package = [string] $State.Version
    if ($existing.SameTree) { $rows += @{ Status = 'ok'; Title = (T 'status.version'); Detail = (T 'status.version.same' $existing.Version $existing.Root) } }
    elseif ((Compare-SetupVersion $package $existing.Version) -gt 0) { $rows += @{ Status = 'info'; Title = (T 'status.version'); Detail = (T 'status.version.newer' $existing.Version $package) } }
    else { $rows += @{ Status = 'ok'; Title = (T 'status.version'); Detail = (T 'status.version.other' $existing.Version $existing.Root $package) } }

    $roots = @($State.Roots)
    # A preview has no disks to look at: its sample says which folder is "gone".
    $gone = @($roots | Where-Object { if ($State.Preview) { [bool] $_.Gone } else { -not (Test-Path -LiteralPath $_.Path -PathType Container) } })
    $unknown = @($roots | Where-Object { -not $_.Known })
    $listed = (@($roots | Select-Object -First 3 | ForEach-Object { $_.Path }) -join ', ') + $(if ($roots.Count -gt 3) { ', ...' } else { '' })
    if ($State.SummaryError) { $rows += @{ Status = 'error'; Title = (T 'status.folders'); Detail = (T 'status.folders.unreadable' $State.SummaryError) } }
    elseif ($gone.Count -gt 0) { $rows += @{ Status = 'warn'; Title = (T 'status.folders'); Detail = (T 'status.folders.gone' $gone[0].Path) } }
    elseif ($unknown.Count -gt 0) { $rows += @{ Status = 'warn'; Title = (T 'status.folders'); Detail = (T 'status.folders.unknown' $roots.Count $listed) } }
    else { $rows += @{ Status = 'ok'; Title = (T 'status.folders'); Detail = (T 'status.folders.ok' $roots.Count $listed) } }
    return @($rows)
}

function Build-PageStatus {
    param($State, $Content, $Page)
    $width = $Content.ClientSize.Width
    $Page.HideNext = $true; $Page.HideBack = $true; $Page.ConfirmClose = $false
    $Page.CancelText = T 'button.close'
    $y = 0
    # The reminder goes beside the Close button: the page itself needs all its height.
    if ($script:SetupContext.DryRun) { Set-SetupMessage (T 'status.dryRun') 'info' }
    $statusRows = @(Get-MaintainStatusRows $State)
    # More status than room: the page scrolls, and everything on it is laid out narrower by the
    # bar's width at once - laid out first and narrowed later, the tiles ran under the bar and a
    # horizontal bar appeared.
    $headingProbe = New-UiLabel -Text (T 'status.actions') -Width $width -Font 'Heading'
    $needed = (S 10) + $headingProbe.Height + (S 8) + 2 * (S 76) + (S 10)
    $headingProbe.Dispose()
    foreach ($row in $statusRows) {
        $probe = New-UiLabel -Text ([string] $row.Detail) -Width ($width - (S 168)) -Font 'Small'
        $needed += [Math]::Max((S 30), $probe.Height + (S 10))
        $probe.Dispose()
    }
    if ($needed -gt $Content.ClientSize.Height) {
        $Content.AutoScroll = $true
        $width -= [System.Windows.Forms.SystemInformation]::VerticalScrollBarWidth
    }
    foreach ($row in $statusRows) {
        $detailLeft = S 168
        $detail = New-UiLabel -Text ([string] $row.Detail) -Width ($width - $detailLeft) -Font 'Small' -Color $(if ($row.Status -eq 'error') { 'Danger' } else { 'Muted' })
        $height = [Math]::Max((S 30), $detail.Height + (S 10))
        $glyph = New-UiStatus (ConvertTo-UiStatusKind $row.Status) 18
        $glyph.Location = New-UiPoint 0 ($y + [int] (($height - $glyph.Height) / 2))
        $Content.Controls.Add($glyph)
        $title = New-UiLabel -Text ([string] $row.Title) -Width ($detailLeft - (S 32)) -Font 'Strong'
        $title.Location = New-UiPoint (S 28) ($y + [int] (($height - $title.Height) / 2))
        $Content.Controls.Add($title)
        $detail.Location = New-UiPoint $detailLeft ($y + [int] (($height - $detail.Height) / 2))
        $Content.Controls.Add($detail)
        $y += $height
    }
    $y += S 10
    $heading = New-UiLabel -Text (T 'status.actions') -Width $width -Font 'Heading'
    $heading.Location = New-UiPoint 0 $y
    $Content.Controls.Add($heading)
    $y += $heading.Height + (S 8)

    # Folders, access and a new administrator all run the installation's own Python.
    $ready = [bool] $State.Env.Existing.VenvWorks
    $updateText = if ($State.Env.Existing.SameTree) { T 'tile.update.same' } else { T 'tile.update.other' $State.Version }
    $tiles = @(
        @(0xED25, (T 'tile.folders'), (T 'tile.folders.text'), 'folders', $ready),
        @(0xE774, (T 'tile.access'), (T 'tile.access.text'), 'access', $ready),
        @(0xE8FA, (T 'tile.admin'), (T 'tile.admin.text'), 'admin', $ready),
        @(0xE895, (T 'tile.update'), $updateText, 'update', $true),
        @(0xE90F, (T 'tile.repair'), (T 'tile.repair.text'), 'repair', $true),
        @(0xE74D, (T 'tile.uninstall'), (T 'tile.uninstall.text'), 'uninstall', $true)
    )
    $gap = S 10
    # Rounded down: [int] rounds to the nearest, and one pixel too many makes a horizontal bar.
    $tileWidth = [int] [Math]::Floor(($width - 2 * $gap) / 3)
    # Tiles shrink to fit, but never below what two lines of text need; a page with
    # more status text than room scrolls instead of cutting the tiles.
    $tileHeight = [int] [Math]::Max((S 76), [Math]::Min((S 92), [Math]::Floor(($Content.ClientSize.Height - $y - $gap) / 2)))
    if ($y + 2 * $tileHeight + $gap -gt $Content.ClientSize.Height) { $Content.AutoScroll = $true }
    for ($i = 0; $i -lt $tiles.Count; $i++) {
        $entry = $tiles[$i]
        $tile = New-UiTile -Glyph $entry[0] -Title $entry[1] -Text $entry[2] -Width $tileWidth -Height $tileHeight -Flow $entry[3] -Enabled $entry[4]
        $tile.Location = New-UiPoint (($i % 3) * ($tileWidth + $gap)) ($y + [int] [Math]::Floor($i / 3) * ($tileHeight + $gap))
        $Content.Controls.Add($tile)
    }
}

function Start-MaintainFlow {
    param([string] $Flow)
    if ($script:Ui.Preview -or $script:Ui.Job) { return }
    $state = $script:Ui.State
    if (-not $state.Env.Python.Ok -and -not $state.Env.Existing.VenvWorks) { Set-SetupMessage (T 'error.noPython'); return }
    $state.Flow = $Flow
    $state.Results = @{}
    $state.PlanResult = $null
    $state.BackupDir = $null
    $state.ApacheChanged = $false
    if ($Flow -eq 'admin') { $state.Admin = @{ Username = ''; Email = ''; Password = '' } }
    if ($Flow -eq 'update') { $state.InPlace = [bool] $state.Env.Existing.SameTree }
    if ($Flow -eq 'repair' -or $Flow -eq 'uninstall') { $state.InPlace = $true }
    Set-SetupFlow (Get-SetupFlowPages $Flow)
}

function Complete-MaintainFlow {
    <# Back to the status page, with a fresh look at the machine. #>
    param($State, $Page)
    $State.Flow = 'status'
    $State.Database.Tested = $false
    $State.Database.Test = $null
    Set-SetupFlow (Get-SetupFlowPages 'boot')
}

# -- update / migrations -----------------------------------------------------------------------

function Add-PageAdminCredentials {
    <# The administrator's name and password with a "Test connection" button: shared by update and uninstall. #>
    param($State, $Page, [hashtable] $Stack)
    $half = [int] (($Stack.Width - (S 16)) / 2)
    $database = $State.Database
    [void] (Add-UiStack $Stack (New-UiLabel -Text (T 'update.server' $database.Label $database.Port $database.Name) -Width $Stack.Width -Font 'Small' -Color 'Muted') -Gap 8)
    $left = New-UiStack $Stack.Parent $Stack.X $Stack.Y $half
    $right = New-UiStack $Stack.Parent ($Stack.X + $half + (S 16)) $Stack.Y $half
    $adminUser = Add-UiField $left (T 'database.adminUser') (New-UiTextBox -Text $database.AdminUser -Width $half) -Gap 8
    $adminPassword = Add-UiField $right (T 'database.adminPassword') (New-UiTextBox -Text $database.AdminPassword -Width $half -Password) -Gap 8
    foreach ($box in @($adminUser, $adminPassword)) { $box.Add_TextChanged({ Reset-PageDatabaseTest }) }
    $Stack.Y = $left.Y
    $test = New-UiButton -Text (T 'database.test') -Kind 'Secondary' -Glyph 0xE945 -Height 32
    $test.Add_Click({ Start-PageDatabaseTest $false })
    [void] (Add-UiStack $Stack $test -Gap 10)
    $result = New-Object System.Windows.Forms.Panel
    $result.BackColor = Get-UiColor 'Window'
    $result.Size = New-UiSize $Stack.Width (S 10)
    [void] (Add-UiStack $Stack $result -Gap 0)
    $Page.Controls.AdminUser = $adminUser
    $Page.Controls.AdminPassword = $adminPassword
    $Page.Controls.Result = $result
    $Page.Servers = @()
}

function Build-PageUpdate {
    param($State, $Content, $Page)
    $width = $Content.ClientSize.Width
    $stack = New-UiStack $Content 0 (S 2) $width
    $existing = $State.Env.Existing
    $package = [string] $State.Version
    $text = if ($existing.SameTree) { T 'update.same' $existing.Version } else { T 'update.other' $existing.Version $existing.Root $package $State.SourceRoot }
    [void] (Add-UiStack $stack (New-UiNotice -Text $text -Kind 'info' -Width $width) -Gap 10)
    if ($State.SavedState -and $State.SavedState.access) {
        [void] (Add-UiStack $stack (New-UiLabel -Text (T 'update.refresh') -Width $width -Font 'Small' -Color 'Muted') -Gap 10)
    }
    # Above the sign-in fields: the box under the test button grows with its result.
    $Page.Controls.Backup = Add-UiStack $stack (New-UiCheck -Text (T 'update.backup') -Checked ([bool] $State.Options.BackupDatabase) -Width $width) -Gap 10
    [void] (Add-UiStack $stack (New-UiLabel -Text (T 'update.why') -Width $width) -Gap 10)
    Add-PageAdminCredentials $State $Page $stack
    $Page.Validate = 'Test-PageDatabase'
    $Page.Leave = 'Leave-PageUpdate'
    Show-PageDatabaseResult
}

function Leave-PageUpdate {
    param($State, $Page)
    if ($Page.Controls.Backup) { $State.Options.BackupDatabase = [bool] $Page.Controls.Backup.Checked }
    return (Leave-PageDatabase $State $Page)
}

# -- uninstall ---------------------------------------------------------------------------------

function Build-PageUninstall {
    param($State, $Content, $Page)
    $width = $Content.ClientSize.Width
    $stack = New-UiStack $Content 0 (S 2) $width
    $uninstall = $State.Uninstall
    [void] (Add-UiStack $stack (New-UiNotice -Text (T 'uninstall.always') -Kind 'info' -Width $width) -Gap 12)
    $data = Add-UiStack $stack (New-UiCheck -Text (T 'uninstall.data' $State.TargetRoot) -Checked ([bool] $uninstall.RemoveData) -Width $width) -Gap 4
    $config = Add-UiStack $stack (New-UiCheck -Text (T 'uninstall.config') -Checked ([bool] $uninstall.RemoveConfig) -Width ($width - (S 24))) -Gap 12 -Indent (S 24)
    $drop = Add-UiStack $stack (New-UiCheck -Text (T 'uninstall.database' $State.Database.Name $State.Database.User) -Checked ([bool] $uninstall.DropDatabase) -Width $width) -Gap 8
    # The record says whether this wizard created the database. One it found, or one made by
    # hand, may serve something else too: say so before anybody types its name (audit P3-11).
    $saved = $State.SavedState
    $ours = ($saved -and $saved.database -and [bool] $saved.database.created_by_wizard)
    if (-not $ours) {
        [void] (Add-UiStack $stack (New-UiLabel -Text (T 'uninstall.database.notOurs' $State.Database.Name) -Width ($width - (S 24)) -Font 'Small' -Color 'Warning') -Gap 8 -Indent (S 24))
    }
    $panel = New-Object System.Windows.Forms.Panel
    $panel.BackColor = Get-UiColor 'Window'
    $panel.Location = New-UiPoint (S 24) $stack.Y
    $panel.Size = New-UiSize ($width - (S 24)) ($Content.ClientSize.Height - $stack.Y)
    $Content.Controls.Add($panel)
    $Page.Controls = @{ Data = $data; Config = $config; Drop = $drop; Panel = $panel }
    $inner = New-UiStack $panel 0 0 $panel.Width
    $confirm = Add-UiField $inner (T 'uninstall.confirm' $State.Database.Name) (New-UiTextBox -Text ([string] $uninstall.ConfirmText) -Width ([int] ($panel.Width / 2))) -Gap 10
    $Page.Controls.Confirm = $confirm
    Add-PageAdminCredentials $State $Page $inner
    $data.Add_CheckedChanged({ Update-PageUninstall })
    $drop.Add_CheckedChanged({ Update-PageUninstall })
    $Page.Validate = 'Test-PageUninstall'
    $Page.Leave = 'Leave-PageUninstall'
    Update-PageUninstall
    Show-PageDatabaseResult
}

function Update-PageUninstall {
    $controls = $script:Ui.Page.Controls
    $controls.Config.Enabled = [bool] $controls.Data.Checked
    if (-not $controls.Data.Checked) { $controls.Config.Checked = $false }
    $controls.Panel.Visible = [bool] $controls.Drop.Checked
}

function Test-PageUninstall {
    param($State, $Page)
    $controls = $Page.Controls
    if (-not $controls.Drop.Checked) { return @() }
    if ($controls.Confirm.Text -cne [string] $State.Database.Name) { return @((T 'uninstall.error.confirm')) }
    if (-not $controls.AdminUser.Text.Trim()) { return @((T 'database.error.admin')) }
    return @()
}

function Leave-PageUninstall {
    param($State, $Page)
    $controls = $Page.Controls
    $State.Uninstall = @{
        RemoveData = [bool] $controls.Data.Checked; RemoveConfig = [bool] $controls.Config.Checked
        DropDatabase = [bool] $controls.Drop.Checked; ConfirmText = [string] $controls.Confirm.Text
    }
    if (-not $State.Uninstall.DropDatabase) { return $true }
    Read-PageDatabase
    if (-not $State.Database.Tested) {
        Start-PageDatabaseTest $true
        return $false
    }
    return $true
}
