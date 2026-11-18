#Requires -Version 5.1
<#
.SYNOPSIS
  Sofia Server Manager - status and control panel for the Sofia's Resto-Lounge server on Windows.

.DESCRIPTION
  Shows PostgreSQL, API, web app, sync, backup, update, internet and storage status; starts, stops and restarts
  the services; creates and restores backups; shows logs, the server address and the public URL.
  Arabic (RTL) or English, following the Windows display language (switchable).

  Installed by Install-Sofia.ps1 to C:\Sofia\tools and started from the "Sofia Server Manager" shortcut.
  It asks for administrator rights because it controls Windows services and reads the protected configuration.

.NOTES
  This script has not been executed on Windows by its authors yet.
#>
param([string]$InstallRoot = '')

$ErrorActionPreference = 'Stop'

# ---- administrator rights ------------------------------------------------------------------------------------------
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $argList = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $PSCommandPath + '"'
  if ($InstallRoot) { $argList += ' -InstallRoot "' + $InstallRoot + '"' }
  Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs
  exit
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

if (-not $InstallRoot) { $InstallRoot = Split-Path -Parent $PSScriptRoot }
$installFile = Join-Path $InstallRoot 'config\install.json'
if (-not (Test-Path $installFile)) {
  [System.Windows.Forms.MessageBox]::Show("Sofia is not installed in $InstallRoot (config\install.json not found).", 'Sofia Server Manager', 'OK', 'Error') | Out-Null
  exit 1
}
$install = Get-Content -Raw $installFile | ConvertFrom-Json
$Port = [int]$install.port
$NodeExe = [string]$install.nodeExe
$Launcher = Join-Path $InstallRoot 'launcher.mjs'
$EnvFile = Join-Path $InstallRoot 'config\sofia.env'
$LogDir = Join-Path $InstallRoot 'logs'
$BackupDir = Join-Path $InstallRoot 'backups'
$LocalUrl = "http://localhost:$Port"
$Services = @([string]$install.postgresService) + @($install.services | ForEach-Object { [string]$_ })

