#Requires -Version 5.1
<#
.SYNOPSIS
  Installs Sofia's Resto-Lounge (Sofia Restaurant Management Platform) on a Windows server or PC.

.DESCRIPTION
  Run from the extracted "SofiaSetup" bundle (built by scripts/build-windows-bundle.mjs), as Administrator:

      powershell -ExecutionPolicy Bypass -File .\Install-Sofia.ps1

  The installer:
    1. checks the system requirements (Windows 10 1809+/Server 2019+, 64-bit, memory, disk, free ports)
    2. verifies every file in the bundle against bundle.json (SHA-256)
    3. installs Node.js 22 LTS and PostgreSQL 16 if they are missing (signature-checked installers)
    4. keeps PostgreSQL on localhost only and blocks port 5432 in Windows Firewall
    5. creates the database with two roles: an owner (migrations, backups) and a runtime role (data only)
    6. writes C:\Sofia\config\sofia.env with freshly generated secrets (no default passwords anywhere)
    7. installs the release under C:\Sofia\releases\<version> and runs the database migrations
    8. registers the Windows services SofiaAPI, SofiaWorker, SofiaUpdater (and SofiaWeb for HTTPS), auto-start
    9. opens the firewall for the local network only, starts everything and waits for the health check
   10. prints the address of the restaurant system and the one-time setup token for the first-run wizard

  HTTPS matters: tablets and phones only allow offline mode (service worker, local encryption) on HTTPS.
    -HttpsMode Lan     (default) HTTPS on the local network with Sofia's own certificate authority.
                       Each device installs the certificate once from http://<server-ip>/sofia-ca.crt
    -HttpsMode Domain  a real domain name with a public certificate (ports 80/443 forwarded to this PC)
    -HttpsMode None    plain HTTP on port 8080 (offline mode then works only on this PC itself)

  Running the installer again on an existing installation repairs it: secrets, database and data are kept.

.NOTES
  This script has not been executed on Windows by its authors yet. Test it on a non-production machine first.
#>
[CmdletBinding()]
param(
  [string]$InstallRoot = 'C:\Sofia',
  [ValidateRange(1024, 65535)][int]$Port = 8080,
  [ValidateSet('Lan', 'Domain', 'None')][string]$HttpsMode = 'Lan',
  [string]$Domain = '',
  [string]$AcmeEmail = '',
  [string]$LanIp = '',
  [string]$PostgresInstaller = '',
  [string]$PostgresVersion = '16.11-1',
  [System.Security.SecureString]$PostgresSuperPassword,
  [ValidateRange(1024, 65535)][int]$PostgresPort = 5432,
  [string]$NodeInstaller = '',
  [string]$UpdateFeedUrl = '',
  [switch]$Unattended
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Any error stops the installation with a readable message (and keeps the window open when run interactively).
trap {
  Write-Host ''
  Write-Host $_.Exception.Message -ForegroundColor Red
  if (-not $Unattended) { Read-Host 'Press Enter to close' | Out-Null }
  exit 1
}

$BundleDir = $PSScriptRoot
$LogFile = Join-Path $env:TEMP ("sofia-install-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$SidSystem = '*S-1-5-18'
$SidAdmins = '*S-1-5-32-544'

function Write-Step([string]$Message) {
  $line = "==> $Message"
  Write-Host $line -ForegroundColor Cyan
  Add-Content -Path $LogFile -Value ("[{0}] {1}" -f (Get-Date -Format s), $line)
}
function Write-Info([string]$Message) {
  Write-Host "    $Message"
  Add-Content -Path $LogFile -Value ("[{0}]     {1}" -f (Get-Date -Format s), $Message)
}
function Write-Warn2([string]$Message) {
  Write-Host "    WARNING: $Message" -ForegroundColor Yellow
  Add-Content -Path $LogFile -Value ("[{0}] WARNING {1}" -f (Get-Date -Format s), $Message)
}
function Fail([string]$Message) {
  Add-Content -Path $LogFile -Value ("[{0}] FAILED {1}" -f (Get-Date -Format s), $Message)
  throw "Sofia installation stopped: $Message  (log: $LogFile)"
}

function New-Secret([int]$Bytes = 32) {
  # Hex keeps secrets safe inside connection strings, env files and SQL literals.
  $b = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($b) } finally { $rng.Dispose() }
  return -join ($b | ForEach-Object { $_.ToString('x2') })
}

function Get-Sha256([string]$Path) { return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant() }

function Protect-Directory([string]$Path) {
  # SYSTEM and Administrators only (by SID, so it also works on Arabic/localized Windows).
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
  & icacls.exe $Path /inheritance:r /grant:r "${SidSystem}:(OI)(CI)F" "${SidAdmins}:(OI)(CI)F" | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "Could not set permissions on $Path" }
}

