<#
    The pages of a first installation, in the order a person meets them.

    Every page is a function that fills the content panel from the state and
    nothing else, so the same function draws the page for a real run and for
    -Preview. What a page needs to remember between events lives in $Page (the
    same object as $script:Ui.Page); what it decides goes into $State when the
    user presses Next (the page's Leave function).

    Keep this file pure ASCII; translated text lives in installer\lang\*.psd1.
#>

function Get-SetupFlowPages {
    param([string] $Flow)
    $page = { param($id, $build) @{ Id = $id; Build = $build } }
    switch ($Flow) {
        'boot'      { return @((& $page 'boot' 'Build-PageBoot')) }
        'install'   {
            return @(
                (& $page 'welcome' 'Build-PageWelcome'), (& $page 'requirements' 'Build-PageRequirements'),
                (& $page 'location' 'Build-PageLocation'), (& $page 'database' 'Build-PageDatabase'),
                (& $page 'media' 'Build-PageMedia'), (& $page 'access' 'Build-PageAccess'),
                (& $page 'admin' 'Build-PageAdmin'), (& $page 'summary' 'Build-PageSummary'),
                (& $page 'progress' 'Build-PageProgress'), (& $page 'finish' 'Build-PageFinish'))
        }
        'status'    { return @((& $page 'status' 'Build-PageStatus')) }
        'folders'   { return @((& $page 'media' 'Build-PageMedia'), (& $page 'summary' 'Build-PageSummary'), (& $page 'progress' 'Build-PageProgress'), (& $page 'done' 'Build-PageFinish')) }
        'access'    { return @((& $page 'access' 'Build-PageAccess'), (& $page 'summary' 'Build-PageSummary'), (& $page 'progress' 'Build-PageProgress'), (& $page 'done' 'Build-PageFinish')) }
        'admin'     { return @((& $page 'admin' 'Build-PageAdmin'), (& $page 'summary' 'Build-PageSummary'), (& $page 'progress' 'Build-PageProgress'), (& $page 'done' 'Build-PageFinish')) }
        'update'    { return @((& $page 'update' 'Build-PageUpdate'), (& $page 'summary' 'Build-PageSummary'), (& $page 'progress' 'Build-PageProgress'), (& $page 'done' 'Build-PageFinish')) }
        'repair'    { return @((& $page 'summary' 'Build-PageSummary'), (& $page 'progress' 'Build-PageProgress'), (& $page 'done' 'Build-PageFinish')) }
        'uninstall' { return @((& $page 'uninstall' 'Build-PageUninstall'), (& $page 'summary' 'Build-PageSummary'), (& $page 'progress' 'Build-PageProgress'), (& $page 'done' 'Build-PageFinish')) }
    }
    throw "Unknown flow: $Flow"
}

function Add-UiBullets {
    <# A numbered list: accent-coloured numbers, wrapped text. #>
    param([hashtable] $Stack, [string[]] $Items, [double] $Gap = 6)
    $number = 0
    foreach ($item in $Items) {
        $number++
        $mark = New-UiLabel -Text "$number." -Width (S 22) -Font 'Strong' -Color 'Accent'
        $mark.Location = New-UiPoint $Stack.X $Stack.Y
        $Stack.Parent.Controls.Add($mark)
        [void] (Add-UiStack $Stack (New-UiLabel -Text $item -Width ($Stack.Width - (S 26))) -Gap $Gap -Indent (S 26))
    }
}

# -- 0. looking at the machine ---------------------------------------------------------------

function Build-PageBoot {
    param($State, $Content, $Page)
    $Page.HideNext = $true; $Page.HideBack = $true; $Page.ConfirmClose = $false
    $stack = New-UiStack $Content 0 (S 6) $Content.ClientSize.Width
    $spinner = New-UiStatus 'Running' 22
    $text = New-UiLabel -Text (T 'boot.text') -Width ($stack.Width - (S 40))
    Add-UiRow $stack @($spinner, $text) -Gap 14 -Spacing 12
    [void] (Add-UiStack $stack (New-UiLabel -Text (T 'boot.detail') -Width $stack.Width -Font 'Small' -Color 'Muted'))
    $Page.Enter = 'Enter-PageBoot'
}

function Enter-PageBoot {
    param($State, $Page)
    Start-SetupJob -Kind 'detect' -OnDone 'Complete-PageBoot' -Arguments @{
        SourceRoot = $State.SourceRoot; TargetRoot = $State.TargetRoot; FfmpegHint = $State.FfmpegPath; AssumeFresh = [bool] $State.AssumeFresh }
}

function Complete-PageBoot {
    param($Finished)
    $state = $script:Ui.State
    if ($Finished.Error) {
        [void] [System.Windows.Forms.MessageBox]::Show($script:Ui.Form, [string] $Finished.Error, (T 'app.title'), 'OK', 'Error')
        $script:Ui.Closing = $true; $script:Ui.Form.Close(); return
    }
    Set-SetupEnvironment $state $Finished.Result
    if ($state.Env.Existing.Found -and $state.Env.Existing.Unfinished) {
        # A first installation that stopped half way: finishing it is the useful thing to
        # offer - the status page cannot repair what was never set up.
        $answer = [System.Windows.Forms.MessageBox]::Show($script:Ui.Form, (T 'resume.question' $state.Env.Existing.Root), (T 'app.title'), 'YesNo', 'Question')
        if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {
            $state.ResumeRoot = [string] $state.Env.Existing.Root
            $state.TargetRoot = $state.ResumeRoot
            $state.InPlace = [bool] $state.Env.Existing.SameTree
            $state.Mode = 'install'; $state.Flow = 'install'
            Set-SetupFlow (Get-SetupFlowPages 'install')
            return
        }
    }
    if ($state.Env.Existing.Found) {
        Initialize-SetupMaintainState $state
        Set-SetupFlow (Get-SetupFlowPages 'status')
    } else {
        $state.Mode = 'install'; $state.Flow = 'install'
        Set-SetupFlow (Get-SetupFlowPages 'install')
    }
}

# -- 1. welcome --------------------------------------------------------------------------------

function Build-PageWelcome {
    param($State, $Content, $Page)
    $width = $Content.ClientSize.Width
    $stack = New-UiStack $Content 0 (S 2) $width
    $Page.ConfirmClose = $false
    if ($script:SetupContext.DryRun) { [void] (Add-UiStack $stack (New-UiNotice -Text (T 'welcome.dryRun') -Kind 'warn' -Width $width) -Gap 14) }

    [void] (Add-UiStack $stack (New-UiLabel -Text (T 'welcome.language') -Width $width -Font 'Small' -Color 'Muted') -Gap 5)
    $buttons = @()
    foreach ($language in @(@('pl', 'Polski'), @('en', 'English'))) {
        $kind = if ($script:SetupContext.Language -eq $language[0]) { 'Primary' } else { 'Secondary' }
        $button = New-UiButton -Text $language[1] -Kind $kind -Width 108 -Height 32
        $button.Tag = $language[0]
        $button.Add_Click({ Switch-SetupLanguage ([string] $this.Tag) })
        $buttons += $button
    }
    Add-UiRow $stack $buttons -Gap 22

    [void] (Add-UiStack $stack (New-UiLabel -Text (T 'welcome.what') -Width $width -Font 'Heading') -Gap 8)
    Add-UiBullets $stack @((T 'welcome.step1'), (T 'welcome.step2'), (T 'welcome.step3'), (T 'welcome.step4'), (T 'welcome.step5'))
    $stack.Y += S 10
    [void] (Add-UiStack $stack (New-UiNotice -Text (T 'welcome.needs') -Kind 'info' -Width $width) -Gap 10)
    [void] (Add-UiStack $stack (New-UiLabel -Text (T 'welcome.later') -Width $width -Font 'Small' -Color 'Muted'))
    $Page.NextText = T 'button.start'
}

function Switch-SetupLanguage {
    param([string] $Language)
    Set-SetupLanguage $Language
    Set-UiStatusNames
    $script:Ui.Form.Text = T 'app.title'
    Show-SetupPage $script:Ui.Index
}

# -- 2. requirements ---------------------------------------------------------------------------

function Add-PageRequirementRows {
    <# Lays the rows out at the given width and returns the height they take. #>
    param($Content, [array] $Rows, [int] $Width)
    $y = 0
    foreach ($row in $Rows) {
        $buttons = @()
        $buttonsWidth = 0
        foreach ($action in @($row.Actions)) {
            $button = New-UiButton -Text ([string] $action.Label) -Kind 'Ghost' -Height 26
            $button.Font = $script:Ui.Fonts.Small
            $button.Width = [System.Windows.Forms.TextRenderer]::MeasureText($button.Text, $button.Font).Width + (S 18)
            $button.Tag = [string] $action.Id
            $button.Add_Click({ Invoke-SetupRequirementAction ([string] $this.Tag) })
            $buttons += $button
            $buttonsWidth += $button.Width + (S 2)
        }
        # One short action sits at the end of the line; several go under the
        # explanation, so the explanation keeps the whole width.
        $beside = ($buttons.Count -eq 1 -and $buttonsWidth -le (S 110))
        $detailLeft = S 168
        $detailWidth = $Width - $detailLeft - $(if ($beside) { $buttonsWidth + (S 6) } else { 0 })
        $detail = New-UiLabel -Text ([string] $row.Detail) -Width $detailWidth -Font 'Small' -Color $(if ($row.Status -eq 'error') { 'Danger' } else { 'Muted' })
        $below = if ($buttons.Count -gt 0 -and -not $beside) { (S 28) } else { 0 }
        $height = [Math]::Max((S 36), $detail.Height + $below + (S 14))
        $first = [Math]::Min($height, (S 36))
        $glyph = New-UiStatus (ConvertTo-UiStatusKind $row.Status) 20
        $glyph.Location = New-UiPoint 0 ($y + [int] (($first - $glyph.Height) / 2))
        $Content.Controls.Add($glyph)
        $title = New-UiLabel -Text ([string] $row.Title) -Width ($detailLeft - (S 36)) -Font 'Strong'
        $title.Location = New-UiPoint (S 32) ($y + [int] (($first - $title.Height) / 2))
        $Content.Controls.Add($title)
        $detailTop = if ($below -gt 0 -or $detail.Height -gt (S 22)) { $y + (S 8) } else { $y + [int] (($height - $detail.Height) / 2) }
        $detail.Location = New-UiPoint $detailLeft $detailTop
        $Content.Controls.Add($detail)
        if ($beside) {
            $buttons[0].Location = New-UiPoint ($Width - $buttons[0].Width) ($y + [int] (($height - $buttons[0].Height) / 2))
            $Content.Controls.Add($buttons[0])
        } else {
            $x = $detailLeft - (S 9)
            foreach ($button in $buttons) {
                $button.Location = New-UiPoint $x ($detailTop + $detail.Height + (S 1))
                $Content.Controls.Add($button)
                $x += $button.Width + (S 2)
            }
        }
        $y += $height
        $line = New-Object System.Windows.Forms.Panel
        $line.BackColor = Get-UiColor 'Border'
        $line.Location = New-UiPoint 0 $y
        $line.Size = New-UiSize $Width 1
        $Content.Controls.Add($line)
        $y += 1
    }
    return $y
}

function Build-PageRequirements {
    param($State, $Content, $Page)
    $width = $Content.ClientSize.Width
    if ($State.Checking) {
        $spinner = New-UiStatus 'Running' 20
        $spinner.Location = New-UiPoint 0 (S 6)
        $Content.Controls.Add($spinner)
        $label = New-UiLabel -Text (T 'requirements.checking') -Width ($width - (S 40))
        $label.Location = New-UiPoint (S 32) (S 7)
        $Content.Controls.Add($label)
        $Page.NextDisabled = $true
        return
    }
    $rows = @(Get-SetupRequirements -Environment $State.Env -Mode $State.Mode -AccessMode $State.Access.Mode)
    $used = Add-PageRequirementRows $Content $rows $width
    if ($used -gt $Content.ClientSize.Height) {
        # More trouble than fits: lay the rows out again beside a scroll bar.
        foreach ($control in @($Content.Controls)) { $Content.Controls.Remove($control); $control.Dispose() }
        $Content.AutoScroll = $true
        $null = Add-PageRequirementRows $Content $rows ($width - [System.Windows.Forms.SystemInformation]::VerticalScrollBarWidth - (S 4))
    }
    $again = New-UiButton -Text (T 'requirements.again') -Kind 'Secondary' -Glyph 0xE72C -Height 32
    $again.Add_Click({ Start-SetupRecheck })
    $Page.HeaderControl = $again
    $errors = @($rows | Where-Object { $_.Status -eq 'error' })
    $fixes = @($rows | Where-Object { $_.Status -eq 'fix' })
    if ($errors.Count -gt 0) { Set-SetupMessage (T 'requirements.blocked') 'error' }
    elseif ($fixes.Count -gt 0) { Set-SetupMessage (T 'requirements.fixes') 'info' }
    else { Set-SetupMessage (T 'requirements.ready') 'ok' }
    $Page.NextDisabled = ($errors.Count -gt 0)
}

function Start-SetupRecheck {
    $state = $script:Ui.State
    if ($script:Ui.Job -or $script:Ui.Preview) { return }
    $state.Checking = $true
    Show-SetupPage $script:Ui.Index
    Start-SetupJob -Kind 'detect' -OnDone 'Complete-SetupRecheck' -Arguments @{
        SourceRoot = $state.SourceRoot; TargetRoot = $state.TargetRoot; FfmpegHint = $state.FfmpegPath; AssumeFresh = [bool] $state.AssumeFresh }
}

function Complete-SetupRecheck {
    param($Finished)
    $state = $script:Ui.State
    $state.Checking = $false
    if ($Finished.Error) { Show-SetupPage $script:Ui.Index; Set-SetupMessage ([string] $Finished.Error); return }
    Set-SetupEnvironment $state $Finished.Result
    Show-SetupPage $script:Ui.Index
}

function Invoke-SetupRequirementAction {
    param([string] $Action)
    if ($script:Ui.Preview) { return }
    $state = $script:Ui.State
    switch ($Action) {
        'open-wamp'     { Open-SetupTarget $script:SetupNames.UrlWamp }
        'open-vcredist' { Open-SetupTarget $script:SetupNames.UrlVcRedist }
        'open-python'   { Open-SetupTarget $script:SetupNames.UrlPython }
        'open-ffmpeg'   { Open-SetupTarget $script:SetupNames.UrlFfmpeg }
        'winget-python' { Start-SetupWinget $script:SetupNames.WingetPython }
        'winget-ffmpeg' { Start-SetupWinget $script:SetupNames.WingetFfmpeg }
        'open-node'     { Open-SetupTarget $script:SetupNames.UrlNode }
        'winget-node'   { Start-SetupWinget $script:SetupNames.WingetNode }
        'browse-ffmpeg' {
            $dialog = New-Object System.Windows.Forms.OpenFileDialog
            $dialog.Filter = 'ffmpeg.exe|ffmpeg.exe'
            $dialog.Title = T 'requirements.ffmpeg.pick'
            if ($dialog.ShowDialog($script:Ui.Form) -eq 'OK') {
                $tested = Test-SetupFfmpeg $dialog.FileName
                if (-not $tested.Found) { Set-SetupMessage (T 'requirements.ffmpeg.bad' $dialog.FileName); return }
                $state.FfmpegPath = $dialog.FileName
                $state.Env.Ffmpeg = $tested
                Show-SetupPage $script:Ui.Index
            }
        }
        'start-services' {
            if ($script:SetupContext.DryRun) { Set-SetupMessage (T 'requirements.dryRunAction') 'info'; return }
            try {
                foreach ($name in @($state.Env.Database.Service.Name, $state.Env.Wamp.Apache.Service.Name)) {
                    if ($name -and (Get-Service -Name $name -ErrorAction Stop).Status -ne 'Running') { Start-Service -Name $name -ErrorAction Stop }
                }
            } catch { Set-SetupMessage ([string] $_.Exception.Message); return }
            Start-SetupRecheck
        }
    }
}

function Start-SetupWinget {
    <# The user's own choice, in a window of its own: winget shows its licence prompts and progress there. #>
    param([string] $Package)
    if ($script:SetupContext.DryRun) { Set-SetupMessage (T 'requirements.dryRunAction') 'info'; return }
    if ($Package -notmatch '^[A-Za-z0-9.\-]+$') { return }
    # /c and a pause: the window waits for a key and then closes. With /k it stayed open as an
    # elevated command prompt nobody asked for (audit P3-7). Characters cmd would act on are dropped.
    $done = (T 'requirements.winget.done') -replace '[&|<>^()%!"]', ''
    $arguments = "/c winget install --exact --id $Package --source winget & echo. & echo $done & pause"
    Start-Process -FilePath $env:ComSpec -ArgumentList $arguments
    Set-SetupMessage (T 'requirements.winget.started') 'info'
}

# -- 3. location -------------------------------------------------------------------------------

function Build-PageLocation {
    param($State, $Content, $Page)
    $width = $Content.ClientSize.Width
    $stack = New-UiStack $Content 0 (S 2) $width
    $fresh = New-UiOption -Title (T 'location.new.title') -Description (T 'location.new.text' $State.SourceRoot) -Width $width -Badge (T 'badge.recommended') -Checked (-not $State.InPlace)
    [void] (Add-UiStack $stack $fresh -Gap 8)
    $path = New-UiTextBox -Text $(if ($State.InPlace) { (Join-Path $env:SystemDrive '\TryHackX\MediaServer') } else { $State.TargetRoot }) -Width ($width - (S 44) - (S 130))
    $browse = New-UiButton -Text (T 'button.browse') -Kind 'Secondary' -Width 116 -Height 30
    $browse.Add_Click({ Select-SetupFolder $script:Ui.Page.Controls.Path })
    Add-UiRow $stack @($path, $browse) -Gap 6 -Spacing 10 -Indent (S 44)
    $harden = New-UiCheck -Text (T 'location.harden') -Checked ([bool] $State.Options.HardenFolder) -Width ($width - (S 44))
    [void] (Add-UiStack $stack $harden -Gap 16 -Indent (S 44))
    $inPlace = New-UiOption -Title (T 'location.inPlace.title') -Description (T 'location.inPlace.text' $State.SourceRoot) -Width $width -Checked ([bool] $State.InPlace)
    [void] (Add-UiStack $stack $inPlace -Gap 16)
    $fresh.Add_CheckedChanged({ if ($this.Checked) { $script:Ui.Page.Controls.InPlace.Checked = $false }; Update-PageLocation })
    $inPlace.Add_CheckedChanged({ if ($this.Checked) { $script:Ui.Page.Controls.Fresh.Checked = $false }; Update-PageLocation })
    $disk = $State.Env.Disk
    $free = New-UiLabel -Text (T 'location.free' $disk.Drive ([Math]::Round($disk.FreeBytes / 1GB, 1))) -Width $width -Font 'Small' -Color 'Muted'
    [void] (Add-UiStack $stack $free -Gap 10)
    [void] (Add-UiStack $stack (New-UiNotice -Text (T 'location.note') -Kind 'info' -Width $width))
    $Page.Controls = @{ Fresh = $fresh; InPlace = $inPlace; Path = $path; Browse = $browse; Harden = $harden }
    $Page.Validate = 'Test-PageLocation'
    $Page.Leave = 'Leave-PageLocation'
    Update-PageLocation
}

function Update-PageLocation {
    $controls = $script:Ui.Page.Controls
    if (-not $controls.Path) { return }
    $new = [bool] $controls.Fresh.Checked
    $controls.Path.Enabled = $new; $controls.Browse.Enabled = $new; $controls.Harden.Enabled = $new
}

function Select-SetupFolder {
    param($TextBox)
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.ShowNewFolderButton = $true
    if ($TextBox.Text -and (Test-Path -LiteralPath $TextBox.Text)) { $dialog.SelectedPath = $TextBox.Text }
    if ($dialog.ShowDialog($script:Ui.Form) -eq 'OK') { $TextBox.Text = $dialog.SelectedPath }
}

function Test-PageLocation {
    param($State, $Page)
    $controls = $Page.Controls
    $resume = [string] $State.ResumeRoot
    if ($controls.InPlace.Checked) { return @(Test-SetupTargetFolder -Path $State.SourceRoot -SourceRoot $State.SourceRoot -Wamp $State.Env.Wamp -ResumeRoot $resume) }
    if (-not $controls.Fresh.Checked) { return @((T 'location.error.choose')) }
    return @(Test-SetupTargetFolder -Path $controls.Path.Text -SourceRoot $State.SourceRoot -Wamp $State.Env.Wamp -ResumeRoot $resume)
}

function Leave-PageLocation {
    param($State, $Page)
    $controls = $Page.Controls
    $State.InPlace = [bool] $controls.InPlace.Checked
    $State.TargetRoot = if ($State.InPlace) { $State.SourceRoot } else { [System.IO.Path]::GetFullPath($controls.Path.Text.Trim()).TrimEnd('\') }
    $State.Options.HardenFolder = ([bool] $controls.Harden.Checked -and -not $State.InPlace)
    $State.Env.Disk = Get-SetupDisk $State.TargetRoot
}

# -- 4. database -------------------------------------------------------------------------------

function Build-PageDatabase {
    param($State, $Content, $Page)
    $width = $Content.ClientSize.Width
    $stack = New-UiStack $Content 0 (S 2) $width
    $database = $State.Database
    $servers = @($State.Env.Wamp.Databases | Where-Object { $_.Supported -and $_.Client })
    $labels = @($servers | ForEach-Object { '{0}  -  {1} {2}{3}' -f $_.Label, (T 'database.port'), $_.Port, $(if ($_.Service.Running) { '' } else { '  (' + (T 'req.stopped') + ')' }) })
    $selected = 0
    for ($i = 0; $i -lt $servers.Count; $i++) { if ($servers[$i].Engine -eq $database.Engine) { $selected = $i } }
    $half = [int] (($width - (S 16)) / 2)
    $server = New-UiCombo -Items $labels -Selected $selected -Width $width
    [void] (Add-UiField $stack (T 'database.server') $server)
    $server.Add_SelectedIndexChanged({ Reset-PageDatabaseTest })

    # Two columns: the administrator on the left, what will be created on the right.
    $left = New-UiStack $Content 0 $stack.Y $half
    $right = New-UiStack $Content ($half + (S 16)) $stack.Y $half
    $adminUser = Add-UiField $left (T 'database.adminUser') (New-UiTextBox -Text $database.AdminUser -Width $half)
    $adminPassword = Add-UiField $left (T 'database.adminPassword') (New-UiTextBox -Text $database.AdminPassword -Width $half -Password) -Hint (T 'database.adminPassword.hint')
    $name = Add-UiField $right (T 'database.name') (New-UiTextBox -Text $database.Name -Width $half)
    $user = Add-UiField $right (T 'database.user') (New-UiTextBox -Text $database.User -Width $half) -Hint (T 'database.user.hint')
    foreach ($box in @($adminUser, $adminPassword, $name, $user)) { $box.Add_TextChanged({ Reset-PageDatabaseTest }) }
    $stack.Y = [Math]::Max($left.Y, $right.Y) + (S 2)

    $test = New-UiButton -Text (T 'database.test') -Kind 'Secondary' -Glyph 0xE945 -Height 32
    $test.Add_Click({ Start-PageDatabaseTest $false })
    [void] (Add-UiStack $stack $test -Gap 10)
    $result = New-Object System.Windows.Forms.Panel
    $result.BackColor = Get-UiColor 'Window'
    $result.Size = New-UiSize $width (S 10)
    [void] (Add-UiStack $stack $result -Gap 0)
    $Page.Controls = @{ Server = $server; AdminUser = $adminUser; AdminPassword = $adminPassword; Name = $name; User = $user; Test = $test; Result = $result }
    $Page.Servers = $servers
    $Page.Validate = 'Test-PageDatabase'
    $Page.Leave = 'Leave-PageDatabase'
    Show-PageDatabaseResult
}

function Show-PageDatabaseResult {
    <# The box under the button: what the last test found, or the reminder to run one. #>
    $page = $script:Ui.Page
    $state = $script:Ui.State
    $panel = $page.Controls.Result
    foreach ($control in @($panel.Controls)) { $panel.Controls.Remove($control); $control.Dispose() }
    $width = $panel.Width
    $test = $state.Database.Test
    $notices = @()
    if ($page.Testing) { $notices += , @((T 'database.testing'), 'info') }
    elseif (-not $test) { $notices += , @((T $(if ($state.Flow -eq 'install') { 'database.info' } else { 'database.infoAdmin' })), 'info') }
    elseif (-not $test.Ok) { $notices += , @((T 'database.failed' $test.Message), 'error') }
    elseif ($state.Flow -ne 'install') {
        if ($test.CanCreate) { $notices += , @((T 'database.connected' $test.Version), 'ok') }
        else { $notices += , @((T 'database.noRights' $test.Version), 'error') }
    }
    else {
        if (-not $test.CanCreate) { $notices += , @((T 'database.noRights' $test.Version), 'error') }
        elseif ($test.DatabaseExists -and $test.Tables -gt 0) { $notices += , @((T 'database.existing' $test.Version $state.Database.Name $test.Tables), 'warn') }
        else { $notices += , @((T 'database.ok' $test.Version $state.Database.Name), 'ok') }
        if ($test.UserExists -and $state.Flow -eq 'install') { $notices += , @((T 'database.userExists' $state.Database.User), 'warn') }
    }
    $y = 0
    foreach ($notice in $notices) {
        $box = New-UiNotice -Text ([string] $notice[0]) -Kind ([string] $notice[1]) -Width $width
        $box.Location = New-UiPoint 0 $y
        $panel.Controls.Add($box)
        $y += $box.Height + (S 8)
    }
    $panel.Height = [Math]::Max((S 10), $y)
}

function Reset-PageDatabaseTest {
    $state = $script:Ui.State
    if ($script:Ui.Preview -or -not $state.Database.Test) { return }
    $state.Database.Tested = $false
    $state.Database.Test = $null
    Show-PageDatabaseResult
}

function Read-PageDatabase {
    <# Copies the fields into the state (so the test and the plan see the same values). #>
    $page = $script:Ui.Page
    $state = $script:Ui.State
    $controls = $page.Controls
    if ($controls.Server -and $page.Servers.Count -gt 0) { Set-SetupDatabaseServer $state $page.Servers[[Math]::Max(0, $controls.Server.SelectedIndex)] }
    $database = $state.Database
    $database.AdminUser = $controls.AdminUser.Text.Trim()
    $database.AdminPassword = $controls.AdminPassword.Text
    if ($controls.Name) { $database.Name = $controls.Name.Text.Trim(); $database.User = $controls.User.Text.Trim() }
    Add-SetupSecret $database.AdminPassword
}

function Start-PageDatabaseTest {
    param([bool] $ThenContinue)
    if ($script:Ui.Job -or $script:Ui.Preview) { return }
    Read-PageDatabase
    $page = $script:Ui.Page
    $page.Testing = $true
    $page.ContinueAfterTest = $ThenContinue
    Show-PageDatabaseResult
    Start-SetupJob -Kind 'dbtest' -OnDone 'Complete-PageDatabaseTest' -Arguments @{ Database = $script:Ui.State.Database }
}

function Complete-PageDatabaseTest {
    param($Finished)
    $page = $script:Ui.Page
    $database = $script:Ui.State.Database
    $page.Testing = $false
    $database.Test = if ($Finished.Error) { @{ Ok = $false; Message = [string] $Finished.Error } } else { $Finished.Result }
    $database.Tested = ([bool] $database.Test.Ok -and [bool] $database.Test.CanCreate)
    Show-PageDatabaseResult
    if ($database.Tested -and $page.ContinueAfterTest) { Move-SetupPage 1 }
}

function Test-PageDatabase {
    param($State, $Page)
    $controls = $Page.Controls
    if ($controls.Name) {
        if ($controls.Name.Text.Trim() -notmatch '^[A-Za-z0-9_]{1,64}$') { return @((T 'db.error.name')) }
        if ($controls.User.Text.Trim() -notmatch '^[A-Za-z0-9_]{1,32}$') { return @((T 'db.error.user')) }
    }
    if (-not $controls.AdminUser.Text.Trim()) { return @((T 'database.error.admin')) }
    return @()
}

function Leave-PageDatabase {
    param($State, $Page)
    Read-PageDatabase
    if (-not $State.Database.Tested) {
        # Next runs the test itself; the page moves on when it passes.
        Start-PageDatabaseTest $true
        return $false
    }
    if ($State.Flow -eq 'install' -and -not $State.Database.AppPassword) {
        $State.Database.AppPassword = New-SetupPassword
        Add-SetupSecret $State.Database.AppPassword
    }
    return $true
}

# -- 5. media folders --------------------------------------------------------------------------

function Build-PageMedia {
    param($State, $Content, $Page)
    $width = $Content.ClientSize.Width
    $Page.Rows = New-Object System.Collections.ArrayList
    foreach ($root in @($State.Roots)) { [void] $Page.Rows.Add(@{ Id = [string] $root.Id; Path = [string] $root.Path; Kind = [string] $root.Kind; Sample = $root.Sample }) }
    $list = New-UiCard -Width $width -Height (S 236)
    $list.Location = New-UiPoint 0 0
    $Content.Controls.Add($list)
    $inner = New-Object System.Windows.Forms.Panel
    $inner.BackColor = Get-UiColor 'Window'
    $inner.Location = New-UiPoint 2 2
    $inner.Size = New-UiSize ($width - 4) ($list.Height - 4)
    $inner.AutoScroll = $true
    $list.Controls.Add($inner)

    $add = New-UiButton -Text (T 'media.add') -Kind 'Secondary' -Glyph 0xE710 -Height 32
    $add.Location = New-UiPoint 0 ($list.Bottom + (S 10))
    $add.Add_Click({ Add-PageMediaFolder })
    $Content.Controls.Add($add)
    $kinds = New-UiLabel -Text (T 'media.kinds') -Width ($width - $add.Width - (S 16)) -Font 'Small' -Color 'Muted'
    $kinds.Location = New-UiPoint ($add.Right + (S 16)) ($add.Top + [int] (($add.Height - $kinds.Height) / 2))
    $Content.Controls.Add($kinds)

    $stack = New-UiStack $Content 0 ($add.Bottom + (S 12)) $width
    $noteKey = if ($State.Mode -eq 'maintain') { 'media.note.maintain' } else { 'media.note' }
    [void] (Add-UiStack $stack (New-UiNotice -Text (T $noteKey) -Kind 'info' -Width $width) -Gap 8)
    $scan = New-UiCheck -Text (T 'media.scanNow') -Checked ([bool] $State.Options.StartScan) -Width $width
    [void] (Add-UiStack $stack $scan)
    $Page.Controls = @{ List = $inner; Scan = $scan }
    $Page.Validate = 'Test-PageMedia'
    $Page.Leave = 'Leave-PageMedia'
    Update-PageMediaRows
}

function Get-PageMediaProblems {
    param([int] $Index)
    $page = $script:Ui.Page
    $row = $page.Rows[$Index]
    $others = @()
    for ($i = 0; $i -lt $page.Rows.Count; $i++) { if ($i -ne $Index) { $others += [string] $page.Rows[$i].Path } }
    if ($script:Ui.Preview) {
        # A preview has no disks to look at: a sample row brings its own findings.
        if ($row.Sample) { return $row.Sample }
        return @{ Errors = @(); Warnings = @() }
    }
    return (Test-SetupMediaFolder -Path $row.Path -ProjectRoot $script:Ui.State.TargetRoot -Others $others)
}

function Update-PageMediaRows {
    $page = $script:Ui.Page
    $panel = $page.Controls.List
    $panel.SuspendLayout()
    foreach ($control in @($panel.Controls)) { $panel.Controls.Remove($control); $control.Dispose() }
    $width = $panel.ClientSize.Width - (S 20)
    if ($page.Rows.Count -eq 0) {
        $empty = New-UiLabel -Text (T 'media.empty') -Width ($width - (S 20)) -Color 'Muted'
        $empty.Location = New-UiPoint (S 16) (S 18)
        $panel.Controls.Add($empty)
        $panel.ResumeLayout()
        return
    }
    $kindNames = @((T 'media.kind.music'), (T 'media.kind.movies'), (T 'media.kind.mixed'))
    $kindKeys = @('music', 'movies', 'mixed')
    $y = 0
    for ($index = 0; $index -lt $page.Rows.Count; $index++) {
        $row = $page.Rows[$index]
        $problems = Get-PageMediaProblems $index
        $icon = New-Object System.Windows.Forms.Label
        $icon.Font = $script:Ui.Fonts.IconLarge
        $icon.ForeColor = Get-UiColor 'Accent'
        $icon.Text = Get-UiGlyph 0xED25
        $icon.AutoSize = $true
        $icon.Location = New-UiPoint (S 12) ($y + (S 11))
        $panel.Controls.Add($icon)

        $remove = New-UiButton -Text '' -Kind 'Chrome' -Width 32 -Glyph 0xE74D -Height 30
        $remove.Location = New-UiPoint ($width - $remove.Width + (S 12)) ($y + (S 8))
        $remove.Tag = $index
        $remove.AccessibleName = T 'media.remove'
        $remove.Add_Click({ $script:Ui.Page.Rows.RemoveAt([int] $this.Tag); Update-PageMediaRows })
        $panel.Controls.Add($remove)
        $change = New-UiButton -Text (T 'media.change') -Kind 'Ghost' -Height 30
        $change.Font = $script:Ui.Fonts.Small
        $change.Width = [System.Windows.Forms.TextRenderer]::MeasureText($change.Text, $change.Font).Width + (S 18)
        $change.Location = New-UiPoint ($remove.Left - $change.Width - (S 2)) ($y + (S 8))
        $change.Tag = $index
        $change.Add_Click({ Edit-PageMediaFolder ([int] $this.Tag) })
        $panel.Controls.Add($change)
        $kind = New-UiCombo -Items $kindNames -Selected ([Math]::Max(0, [array]::IndexOf($kindKeys, [string] $row.Kind))) -Width (S 112)
        $kind.Font = $script:Ui.Fonts.Small
        $kind.Location = New-UiPoint ($change.Left - $kind.Width - (S 8)) ($y + (S 11))
        $kind.Tag = $index
        $kind.Add_SelectedIndexChanged({ $script:Ui.Page.Rows[[int] $this.Tag].Kind = @('music', 'movies', 'mixed')[$this.SelectedIndex] })
        $panel.Controls.Add($kind)

        $textWidth = $kind.Left - (S 50) - (S 10)
        $path = New-Object System.Windows.Forms.Label
        $path.UseMnemonic = $false
        $path.Font = $script:Ui.Fonts.Strong
        $path.ForeColor = Get-UiColor 'Text'
        $path.AutoEllipsis = $true
        $path.Text = [string] $row.Path
        $path.Location = New-UiPoint (S 48) ($y + (S 7))
        $path.Size = New-UiSize $textWidth (S 19)
        $panel.Controls.Add($path)
        $note = ''
        $color = 'Muted'
        if (@($problems.Errors).Count -gt 0) { $note = [string] $problems.Errors[0]; $color = 'Danger' }
        elseif (@($problems.Warnings).Count -gt 0) { $note = [string] $problems.Warnings[0]; $color = 'Warning' }
        elseif ($row.Id) { $note = T 'media.row.known' $row.Id }
        else { $note = T 'media.row.new' }
        $detail = New-UiLabel -Text $note -Width $textWidth -Font 'Small' -Color $color
        $detail.Location = New-UiPoint (S 48) ($y + (S 26))
        $panel.Controls.Add($detail)
        $y += [Math]::Max((S 48), (S 30) + $detail.Height + (S 4))
        $line = New-Object System.Windows.Forms.Panel
        $line.BackColor = Get-UiColor 'Border'
        $line.Location = New-UiPoint (S 12) $y
        $line.Size = New-UiSize $width 1
        $panel.Controls.Add($line)
        $y += 1
    }
    $panel.ResumeLayout()
}

function Add-PageMediaFolder {
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.ShowNewFolderButton = $false
    $dialog.Description = T 'media.pick'
    if ($dialog.ShowDialog($script:Ui.Form) -ne 'OK') { return }
    $page = $script:Ui.Page
    [void] $page.Rows.Add(@{ Id = ''; Path = $dialog.SelectedPath; Kind = (Get-SetupGuessedKind $dialog.SelectedPath) })
    Update-PageMediaRows
}

function Edit-PageMediaFolder {
    param([int] $Index)
    $row = $script:Ui.Page.Rows[$Index]
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.ShowNewFolderButton = $false
    $dialog.Description = T 'media.pickChange'
    if (Test-Path -LiteralPath $row.Path) { $dialog.SelectedPath = $row.Path }
    if ($dialog.ShowDialog($script:Ui.Form) -ne 'OK') { return }
    # The identifier stays: this is the same library in a new place.
    $row.Path = $dialog.SelectedPath
    Update-PageMediaRows
}

function Test-PageMedia {
    param($State, $Page)
    if ($Page.Rows.Count -eq 0) { return @((T 'media.error.none')) }
    for ($index = 0; $index -lt $Page.Rows.Count; $index++) {
        $problems = Get-PageMediaProblems $index
        if (@($problems.Errors).Count -gt 0) { return @([string] $problems.Errors[0]) }
    }
    return @()
}

function Leave-PageMedia {
    param($State, $Page)
    $warnings = @()
    for ($index = 0; $index -lt $Page.Rows.Count; $index++) { $warnings += @((Get-PageMediaProblems $index).Warnings) }
    if ($warnings.Count -gt 0) {
        $text = (@($warnings | Select-Object -Unique) -join "`n`n") + "`n`n" + (T 'media.confirm')
        $answer = [System.Windows.Forms.MessageBox]::Show($script:Ui.Form, $text, (T 'app.title'), 'YesNo', 'Warning')
        if ($answer -ne 'Yes') { return $false }
    }
    $State.Roots = @($Page.Rows | ForEach-Object { @{ Id = [string] $_.Id; Path = [System.IO.Path]::GetFullPath([string] $_.Path); Kind = [string] $_.Kind } })
    $State.Options.StartScan = [bool] $Page.Controls.Scan.Checked
    try { Set-SetupRootIds $State } catch { return [string] $_.Exception.Message }
    return $true
}

# -- 6. access ---------------------------------------------------------------------------------

function Build-PageAccess {
    param($State, $Content, $Page)
    $width = $Content.ClientSize.Width
    $half = [int] (($width - (S 12)) / 2)
    $cards = @{}
    $order = @('local', 'lan', 'direct', 'vps')
    $heights = @()
    foreach ($mode in $order) {
        $card = New-UiOption -Title (T ('access.mode.' + $mode + '.name')) -Description (T ('access.mode.' + $mode + '.text')) -Width $half -Checked ($State.Access.Mode -eq $mode)
        $card.Tag = $mode
        $cards[$mode] = $card
        $heights += $card.Height
    }
    $rowHeights = @([Math]::Max($heights[0], $heights[1]), [Math]::Max($heights[2], $heights[3]))
    for ($i = 0; $i -lt 4; $i++) {
        $card = $cards[$order[$i]]
        $row = [int] [Math]::Floor($i / 2)
        $card.Height = $rowHeights[$row]
        $card.Location = New-UiPoint (($i % 2) * ($half + (S 12))) ($(if ($row -eq 0) { 0 } else { $rowHeights[0] + (S 10) }))
        $card.Add_CheckedChanged({
                if (-not $this.Checked) { return }
                foreach ($other in $script:Ui.Page.Cards.Values) { if ($other -ne $this) { $other.Checked = $false } }
                Save-PageAccessFields
                $script:Ui.Page.Mode = [string] $this.Tag
                Update-PageAccessFields
            })
        $Content.Controls.Add($card)
    }
    $fields = New-Object System.Windows.Forms.Panel
    $fields.BackColor = Get-UiColor 'Window'
    $fields.Location = New-UiPoint 0 ($rowHeights[0] + $rowHeights[1] + (S 22))
    $fields.Size = New-UiSize $width ($Content.ClientSize.Height - $fields.Top)
    $Content.Controls.Add($fields)
    $Page.Cards = $cards
    $Page.Mode = [string] $State.Access.Mode
    # A working copy: nothing reaches the state until Next.
    $Page.Draft = @{}
    foreach ($key in @($State.Access.Keys)) { $Page.Draft[$key] = $State.Access[$key] }
    $Page.Controls = @{ Fields = $fields }
    $Page.Validate = 'Test-PageAccess'
    $Page.Leave = 'Leave-PageAccess'
    Update-PageAccessFields
}

function Save-PageAccessFields {
    <# Keeps what was typed when the user looks at another mode and comes back. #>
    $page = $script:Ui.Page
    $controls = $page.Controls
    $draft = $page.Draft
    if ($controls.Host) { $draft.HostName = $controls.Host.Text.Trim() }
    if ($controls.Vps) { $draft.VpsAddresses = @($controls.Vps.Text -split '[\s,;]+' | Where-Object { $_ }) }
    if ($controls.Home) { $draft.HomeAddress = $controls.Home.Text.Trim() }
    if ($controls.AllowLan) { $draft.AllowLan = [bool] $controls.AllowLan.Checked }
    if ($controls.Regenerate) { $draft.Regenerate = [bool] $controls.Regenerate.Checked }
    if ($controls.Certificate) { $draft.CertificateFile = $controls.Certificate.Text.Trim(); $draft.KeyFile = $controls.Key.Text.Trim() }
    if ($controls.SelfSigned) { $draft.SelfSigned = [bool] $controls.SelfSigned.Checked }
    if ($controls.DisableHttps) { $draft.DisableExistingHttps = [bool] $controls.DisableHttps.Checked }
}

function Update-PageAccessFields {
    $page = $script:Ui.Page
    $state = $script:Ui.State
    $panel = $page.Controls.Fields
    $panel.SuspendLayout()
    foreach ($control in @($panel.Controls)) { $panel.Controls.Remove($control); $control.Dispose() }
    $page.Controls = @{ Fields = $panel }
    $controls = $page.Controls
    $draft = $page.Draft
    # The panel scrolls when what a mode asks does not fit (English is longer, 150 % is
    # taller); the fields leave room for the bar so it never needs a horizontal one.
    $panel.AutoScroll = $true
    $width = $panel.ClientSize.Width - [System.Windows.Forms.SystemInformation]::VerticalScrollBarWidth
    $half = [int] (($width - (S 16)) / 2)
    $stack = New-UiStack $panel 0 0 $width
    $lan = [string] $state.Env.Lan.Address
    $httpsHosts = @($state.Env.Wamp.Apache.HttpsHosts)
    # First, not last: the box the error message names was cut off below the panel, and in
    # English not visible at all (audit P2-1).
    if (($page.Mode -eq 'vps' -or $page.Mode -eq 'direct') -and $httpsHosts.Count -gt 0) {
        $controls.DisableHttps = Add-UiStack $stack (New-UiCheck -Text (T 'access.disableHttps' ($httpsHosts -join ', ')) -Checked ([bool] $draft.DisableExistingHttps) -Width $width) -Gap 10
    }
    switch ($page.Mode) {
        'local' {
            [void] (Add-UiStack $stack (New-UiNotice -Text (T 'access.local.note') -Kind 'info' -Width $width))
        }
        'lan' {
            [void] (Add-UiStack $stack (New-UiNotice -Text (T 'access.lan.warning') -Kind 'warn' -Width $width) -Gap 10)
            if ([string] $state.Env.Lan.Category -eq 'Public') {
                [void] (Add-UiStack $stack (New-UiNotice -Text (T 'log.firewall.publicNetwork') -Kind 'warn' -Width $width) -Gap 10)
            }
            $address = if ($lan) { "http://$lan/" } else { T 'access.lan.unknown' }
            [void] (Add-UiStack $stack (New-UiLabel -Text (T 'access.lan.address' $address) -Width $width) -Gap 6)
            [void] (Add-UiStack $stack (New-UiLabel -Text (T 'access.lan.changes') -Width $width -Font 'Small' -Color 'Muted'))
        }
        'direct' {
            $controls.Host = Add-UiField $stack (T 'access.host') (New-UiTextBox -Text ([string] $draft.HostName) -Width $half) -Gap 8
            $left = New-UiStack $panel 0 $stack.Y $half
            $right = New-UiStack $panel ($half + (S 16)) $stack.Y $half
            $controls.Certificate = Add-UiField $left (T 'access.certificate') (New-UiTextBox -Text ([string] $draft.CertificateFile) -Width $half) -Gap 4
            $controls.Key = Add-UiField $right (T 'access.key') (New-UiTextBox -Text ([string] $draft.KeyFile) -Width $half) -Gap 4
            # A file picker beside each path: typing C:\...\fullchain.pem by hand is where a layperson stops (audit P3-23).
            $picks = @(
                @($left, 'Certificate', (T 'access.certificate.pick'), (T 'access.certificate.filter')),
                @($right, 'Key', (T 'access.key.pick'), (T 'access.key.filter')))
            foreach ($pick in $picks) {
                $browse = New-UiButton -Text (T 'access.browse') -Kind 'Ghost' -Height 28
                $browse.Font = $script:Ui.Fonts.Small
                $browse.Tag = @{ Field = $pick[1]; Title = $pick[2]; Filter = $pick[3] }
                $browse.Add_Click({
                        $info = $this.Tag
                        $dialog = New-Object System.Windows.Forms.OpenFileDialog
                        $dialog.Title = $info.Title
                        $dialog.Filter = $info.Filter
                        $field = $script:Ui.Page.Controls[$info.Field]
                        $current = $field.Text.Trim()
                        if ($current -and (Test-Path -LiteralPath (Split-Path -Parent $current) -ErrorAction SilentlyContinue)) { $dialog.InitialDirectory = Split-Path -Parent $current }
                        if ($dialog.ShowDialog($script:Ui.Form) -eq 'OK') { $field.Text = $dialog.FileName }
                        $dialog.Dispose()
                    })
                $controls[$pick[1] + 'Browse'] = Add-UiStack $pick[0] $browse -Gap 6
            }
            $stack.Y = [Math]::Max($left.Y, $right.Y)
            $controls.SelfSigned = Add-UiStack $stack (New-UiCheck -Text (T 'access.selfSigned') -Checked ([bool] $draft.SelfSigned) -Width $width) -Gap 8
            $controls.SelfSigned.Add_CheckedChanged({
                    foreach ($name in @('Certificate', 'Key', 'CertificateBrowse', 'KeyBrowse')) { $script:Ui.Page.Controls[$name].Enabled = -not $this.Checked }
                })
            foreach ($name in @('Certificate', 'Key', 'CertificateBrowse', 'KeyBrowse')) { $controls[$name].Enabled = -not $draft.SelfSigned }
            [void] (Add-UiStack $stack (New-UiNotice -Text (T 'access.direct.note' $(if ($lan) { $lan } else { '?' })) -Kind 'info' -Width $width) -Gap 8)
        }
        'vps' {
            # Below the "switch off the existing HTTPS host" box when there is one.
            $left = New-UiStack $panel 0 $stack.Y $half
            $right = New-UiStack $panel ($half + (S 16)) $stack.Y $half
            $controls.Host = Add-UiField $left (T 'access.host') (New-UiTextBox -Text ([string] $draft.HostName) -Width $half) -Hint (T 'access.host.hint') -Gap 8
            $controls.Vps = Add-UiField $right (T 'access.vps') (New-UiTextBox -Text (@($draft.VpsAddresses) -join ', ') -Width $half) -Hint (T 'access.vps.hint') -Gap 8
            $stack.Y = [Math]::Max($left.Y, $right.Y)
            [void] (Add-UiStack $stack (New-UiLabel -Text (T 'access.home') -Width $width -Font 'Small' -Color 'Muted') -Gap 3)
            $controls.Home = New-UiTextBox -Text ([string] $draft.HomeAddress) -Width $half
            $detect = New-UiButton -Text (T 'access.home.detect') -Kind 'Ghost' -Height 28
            $detect.Font = $script:Ui.Fonts.Small
            $detect.Add_Click({ Find-PageAccessHomeAddress })
            Add-UiRow $stack @($controls.Home, $detect) -Gap 3 -Spacing 8
            [void] (Add-UiStack $stack (New-UiLabel -Text (T 'access.home.hint') -Width $width -Font 'Small' -Color 'Muted') -Gap 8)
            $controls.AllowLan = Add-UiStack $stack (New-UiCheck -Text (T 'access.allowLan' $(if ($lan) { $lan } else { '192.168.x.x' })) -Checked ([bool] $draft.AllowLan) -Width $width) -Gap 4
            $originExists = Test-Path -LiteralPath (Get-SetupPaths $state).OriginCert
            if ($originExists -or $draft.ShowRegenerate) {
                $controls.Regenerate = Add-UiStack $stack (New-UiCheck -Text (T 'access.regenerate') -Checked ([bool] $draft.Regenerate) -Width $width) -Gap 4
            }
            [void] (Add-UiStack $stack (New-UiLabel -Text (T 'access.vps.creates') -Width $width -Font 'Small' -Color 'Muted') -Gap 4)
        }
    }
    $panel.ResumeLayout()
}

function Find-PageAccessHomeAddress {
    <# Asks a public service which address this connection has. Only on the user's click. #>
    if ($script:Ui.Preview) { return }
    if ($script:SetupContext.DryRun) { Set-SetupMessage (T 'requirements.dryRunAction') 'info'; return }
    try {
        $address = (Invoke-WebRequest -Uri 'https://api.ipify.org' -UseBasicParsing -TimeoutSec 8).Content.Trim()
        $parsed = $null
        if ([System.Net.IPAddress]::TryParse($address, [ref] $parsed)) { $script:Ui.Page.Controls.Home.Text = $address; Set-SetupMessage '' }
        else { Set-SetupMessage (T 'access.home.failed') }
    } catch { Set-SetupMessage (T 'access.home.failed') }
}

function Test-PageAccess {
    param($State, $Page)
    Save-PageAccessFields
    $draft = $Page.Draft
    $draft.Mode = [string] $Page.Mode
    if ($draft.Mode -eq 'direct' -and -not $draft.SelfSigned -and -not $draft.CertificateFile) { return @((T 'access.error.certificate')) }
    return @(Test-SetupAccess -State $State -Access $draft)
}

function Leave-PageAccess {
    param($State, $Page)
    $draft = $Page.Draft
    foreach ($key in @($draft.Keys)) { $State.Access[$key] = $draft[$key] }
    $State.Access.Mode = [string] $Page.Mode
    $paths = Get-SetupPaths $State
    if ($State.Access.Mode -eq 'vps') { $State.Access.CertificateFile = $paths.OriginCert; $State.Access.KeyFile = $paths.OriginKey; $State.Access.SelfSigned = $false }
    elseif ($State.Access.Mode -eq 'direct' -and $State.Access.SelfSigned) { $State.Access.CertificateFile = $paths.SelfCert; $State.Access.KeyFile = $paths.SelfKey }
    return $true
}

# -- 7. administrator --------------------------------------------------------------------------

function Build-PageAdmin {
    param($State, $Content, $Page)
    $width = $Content.ClientSize.Width
    $half = [int] (($width - (S 16)) / 2)
    $stack = New-UiStack $Content 0 (S 2) $width
    $username = Add-UiField $stack (T 'admin.username') (New-UiTextBox -Text ([string] $State.Admin.Username) -Width $half) -Hint (T 'admin.username.hint')
    $email = Add-UiField $stack (T 'admin.email') (New-UiTextBox -Text ([string] $State.Admin.Email) -Width $half) -Hint (T 'admin.email.hint')
    $left = New-UiStack $Content 0 $stack.Y $half
    $right = New-UiStack $Content ($half + (S 16)) $stack.Y $half
    $password = Add-UiField $left (T 'admin.password') (New-UiTextBox -Text ([string] $State.Admin.Password) -Width $half -Password) -Gap 6
    $repeat = Add-UiField $right (T 'admin.repeat') (New-UiTextBox -Text ([string] $State.Admin.Password) -Width $half -Password) -Gap 6
    $stack.Y = $left.Y
    $show = Add-UiStack $stack (New-UiCheck -Text (T 'admin.show') -Checked $false -Width $half) -Gap 14
    $show.Add_CheckedChanged({
            $script:Ui.Page.Controls.Password.UseSystemPasswordChar = -not $this.Checked
            $script:Ui.Page.Controls.Repeat.UseSystemPasswordChar = -not $this.Checked
        })
    $noteKey = if ($State.Mode -eq 'maintain') { 'admin.note.maintain' } else { 'admin.note' }
    [void] (Add-UiStack $stack (New-UiNotice -Text (T $noteKey) -Kind 'info' -Width $width))
    $Page.Controls = @{ Username = $username; Email = $email; Password = $password; Repeat = $repeat }
    $Page.Validate = 'Test-PageAdmin'
    $Page.Leave = 'Leave-PageAdmin'
}

function Test-PageAdmin {
    param($State, $Page)
    $controls = $Page.Controls
    return @(Test-SetupAdminAccount -Username $controls.Username.Text.Trim() -Email $controls.Email.Text.Trim() -Password $controls.Password.Text -Repeat $controls.Repeat.Text)
}

function Leave-PageAdmin {
    param($State, $Page)
    $controls = $Page.Controls
    $State.Admin = @{ Username = $controls.Username.Text.Trim(); Email = $controls.Email.Text.Trim(); Password = $controls.Password.Text }
    Add-SetupSecret $State.Admin.Password
    return $true
}

# -- 8. summary --------------------------------------------------------------------------------

function Build-PageSummary {
    param($State, $Content, $Page)
    $width = $Content.ClientSize.Width
    $options = @()
    if ($State.Flow -eq 'install') {
        $options += , @('AutoStartServices', (T 'summary.option.services'))
        $options += , @('StartScan', (T 'summary.option.scan'))
    }
    $generic = @($State.Env.Firewall.Generic | Where-Object { $_.Enabled })
    if (@('install', 'access') -contains $State.Flow -and $generic.Count -gt 0 -and @('vps', 'lan') -contains $State.Access.Mode) {
        $options += , @('DisableGenericRules', (T 'summary.option.generic' $generic.Count))
    }
    $optionsHeight = 0
    $checks = @{}
    foreach ($option in $options) {
        $check = New-UiCheck -Text ([string] $option[1]) -Checked ([bool] $State.Options[$option[0]]) -Width $width
        $check.Tag = [string] $option[0]
        $check.Add_CheckedChanged({ $script:Ui.State.Options[[string] $this.Tag] = [bool] $this.Checked; Update-PageSummary })
        $checks[$option[0]] = $check
        $optionsHeight += $check.Height + (S 4)
    }
    $listHeight = $Content.ClientSize.Height - $optionsHeight - $(if ($options.Count -gt 0) { S 10 } else { 0 })
    $card = New-UiCard -Width $width -Height $listHeight
    $card.Location = New-UiPoint 0 0
    $Content.Controls.Add($card)
    $list = New-Object System.Windows.Forms.Panel
    $list.BackColor = Get-UiColor 'Window'
    $list.Location = New-UiPoint 2 2
    $list.Size = New-UiSize ($width - 4) ($listHeight - 4)
    $list.AutoScroll = $true
    $card.Controls.Add($list)
    $y = $listHeight + (S 10)
    foreach ($option in $options) {
        $check = $checks[$option[0]]
        $check.Location = New-UiPoint 0 $y
        $Content.Controls.Add($check)
        $y += $check.Height + (S 4)
    }
    $Page.Controls = @{ List = $list }
    $Page.NextText = T ('summary.go.' + $State.Flow)
    if ($State.Flow -eq 'uninstall') { $Page.NextKind = 'Danger' }
    $Page.Leave = 'Leave-PageSummary'
    Update-PageSummary
}

function Update-PageSummary {
    $page = $script:Ui.Page
    $state = $script:Ui.State
    $list = $page.Controls.List
    $list.SuspendLayout()
    foreach ($control in @($list.Controls)) { $list.Controls.Remove($control); $control.Dispose() }
    $width = $list.ClientSize.Width - (S 34)
    $plan = @(Get-SetupPlan $state)
    $y = S 10
    $number = 0
    foreach ($step in $plan) {
        $number++
        $mark = New-UiLabel -Text "$number." -Width (S 28) -Font 'Strong' -Color 'Accent'
        $mark.Location = New-UiPoint (S 14) $y
        $list.Controls.Add($mark)
        $title = New-UiLabel -Text ([string] $step.Title) -Width ($width - (S 30)) -Font 'Strong'
        $title.Location = New-UiPoint (S 44) $y
        $list.Controls.Add($title)
        $y += $title.Height + (S 1)
        foreach ($detail in @($step.Details)) {
            if (-not $detail) { continue }
            $line = New-UiLabel -Text ([string] $detail) -Width ($width - (S 30)) -Font 'Small' -Color 'Muted'
            $line.Location = New-UiPoint (S 44) $y
            $list.Controls.Add($line)
            $y += $line.Height
        }
        $y += S 9
    }
    $spacer = New-Object System.Windows.Forms.Panel
    $spacer.Location = New-UiPoint 0 $y
    $spacer.Size = New-UiSize 1 (S 4)
    $list.Controls.Add($spacer)
    $list.ResumeLayout()
}

function Leave-PageSummary {
    param($State, $Page)
    $State.Plan = @(Get-SetupPlan $State)
    if ($State.Flow -eq 'uninstall') {
        $answer = [System.Windows.Forms.MessageBox]::Show($script:Ui.Form, (T 'uninstall.lastQuestion'), (T 'app.title'), 'YesNo', 'Warning')
        if ($answer -ne 'Yes') { return $false }
    }
    $State.PlanResult = $null
    return $true
}

# -- 9. progress -------------------------------------------------------------------------------

function Build-PageProgress {
    param($State, $Content, $Page)
    $Page.CloseText = T 'close.afterRun'
    $width = $Content.ClientSize.Width
    $height = $Content.ClientSize.Height
    $plan = @($State.Plan)
    $status = New-UiLabel -Text (T 'progress.starting') -Width $width -Font 'Strong'
    $status.AutoEllipsis = $true
    $status.Location = New-UiPoint 0 0
    $Content.Controls.Add($status)
    $bar = New-Object TryHackX.Setup.ThinProgress
    $bar.Location = New-UiPoint 0 (S 26)
    $bar.Size = New-UiSize $width (S 7)
    $bar.BackColor = Get-UiColor 'Window'
    $Content.Controls.Add($bar)

    $top = S 46
    $buttonsHeight = S 40
    $paneHeight = $height - $top - $buttonsHeight
    $stepsWidth = S 290
    $steps = New-UiCard -Width $stepsWidth -Height $paneHeight -Fill 'Surface'
    $steps.Location = New-UiPoint 0 $top
    $Content.Controls.Add($steps)
    $stepsInner = New-Object System.Windows.Forms.Panel
    $stepsInner.BackColor = Get-UiColor 'Surface'
    $stepsInner.Location = New-UiPoint 2 (S 6)
    $stepsInner.Size = New-UiSize ($stepsWidth - 4) ($paneHeight - (S 12))
    $stepsInner.AutoScroll = $true
    $steps.Controls.Add($stepsInner)
    $glyphs = @{}
    $labels = @{}
    $rowHeight = S 25
    $y = 0
    foreach ($step in $plan) {
        $glyph = New-UiStatus 'Pending' 16
        $glyph.BackColor = Get-UiColor 'Surface'
        $glyph.Location = New-UiPoint (S 10) ($y + [int] (($rowHeight - $glyph.Height) / 2))
        $stepsInner.Controls.Add($glyph)
        $label = New-Object System.Windows.Forms.Label
        $label.UseMnemonic = $false
        $label.Font = $script:Ui.Fonts.Small
        $label.ForeColor = Get-UiColor 'Muted'
        $label.BackColor = Get-UiColor 'Surface'
        $label.AutoEllipsis = $true
        $label.Text = [string] $step.Title
        $label.TextAlign = 'MiddleLeft'
        $label.Location = New-UiPoint (S 34) $y
        $label.Size = New-UiSize ($stepsWidth - (S 62)) $rowHeight
        $stepsInner.Controls.Add($label)
        $glyphs[[string] $step.Id] = $glyph
        $labels[[string] $step.Id] = $label
        $y += $rowHeight
    }

    $log = New-Object System.Windows.Forms.TextBox
    $log.Multiline = $true
    $log.ReadOnly = $true
    $log.ScrollBars = 'Vertical'
    $log.WordWrap = $true
    $log.BorderStyle = 'FixedSingle'
    $log.BackColor = Get-UiColor 'Window'
    $log.ForeColor = Get-UiColor 'Text'
    $log.Font = $script:Ui.Fonts.Mono
    $log.Location = New-UiPoint ($stepsWidth + (S 12)) $top
    $log.Size = New-UiSize ($width - $stepsWidth - (S 12)) $paneHeight
    $log.TabStop = $false
    $Content.Controls.Add($log)

    $save = New-UiButton -Text (T 'progress.save') -Kind 'Ghost' -Glyph 0xE74E -Height 30
    $save.Font = $script:Ui.Fonts.Small
    $save.Location = New-UiPoint ($width - $save.Width) ($height - (S 32))
    $save.Add_Click({ Save-SetupLog })
    $Content.Controls.Add($save)
    $retry = New-UiButton -Text (T 'progress.retry') -Kind 'Secondary' -Glyph 0xE72C -Height 30
    $retry.Location = New-UiPoint 0 ($height - (S 32))
    $retry.Visible = $false
    $retry.Add_Click({ Start-PagePlan })
    $Content.Controls.Add($retry)
    $problem = New-UiLabel -Text '' -Width ($width - $save.Width - $retry.Width - (S 30)) -Font 'Small' -Color 'Danger'
    $problem.AutoEllipsis = $true
    $problem.Height = S 32
    $problem.Location = New-UiPoint ($retry.Width + (S 12)) ($height - (S 32))
    $Content.Controls.Add($problem)

    $Page.Controls = @{ Status = $status; Bar = $bar; Glyphs = $glyphs; Labels = $labels; Log = $log; Retry = $retry; Problem = $problem; Steps = $stepsInner }
    $Page.OnStep = 'Update-PageProgressStep'
    $Page.Enter = 'Enter-PageProgress'
    $Page.NextDisabled = $true
    $Page.BackDisabled = $true
    $Page.Leave = 'Leave-PageProgress'
    if ($State.PreviewProgress) { Show-PageProgressSample $State.PreviewProgress }
}

function Show-PageProgressSample {
    <# -Preview only: paints a run that is half way, or one that has just failed. #>
    param([hashtable] $Sample)
    $page = $script:Ui.Page
    $plan = @($script:Ui.State.Plan)
    $index = 0
    foreach ($step in $plan) {
        $index++
        $status = if ($index -lt $Sample.At) { 'done' } elseif ($index -eq $Sample.At) { $(if ($Sample.Failed) { 'failed' } else { 'running' }) } else { 'pending' }
        if ($status -ne 'pending') { Update-PageProgressStep @{ Id = $step.Id; Status = $status; Index = $index; Count = $plan.Count } }
    }
    foreach ($line in @($Sample.Log)) { $page.Controls.Log.AppendText($line + [Environment]::NewLine) }
    if ($Sample.Failed) {
        $page.Controls.Status.Text = T 'progress.failed'
        $page.Controls.Bar.BarColor = Get-UiColor 'Danger'
        $page.Controls.Retry.Visible = $true
        $page.Controls.Problem.Text = [string] $Sample.Error
        $page.BackDisabled = $false
    }
}

function Enter-PageProgress {
    param($State, $Page)
    if (-not $State.PlanResult) { Start-PagePlan }
}

function Start-PagePlan {
    $state = $script:Ui.State
    $page = $script:Ui.Page
    if ($script:Ui.Job) { return }
    $page.Controls.Retry.Visible = $false
    $page.Controls.Problem.Text = ''
    $page.NextDisabled = $true; $page.BackDisabled = $true
    foreach ($glyph in $page.Controls.Glyphs.Values) { $glyph.Kind = [TryHackX.Setup.StatusKind]::Pending }
    $page.Controls.Bar.Value = 0
    $page.Controls.Bar.BarColor = Get-UiColor 'Accent'
    Start-SetupJob -Kind 'plan' -OnDone 'Complete-PagePlan' -Arguments @{ State = $state; Plan = @($state.Plan) }
}

function Update-PageProgressStep {
    param($Message)
    $controls = $script:Ui.Page.Controls
    $id = [string] $Message.Id
    $glyph = $controls.Glyphs[$id]
    if (-not $glyph) { return }
    $glyph.Kind = [TryHackX.Setup.StatusKind] (ConvertTo-UiStatusKind ([string] $Message.Status))
    $label = $controls.Labels[$id]
    $label.ForeColor = if ($Message.Status -eq 'failed') { Get-UiColor 'Danger' } else { Get-UiColor 'Text' }
    $label.Font = if ($Message.Status -eq 'running') { $script:Ui.Fonts.Strong } else { $script:Ui.Fonts.Small }
    $completed = if ($Message.Status -eq 'done') { [int] $Message.Index } else { [int] $Message.Index - 1 }
    $controls.Bar.Value = [int] (100 * $completed / [Math]::Max(1, [int] $Message.Count))
    if ($Message.Status -eq 'running') {
        $controls.Status.Text = T 'progress.step' $Message.Index $Message.Count $label.Text
        $controls.Steps.ScrollControlIntoView($label)
    }
}

function Complete-PagePlan {
    param($Finished)
    $state = $script:Ui.State
    $page = $script:Ui.Page
    $controls = $page.Controls
    $result = if ($Finished.Error) { @{ Ok = $false; Error = [string] $Finished.Error } } else { $Finished.Result }
    $state.PlanResult = $result
    if ($result.Ok) {
        $controls.Bar.Value = 100
        $controls.Bar.BarColor = Get-UiColor 'Success'
        $controls.Status.Text = if ($script:SetupContext.DryRun) { T 'progress.doneDry' } else { T 'progress.done' }
        $page.NextDisabled = $false
        Set-SetupBusy $false
        return
    }
    $controls.Bar.BarColor = Get-UiColor 'Danger'
    $controls.Status.Text = T 'progress.failed'
    $controls.Problem.Text = [string] $result.Error
    $controls.Retry.Visible = $true
    $state.PlanResult = $null
    $page.BackDisabled = $false
    Set-SetupBusy $false
}

function Leave-PageProgress {
    param($State, $Page)
    if (-not $State.PlanResult -or -not $State.PlanResult.Ok) { return $false }
    return $true
}

function Save-SetupLog {
    $dialog = New-Object System.Windows.Forms.SaveFileDialog
    $dialog.Filter = 'Log (*.log)|*.log|Text (*.txt)|*.txt'
    $dialog.FileName = 'tryhackx-media-setup-' + (Get-SetupStamp) + '.log'
    if ($dialog.ShowDialog($script:Ui.Form) -ne 'OK') { return }
    # The lines were redacted when they were written; nothing is added here.
    [System.IO.File]::WriteAllLines($dialog.FileName, [string[]] @($script:Ui.LogLines), (New-Object System.Text.UTF8Encoding $false))
}

# -- 10. finish --------------------------------------------------------------------------------

function Build-PageFinish {
    param($State, $Content, $Page)
    $width = $Content.ClientSize.Width
    $stack = New-UiStack $Content 0 (S 2) $width
    $Page.HideBack = $true
    $Page.ConfirmClose = $false
    $dry = [bool] $script:SetupContext.DryRun
    $headline = if ($dry) { T 'finish.dry' } else { T ('finish.headline.' + $State.Flow) }
    $mark = New-UiStatus $(if ($dry) { 'Info' } else { 'Ok' }) 26
    $title = New-UiLabel -Text $headline -Width ($width - (S 44)) -Font 'Heading'
    Add-UiRow $stack @($mark, $title) -Gap 14 -Spacing 12

    $warnings = @()
    if ($State.Results -and $State.Results.Warnings) { $warnings = @($State.Results.Warnings) }
    if ($warnings.Count -gt 0) { [void] (Add-UiStack $stack (New-UiNotice -Text (($warnings | Select-Object -First 3) -join "`n") -Kind 'warn' -Width $width) -Gap 12) }

    if ($State.Flow -ne 'uninstall') {
        [void] (Add-UiStack $stack (New-UiLabel -Text (T 'finish.addresses') -Width $width -Font 'Small' -Color 'Muted') -Gap 4)
        foreach ($address in @(Get-SetupAddresses $State)) {
            $label = New-UiLabel -Text ([string] $address.Label) -Width (S 190)
            $link = New-Object System.Windows.Forms.LinkLabel
            $link.Font = $script:Ui.Fonts.Strong
            $link.LinkColor = Get-UiColor 'Accent'
            $link.AutoSize = $true
            $link.Text = [string] $address.Url
            $link.Tag = [string] $address.Url
            $link.Add_LinkClicked({ Open-SetupTarget ([string] $this.Tag) })
            Add-UiRow $stack @($label, $link) -Gap 4 -Spacing 6
        }
        $stack.Y += S 8
    }
    $buttons = @()
    if ($State.Flow -ne 'uninstall') {
        $open = New-UiButton -Text (T 'finish.open') -Kind 'Secondary' -Glyph 0xE774 -Height 32
        $open.Add_Click({ Open-SetupTarget 'http://localhost/' })
        $buttons += $open
    }
    $bundle = if ($State.Results) { [string] $State.Results.BundleDir } else { '' }
    if ($State.Access.Mode -eq 'vps' -and $bundle -and @('install', 'access') -contains $State.Flow) {
        $folder = New-UiButton -Text (T 'finish.bundle') -Kind 'Secondary' -Glyph 0xED25 -Height 32
        $folder.Tag = $bundle
        $folder.Add_Click({ if (Test-Path -LiteralPath ([string] $this.Tag)) { Open-SetupTarget ([string] $this.Tag) } })
        $buttons += $folder
        $guideFile = [string] $State.Results.GuideFile
        if ($guideFile) {
            $guide = New-UiButton -Text (T 'finish.guide') -Kind 'Secondary' -Glyph 0xE8A5 -Height 32
            $guide.Tag = $guideFile
            $guide.Add_Click({ if (Test-Path -LiteralPath ([string] $this.Tag)) { Open-SetupTarget ([string] $this.Tag) } })
            $buttons += $guide
        }
    }
    if ($buttons.Count -gt 0) { Add-UiRow $stack $buttons -Gap 14 -Spacing 10 }

    $notes = @()
    if ($State.Flow -eq 'install' -or $State.Flow -eq 'access') {
        switch ($State.Access.Mode) {
            'vps'    { $notes += (T 'finish.next.vps' $bundle) }
            'direct' { $notes += (T 'finish.next.direct' $State.Env.Lan.Address) }
            'lan'    { $notes += (T 'finish.next.lan') }
        }
    }
    if ($State.Flow -eq 'install') {
        if ($State.Results -and $State.Results.ScanStarted) { $notes += (T 'finish.scan') }
        $notes += (T 'finish.signIn' $State.Admin.Username)
        $notes += (T 'finish.later')
    } elseif ($State.Flow -eq 'uninstall') {
        $notes += (T 'finish.uninstalled' $State.TargetRoot)
    } elseif ($State.Flow -eq 'folders' -and $State.Results -and $State.Results.ScanStarted) {
        $notes += (T 'finish.scan')
    }
    if ($notes.Count -gt 0) { Add-UiBullets $stack $notes -Gap 7 }
    if ($State.Mode -eq 'maintain' -and $State.Flow -ne 'uninstall') {
        $Page.NextText = T 'button.backToStatus'
        $Page.Finish = 'Complete-MaintainFlow'
        $Page.CancelText = T 'button.close'
    } else {
        $Page.NextText = T 'button.finish'
        $Page.HideCancel = $true
    }
}
