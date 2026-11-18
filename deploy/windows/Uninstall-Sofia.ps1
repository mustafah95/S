#Requires -Version 5.1
<#
.SYNOPSIS
  Removes the Sofia's Resto-Lounge services from this computer.

.DESCRIPTION
  By default only the program is removed: the Windows services, firewall rules, shortcuts, the Sofia certificate
  authority and the application files. The database, the configuration (secrets) and the backups are KEPT, so a
  later installation continues with the same data.

    -RemoveData       also delete C:\Sofia\data, C:\Sofia\config and the database "sofia" (asks for confirmation;
                      backups are still kept)
    -RemoveBackups    with -RemoveData: also delete C:\Sofia\backups

  Node.js and PostgreSQL are not uninstalled (other programs may use them); remove them from Windows Settings
  > Apps if they are no longer needed.

.NOTES
  This script has not been executed on Windows by its authors yet.
#>
[CmdletBinding()]
param(
  [string]$InstallRoot = '',
  [switch]$RemoveData,
  [switch]$RemoveBackups,
  [switch]$Force
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Please run as Administrator.'
}
if (-not $InstallRoot) {
  $InstallRoot = if ((Split-Path -Leaf $PSScriptRoot) -eq 'tools') { Split-Path -Parent $PSScriptRoot } else { 'C:\Sofia' }
}
$installFile = Join-Path $InstallRoot 'config\install.json'
$install = $null
if (Test-Path $installFile) { $install = Get-Content -Raw $installFile | ConvertFrom-Json }

if ($RemoveData -and -not $Force) {
  Write-Host ''
  Write-Host 'WARNING: -RemoveData permanently deletes the restaurant database (guests, reservations, history).' -ForegroundColor Red
  $typed = Read-Host 'Type DELETE to continue'
  if ($typed -ne 'DELETE') { Write-Host 'Cancelled.'; exit 1 }
}

Write-Host '==> Stopping and removing services' -ForegroundColor Cyan
foreach ($id in 'SofiaWeb', 'SofiaUpdater', 'SofiaWorker', 'SofiaAPI') {
  $svc = Get-Service -Name $id -ErrorAction SilentlyContinue
  if (-not $svc) { continue }
  if ($svc.Status -ne 'Stopped') { Stop-Service -Name $id -Force -ErrorAction SilentlyContinue }
  $exe = Join-Path $InstallRoot "services\$id.exe"
  if (Test-Path $exe) { & $exe uninstall | Out-Null } else { & sc.exe delete $id | Out-Null }
  Write-Host "    removed $id"
}

Write-Host '==> Firewall rules, shortcuts, certificate' -ForegroundColor Cyan
Get-NetFirewallRule -DisplayName 'Sofia - restaurant system*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
# The rule blocking PostgreSQL from the network is kept while PostgreSQL stays installed.
foreach ($lnk in @(
    (Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Sofia Server Manager.lnk'),
    (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) "Sofia's Resto-Lounge"))) {
  Remove-Item -Path $lnk -Recurse -Force -ErrorAction SilentlyContinue
}
if ($install -and $install.PSObject.Properties['caThumbprint'] -and $install.caThumbprint) {
  Remove-Item -Path ("Cert:\LocalMachine\Root\{0}" -f $install.caThumbprint) -ErrorAction SilentlyContinue
  Write-Host '    Sofia certificate authority removed from this PC'
}

Write-Host '==> Application files' -ForegroundColor Cyan
foreach ($d in 'releases', 'services', 'caddy', 'https', 'tools', 'logs') {
  Remove-Item -Path (Join-Path $InstallRoot $d) -Recurse -Force -ErrorAction SilentlyContinue
}
foreach ($f in 'launcher.mjs', 'current.json', 'sofia.cmd') { Remove-Item -Path (Join-Path $InstallRoot $f) -Force -ErrorAction SilentlyContinue }

if ($RemoveData) {
  Write-Host '==> Database and data' -ForegroundColor Cyan
  $superFile = Join-Path $InstallRoot 'config\postgres-superuser.txt'
  if ($install -and (Test-Path $superFile)) {
    $env:PGPASSWORD = (Get-Content -Raw $superFile).Trim()
    $psql = Join-Path $install.postgresBin 'psql.exe'
    $ErrorActionPreference = 'Continue'
    'DROP DATABASE IF EXISTS sofia WITH (FORCE); DROP ROLE IF EXISTS sofia_app; DROP ROLE IF EXISTS sofia_owner;' |
      & $psql -X -q -h 127.0.0.1 -p $install.postgresPort -U postgres -d postgres -v ON_ERROR_STOP=1 -f - 2>&1 | Out-Host
    $ErrorActionPreference = 'Stop'
    Remove-Item Env:\PGPASSWORD
  } else {
    Write-Host '    The PostgreSQL superuser password is not stored here; drop the database "sofia" manually if needed.' -ForegroundColor Yellow
  }
  Remove-Item -Path (Join-Path $InstallRoot 'data') -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -Path (Join-Path $InstallRoot 'config') -Recurse -Force -ErrorAction SilentlyContinue
  if ($RemoveBackups) { Remove-Item -Path (Join-Path $InstallRoot 'backups') -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
Write-Host 'Sofia has been removed.' -ForegroundColor Green
if (-not $RemoveData) { Write-Host "Database, configuration and backups were kept ($InstallRoot\config, $InstallRoot\backups)." }
elseif (-not $RemoveBackups) { Write-Host "Backups were kept in $InstallRoot\backups." }
