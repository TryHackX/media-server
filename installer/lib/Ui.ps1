<#
    The window of the wizard: one borderless form with the steps on the left, the
    page on the right and Back / Next / Cancel below.

    Layout is done by hand, in logical pixels multiplied by one scale factor (S).
    That is deliberate: the same code lays the window out at 100 % and at 150 %,
    and -Preview can render either without changing the display settings. Fonts
    are created in pixels for the same reason.

    Event handlers here never capture local variables: a handler finds what it
    needs in $script:Ui or in the Tag of the control that raised the event ($this).

    Keep this file pure ASCII; translated text lives in installer\lang\*.psd1.
#>

$script:Ui = @{
    Scale = 1.0; Fonts = @{}; Form = $null; State = $null; Flow = @(); Index = 0; Page = $null
    Job = $null; JobTimer = $null; LogLines = $null; Preview = $false; Rebuild = $null
}

$script:UiSize = @{ Width = 980; Height = 664; Sidebar = 252; Top = 40; Footer = 68; Pad = 36 }

function Initialize-SetupUi {
    param([double] $Scale = 0)
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    if (-not ('TryHackX.Setup.WizardForm' -as [type])) {
        $source = [System.IO.File]::ReadAllText((Join-Path $script:SetupContext.InstallerDir 'lib\Controls.cs'), [System.Text.Encoding]::UTF8)
        # Accessibility: the option cards describe themselves to screen readers (IAccessible lives there).
        Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies System.Windows.Forms, System.Drawing, Accessibility
    }
    [void] [TryHackX.Setup.NativeMethods]::SetProcessDPIAware()
    [System.Windows.Forms.Application]::EnableVisualStyles()
    if ($Scale -le 0) {
        $Scale = [TryHackX.Setup.NativeMethods]::ScreenDpi() / 96.0
        # A window taller than the screen cannot be used: shrink rather than hide the buttons.
        $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
        $fit = [Math]::Min($area.Width / ($script:UiSize.Width + 24.0), $area.Height / ($script:UiSize.Height + 24.0))
        if ($fit -lt $Scale) { $Scale = [Math]::Max(0.8, $fit) }
    }
    $script:Ui.Scale = $Scale
    [TryHackX.Setup.Theme]::Scale = [single] $Scale
    Set-UiStatusNames
    $script:Ui.LogLines = New-Object System.Collections.ArrayList
    $font = { param($family, $size, $style) New-Object System.Drawing.Font($family, [single] ([Math]::Round($size * $Scale)), [System.Drawing.FontStyle] $style, [System.Drawing.GraphicsUnit]::Pixel) }
    $script:Ui.Fonts = @{
        Body     = & $font 'Segoe UI' 13 'Regular'
        Small    = & $font 'Segoe UI' 12 'Regular'
        Strong   = & $font 'Segoe UI Semibold' 13 'Regular'
        Title    = & $font 'Segoe UI Semibold' 23 'Regular'
        Heading  = & $font 'Segoe UI Semibold' 15 'Regular'
        Brand    = & $font 'Segoe UI Semibold' 16 'Regular'
        Mono     = & $font 'Consolas' 12 'Regular'
        Icon     = & $font 'Segoe MDL2 Assets' 13 'Regular'
        IconSmall = & $font 'Segoe MDL2 Assets' 10 'Regular'
        IconLarge = & $font 'Segoe MDL2 Assets' 20 'Regular'
    }
}

function Set-UiStatusNames {
    <# What a screen reader says for each status mark, in enum order (Ok, Warning, Error, Info, Pending, Running, Skipped). #>
    [TryHackX.Setup.StatusGlyph]::KindNames = [string[]] @(
        (T 'glyph.ok'), (T 'glyph.warning'), (T 'glyph.error'), (T 'glyph.info'),
        (T 'glyph.pending'), (T 'glyph.running'), (T 'glyph.skipped'))
}

function S { param([double] $Value) return [TryHackX.Setup.Theme]::S([single] $Value) }
function New-UiPoint { param($X, $Y) return New-Object System.Drawing.Point([int] $X, [int] $Y) }
function New-UiSize { param($Width, $Height) return New-Object System.Drawing.Size([int] $Width, [int] $Height) }
function Get-UiGlyph { param([int] $Code) return [string] [char] $Code }
function Get-UiColor { param([string] $Name) return [TryHackX.Setup.Theme]::$Name }

# -- controls ----------------------------------------------------------------------------------