# ---- texts -------------------------------------------------------------------------------------------------------
$Texts = @{
  en = @{
    title = 'Sofia Server Manager'; status = 'System status'; info = 'Server'; actions = 'Actions'
    postgres = 'PostgreSQL database'; api = 'API server'; web = 'Web app'; sync = 'Sync & background jobs'; backup = 'Backups'
    update = 'Update Center'; internet = 'Internet'; storage = 'Storage'
    running = 'Running'; stopped = 'Stopped'; starting = 'Starting...'; notInstalled = 'Not installed'; unreachable = 'Not responding'
    startAll = 'Start all'; stopAll = 'Stop all'; restartAll = 'Restart all'; openApp = 'Open Sofia'; copyUrl = 'Copy network address'
    createBackup = 'Create backup'; restoreBackup = 'Restore backup...'; backupsFolder = 'Backups folder'; viewLogs = 'View logs'
    logsFolder = 'Logs folder'; certificate = 'Device certificate'; language = 'العربية'
    localUrl = 'On this PC'; lanUrl = 'Tablets & phones'; publicUrl = 'Public URL'; serverIp = 'Server IP'; version = 'Version'
    online = 'Online'; offline = 'Offline - restaurant keeps working, messages wait'; conflicts = 'open conflicts'; lastOp = 'last sync'
    lastBackup = 'last backup'; never = 'never'; disabled = 'automatic backups are OFF'; free = 'free'; previous = 'previous'
    working = 'Working...'; done = 'Done'; failed = 'Failed'; confirmStop = 'Stop Sofia? Devices switch to offline mode until it is started again.'
    confirmRestore = "Restore this backup?`n`n{0}`n`nThe current database is replaced by the backup. A safety backup is taken first. Devices keep their unsynced changes."
    pickBackup = 'Choose a backup to restore'; restore = 'Restore'; cancel = 'Cancel'; noBackups = 'No completed backups found.'
    colDate = 'Date'; colKind = 'Type'; colSize = 'Size'; colVerified = 'Verified'; colFile = 'File'; refresh = 'Refresh'
    certHelp = "On each tablet or phone open:`n`n{0}`n`nand install the certificate (iPhone/iPad: Settings > General > About > Certificate Trust Settings; Android: Settings > Security > Install certificate > CA certificate). Then open {1}."
    copied = 'Address copied'; workerStopped = 'background jobs stopped'; updaterStopped = 'updater stopped'
  }
  ar = @{
    title = 'مدير خادم صوفيا'; status = 'حالة النظام'; info = 'الخادم'; actions = 'الإجراءات'
    postgres = 'قاعدة البيانات PostgreSQL'; api = 'خادم التطبيق (API)'; web = 'تطبيق الويب'; sync = 'المزامنة والمهام الخلفية'; backup = 'النسخ الاحتياطي'
    update = 'مركز التحديثات'; internet = 'الإنترنت'; storage = 'التخزين'
    running = 'يعمل'; stopped = 'متوقف'; starting = 'جارٍ التشغيل...'; notInstalled = 'غير مثبت'; unreachable = 'لا يستجيب'
    startAll = 'تشغيل الكل'; stopAll = 'إيقاف الكل'; restartAll = 'إعادة تشغيل الكل'; openApp = 'فتح صوفيا'; copyUrl = 'نسخ عنوان الشبكة'
    createBackup = 'إنشاء نسخة احتياطية'; restoreBackup = 'استعادة نسخة...'; backupsFolder = 'مجلد النسخ'; viewLogs = 'عرض السجلات'
    logsFolder = 'مجلد السجلات'; certificate = 'شهادة الأجهزة'; language = 'English'
    localUrl = 'على هذا الجهاز'; lanUrl = 'الأجهزة اللوحية والهواتف'; publicUrl = 'الرابط العام'; serverIp = 'عنوان IP للخادم'; version = 'الإصدار'
    online = 'متصل'; offline = 'غير متصل - المطعم يستمر بالعمل والرسائل تنتظر'; conflicts = 'تعارضات مفتوحة'; lastOp = 'آخر مزامنة'
    lastBackup = 'آخر نسخة'; never = 'لا يوجد'; disabled = 'النسخ التلقائي متوقف'; free = 'متاح'; previous = 'السابق'
    working = 'جارٍ التنفيذ...'; done = 'تم'; failed = 'فشل'; confirmStop = 'إيقاف صوفيا؟ ستنتقل الأجهزة إلى وضع عدم الاتصال حتى يُعاد التشغيل.'
    confirmRestore = "استعادة هذه النسخة؟`n`n{0}`n`nستُستبدل قاعدة البيانات الحالية بالنسخة. تُؤخذ نسخة أمان أولاً. تحتفظ الأجهزة بتغييراتها غير المتزامنة."
    pickBackup = 'اختر نسخة للاستعادة'; restore = 'استعادة'; cancel = 'إلغاء'; noBackups = 'لا توجد نسخ احتياطية مكتملة.'
    colDate = 'التاريخ'; colKind = 'النوع'; colSize = 'الحجم'; colVerified = 'تم التحقق'; colFile = 'الملف'; refresh = 'تحديث'
    certHelp = "على كل جهاز لوحي أو هاتف افتح:`n`n{0}`n`nوثبّت الشهادة (آيفون/آيباد: الإعدادات > عام > حول > إعدادات الثقة بالشهادات؛ أندرويد: الإعدادات > الأمان > تثبيت شهادة > شهادة CA). ثم افتح {1}."
    copied = 'تم نسخ العنوان'; workerStopped = 'المهام الخلفية متوقفة'; updaterStopped = 'خدمة التحديث متوقفة'
  }
}
$script:Lang = if ((Get-UICulture).TwoLetterISOLanguageName -eq 'ar') { 'ar' } else { 'en' }
function T([string]$Key) { return $Texts[$script:Lang][$Key] }

# ---- colours (brand) ---------------------------------------------------------------------------------------------
function Color([string]$Hex) { return [System.Drawing.ColorTranslator]::FromHtml($Hex) }
$Wine = Color '#6B1420'; $WineDark = Color '#3E0B12'; $Cream = Color '#F3E6D0'; $Paper = Color '#FBF7F1'; $Gold = Color '#C9A26B'
$Ok = Color '#2E7D32'; $Warn = Color '#B7791F'; $Bad = Color '#C62828'; $Grey = Color '#8A8178'
$FontUi = New-Object System.Drawing.Font('Segoe UI', 10)
$FontBold = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
$FontTitle = New-Object System.Drawing.Font('Segoe UI Semibold', 16)

