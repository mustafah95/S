#Requires -Version 5.1
<#
.SYNOPSIS
  Prepares a staff Windows PC (reception, manager office, cashier) to use Sofia's Resto-Lounge.

.DESCRIPTION
  Sofia runs on the restaurant server; staff PCs use it as an installed web app, which also works when the server
  or the internet is temporarily unavailable. This script:
    1. asks for the server address (shown by the server installer and in Sofia Server Manager)
    2. if the server uses the restaurant-network HTTPS option, downloads its certificate, shows the fingerprint
       for comparison with the one in Sofia Server Manager, and installs it as a trusted root on this PC
    3. checks that the server answers over HTTPS
    4. creates "Sofia's Resto-Lounge" shortcuts (desktop + Start menu) that open the app in its own window

    powershell -ExecutionPolicy Bypass -File .\Install-SofiaStaffPC.ps1 [-Server 192.168.1.10]

.NOTES
  This script has not been executed on Windows by its authors yet.
#>
[CmdletBinding()]
param(
  [string]$Server = '',
  [switch]$SkipCertificate
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $argList = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"'
  if ($Server) { $argList += ' -Server "' + $Server + '"' }
  if ($SkipCertificate) { $argList += ' -SkipCertificate' }
  Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs
  exit
}

trap {
  Write-Host ''
  Write-Host $_.Exception.Message -ForegroundColor Red
  Read-Host 'Press Enter to close' | Out-Null
  exit 1
}

Write-Host ''
Write-Host "  Sofia's Resto-Lounge - staff PC setup" -ForegroundColor White
Write-Host ''

if (-not $Server) { $Server = Read-Host 'Server address (for example 192.168.1.10 or sofia.example.com)' }
$Server = ($Server.Trim() -replace '^https?://', '').TrimEnd('/')
if (-not $Server -or $Server -notmatch '^[A-Za-z0-9.\-:\[\]]+$') { throw "Invalid server address: '$Server'" }

# ---- certificate (restaurant-network HTTPS) ----------------------------------------------------------------------
if (-not $SkipCertificate) {
  Write-Host '==> Restaurant certificate' -ForegroundColor Cyan
  $crtFile = Join-Path $env:TEMP 'sofia-ca.crt'
  $downloaded = $false
  try {
    Invoke-WebRequest -Uri "http://$Server/sofia-ca.crt" -OutFile $crtFile -UseBasicParsing -TimeoutSec 15
    $downloaded = $true
  } catch {
    Write-Host '    No restaurant certificate offered by this server (public certificate or plain HTTP) - skipped.'
  }
  if ($downloaded) {
    $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($crtFile)
    if (-not ($cert.Extensions | Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension] -and $_.CertificateAuthority })) {
      throw 'The downloaded file is not a certificate authority certificate. Nothing was installed.'
    }
    Write-Host "    Issued to:   $($cert.Subject)"
    Write-Host "    Valid until: $($cert.NotAfter.ToString('yyyy-MM-dd'))"
    Write-Host "    Fingerprint: $($cert.Thumbprint)" -ForegroundColor Yellow
    Write-Host ''
    Write-Host '    Compare the fingerprint with the one shown on the server'
    Write-Host '    (Sofia Server Manager > Device certificate, or the end of the server installation).'
    $answer = Read-Host '    Do they match? (Y/N)'
    if ($answer -notmatch '^[Yy]') { throw 'The certificate was NOT installed (fingerprint not confirmed). Check the server address.' }
    Import-Certificate -FilePath $crtFile -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null
    Remove-Item $crtFile -Force
    Write-Host '    Certificate installed (trusted for this PC).' -ForegroundColor Green
  }
}

# ---- connection check ------------------------------------------------------------------------------------------------
Write-Host '==> Checking the connection' -ForegroundColor Cyan
$appUrl = "https://$Server/"
try {
  $r = Invoke-WebRequest -Uri "https://$Server/health/live" -UseBasicParsing -TimeoutSec 15
  Write-Host "    Sofia answered over HTTPS ($($r.StatusCode))." -ForegroundColor Green
} catch {
  Write-Host "    Sofia did not answer on $appUrl ($($_.Exception.Message))." -ForegroundColor Yellow
  Write-Host '    If the server was installed with -HttpsMode None, the address is http://SERVER:8080 and offline mode'
  Write-Host '    is not available on this PC. The shortcut is created anyway.'
}

# ---- shortcuts ---------------------------------------------------------------------------------------------------
Write-Host '==> Shortcuts' -ForegroundColor Cyan
$browsers = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
)
$browser = $browsers | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $browser) { throw 'Microsoft Edge or Google Chrome is required.' }
$iconDir = Join-Path $env:ProgramData 'Sofia'
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null
$icon = Join-Path $PSScriptRoot 'sofia.ico'
if (Test-Path $icon) { Copy-Item $icon (Join-Path $iconDir 'sofia.ico') -Force }
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('CommonDesktopDirectory'), [Environment]::GetFolderPath('CommonPrograms'))) {
  $lnk = $shell.CreateShortcut((Join-Path $dir "Sofia's Resto-Lounge.lnk"))
  $lnk.TargetPath = $browser
  $lnk.Arguments = "--app=$appUrl"
  $lnk.Description = "Sofia's Resto-Lounge"
  if (Test-Path (Join-Path $iconDir 'sofia.ico')) { $lnk.IconLocation = (Join-Path $iconDir 'sofia.ico') }
  $lnk.Save()
}
Write-Host "    Desktop and Start menu: Sofia's Resto-Lounge -> $appUrl" -ForegroundColor Green

Write-Host ''
Write-Host '  Done. Open the shortcut and sign in once while the server is reachable:' -ForegroundColor Green
Write-Host '  after that this PC keeps working when the server or the internet is down, and syncs automatically.'
Write-Host ''
Start-Process -FilePath $browser -ArgumentList "--app=$appUrl"
Read-Host 'Press Enter to close' | Out-Null