function New-UiLabel {
    <# A label that wraps to the given width (already scaled) and is exactly as tall as its text. #>
    param([string] $Text, [int] $Width, [string] $Font = 'Body', [string] $Color = 'Text', $BackColor = $null)
    $label = New-Object System.Windows.Forms.Label
    $label.UseMnemonic = $false
    $label.AutoSize = $false
    $label.Font = $script:Ui.Fonts[$Font]
    $label.ForeColor = Get-UiColor $Color
    if ($null -ne $BackColor) { $label.BackColor = $BackColor }
    $label.Text = $Text
    # The label measures itself: it knows the padding it draws with, which a
    # separate TextRenderer call would have to guess (and guessing clips a line).
    $height = $label.GetPreferredSize((New-UiSize $Width 0)).Height
    $label.Size = New-UiSize $Width ([Math]::Max($height, (S 16)) + 1)
    return $label
}

function New-UiButton {
    param([string] $Text, [string] $Kind = 'Secondary', [int] $Width = 0, [int] $Glyph = 0, [int] $Height = 34)
    $button = New-Object TryHackX.Setup.RoundButton
    $button.Kind = [TryHackX.Setup.ButtonKind] $Kind
    $button.Font = if ($Kind -eq 'Primary' -or $Kind -eq 'Danger') { $script:Ui.Fonts.Strong } else { $script:Ui.Fonts.Body }
    $button.Text = $Text
    if ($Glyph -gt 0) { $button.Glyph = Get-UiGlyph $Glyph; $button.GlyphFont = $script:Ui.Fonts.Icon }
    if ($Width -le 0) {
        $measured = [System.Windows.Forms.TextRenderer]::MeasureText($Text, $button.Font).Width
        $Width = $measured + (S 30) + $(if ($Glyph -gt 0) { S 22 } else { 0 })
    } else { $Width = S $Width }
    $button.Size = New-UiSize $Width (S $Height)
    $button.BackColor = Get-UiColor 'Window'
    return $button
}

function New-UiTextBox {
    param([string] $Text = '', [int] $Width = 300, [switch] $Password, [switch] $Mono)
    $box = New-Object System.Windows.Forms.TextBox
    $box.BorderStyle = 'FixedSingle'
    $box.Font = if ($Mono) { $script:Ui.Fonts.Mono } else { $script:Ui.Fonts.Body }
    $box.Width = $Width
    $box.Text = $Text
    if ($Password) { $box.UseSystemPasswordChar = $true }
    return $box
}

function New-UiCheck {
    param([string] $Text, [bool] $Checked = $false, [int] $Width = 400)
    $check = New-Object System.Windows.Forms.CheckBox
    $check.UseMnemonic = $false
    $check.Font = $script:Ui.Fonts.Body
    $check.ForeColor = Get-UiColor 'Text'
    $check.Text = $Text
    $check.Checked = $Checked
    $check.AutoSize = $false
    $check.CheckAlign = 'TopLeft'
    $check.TextAlign = 'TopLeft'
    $textWidth = $Width - (S 22)
    $height = [System.Windows.Forms.TextRenderer]::MeasureText($Text, $check.Font, (New-UiSize $textWidth 100000),
        [System.Windows.Forms.TextFormatFlags] 'WordBreak, NoPrefix, TextBoxControl').Height
    $check.Size = New-UiSize $Width ([Math]::Max($height, (S 18)) + (S 4))
    return $check
}

function New-UiCombo {
    param([string[]] $Items, [int] $Selected = 0, [int] $Width = 200)
    $combo = New-Object System.Windows.Forms.ComboBox
    $combo.DropDownStyle = 'DropDownList'
    $combo.Font = $script:Ui.Fonts.Body
    $combo.Width = $Width
    foreach ($item in $Items) { [void] $combo.Items.Add($item) }
    if ($combo.Items.Count -gt 0) { $combo.SelectedIndex = [Math]::Max(0, [Math]::Min($Selected, $combo.Items.Count - 1)) }
    return $combo
}

function New-UiStatus {
    param([string] $Kind = 'Pending', [int] $Size = 20)
    $glyph = New-Object TryHackX.Setup.StatusGlyph
    $glyph.GlyphFont = if ($Size -le 18) { $script:Ui.Fonts.IconSmall } else { $script:Ui.Fonts.Icon }
    $glyph.Size = New-UiSize (S $Size) (S $Size)
    $glyph.Kind = [TryHackX.Setup.StatusKind] $Kind
    return $glyph
}