# ---- helpers -----------------------------------------------------------------------------------------------------
function Format-Bytes($n) {
  if ($null -eq $n) { return '-' }
  $n = [double]$n
  if ($n -ge 1GB) { return ('{0:N1} GB' -f ($n / 1GB)) }
  if ($n -ge 1MB) { return ('{0:N1} MB' -f ($n / 1MB)) }
  return ('{0:N0} KB' -f ($n / 1KB))
}
function Format-When($iso) {
  if (-not $iso) { return (T 'never') }
  if ($iso -is [datetime]) { return $iso.ToLocalTime().ToString('yyyy-MM-dd HH:mm') }
  # PostgreSQL text ("2026-11-18 10:26:10.92+00") or ISO 8601 ("2026-11-18T10:26:10.920Z")
  $text = ([string]$iso) -replace '^(\d{4}-\d\d-\d\d) ', '$1T' -replace '([+-]\d\d)$', '$1:00'
  try { return [datetimeoffset]::Parse($text, [Globalization.CultureInfo]::InvariantCulture).LocalDateTime.ToString('yyyy-MM-dd HH:mm') }
  catch { return [string]$iso }
}
function Get-ServiceState([string]$Name) {
  $s = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if (-not $s) { return 'missing' }
  return [string]$s.Status
}
function Get-Health {
  try { return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3 } catch { return $null }
}
function Test-WebApp {
  try { return ((Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) } catch { return $false }
}
function Get-CurrentRelease {
  try { return Get-Content -Raw (Join-Path $InstallRoot 'current.json') | ConvertFrom-Json } catch { return $null }
}
function Get-LanUrl { return [string]$install.publicUrl }
function Invoke-Cli([string[]]$Arguments) {
  # Short, synchronous CLI calls (e.g. listing backups).
  $env:SOFIA_ENV_FILE = $EnvFile
  $env:SOFIA_INSTALL_ROOT = $InstallRoot
  $ErrorActionPreference = 'Continue'
  $out = & $NodeExe $Launcher cli @Arguments 2>&1 | Out-String
  return [pscustomobject]@{ Code = $LASTEXITCODE; Output = $out }
}

# ---- form --------------------------------------------------------------------------------------------------------
$form = New-Object System.Windows.Forms.Form
$form.Size = New-Object System.Drawing.Size(980, 660)
$form.MinimumSize = $form.Size
$form.StartPosition = 'CenterScreen'
$form.BackColor = $Paper
$form.Font = $FontUi
$iconPath = Join-Path $PSScriptRoot 'sofia.ico'
if (Test-Path $iconPath) { $form.Icon = New-Object System.Drawing.Icon($iconPath) }

$header = New-Object System.Windows.Forms.Panel
$header.Dock = 'Top'; $header.Height = 92; $header.BackColor = $WineDark
$form.Controls.Add($header)
$logo = New-Object System.Windows.Forms.PictureBox
$logo.SizeMode = 'Zoom'; $logo.Size = New-Object System.Drawing.Size(150, 76); $logo.Location = New-Object System.Drawing.Point(16, 8)
$rel = Get-CurrentRelease
if ($rel) {
  $logoFile = Join-Path $InstallRoot ("releases\{0}\web\brand\sofia-logo-cream.png" -f $rel.version)
  if (Test-Path $logoFile) { $logo.Image = [System.Drawing.Image]::FromFile($logoFile) }
}
$header.Controls.Add($logo)
$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.ForeColor = $Cream; $titleLabel.Font = $FontTitle; $titleLabel.AutoSize = $true; $titleLabel.Location = New-Object System.Drawing.Point(180, 18)
$header.Controls.Add($titleLabel)
$versionLabel = New-Object System.Windows.Forms.Label
$versionLabel.ForeColor = $Gold; $versionLabel.AutoSize = $true; $versionLabel.Location = New-Object System.Drawing.Point(182, 54)
$header.Controls.Add($versionLabel)
$langButton = New-Object System.Windows.Forms.Button
$langButton.FlatStyle = 'Flat'; $langButton.ForeColor = $Cream; $langButton.Size = New-Object System.Drawing.Size(100, 32)
$langButton.Anchor = 'Top, Right'; $langButton.Location = New-Object System.Drawing.Point(850, 28)
$header.Controls.Add($langButton)

$statusBar = New-Object System.Windows.Forms.StatusStrip
$statusText = New-Object System.Windows.Forms.ToolStripStatusLabel
$statusBar.Items.Add($statusText) | Out-Null
$form.Controls.Add($statusBar)

$body = New-Object System.Windows.Forms.TableLayoutPanel
$body.Dock = 'Fill'; $body.ColumnCount = 2; $body.RowCount = 1; $body.Padding = New-Object System.Windows.Forms.Padding(12)
$body.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Percent', 58))) | Out-Null
$body.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Percent', 42))) | Out-Null
$form.Controls.Add($body)
$body.BringToFront()

# status list
$statusGroup = New-Object System.Windows.Forms.GroupBox
$statusGroup.Dock = 'Fill'; $statusGroup.ForeColor = $WineDark; $statusGroup.Font = $FontBold
$body.Controls.Add($statusGroup, 0, 0)
$grid = New-Object System.Windows.Forms.TableLayoutPanel
$grid.Dock = 'Fill'; $grid.ColumnCount = 3; $grid.Padding = New-Object System.Windows.Forms.Padding(6)
$grid.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Absolute', 28))) | Out-Null
$grid.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Absolute', 190))) | Out-Null
$grid.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Percent', 100))) | Out-Null
$statusGroup.Controls.Add($grid)
$rows = [ordered]@{}
foreach ($key in 'postgres', 'api', 'web', 'sync', 'backup', 'update', 'internet', 'storage') {
  $dot = New-Object System.Windows.Forms.Label
  $dot.Text = [string][char]0x25CF; $dot.Font = New-Object System.Drawing.Font('Segoe UI', 14); $dot.ForeColor = $Grey; $dot.AutoSize = $true
  $name = New-Object System.Windows.Forms.Label
  $name.Font = $FontBold; $name.ForeColor = $WineDark; $name.AutoSize = $true; $name.Margin = New-Object System.Windows.Forms.Padding(3, 8, 3, 3)
  $detail = New-Object System.Windows.Forms.Label
  $detail.Font = $FontUi; $detail.ForeColor = [System.Drawing.Color]::FromArgb(60, 50, 45); $detail.AutoSize = $true
  $detail.MaximumSize = New-Object System.Drawing.Size(330, 0); $detail.Margin = New-Object System.Windows.Forms.Padding(3, 8, 3, 3)
  $grid.RowCount += 1
  $grid.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('AutoSize'))) | Out-Null
  $grid.Controls.Add($dot, 0, $grid.RowCount - 1); $grid.Controls.Add($name, 1, $grid.RowCount - 1); $grid.Controls.Add($detail, 2, $grid.RowCount - 1)
  $rows[$key] = @{ Dot = $dot; Name = $name; Detail = $detail }
}
function Set-Row([string]$Key, [string]$Level, [string]$Text) {
  $r = $rows[$Key]
  $r.Dot.ForeColor = switch ($Level) { 'ok' { $Ok } 'warn' { $Warn } 'error' { $Bad } default { $Grey } }
  $r.Detail.Text = $Text
}