function Read-EnvFile([string]$Path) {
  $map = @{}
  if (Test-Path $Path) {
    foreach ($line in Get-Content -Path $Path) {
      if ($line -match '^\s*#' -or $line -notmatch '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { continue }
      $map[$Matches[1]] = $Matches[2].Trim()
    }
  }
  return $map
}

function Invoke-Native([string]$File, [string[]]$Arguments, [string]$What) {
  # Native tools write progress to stderr; with 'Stop' Windows PowerShell 5.1 would turn that into an error.
  $ErrorActionPreference = 'Continue'
  & $File @Arguments 2>&1 | ForEach-Object { Add-Content -Path $LogFile -Value "      $_" }
  if ($LASTEXITCODE -ne 0) { Fail "$What failed (exit code $LASTEXITCODE)" }
}

function Test-Signature([string]$Path, [string]$PublisherPattern) {
  $sig = Get-AuthenticodeSignature -FilePath $Path
  if ($sig.Status -ne 'Valid') { Fail "The installer $Path is not validly signed ($($sig.Status))." }
  if ($sig.SignerCertificate.Subject -notmatch $PublisherPattern) {
    Fail "The installer $Path is signed by an unexpected publisher: $($sig.SignerCertificate.Subject)"
  }
  Write-Info "signature OK: $($sig.SignerCertificate.Subject)"
}

function Get-LanIPv4 {
  $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1
  $candidates = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.AddressState -eq 'Preferred' }
  if ($route) {
    $preferred = $candidates | Where-Object { $_.InterfaceIndex -eq $route.InterfaceIndex } | Select-Object -First 1
    if ($preferred) { return $preferred.IPAddress }
  }
  $first = $candidates | Select-Object -First 1
  if ($first) { return $first.IPAddress }
  return '127.0.0.1'
}

function Wait-Http([string]$Url, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
      if ($r.StatusCode -eq 200) { return $true }
    } catch { Start-Sleep -Seconds 2 }
  }
  return $false
}

# ------------------------------------------------------------------------------------------------------------------
Write-Host ''
Write-Host "  Sofia's Resto-Lounge - server installation" -ForegroundColor White
Write-Host "  Log file: $LogFile"
Write-Host ''

# ---- 1. requirements --------------------------------------------------------------------------------------------
Write-Step 'Checking system requirements'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail 'Please run this installer as Administrator (right-click PowerShell > Run as administrator).'
}
if (-not [Environment]::Is64BitOperatingSystem) { Fail 'A 64-bit edition of Windows is required.' }
$os = Get-CimInstance Win32_OperatingSystem
if ([int]$os.BuildNumber -lt 17763) { Fail "Windows 10 version 1809 / Windows Server 2019 or newer is required (found build $($os.BuildNumber))." }
Write-Info "Windows: $($os.Caption) build $($os.BuildNumber)"
$ramGb = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
if ($ramGb -lt 4) { Write-Warn2 "Only $ramGb GB of memory. 8 GB or more is recommended for a busy restaurant." } else { Write-Info "Memory: $ramGb GB" }
$drive = (Split-Path -Qualifier $InstallRoot).TrimEnd(':')
$freeGb = [math]::Round((Get-PSDrive -Name $drive).Free / 1GB, 1)
if ($freeGb -lt 10) { Fail "At least 10 GB of free disk space is needed on drive ${drive}: (found $freeGb GB)." }
Write-Info "Free disk space on ${drive}: $freeGb GB"
if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) { Fail 'tar.exe was not found (it ships with Windows 10 1803 and newer).' }

$existingEnvPath = Join-Path $InstallRoot 'config\sofia.env'
$Repair = Test-Path $existingEnvPath
if ($Repair) { Write-Info "Existing installation found in $InstallRoot - repairing it (data and secrets are kept)." }