function ConvertTo-UiStatusKind {
    param([string] $Status)
    switch ($Status) {
        'ok' { return 'Ok' } 'fix' { return 'Info' } 'info' { return 'Info' } 'warn' { return 'Warning' } 'error' { return 'Error' }
        'running' { return 'Running' } 'done' { return 'Ok' } 'failed' { return 'Error' } 'skipped' { return 'Skipped' }
        default { return 'Pending' }
    }
}

function New-UiNotice {
    <# A tinted box with a coloured edge: something the reader should not miss. #>
    param([string] $Text, [string] $Kind = 'info', [int] $Width)
    $palette = switch ($Kind) {
        'warn'  { @('WarningSoft', 'Warning') }
        'error' { @('DangerSoft', 'Danger') }
        'ok'    { @('SuccessSoft', 'Success') }
        default { @('AccentSoft', 'Accent') }
    }
    $box = New-Object TryHackX.Setup.Surface
    $box.Fill = Get-UiColor $palette[0]
    $box.AccentBar = Get-UiColor $palette[1]
    $box.Radius = S 6
    $box.BackColor = Get-UiColor 'Window'
    $label = New-UiLabel -Text $Text -Width ($Width - (S 30)) -Font 'Small' -Color 'Text' -BackColor (Get-UiColor $palette[0])
    $label.Location = New-UiPoint (S 16) (S 9)
    $box.Controls.Add($label)
    $box.Size = New-UiSize $Width ($label.Height + (S 18))
    return $box
}

function New-UiCard {
    param([int] $Width, [int] $Height, [string] $Fill = 'Window')
    $card = New-Object TryHackX.Setup.Surface
    $card.Fill = Get-UiColor $Fill
    $card.Stroke = Get-UiColor 'Border'
    $card.Radius = S 8
    $card.BackColor = Get-UiColor 'Window'
    $card.Size = New-UiSize $Width $Height
    return $card
}

function New-UiOption {
    param([string] $Title, [string] $Description, [int] $Width, [string] $Badge = '', [bool] $Checked = $false)
    $card = New-Object TryHackX.Setup.OptionCard
    $card.Font = $script:Ui.Fonts.Small
    $card.TitleFont = $script:Ui.Fonts.Strong
    $card.BadgeFont = $script:Ui.Fonts.Small
    $card.Title = $Title
    $card.Description = $Description
    $card.Badge = $Badge
    $card.BackColor = Get-UiColor 'Window'
    $card.Size = New-UiSize $Width ($card.MeasureHeight($Width))
    $card.Checked = $Checked
    return $card
}

# -- a vertical stack: the only layout the pages need ------------------------------------------

function New-UiStack {
    param($Parent, [int] $X = 0, [int] $Y = 0, [int] $Width = 0)
    if ($Width -le 0) { $Width = $Parent.ClientSize.Width - $X }
    return @{ Parent = $Parent; X = $X; Y = $Y; Width = $Width }
}

function Add-UiStack {
    <# Places a control at the stack's cursor and moves the cursor below it (Gap in logical pixels). #>
    param([hashtable] $Stack, $Control, [double] $Gap = 10, [int] $Indent = 0)
    $Control.Location = New-UiPoint ($Stack.X + $Indent) $Stack.Y
    $Stack.Parent.Controls.Add($Control)
    $Stack.Y += $Control.Height + (S $Gap)
    return $Control
}

function Add-UiRow {
    <# Places several controls side by side, vertically centred on the tallest. #>
    param([hashtable] $Stack, [array] $Controls, [double] $Gap = 10, [double] $Spacing = 8, [int] $Indent = 0)
    $height = 0
    foreach ($control in $Controls) { if ($control.Height -gt $height) { $height = $control.Height } }
    $x = $Stack.X + $Indent
    foreach ($control in $Controls) {
        $control.Location = New-UiPoint $x ($Stack.Y + [int] (($height - $control.Height) / 2))
        $Stack.Parent.Controls.Add($control)
        $x += $control.Width + (S $Spacing)
    }
    $Stack.Y += $height + (S $Gap)
}