# right column: server info + actions
$right = New-Object System.Windows.Forms.FlowLayoutPanel
$right.Dock = 'Fill'; $right.FlowDirection = 'TopDown'; $right.WrapContents = $false; $right.AutoScroll = $true
$body.Controls.Add($right, 1, 0)
$infoGroup = New-Object System.Windows.Forms.GroupBox
$infoGroup.Size = New-Object System.Drawing.Size(380, 190); $infoGroup.ForeColor = $WineDark; $infoGroup.Font = $FontBold
$right.Controls.Add($infoGroup)
$infoText = New-Object System.Windows.Forms.Label
$infoText.Dock = 'Fill'; $infoText.Font = $FontUi; $infoText.ForeColor = [System.Drawing.Color]::Black; $infoText.Padding = New-Object System.Windows.Forms.Padding(6)
$infoGroup.Controls.Add($infoText)

$actionsGroup = New-Object System.Windows.Forms.GroupBox
$actionsGroup.Size = New-Object System.Drawing.Size(380, 300); $actionsGroup.ForeColor = $WineDark; $actionsGroup.Font = $FontBold
$right.Controls.Add($actionsGroup)
$buttons = New-Object System.Windows.Forms.FlowLayoutPanel
$buttons.Dock = 'Fill'; $buttons.Padding = New-Object System.Windows.Forms.Padding(4)
$actionsGroup.Controls.Add($buttons)
$buttonMap = [ordered]@{}
function Add-Button([string]$Key, [bool]$Primary, [scriptblock]$OnClick) {
  $b = New-Object System.Windows.Forms.Button
  $b.Size = New-Object System.Drawing.Size(172, 38); $b.Font = $FontUi; $b.FlatStyle = 'Flat'; $b.Margin = New-Object System.Windows.Forms.Padding(4)
  if ($Primary) { $b.BackColor = $Wine; $b.ForeColor = $Cream } else { $b.BackColor = $Cream; $b.ForeColor = $WineDark }
  $b.FlatAppearance.BorderColor = $Wine
  $b.Add_Click($OnClick)
  $buttons.Controls.Add($b)
  $buttonMap[$Key] = $b
}