$portsToCheck = @($Port)
if ($HttpsMode -ne 'None') { $portsToCheck += 80, 443 }
foreach ($p in $portsToCheck) {
  $listener = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    $owner = (Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue).ProcessName
    if (-not ($Repair -and $owner -in @('node', 'caddy'))) { Fail "Port $p is already used by '$owner'. Choose another -Port or stop that program." }
  }
}
if ($HttpsMode -eq 'Domain' -and (-not $Domain -or -not $AcmeEmail)) { Fail '-HttpsMode Domain needs -Domain (e.g. book.example.com) and -AcmeEmail.' }

# ---- 2. bundle integrity ----------------------------------------------------------------------------------------
Write-Step 'Verifying the installation bundle'
$bundleJson = Join-Path $BundleDir 'bundle.json'
if (-not (Test-Path $bundleJson)) { Fail "bundle.json not found next to the installer ($BundleDir)." }
$bundle = Get-Content -Raw -Path $bundleJson | ConvertFrom-Json
foreach ($f in $bundle.files) {
  $path = Join-Path $BundleDir $f.path
  if (-not (Test-Path $path)) { Fail "Missing bundle file: $($f.path)" }
  if ((Get-Sha256 $path) -ne $f.sha256) { Fail "Bundle file is damaged or was modified: $($f.path)" }
}
$Version = [string]$bundle.version
Write-Info "Sofia version $Version - $(@($bundle.files).Count) files verified"

# ---- 3. Node.js -------------------------------------------------------------------------------------------------
Write-Step 'Node.js runtime'
$NodeExe = Join-Path $env:ProgramFiles 'nodejs\node.exe'
$nodeOk = $false
if (Test-Path $NodeExe) {
  $nv = (& $NodeExe --version).TrimStart('v')
  $nodeOk = ([int]($nv.Split('.')[0]) -ge 22)
  Write-Info "found Node.js $nv"
}
if (-not $nodeOk) {
  $msi = $NodeInstaller
  if (-not $msi -and $bundle.PSObject.Properties['node'] -and $bundle.node) { $msi = Join-Path $BundleDir $bundle.node }
  if (-not $msi) {
    Write-Info 'downloading Node.js 22 LTS from nodejs.org'
    $base = 'https://nodejs.org/dist/latest-v22.x/'
    $sums = (Invoke-WebRequest -Uri ($base + 'SHASUMS256.txt') -UseBasicParsing).Content
    $line = ($sums -split "`n") | Where-Object { $_ -match 'node-v[0-9.]+-x64\.msi$' } | Select-Object -First 1
    if (-not $line) { Fail 'Could not find the Node.js installer in SHASUMS256.txt' }
    $parts = $line.Trim() -split '\s+'
    $msi = Join-Path $env:TEMP $parts[1]
    Invoke-WebRequest -Uri ($base + $parts[1]) -OutFile $msi -UseBasicParsing
    if ((Get-Sha256 $msi) -ne $parts[0].ToLowerInvariant()) { Fail 'The downloaded Node.js installer does not match its published checksum.' }
  }
  Test-Signature $msi 'OpenJS Foundation|Node\.js Foundation'
  Write-Info "installing $msi"
  Invoke-Native 'msiexec.exe' @('/i', $msi, '/qn', '/norestart') 'Node.js installation'
  if (-not (Test-Path $NodeExe)) { Fail 'Node.js was not installed correctly.' }
  Write-Info "installed Node.js $((& $NodeExe --version))"
}

# ---- 4. PostgreSQL ----------------------------------------------------------------------------------------------
Write-Step 'PostgreSQL 16 database server'
function Find-Postgres16 {
  $keys = Get-ChildItem 'HKLM:\SOFTWARE\PostgreSQL\Installations' -ErrorAction SilentlyContinue
  foreach ($k in $keys) {
    $p = Get-ItemProperty $k.PSPath
    if ($p.PSObject.Properties['Version'] -and "$($p.Version)" -like '16*') {
      return [pscustomobject]@{ Bin = (Join-Path $p.'Base Directory' 'bin'); Data = $p.'Data Directory'; Service = $p.'Service ID' }
    }
  }
  $default = Join-Path $env:ProgramFiles 'PostgreSQL\16'
  if (Test-Path (Join-Path $default 'bin\psql.exe')) {
    return [pscustomobject]@{ Bin = (Join-Path $default 'bin'); Data = (Join-Path $default 'data'); Service = 'postgresql-x64-16' }
  }
  return $null
}