function Add-UiField {
    <# A caption, the input under it, and an optional hint under that. Returns the input. #>
    param([hashtable] $Stack, [string] $Caption, $Control, [string] $Hint = '', [double] $Gap = 12, [int] $Indent = 0)
    [void] (Add-UiStack $Stack (New-UiLabel -Text $Caption -Width ($Stack.Width - $Indent) -Font 'Small' -Color 'Muted') -Gap 3 -Indent $Indent)
    if ($Hint) {
        [void] (Add-UiStack $Stack $Control -Gap 3 -Indent $Indent)
        [void] (Add-UiStack $Stack (New-UiLabel -Text $Hint -Width ($Stack.Width - $Indent) -Font 'Small' -Color 'Muted') -Gap $Gap -Indent $Indent)
    } else {
        [void] (Add-UiStack $Stack $Control -Gap $Gap -Indent $Indent)
    }
    return $Control
}

# -- the window --------------------------------------------------------------------------------

function New-SetupWindow {
    $size = $script:UiSize
    $form = New-Object TryHackX.Setup.WizardForm
    $form.Text = T 'app.title'
    $form.ClientSize = New-UiSize (S $size.Width) (S $size.Height)
    $form.StartPosition = 'CenterScreen'
    $form.BackColor = Get-UiColor 'Window'
    $form.Font = $script:Ui.Fonts.Body
    $form.KeyPreview = $true
    $script:Ui.Form = $form

    # ---- sidebar
    $sidebar = New-Object TryHackX.Setup.Surface
    $sidebar.BackColor = Get-UiColor 'Sidebar'
    $sidebar.Location = New-UiPoint 1 1
    $sidebar.Size = New-UiSize (S $size.Sidebar) ($form.ClientSize.Height - 2)
    $form.Controls.Add($sidebar)
    $script:Ui.Sidebar = $sidebar

    $logo = New-Object TryHackX.Setup.LogoMark
    $logo.Size = New-UiSize (S 40) (S 40)
    $logo.Location = New-UiPoint (S 22) (S 24)
    $logo.BackColor = Get-UiColor 'Sidebar'
    foreach ($candidate in @('frontend\public\icon-192.png', 'public\assets\build\icon-192.png')) {
        $picture = Join-Path (Split-Path -Parent $script:SetupContext.InstallerDir) $candidate
        if (Test-Path -LiteralPath $picture) {
            try { $logo.Picture = [System.Drawing.Image]::FromStream((New-Object System.IO.MemoryStream (, [System.IO.File]::ReadAllBytes($picture)))); break } catch { }
        }
    }
    $sidebar.Controls.Add($logo)
    if ($logo.Picture) {
        # The taskbar shows the product's own mark, made from the same picture.
        try { $form.Icon = [System.Drawing.Icon]::FromHandle((New-Object System.Drawing.Bitmap($logo.Picture, 48, 48)).GetHicon()) } catch { }
    }

    $brand = New-Object System.Windows.Forms.Label
    $brand.Text = 'TryHackX'
    $brand.Font = $script:Ui.Fonts.Brand
    $brand.ForeColor = [System.Drawing.Color]::White
    $brand.BackColor = Get-UiColor 'Sidebar'
    $brand.AutoSize = $true
    $brand.Location = New-UiPoint (S 72) (S 23)
    $sidebar.Controls.Add($brand)
    $product = New-Object System.Windows.Forms.Label
    $product.Text = 'Media Server'
    $product.Font = $script:Ui.Fonts.Small
    $product.ForeColor = Get-UiColor 'SidebarMuted'
    $product.BackColor = Get-UiColor 'Sidebar'
    $product.AutoSize = $true
    $product.Location = New-UiPoint (S 73) (S 45)
    $sidebar.Controls.Add($product)

    $steps = New-Object TryHackX.Setup.StepList
    $steps.BackColor = Get-UiColor 'Sidebar'
    $steps.Font = $script:Ui.Fonts.Small
    $steps.StrongFont = $script:Ui.Fonts.Strong
    $steps.GlyphFont = $script:Ui.Fonts.IconSmall
    $steps.Location = New-UiPoint 0 (S 92)
    $steps.Size = New-UiSize (S $size.Sidebar) (S 440)
    $sidebar.Controls.Add($steps)
    $script:Ui.StepList = $steps

    $version = New-Object System.Windows.Forms.Label
    $version.Font = $script:Ui.Fonts.Small
    $version.ForeColor = Get-UiColor 'SidebarMuted'
    $version.BackColor = Get-UiColor 'Sidebar'
    $version.AutoSize = $false
    $version.Size = New-UiSize ((S $size.Sidebar) - (S 44)) (S 40)
    $version.Location = New-UiPoint (S 22) ($sidebar.Height - (S 52))
    $version.TextAlign = 'BottomLeft'
    $sidebar.Controls.Add($version)
    $script:Ui.VersionLabel = $version

    # ---- the strip above the page: empty, so the window can be dragged by it
    $left = (S $size.Sidebar) + 1
    $width = $form.ClientSize.Width - $left - 1
    $top = New-Object System.Windows.Forms.Panel
    $top.BackColor = Get-UiColor 'Window'
    $top.Location = New-UiPoint $left 1
    $top.Size = New-UiSize $width (S $size.Top)
    $form.Controls.Add($top)
    $close = New-UiButton -Text '' -Kind 'Chrome' -Width 40 -Glyph 0xE8BB -Height 30
    $close.GlyphFont = $script:Ui.Fonts.IconSmall
    $close.Location = New-UiPoint ($width - (S 46)) (S 6)
    $close.TabStop = $false
    $close.AccessibleName = T 'button.close'
    $close.Add_Click({ $script:Ui.Form.Close() })
    $top.Controls.Add($close)
    $minimize = New-UiButton -Text '' -Kind 'Chrome' -Width 40 -Glyph 0xE921 -Height 30
    $minimize.GlyphFont = $script:Ui.Fonts.IconSmall
    $minimize.Location = New-UiPoint ($width - (S 88)) (S 6)
    $minimize.TabStop = $false
    $minimize.AccessibleName = T 'button.minimize'
    $minimize.Add_Click({ $script:Ui.Form.WindowState = 'Minimized' })
    $top.Controls.Add($minimize)
    $drag = { if ($_.Button -eq 'Left') { $script:Ui.Form.DragMove() } }
    foreach ($handle in @($top, $sidebar, $logo, $brand, $product)) { $handle.Add_MouseDown($drag) }

    # ---- title, subtitle and the page itself
    $pad = S $size.Pad
    $title = New-Object System.Windows.Forms.Label
    $title.UseMnemonic = $false
    $title.Font = $script:Ui.Fonts.Title
    $title.ForeColor = Get-UiColor 'Text'
    $title.AutoSize = $false
    $title.Location = New-UiPoint ($left + $pad - (S 2)) (S 44)
    $title.Size = New-UiSize ($width - 2 * $pad) (S 36)
    $form.Controls.Add($title)
    $script:Ui.Title = $title
    $subtitle = New-Object System.Windows.Forms.Label
    $subtitle.UseMnemonic = $false
    $subtitle.Font = $script:Ui.Fonts.Body
    $subtitle.ForeColor = Get-UiColor 'Muted'
    $subtitle.AutoSize = $false
    $subtitle.Location = New-UiPoint ($left + $pad) (S 82)
    $subtitle.Size = New-UiSize ($width - 2 * $pad) (S 38)
    $form.Controls.Add($subtitle)
    $script:Ui.Subtitle = $subtitle

    $content = New-Object System.Windows.Forms.Panel
    $content.BackColor = Get-UiColor 'Window'
    $content.Location = New-UiPoint ($left + $pad) (S 128)
    $content.Size = New-UiSize ($width - 2 * $pad) ($form.ClientSize.Height - (S 128) - (S $size.Footer) - (S 8))
    $form.Controls.Add($content)
    $script:Ui.Content = $content

    # ---- footer
    $footerTop = $form.ClientSize.Height - (S $size.Footer)
    $line = New-Object System.Windows.Forms.Panel
    $line.BackColor = Get-UiColor 'Border'
    $line.Location = New-UiPoint $left $footerTop
    $line.Size = New-UiSize $width 1
    $form.Controls.Add($line)

    $message = New-Object System.Windows.Forms.Label
    $message.UseMnemonic = $false
    $message.Font = $script:Ui.Fonts.Small
    $message.ForeColor = Get-UiColor 'Danger'
    $message.AutoSize = $false
    $message.TextAlign = 'MiddleLeft'
    $message.Location = New-UiPoint ($left + $pad) ($footerTop + (S 8))
    $message.Size = New-UiSize ($width - $pad - (S 380)) (S 52)
    $form.Controls.Add($message)
    $script:Ui.Message = $message
    $script:Ui.TitleBounds = $title.Bounds
    $script:Ui.HeaderControl = $null

    $buttonTop = $footerTop + (S 17)
    $cancel = New-UiButton -Text (T 'button.cancel') -Kind 'Secondary' -Width 104
    $cancel.Location = New-UiPoint ($left + $width - $pad - $cancel.Width) $buttonTop
    $cancel.Add_Click({ $script:Ui.Form.Close() })
    $form.Controls.Add($cancel)
    $script:Ui.Cancel = $cancel
    $next = New-UiButton -Text (T 'button.next') -Kind 'Primary' -Width 124
    $next.Location = New-UiPoint ($cancel.Left - $next.Width - (S 10)) $buttonTop
    $next.Add_Click({ Move-SetupPage 1 })
    $form.Controls.Add($next)
    $script:Ui.Next = $next
    $back = New-UiButton -Text (T 'button.back') -Kind 'Secondary' -Width 104
    $back.Location = New-UiPoint ($next.Left - $back.Width - (S 10)) $buttonTop
    $back.Add_Click({ Move-SetupPage -1 })
    $form.Controls.Add($back)
    $script:Ui.Back = $back
    $form.AcceptButton = $next

    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 80
    $timer.Add_Tick({ Receive-SetupJob })
    $script:Ui.JobTimer = $timer

    $form.Add_FormClosing({
            if ($script:Ui.Preview -or $script:Ui.Closing) { return }
            $job = $script:Ui.Job
            if ($job -and $job.Kind -eq 'plan') {
                $answer = [System.Windows.Forms.MessageBox]::Show($script:Ui.Form, (T 'close.running'), (T 'app.title'), 'YesNo', 'Warning')
                if ($answer -ne 'Yes') { $_.Cancel = $true; return }
                $job.Cancel.Requested = $true
                $_.Cancel = $true
                $script:Ui.CloseWhenDone = $true
                return
            }
            if ($script:Ui.Page -and $script:Ui.Page.ConfirmClose) {
                # A page after a run says something else than "nothing has been changed yet".
                $question = if ($script:Ui.Page.CloseText) { [string] $script:Ui.Page.CloseText } else { T 'close.confirm' }
                $answer = [System.Windows.Forms.MessageBox]::Show($script:Ui.Form, $question, (T 'app.title'), 'YesNo', 'Question')
                if ($answer -ne 'Yes') { $_.Cancel = $true }
            }
        })
    return $form
}