# ---- background operations ---------------------------------------------------------------------------------------
$script:Job = $null
$script:JobLabel = ''
$jobTimer = New-Object System.Windows.Forms.Timer
$jobTimer.Interval = 700
function Set-Busy([bool]$Busy) { foreach ($b in $buttonMap.Values) { if ($b.Tag -ne 'always') { $b.Enabled = -not $Busy } } }
function Start-Operation([string]$Label, [scriptblock]$Script, [object[]]$Arguments) {
  if ($script:Job) { return }
  $script:JobLabel = $Label
  $statusText.Text = "$Label - $(T 'working')"
  Set-Busy $true
  $script:Job = Start-Job -ScriptBlock $Script -ArgumentList $Arguments
  $jobTimer.Start()
}
$jobTimer.Add_Tick({
  if (-not $script:Job -or $script:Job.State -eq 'Running' -or $script:Job.State -eq 'NotStarted') { return }
  $jobTimer.Stop()
  $failed = $script:Job.State -eq 'Failed'
  $output = (Receive-Job -Job $script:Job -ErrorAction SilentlyContinue 2>&1 | Out-String).Trim()
  if ($failed -or $output -match '(?m)^EXIT=([1-9]\d*)') { $failed = $true }
  Remove-Job -Job $script:Job -Force
  $script:Job = $null
  Set-Busy $false
  $result = if ($failed) { T 'failed' } else { T 'done' }
  $statusText.Text = "$($script:JobLabel) - $result"
  $shown = ($output -replace '(?m)^EXIT=\d+\s*$', '').Trim()
  if ($shown.Length -gt 1500) { $shown = '...' + $shown.Substring($shown.Length - 1500) }
  $icon = if ($failed) { 'Error' } else { 'Information' }
  [System.Windows.Forms.MessageBox]::Show($form, "$result`n`n$shown", $script:JobLabel, 'OK', $icon) | Out-Null
  Update-Status
})

$cliJob = {
  param($node, $launcher, $envFile, $root, [string[]]$cliArgs)
  $env:SOFIA_ENV_FILE = $envFile
  $env:SOFIA_INSTALL_ROOT = $root
  $ErrorActionPreference = 'Continue'
  & $node $launcher cli @cliArgs 2>&1 | ForEach-Object { "$_" }
  "EXIT=$LASTEXITCODE"
}
$serviceJob = {
  param([string]$action, [string[]]$names)
  $ErrorActionPreference = 'Continue'
  foreach ($n in $names) {
    if (-not (Get-Service -Name $n -ErrorAction SilentlyContinue)) { continue }
    switch ($action) {
      'start' { Start-Service -Name $n }
      'stop' { Stop-Service -Name $n -Force }
      'restart' { Restart-Service -Name $n -Force }
    }
    "$n -> $((Get-Service -Name $n).Status)"
  }
}
$appServices = @($install.services | ForEach-Object { [string]$_ })