$superPasswordFile = Join-Path $InstallRoot 'config\postgres-superuser.txt'
$pg = Find-Postgres16
$SuperPassword = $null
if ($pg) {
  Write-Info "found PostgreSQL 16 in $($pg.Bin) (service $($pg.Service))"
  if ($PostgresSuperPassword) {
    $SuperPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($PostgresSuperPassword))
  } elseif (Test-Path $superPasswordFile) {
    $SuperPassword = (Get-Content -Raw $superPasswordFile).Trim()
  } elseif (-not $Unattended) {
    $sec = Read-Host -AsSecureString 'Password of the PostgreSQL "postgres" superuser'
    $SuperPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  } else {
    Fail 'PostgreSQL is already installed: pass -PostgresSuperPassword.'
  }
} else {
  $exe = $PostgresInstaller
  if (-not $exe -and $bundle.PSObject.Properties['postgres'] -and $bundle.postgres) { $exe = Join-Path $BundleDir $bundle.postgres }
  if (-not $exe) {
    $url = "https://get.enterprisedb.com/postgresql/postgresql-$PostgresVersion-windows-x64.exe"
    Write-Info "downloading $url"
    $exe = Join-Path $env:TEMP "postgresql-$PostgresVersion-windows-x64.exe"
    try { Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing }
    catch { Fail "Could not download PostgreSQL ($url). Download PostgreSQL 16 for Windows x64 from https://www.enterprisedb.com/downloads/postgres-postgresql-downloads and run again with -PostgresInstaller <file>." }
  }
  Test-Signature $exe 'EnterpriseDB'
  $SuperPassword = New-Secret 24
  $pgData = Join-Path $InstallRoot 'pgdata'
  Write-Info "installing PostgreSQL (data directory $pgData) - this can take a few minutes"
  Invoke-Native $exe @('--mode', 'unattended', '--unattendedmodeui', 'none', '--superpassword', $SuperPassword,
    '--servicename', 'postgresql-x64-16', '--serverport', "$PostgresPort", '--datadir', $pgData,
    '--disable-components', 'pgAdmin,stackbuilder', '--locale', 'C') 'PostgreSQL installation'
  $pg = Find-Postgres16
  if (-not $pg) { Fail 'PostgreSQL 16 was not found after installation.' }
  New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot 'config') | Out-Null
  Protect-Directory (Join-Path $InstallRoot 'config')
  Set-Content -Path $superPasswordFile -Value $SuperPassword -Encoding ASCII
  Write-Info "superuser password saved to $superPasswordFile (Administrators only)"
}
$Psql = Join-Path $pg.Bin 'psql.exe'
$env:PGPASSWORD = $SuperPassword
function Invoke-Sql([string]$Database, [string]$Sql, [string]$What) {
  $ErrorActionPreference = 'Continue'
  $out = $Sql | & $Psql -X -q -t -A -h 127.0.0.1 -p $PostgresPort -U postgres -d $Database -v ON_ERROR_STOP=1 -f - 2>&1
  if ($LASTEXITCODE -ne 0) { Fail "$What failed: $out" }
  return ($out | Out-String).Trim()
}

Write-Info 'restricting PostgreSQL to this computer (localhost only)'
$listen = Invoke-Sql 'postgres' 'SHOW listen_addresses;' 'Reading PostgreSQL settings'
if ($listen -ne 'localhost') {
  Invoke-Sql 'postgres' "ALTER SYSTEM SET listen_addresses = 'localhost';" 'Restricting PostgreSQL to localhost' | Out-Null
  Restart-Service -Name $pg.Service -Force
  Start-Sleep -Seconds 3
}
if (-not (Get-NetFirewallRule -DisplayName 'Sofia - block PostgreSQL from the network' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'Sofia - block PostgreSQL from the network' -Direction Inbound -Protocol TCP -LocalPort $PostgresPort -Action Block | Out-Null
}
Set-Service -Name $pg.Service -StartupType Automatic

# ---- 5. database and roles --------------------------------------------------------------------------------------
Write-Step 'Database and roles'
$envOld = Read-EnvFile $existingEnvPath
function Get-UrlPassword([string]$Url) { if ($Url -match '^postgres(?:ql)?://[^:]+:([^@]+)@') { return $Matches[1] } else { return $null } }
$OwnerPassword = Get-UrlPassword $envOld['DATABASE_OWNER_URL']; if (-not $OwnerPassword) { $OwnerPassword = New-Secret 24 }
$AppPassword = Get-UrlPassword $envOld['DATABASE_URL']; if (-not $AppPassword) { $AppPassword = New-Secret 24 }

$roleSql = @'
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sofia_owner') THEN
    CREATE ROLE sofia_owner LOGIN PASSWORD '{OWNER}';
  ELSE
    ALTER ROLE sofia_owner LOGIN PASSWORD '{OWNER}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sofia_app') THEN
    CREATE ROLE sofia_app LOGIN PASSWORD '{APP}';
  ELSE
    ALTER ROLE sofia_app LOGIN PASSWORD '{APP}';
  END IF;