function Open-SetupTarget {
    <#
        Opens an address or a folder the way a double-click would. Through Explorer on
        purpose: the wizard runs elevated, and a browser started directly from it would
        run with administrator rights too.
    #>
    param([string] $Target)
    if ($script:Ui.Preview -or -not $Target) { return }
    try { Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList ('"' + $Target + '"') } catch { Set-SetupMessage ([string] $_.Exception.Message) }
}

function Set-SetupMessage {
    <# The line beside the buttons: why Next did nothing. Empty clears it. #>
    param([string] $Text = '', [string] $Kind = 'error')
    $script:Ui.Message.ForeColor = if ($Kind -eq 'error') { Get-UiColor 'Danger' } elseif ($Kind -eq 'ok') { Get-UiColor 'Success' } else { Get-UiColor 'Muted' }
    $script:Ui.Message.Text = $Text
}

function Set-SetupBusy {
    param([bool] $Busy)
    $page = $script:Ui.Page
    $script:Ui.Next.Enabled = (-not $Busy) -and (-not ($page -and $page.NextDisabled))
    $script:Ui.Back.Enabled = (-not $Busy) -and ($script:Ui.Index -gt 0) -and (-not ($page -and $page.BackDisabled))
}

# -- pages and flows ---------------------------------------------------------------------------