# ---- actions -----------------------------------------------------------------------------------------------------
Add-Button 'openApp' $true { Start-Process (Get-LanUrl) }
Add-Button 'copyUrl' $false { [System.Windows.Forms.Clipboard]::SetText((Get-LanUrl)); $statusText.Text = T 'copied' }
Add-Button 'startAll' $false { Start-Operation (T 'startAll') $serviceJob @('start', (@([string]$install.postgresService) + $appServices)) }
Add-Button 'stopAll' $false {
  $answer = [System.Windows.Forms.MessageBox]::Show($form, (T 'confirmStop'), (T 'stopAll'), 'YesNo', 'Warning', 'Button2')
  if ($answer -eq 'Yes') { Start-Operation (T 'stopAll') $serviceJob @('stop', $appServices) }
}
Add-Button 'restartAll' $false { Start-Operation (T 'restartAll') $serviceJob @('restart', $appServices) }
Add-Button 'createBackup' $true { Start-Operation (T 'createBackup') $cliJob @($NodeExe, $Launcher, $EnvFile, $InstallRoot, @('backup', 'create')) }
Add-Button 'restoreBackup' $false { Show-RestoreDialog }
Add-Button 'backupsFolder' $false { Start-Process explorer.exe $BackupDir }
Add-Button 'viewLogs' $false { Show-Logs }
Add-Button 'logsFolder' $false { Start-Process explorer.exe $LogDir }
if ($install.httpsMode -eq 'Lan') {
  Add-Button 'certificate' $false {
    $certUrl = "http://$($install.lanIp)/sofia-ca.crt"
    $text = (T 'certHelp') -f $certUrl, (Get-LanUrl)
    if ($install.PSObject.Properties['caThumbprint'] -and $install.caThumbprint) { $text += "`n`nSHA-1: $($install.caThumbprint)" }
    [System.Windows.Forms.MessageBox]::Show($form, $text, (T 'certificate'), 'OK', 'Information') | Out-Null
  }
}
foreach ($k in 'openApp', 'copyUrl', 'backupsFolder', 'viewLogs', 'logsFolder', 'certificate') { if ($buttonMap.Contains($k)) { $buttonMap[$k].Tag = 'always' } }

function Show-RestoreDialog {
  $r = Invoke-Cli @('backup', 'list', '--json')
  $list = @()
  try { $list = @(($r.Output | ConvertFrom-Json) | Where-Object { $_.status -eq 'completed' }) } catch { }
  if ($r.Code -ne 0 -or $list.Count -eq 0) {
    $msg = if ($r.Code -ne 0) { $r.Output } else { T 'noBackups' }
    [System.Windows.Forms.MessageBox]::Show($form, $msg, (T 'restoreBackup'), 'OK', 'Information') | Out-Null
    return
  }
  $dlg = New-Object System.Windows.Forms.Form
  $dlg.Text = T 'pickBackup'; $dlg.Size = New-Object System.Drawing.Size(760, 440); $dlg.StartPosition = 'CenterParent'; $dlg.Font = $FontUi
  $dlg.BackColor = $Paper
  if ($script:Lang -eq 'ar') { $dlg.RightToLeft = 'Yes'; $dlg.RightToLeftLayout = $true }
  $lv = New-Object System.Windows.Forms.ListView
  $lv.View = 'Details'; $lv.FullRowSelect = $true; $lv.MultiSelect = $false; $lv.Dock = 'Fill'; $lv.HideSelection = $false
  foreach ($c in @(@('colDate', 150), @('colKind', 110), @('colSize', 90), @('colVerified', 90), @('colFile', 300))) { $lv.Columns.Add((T $c[0]), $c[1]) | Out-Null }
  foreach ($b in $list) {
    $item = New-Object System.Windows.Forms.ListViewItem((Format-When $b.finishedAt))
    $item.SubItems.Add([string]$b.kind) | Out-Null
    $item.SubItems.Add((Format-Bytes $b.sizeBytes)) | Out-Null
    $item.SubItems.Add([string]$b.verifyStatus) | Out-Null
    $item.SubItems.Add([string]$b.fileName) | Out-Null
    $item.Tag = $b
    $lv.Items.Add($item) | Out-Null
  }
  $dlg.Controls.Add($lv)
  $bar = New-Object System.Windows.Forms.FlowLayoutPanel
  $bar.Dock = 'Bottom'; $bar.Height = 48; $bar.FlowDirection = 'RightToLeft'; $bar.Padding = New-Object System.Windows.Forms.Padding(6)
  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = T 'restore'; $ok.Size = New-Object System.Drawing.Size(140, 34); $ok.BackColor = $Wine; $ok.ForeColor = $Cream; $ok.FlatStyle = 'Flat'
  $ok.DialogResult = 'OK'
  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = T 'cancel'; $cancel.Size = New-Object System.Drawing.Size(120, 34); $cancel.DialogResult = 'Cancel'
  $bar.Controls.Add($ok); $bar.Controls.Add($cancel)
  $dlg.Controls.Add($bar)
  $dlg.AcceptButton = $ok; $dlg.CancelButton = $cancel
  if ($dlg.ShowDialog($form) -ne 'OK' -or $lv.SelectedItems.Count -eq 0) { return }
  $chosen = $lv.SelectedItems[0].Tag
  $desc = "{0}  -  {1}  -  {2}" -f (Format-When $chosen.finishedAt), $chosen.kind, $chosen.fileName
  $answer = [System.Windows.Forms.MessageBox]::Show($form, ((T 'confirmRestore') -f $desc), (T 'restoreBackup'), 'YesNo', 'Warning', 'Button2')
  if ($answer -ne 'Yes') { return }
  Start-Operation (T 'restoreBackup') $cliJob @($NodeExe, $Launcher, $EnvFile, $InstallRoot, @('backup', 'restore', [string]$chosen.id, '--yes'))
}