END
$do$;
'@
Invoke-Sql 'postgres' ($roleSql.Replace('{OWNER}', $OwnerPassword).Replace('{APP}', $AppPassword)) 'Creating database roles' | Out-Null
$hasDb = Invoke-Sql 'postgres' "SELECT 1 FROM pg_database WHERE datname = 'sofia';" 'Checking the database'
if ($hasDb -ne '1') {
  Invoke-Sql 'postgres' "CREATE DATABASE sofia OWNER sofia_owner ENCODING 'UTF8' TEMPLATE template0;" 'Creating the database' | Out-Null
  Write-Info 'database "sofia" created'
}
$dbSql = @'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO sofia_owner;
REVOKE ALL ON DATABASE sofia FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE sofia TO sofia_owner;
GRANT CONNECT ON DATABASE sofia TO sofia_app;
'@
Invoke-Sql 'sofia' $dbSql 'Preparing the database' | Out-Null
Remove-Item Env:\PGPASSWORD
Write-Info 'roles: sofia_owner (schema, backups) and sofia_app (application data only)'

# ---- 6. folders and configuration -------------------------------------------------------------------------------
Write-Step "Installing files to $InstallRoot"
foreach ($d in 'releases', 'services', 'logs', 'tools', 'https') { New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot $d) | Out-Null }
foreach ($d in 'config', 'data', 'backups') { Protect-Directory (Join-Path $InstallRoot $d) }

if (-not $LanIp) { $LanIp = Get-LanIPv4 }
switch ($HttpsMode) {
  'Lan'    { $PublicUrl = "https://$LanIp"; $BindHost = '127.0.0.1' }
  'Domain' { $PublicUrl = "https://$Domain"; $BindHost = '127.0.0.1' }
  default  { $PublicUrl = "http://${LanIp}:$Port"; $BindHost = '0.0.0.0' }
}
if ($envOld['SOFIA_PUBLIC_URL'] -and $Repair -and -not $PSBoundParameters.ContainsKey('HttpsMode')) { $PublicUrl = $envOld['SOFIA_PUBLIC_URL'] }