function Set-SetupFlow {
    <# A flow is a list of page definitions: @{ Id; Build (function name) }. #>
    param([array] $Pages, [int] $Index = 0)
    $script:Ui.Flow = @($Pages)
    Show-SetupPage $Index
}

function Show-SetupPage {
    param([int] $Index)
    $ui = $script:Ui
    $ui.Index = $Index
    $definition = $ui.Flow[$Index]
    $content = $ui.Content
    $content.SuspendLayout()
    foreach ($control in @($content.Controls)) { $content.Controls.Remove($control); $control.Dispose() }
    $content.AutoScroll = $false
    Set-SetupMessage ''
    if ($ui.HeaderControl) { $ui.Form.Controls.Remove($ui.HeaderControl); $ui.HeaderControl.Dispose(); $ui.HeaderControl = $null }
    $ui.Title.Bounds = $ui.TitleBounds
    $ui.StepList.Items = [string[]] @($ui.Flow | ForEach-Object { T ('page.' + $_.Id + '.step') })
    $ui.StepList.Current = $Index
    $ui.StepList.Height = [Math]::Max((S 40), $ui.StepList.RowHeight * $ui.Flow.Count)
    $ui.Title.Text = T ('page.' + $definition.Id + '.title')
    $ui.Subtitle.Text = T ('page.' + $definition.Id + '.subtitle')
    $ui.VersionLabel.Text = (T 'app.version' $ui.State.Version) + $(if ($script:SetupContext.DryRun) { "`n" + (T 'app.dryRun') } else { '' })
    $ui.Back.Text = T 'button.back'
    $ui.Cancel.Text = T 'button.cancel'
    $ui.Next.Text = T 'button.next'
    $ui.Next.Kind = [TryHackX.Setup.ButtonKind]::Primary
    $ui.Next.Visible = $true
    $ui.Back.Visible = $true
    $ui.Cancel.Visible = $true
    $ui.Page = @{ Id = $definition.Id; Controls = @{}; ConfirmClose = $true }
    $null = & $definition.Build $ui.State $content $ui.Page
    if ($ui.Page.NextText) { $ui.Next.Text = $ui.Page.NextText }
    if ($ui.Page.NextKind) { $ui.Next.Kind = [TryHackX.Setup.ButtonKind] $ui.Page.NextKind }
    if ($ui.Page.CancelText) { $ui.Cancel.Text = $ui.Page.CancelText }
    if ($ui.Page.HideNext) { $ui.Next.Visible = $false }
    if ($ui.Page.HideCancel) { $ui.Cancel.Visible = $false }
    if ($ui.Page.HeaderControl) {
        # A page may park one control beside its title: always in view, however
        # long the page itself grows.
        $extra = $ui.Page.HeaderControl
        $bounds = $ui.TitleBounds
        $extra.Location = New-UiPoint ($bounds.Right - $extra.Width) ($bounds.Top + [int] (($bounds.Height - $extra.Height) / 2) + (S 2))
        $ui.Form.Controls.Add($extra)
        $extra.BringToFront()
        $ui.HeaderControl = $extra
        $ui.Title.Width = $bounds.Width - $extra.Width - (S 12)
    }
    if ($ui.Page.HideBack -or $Index -eq 0) { $ui.Back.Visible = $false }
    Set-SetupBusy $false
    $content.ResumeLayout()
    $ui.Next.Invalidate()
    if (-not $ui.Preview -and $ui.Page.Enter) { $null = & $ui.Page.Enter $ui.State $ui.Page }
}