function Show-Logs {
  $dlg = New-Object System.Windows.Forms.Form
  $dlg.Text = T 'viewLogs'; $dlg.Size = New-Object System.Drawing.Size(980, 620); $dlg.StartPosition = 'CenterParent'; $dlg.Font = $FontUi
  $top = New-Object System.Windows.Forms.FlowLayoutPanel
  $top.Dock = 'Top'; $top.Height = 42; $top.Padding = New-Object System.Windows.Forms.Padding(6)
  $combo = New-Object System.Windows.Forms.ComboBox
  $combo.DropDownStyle = 'DropDownList'; $combo.Width = 420
  $refreshBtn = New-Object System.Windows.Forms.Button
  $refreshBtn.Text = T 'refresh'; $refreshBtn.Width = 110
  $top.Controls.Add($combo); $top.Controls.Add($refreshBtn)
  $box = New-Object System.Windows.Forms.TextBox
  $box.Multiline = $true; $box.ReadOnly = $true; $box.ScrollBars = 'Both'; $box.WordWrap = $false; $box.Dock = 'Fill'
  $box.Font = New-Object System.Drawing.Font('Consolas', 9); $box.BackColor = [System.Drawing.Color]::White
  $dlg.Controls.Add($box); $dlg.Controls.Add($top)
  Get-ChildItem -Path $LogDir -Filter '*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | ForEach-Object { $combo.Items.Add($_.Name) | Out-Null }
  $load = {
    if ($combo.SelectedItem) {
      $lines = Get-Content -Path (Join-Path $LogDir $combo.SelectedItem) -Tail 400 -ErrorAction SilentlyContinue
      $box.Text = ($lines -join "`r`n")
      $box.SelectionStart = $box.TextLength; $box.ScrollToCaret()
    }
  }
  $combo.Add_SelectedIndexChanged($load); $refreshBtn.Add_Click($load)
  if ($combo.Items.Count -gt 0) { $combo.SelectedIndex = 0 }
  $dlg.ShowDialog($form) | Out-Null
}

