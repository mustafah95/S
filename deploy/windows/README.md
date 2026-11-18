Sofia's Resto-Lounge - Windows installation
=============================================

What you need
-------------
* Windows 10 (1809 or newer), Windows 11 or Windows Server 2019/2022/2025, 64-bit
* 8 GB memory recommended (4 GB minimum), 10 GB free disk space, a fixed IP address for the server PC
  (set a DHCP reservation in the router so tablets always find it)
* Internet during installation (Node.js and PostgreSQL are downloaded from their official sites) - or pass the
  installers yourself with -NodeInstaller / -PostgresInstaller for an offline installation

Install
-------
1. Extract SofiaSetup-<version>-windows.zip to a folder (for example C:\SofiaSetup).
2. Double-click Install-Sofia.cmd and allow administrator rights.
3. At the end the installer shows:
     - the address for tablets and phones, e.g. https://192.168.1.10
     - the address of the device certificate, e.g. http://192.168.1.10/sofia-ca.crt
     - the one-time setup token
4. Open the address, enter the setup token and complete the setup wizard (restaurant, branch, opening hours,
   tables, owner account with your own strong password - there is no default password).

Every tablet and phone: install the device certificate once
-----------------------------------------------------------
Offline mode (working without the server) needs HTTPS. The installer creates a private certificate authority for
the restaurant network. On each device, open http://<server-ip>/sofia-ca.crt and install it:
  * iPhone/iPad: install the profile (Settings > General > VPN & Device Management), then enable it under
    Settings > General > About > Certificate Trust Settings
  * Android: Settings > Security > Encryption & credentials > Install a certificate > CA certificate
  * Windows: double-click the file > Install Certificate > Local Machine > "Trusted Root Certification Authorities"
Then open https://<server-ip>, sign in once while the server is reachable, and add the app to the home screen.

Options (administrator PowerShell)
----------------------------------
  powershell -ExecutionPolicy Bypass -File .\Install-Sofia.ps1 [options]

  -HttpsMode Lan       (default) HTTPS on the local network with Sofia's own certificate authority
  -HttpsMode Domain -Domain book.example.com -AcmeEmail you@example.com
                       public domain with a Let's Encrypt certificate; forward ports 80 and 443 to this PC
  -HttpsMode None      plain HTTP on port 8080 (offline mode then works only on the server PC itself)
  -Port 8080           internal application port
  -InstallRoot C:\Sofia
  -LanIp 192.168.1.10  server address to use if the automatic choice is wrong
  -PostgresInstaller <file>   use a downloaded PostgreSQL 16 installer (EnterpriseDB, signature is checked)
  -PostgresSuperPassword (Read-Host -AsSecureString)   when PostgreSQL 16 is already installed
  -NodeInstaller <file>       use a downloaded Node.js 22 MSI (signature is checked)
  -UpdateFeedUrl https://updates.example.com/sofia/feed.json   signed update feed for the Update Center
  -Unattended          no prompts and no browser at the end

Running the installer again repairs an installation: secrets, database and data are kept.

What gets installed
-------------------
  C:\Sofia\releases\<version>   application (server bundle + web app); the Update Center adds new versions here
  C:\Sofia\current.json         which version is active (the Update Center switches and rolls back this pointer)
  C:\Sofia\config               sofia.env (secrets), install.json, update-public-key.pem - Administrators only
  C:\Sofia\data, \backups       uploads, exports and verified database backups - Administrators only
  C:\Sofia\logs                 service logs
  C:\Sofia\sofia.cmd            command line: sofia.cmd backup create | backup list | health | migrate:status ...
  Services (automatic start):   SofiaAPI, SofiaWorker, SofiaUpdater, SofiaWeb (HTTPS), postgresql-x64-16

Security
--------
  * PostgreSQL listens on localhost only and port 5432 is blocked in Windows Firewall.
  * The application uses a database role that can read and write data but cannot change the schema or alter
    the audit log; a separate owner role is used for migrations, backups and restores.
  * The firewall opens the application only for Private/Domain networks (Lan/None modes).
  * Secrets are generated during installation; nothing is shared between installations.
  * Keep a copy of C:\Sofia\config\sofia.env together with your off-site backups: SOFIA_ENCRYPTION_KEY is needed
    to read stored integration credentials (WhatsApp, SMTP, POS) after restoring on another PC.

Sofia Server Manager
--------------------
Desktop shortcut "Sofia Server Manager" (Arabic or English): status of PostgreSQL, API, web app, sync, backups,
updates, internet and storage; start/stop/restart; create and restore backups; logs; server address.

Uninstall
---------
  powershell -ExecutionPolicy Bypass -File C:\Sofia\tools\Uninstall-Sofia.ps1
removes services, firewall rules, shortcuts and program files but keeps the database, configuration and backups.
Add -RemoveData (and -RemoveBackups) to delete them as well.

Status of these scripts
-----------------------
The Windows installer, uninstaller and Server Manager were written for Windows PowerShell 5.1 but have not yet
been run on a Windows machine by the development team. Test on a spare PC before installing in the restaurant,
and report problems with the installation log (path printed at the start of the installation).