function Move-SetupPage {
    param([int] $Direction)
    $ui = $script:Ui
    if ($ui.Job) { return }
    $page = $ui.Page
    Set-SetupMessage ''
    if ($Direction -gt 0) {
        if ($page.Validate) {
            $problems = @(& $page.Validate $ui.State $page)
            $problems = @($problems | Where-Object { $_ -is [string] -and $_ })
            if ($problems.Count -gt 0) { Set-SetupMessage ([string] $problems[0]); return }
        }
        if ($page.Leave) {
            # Leave may refuse too (returning a sentence), or take over navigation (returning $false).
            # Only the last thing Leave returns counts: a stray value written to the
            # pipeline inside it must not be mistaken for the answer.
            $result = @(& $page.Leave $ui.State $page) | Select-Object -Last 1
            if ($result -is [string] -and $result) { Set-SetupMessage $result; return }
            if ($result -is [bool] -and -not $result) { return }
        }
        if ($ui.Index + 1 -ge $ui.Flow.Count) {
            if ($page.Finish) { $null = & $page.Finish $ui.State $page } else { $ui.Closing = $true; $ui.Form.Close() }
            return
        }
        Show-SetupPage ($ui.Index + 1)
    } elseif ($ui.Index -gt 0) {
        if ($page.Keep) { & $page.Keep $ui.State $page }
        Show-SetupPage ($ui.Index - 1)
    }
}

# -- work off the user-interface thread ---------------------------------------------------------