# ---- status refresh ----------------------------------------------------------------------------------------------
function Update-Status {
  $pgState = Get-ServiceState ([string]$install.postgresService)
  $apiState = Get-ServiceState 'SofiaAPI'
  $workerState = Get-ServiceState 'SofiaWorker'
  $updaterState = Get-ServiceState 'SofiaUpdater'
  $health = if ($apiState -eq 'Running') { Get-Health } else { $null }
  $c = if ($health -and $health.PSObject.Properties['checks']) { $health.checks } else { $null }

  if ($pgState -ne 'Running') { Set-Row 'postgres' 'error' "$(T 'stopped') ($($install.postgresService))" }
  elseif ($c -and $c.database.status -eq 'ok') { Set-Row 'postgres' 'ok' ("{0} - PostgreSQL {1} - {2} ms" -f (T 'running'), $c.database.postgres, $c.database.latencyMs) }
  elseif ($c) { Set-Row 'postgres' 'error' ([string]$c.database.error) }
  else { Set-Row 'postgres' 'ok' (T 'running') }

  if ($apiState -eq 'missing') { Set-Row 'api' 'unknown' (T 'notInstalled') }
  elseif ($apiState -ne 'Running') { Set-Row 'api' 'error' (T 'stopped') }
  elseif (-not $c) { Set-Row 'api' 'warn' (T 'starting') }
  else {
    $uptime = [TimeSpan]::FromSeconds([double]$c.api.uptimeSeconds)
    Set-Row 'api' 'ok' ("{0} - {1:%d}d {1:hh\:mm} - {2} MB" -f (T 'running'), $uptime, $c.api.memoryMb)
  }

  $webOk = ($apiState -eq 'Running') -and (Test-WebApp)
  $webText = if ($webOk) { "$(T 'running') - $(Get-LanUrl)" } else { T 'unreachable' }
  $webLevel = if ($webOk) { 'ok' } else { 'error' }
  if ($install.httpsMode -ne 'None') {
    $webState = Get-ServiceState 'SofiaWeb'
    if ($webState -ne 'Running') { $webLevel = 'error'; $webText = "HTTPS (SofiaWeb): $(T 'stopped')" }
  }
  Set-Row 'web' $webLevel $webText

  if ($c) {
    $syncText = "{0}: {1} - {2} {3}" -f (T 'lastOp'), (Format-When $c.sync.lastOperationAt), $c.sync.openConflicts, (T 'conflicts')
    $syncLevel = [string]$c.sync.status
    if ($workerState -ne 'Running') { $syncLevel = 'warn'; $syncText += " - $(T 'workerStopped')" }
    Set-Row 'sync' $syncLevel $syncText
    $backupText = if (-not $c.backup.enabled) { T 'disabled' } else { "{0}: {1}" -f (T 'lastBackup'), (Format-When $c.backup.lastSuccessAt) }
    if ($c.backup.lastFailureError) { $backupText += " - $(T 'failed'): $($c.backup.lastFailureError)" }
    Set-Row 'backup' ([string]$c.backup.status) $backupText
    $netText = if ($c.internet.online -eq $false) { T 'offline' } else { T 'online' }
    Set-Row 'internet' ([string]$c.internet.status) $netText
  } else {
    foreach ($k in 'sync', 'backup', 'internet') { Set-Row $k 'unknown' '-' }
  }

  $relNow = Get-CurrentRelease
  $verText = if ($relNow) { "$($relNow.version)" } else { '?' }
  if ($relNow -and $relNow.PSObject.Properties['previous'] -and $relNow.previous) { $verText += " ($(T 'previous'): $($relNow.previous))" }
  if ($updaterState -eq 'Running') { Set-Row 'update' 'ok' "$(T 'running') - v$verText" }
  else { Set-Row 'update' 'warn' "$(T 'updaterStopped') - v$verText" }

  $drive = Get-PSDrive -Name ((Split-Path -Qualifier $InstallRoot).TrimEnd(':')) -ErrorAction SilentlyContinue
  $free = if ($drive) { $drive.Free } else { $null }
  $storageLevel = if ($c) { [string]$c.storage.status } elseif ($free -and $free -lt 5GB) { 'warn' } else { 'ok' }
  Set-Row 'storage' $storageLevel ("{0} {1} ({2})" -f (Format-Bytes $free), (T 'free'), $InstallRoot)

  $versionLabel.Text = "$(T 'version') $verText"
  $infoLines = @(
    "$(T 'localUrl'):  $LocalUrl",
    "$(T 'lanUrl'):  $(Get-LanUrl)",
    "$(T 'serverIp'):  $($install.lanIp)",
    "$(T 'publicUrl'):  $($install.publicUrl)"
  )
  $infoText.Text = $infoLines -join "`r`n`r`n"
}

function Set-Language {
  $form.Text = T 'title'
  $titleLabel.Text = T 'title'
  $langButton.Text = T 'language'
  $statusGroup.Text = T 'status'
  $infoGroup.Text = T 'info'
  $actionsGroup.Text = T 'actions'
  foreach ($k in $rows.Keys) { $rows[$k].Name.Text = T $k }
  foreach ($k in $buttonMap.Keys) { $buttonMap[$k].Text = T $k }
  $rtl = $script:Lang -eq 'ar'
  $form.RightToLeft = if ($rtl) { 'Yes' } else { 'No' }
  $form.RightToLeftLayout = $rtl
  Update-Status
}
$langButton.Add_Click({ $script:Lang = if ($script:Lang -eq 'ar') { 'en' } else { 'ar' }; Set-Language })

$refreshTimer = New-Object System.Windows.Forms.Timer
$refreshTimer.Interval = 5000
$refreshTimer.Add_Tick({ if (-not $script:Job) { Update-Status } })
$form.Add_Shown({ Set-Language; $refreshTimer.Start() })
$form.Add_FormClosing({ $refreshTimer.Stop(); $jobTimer.Stop() })
[System.Windows.Forms.Application]::Run($form)