function KeepOr([string]$Key, [string]$Fallback) { if ($envOld[$Key]) { return $envOld[$Key] } else { return $Fallback } }
$JwtSecret = KeepOr 'SOFIA_JWT_SECRET' (New-Secret 48)
$EncKey = KeepOr 'SOFIA_ENCRYPTION_KEY' (New-Secret 32)
$SetupToken = KeepOr 'SOFIA_SETUP_TOKEN' (New-Secret 8)
$FeedUrl = $UpdateFeedUrl; if (-not $FeedUrl) { $FeedUrl = KeepOr 'SOFIA_UPDATE_FEED_URL' '' }
$fwd = $InstallRoot.Replace('\', '/')

$envText = @"
# Sofia's Resto-Lounge server configuration - generated $(Get-Date -Format s). KEEP THIS FILE SECRET.
# Readable by SYSTEM and Administrators only. Changing a secret signs everybody out (JWT) or makes stored
# integration credentials unreadable (ENCRYPTION_KEY) - keep a copy of this file with your backups.
NODE_ENV=production
HOST=$BindHost
PORT=$Port
DATABASE_URL=postgres://sofia_app:$AppPassword@127.0.0.1:$PostgresPort/sofia
DATABASE_OWNER_URL=postgres://sofia_owner:$OwnerPassword@127.0.0.1:$PostgresPort/sofia
SOFIA_DB_APP_ROLE=sofia_app
SOFIA_JWT_SECRET=$JwtSecret
SOFIA_ENCRYPTION_KEY=$EncKey
SOFIA_SETUP_TOKEN=$SetupToken
SOFIA_PUBLIC_URL=$PublicUrl
SOFIA_TRUST_PROXY=$(if ($HttpsMode -eq 'None') { 'false' } else { 'true' })
SOFIA_DATA_DIR=$fwd/data
SOFIA_BACKUP_DIR=$fwd/backups
SOFIA_PG_BIN=$($pg.Bin)
SOFIA_INSTALL_ROOT=$InstallRoot
SOFIA_SERVICE_CONTROLLER=launcher
SOFIA_SERVICE_NAMES=SofiaAPI,SofiaWorker
SOFIA_EMBEDDED_WORKER=false
SOFIA_UPDATE_FEED_URL=$FeedUrl
SOFIA_UPDATE_CHANNEL=$(KeepOr 'SOFIA_UPDATE_CHANNEL' 'stable')
SOFIA_LOG_LEVEL=info
"@
Set-Content -Path $existingEnvPath -Value $envText -Encoding ASCII
Write-Info "configuration written to $existingEnvPath"

$keySrc = Join-Path $BundleDir 'payload\update-public-key.pem'
if ((Test-Path $keySrc) -and (Get-Item $keySrc).Length -gt 0) {
  Copy-Item $keySrc (Join-Path $InstallRoot 'config\update-public-key.pem') -Force
} else {
  Write-Warn2 'No update signing key in this bundle: the Update Center will refuse all update packages until one is added to config\update-public-key.pem.'
}

# ---- 7. release -------------------------------------------------------------------------------------------------
$releaseDir = Join-Path $InstallRoot "releases\$Version"
if (-not (Test-Path (Join-Path $releaseDir 'server\main.js'))) {
  Write-Info "extracting release $Version"
  New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
  Invoke-Native 'tar.exe' @('-xzf', (Join-Path $BundleDir $bundle.release), '-C', $releaseDir) 'Extracting the release'
}
$currentPath = Join-Path $InstallRoot 'current.json'
$current = $null
if (Test-Path $currentPath) { $current = Get-Content -Raw $currentPath | ConvertFrom-Json }
if (-not $current -or [version]$current.version -lt [version]$Version) {
  $previous = $null; if ($current) { $previous = $current.version }
  (@{ version = $Version; previous = $previous; switchedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json) | Set-Content -Path $currentPath -Encoding ASCII
}
Copy-Item (Join-Path $releaseDir 'launcher.mjs') (Join-Path $InstallRoot 'launcher.mjs') -Force
foreach ($tool in 'SofiaServerManager.ps1', 'Uninstall-Sofia.ps1', 'sofia.ico') { Copy-Item (Join-Path $BundleDir $tool) (Join-Path $InstallRoot "tools\$tool") -Force }
$cmd = "@echo off`r`nset `"SOFIA_ENV_FILE=$existingEnvPath`"`r`nset `"SOFIA_INSTALL_ROOT=$InstallRoot`"`r`n`"$NodeExe`" `"$InstallRoot\launcher.mjs`" cli %*`r`n"
Set-Content -Path (Join-Path $InstallRoot 'sofia.cmd') -Value $cmd -Encoding ASCII

Write-Step 'Database migrations'
$env:SOFIA_ENV_FILE = $existingEnvPath
$env:SOFIA_INSTALL_ROOT = $InstallRoot
Invoke-Native $NodeExe @((Join-Path $InstallRoot 'launcher.mjs'), 'cli', 'migrate') 'Database migration'
Write-Info 'database schema is up to date'

# ---- 8. services ------------------------------------------------------------------------------------------------
Write-Step 'Windows services'
$winsw = Join-Path $BundleDir $bundle.winsw
$template = Get-Content -Raw (Join-Path $BundleDir 'templates\service.xml')
function Install-SofiaService([string]$Id, [string]$Name, [string]$Description, [string]$Executable, [string]$Arguments, [string]$Depends) {
  $dir = Join-Path $InstallRoot 'services'
  $exe = Join-Path $dir "$Id.exe"
  $existing = Get-Service -Name $Id -ErrorAction SilentlyContinue
  if ($existing) {
    if ($existing.Status -ne 'Stopped') { Stop-Service -Name $Id -Force -ErrorAction SilentlyContinue }
    if (Test-Path $exe) { & $exe uninstall | Out-Null } else { & sc.exe delete $Id | Out-Null }
    Start-Sleep -Seconds 2
  }
  Copy-Item $winsw $exe -Force
  $values = [ordered]@{
    '{ID}' = $Id; '{NAME}' = $Name; '{DESCRIPTION}' = $Description; '{EXECUTABLE}' = $Executable; '{ARGUMENTS}' = $Arguments
    '{WORKDIR}' = $InstallRoot; '{LOGDIR}' = (Join-Path $InstallRoot 'logs'); '{ENVFILE}' = $existingEnvPath; '{ROOT}' = $InstallRoot
  }
  $xml = $template
  foreach ($k in $values.Keys) { $xml = $xml.Replace($k, [Security.SecurityElement]::Escape([string]$values[$k])) }
  $xml = $xml.Replace('{DEPENDS}', $Depends)
  Set-Content -Path (Join-Path $dir "$Id.xml") -Value $xml -Encoding UTF8
  Invoke-Native $exe @('install') "Registering service $Id"
  Write-Info "service $Id registered (automatic start)"
}
$launcherArgs = '"' + (Join-Path $InstallRoot 'launcher.mjs') + '"'
$dep = "<depend>$($pg.Service)</depend>"
Install-SofiaService 'SofiaAPI' 'Sofia API' "Sofia's Resto-Lounge application server" $NodeExe "$launcherArgs api" $dep
Install-SofiaService 'SofiaWorker' 'Sofia Worker' "Sofia's Resto-Lounge background jobs (reminders, backups, messages, POS)" $NodeExe "$launcherArgs worker" $dep
Install-SofiaService 'SofiaUpdater' 'Sofia Updater' "Sofia's Resto-Lounge System Update Center" $NodeExe "$launcherArgs updater" $dep

if ($HttpsMode -ne 'None') {
  $caddyDir = Join-Path $InstallRoot 'caddy'
  New-Item -ItemType Directory -Force -Path $caddyDir | Out-Null
  $tmp = Join-Path $env:TEMP 'sofia-caddy'
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive -Path (Join-Path $BundleDir $bundle.caddy) -DestinationPath $tmp -Force
  Copy-Item (Join-Path $tmp 'caddy.exe') (Join-Path $caddyDir 'caddy.exe') -Force
  $cf = Get-Content -Raw (Join-Path $BundleDir "templates\Caddyfile.$($HttpsMode.ToLowerInvariant())")
  $cf = $cf.Replace('{ROOT}', $fwd).Replace('{PORT}', "$Port").Replace('{LAN_IP}', $LanIp)
  $cf = $cf.Replace('{HOSTNAME}', $env:COMPUTERNAME.ToLowerInvariant()).Replace('{DOMAIN}', $Domain).Replace('{EMAIL}', $AcmeEmail)
  Set-Content -Path (Join-Path $caddyDir 'Caddyfile') -Value $cf -Encoding ASCII
  Install-SofiaService 'SofiaWeb' 'Sofia Web (HTTPS)' "Sofia's Resto-Lounge HTTPS front end (Caddy)" (Join-Path $caddyDir 'caddy.exe') ('run --config "' + (Join-Path $caddyDir 'Caddyfile') + '" --adapter caddyfile') ''
}

# ---- 9. firewall ------------------------------------------------------------------------------------------------
Write-Step 'Windows Firewall'
Get-NetFirewallRule -DisplayName 'Sofia - restaurant system*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if ($HttpsMode -eq 'None') {
  New-NetFirewallRule -DisplayName "Sofia - restaurant system (HTTP $Port)" -Direction Inbound -Protocol TCP -LocalPort $Port -Profile Private, Domain -Action Allow | Out-Null
  Write-Info "port $Port open for the local network (Private/Domain profiles)"
} else {
  $profiles = if ($HttpsMode -eq 'Domain') { 'Any' } else { 'Private, Domain' }
  New-NetFirewallRule -DisplayName 'Sofia - restaurant system (HTTP/HTTPS)' -Direction Inbound -Protocol TCP -LocalPort 80, 443 -Profile $profiles -Action Allow | Out-Null
  Write-Info "ports 80/443 open ($profiles); the application port $Port stays private to this PC"
}
$publicNets = Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq 'Public' }
if ($publicNets -and $HttpsMode -ne 'Domain') {
  Write-Warn2 "The network '$(($publicNets | Select-Object -First 1).Name)' is marked Public: tablets will not reach the server. Set it to Private in Windows Settings > Network."
}

# ---- 10. start and verify ---------------------------------------------------------------------------------------
Write-Step 'Starting Sofia'
Start-Service -Name $pg.Service -ErrorAction SilentlyContinue
foreach ($s in 'SofiaAPI', 'SofiaWorker', 'SofiaUpdater', 'SofiaWeb') { if (Get-Service -Name $s -ErrorAction SilentlyContinue) { Start-Service -Name $s } }
if (-not (Wait-Http "http://127.0.0.1:$Port/health/ready" 120)) { Fail "Sofia did not become ready. See the logs in $InstallRoot\logs." }
Write-Info 'health check passed'

$caThumb = $null
if ($HttpsMode -eq 'Lan') {
  $rootCrt = Join-Path $InstallRoot 'caddy\data\pki\authorities\local\root.crt'
  $deadline = (Get-Date).AddSeconds(60)
  while (-not (Test-Path $rootCrt) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
  if (Test-Path $rootCrt) {
    Copy-Item $rootCrt (Join-Path $InstallRoot 'https\sofia-ca.crt') -Force
    $cert = Import-Certificate -FilePath $rootCrt -CertStoreLocation 'Cert:\LocalMachine\Root'
    $caThumb = $cert.Thumbprint
    Write-Info 'Sofia certificate authority trusted on this PC; devices install it from the address below'
  } else {
    Write-Warn2 'The HTTPS certificate was not created yet - check the SofiaWeb service log.'
  }
}

$install = [ordered]@{
  version = $Version; installedAt = (Get-Date).ToUniversalTime().ToString('o'); httpsMode = $HttpsMode; port = $Port
  lanIp = $LanIp; publicUrl = $PublicUrl; postgresService = $pg.Service; postgresBin = $pg.Bin; postgresPort = $PostgresPort
  nodeExe = $NodeExe; caThumbprint = $caThumb; services = @('SofiaAPI', 'SofiaWorker', 'SofiaUpdater') + $(if ($HttpsMode -ne 'None') { @('SofiaWeb') } else { @() })
}
($install | ConvertTo-Json) | Set-Content -Path (Join-Path $InstallRoot 'config\install.json') -Encoding ASCII

# Shortcuts for the Server Manager (it asks for administrator rights itself).
$shell = New-Object -ComObject WScript.Shell
$target = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$smArgs = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $InstallRoot 'tools\SofiaServerManager.ps1') + '"'
$icon = Join-Path $InstallRoot 'tools\sofia.ico'
foreach ($lnkDir in @([Environment]::GetFolderPath('CommonDesktopDirectory'), (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) "Sofia's Resto-Lounge"))) {
  New-Item -ItemType Directory -Force -Path $lnkDir | Out-Null
  $lnk = $shell.CreateShortcut((Join-Path $lnkDir 'Sofia Server Manager.lnk'))
  $lnk.TargetPath = $target; $lnk.Arguments = $smArgs; $lnk.WorkingDirectory = $InstallRoot
  if (Test-Path $icon) { $lnk.IconLocation = $icon }
  $lnk.Save()
}

$setupDone = $false
try { $setupDone = (Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/v1/setup/status" -TimeoutSec 5).completed } catch { }
Write-Host ''
Write-Host '  Sofia is installed and running.' -ForegroundColor Green
Write-Host ''
Write-Host "  On this PC:            http://localhost:$Port"
Write-Host "  Tablets and phones:    $PublicUrl"
if ($HttpsMode -eq 'Lan') {
  Write-Host "  Device certificate:    http://$LanIp/sofia-ca.crt  (install once on each tablet/phone)"
  if ($caThumb) { Write-Host "  Certificate fingerprint (SHA-1): $caThumb  - compare it when installing on staff PCs" }
}
if (-not $setupDone) {
  Write-Host ''
  Write-Host "  First-run setup token: $SetupToken" -ForegroundColor Yellow
  Write-Host '  Open the address above and complete the setup wizard (restaurant, branch, tables, owner account).'
}
Write-Host ''
Write-Host "  Server Manager:        desktop shortcut 'Sofia Server Manager'"
Write-Host "  Command line:          $InstallRoot\sofia.cmd help"
Write-Host "  Installation log:      $LogFile"
Write-Host ''
if (-not $Unattended) {
  if (-not $setupDone) { Start-Process "http://localhost:$Port/" }
  Read-Host 'Press Enter to close' | Out-Null
}