$script:SetupJobScript = @'
param($job)
$ErrorActionPreference = 'Stop'
try {
    foreach ($file in @('Common.ps1', 'Detect.ps1', 'Steps.ps1')) { . (Join-Path $job.InstallerDir ('lib\' + $file)) }
    Initialize-SetupContext -InstallerDir $job.InstallerDir -Language $job.Language -DryRun $job.DryRun -Sink $job.Queue `
        -LogFile $job.LogFile -Secrets $job.Secrets -Cancel $job.Cancel
    $arguments = $job.Arguments
    $result = switch ($job.Kind) {
        'detect' { Get-SetupEnvironment -SourceRoot $arguments.SourceRoot -TargetRoot $arguments.TargetRoot -FfmpegHint $arguments.FfmpegHint -AssumeFresh:([bool] $arguments.AssumeFresh) }
        'dbtest' { Test-SetupDatabase $arguments.Database }
        'plan'   { Invoke-SetupPlan -State $arguments.State -Plan $arguments.Plan }
        'call'   { & $arguments.Function $arguments.Value }
    }
    $job.Queue.Enqueue(@{ Type = 'done'; Result = $result })
} catch {
    $job.Queue.Enqueue(@{ Type = 'done'; Error = [string] $_.Exception.Message })
}
'@

function Start-SetupJob {
    <# Runs detection, a database test or a plan in a background runspace; OnDone is a function name. #>
    param([string] $Kind, [hashtable] $Arguments, [string] $OnDone)
    if ($script:Ui.Job) { return }
    $queue = New-Object 'System.Collections.Concurrent.ConcurrentQueue[object]'
    $cancel = [hashtable]::Synchronized(@{ Requested = $false })
    $runspace = [runspacefactory]::CreateRunspace()
    $runspace.Open()
    $powershell = [powershell]::Create()
    $powershell.Runspace = $runspace
    [void] $powershell.AddScript($script:SetupJobScript).AddArgument(@{
            InstallerDir = $script:SetupContext.InstallerDir; Language = $script:SetupContext.Language
            DryRun = [bool] $script:SetupContext.DryRun; Queue = $queue; Cancel = $cancel
            LogFile = $script:SetupContext.LogFile; Secrets = @($script:SetupContext.Secrets)
            Kind = $Kind; Arguments = $Arguments
        })
    $script:Ui.Job = @{ Kind = $Kind; PowerShell = $powershell; Runspace = $runspace; Handle = $powershell.BeginInvoke(); Queue = $queue; Cancel = $cancel; OnDone = $OnDone }
    Set-SetupBusy $true
    $script:Ui.JobTimer.Start()
}

function Receive-SetupJob {
    $job = $script:Ui.Job
    if (-not $job) { $script:Ui.JobTimer.Stop(); return }
    $message = $null
    $finished = $null
    while ($job.Queue.TryDequeue([ref] $message)) {
        switch ($message.Type) {
            'log'  { Add-SetupLogLine $message.Text $message.Level }
            'step' { if ($script:Ui.Page.OnStep) { & $script:Ui.Page.OnStep $message } }
            'done' { $finished = $message }
        }
    }
    if (-not $finished -and $job.Handle.IsCompleted) {
        # The runspace ended without reporting: a failure before the script's own try block.
        $failure = ''
        try { [void] $job.PowerShell.EndInvoke($job.Handle) } catch { $failure = [string] $_.Exception.Message }
        if (-not $failure -and $job.PowerShell.Streams.Error.Count -gt 0) { $failure = [string] $job.PowerShell.Streams.Error[0] }
        $finished = @{ Type = 'done'; Error = $(if ($failure) { $failure } else { 'The background task ended unexpectedly.' }) }
    }
    if (-not $finished) { return }
    $script:Ui.JobTimer.Stop()
    try { $job.PowerShell.Dispose(); $job.Runspace.Dispose() } catch { }
    $script:Ui.Job = $null
    Set-SetupBusy $false
    if ($script:Ui.CloseWhenDone) { $script:Ui.Closing = $true; $script:Ui.Form.Close(); return }
    $null = & $job.OnDone $finished
}

function Add-SetupLogLine {
    param([string] $Text, [string] $Level = 'info')
    [void] $script:Ui.LogLines.Add($Text)
    $box = if ($script:Ui.Page) { $script:Ui.Page.Controls.Log } else { $null }
    if ($box) { $box.AppendText($Text + [Environment]::NewLine) }
}

function Save-SetupScreenshot {
    param([string] $Path)
    $form = $script:Ui.Form
    [System.Windows.Forms.Application]::DoEvents()
    $bitmap = New-Object System.Drawing.Bitmap($form.Width, $form.Height)
    try {
        $form.DrawToBitmap($bitmap, (New-Object System.Drawing.Rectangle(0, 0, $form.Width, $form.Height)))
        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $bitmap.Dispose() }
}
