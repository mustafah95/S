# Operations guide

How to install, run, back up, update and administer Sofia's Resto-Lounge.

## 1. Choosing an installation

| | Windows PC / server in the restaurant | Linux server or cloud VM |
|---|---|---|
| Package | `SofiaSetup-<v>-windows.zip` (or `.exe` built with Inno Setup) | Docker Compose (`deploy/`) |
| Database | PostgreSQL 16 Windows service, localhost only | `postgres:16` container on an internal network only |
| Processes | Windows services *SofiaAPI*, *SofiaWorker*, *SofiaUpdater*, *SofiaWeb* (Caddy) | containers `api`, `worker`, `updater`, `caddy` |
| HTTPS | restaurant-network CA (default) or public domain | public domain (automatic Let's Encrypt) or Caddy internal CA |
| Control panel | **Sofia Server Manager** + Settings › System/Backups/Updates in the web app | the same web app pages, `docker compose` |

Both run the same release package and the same launcher, so updates, restarts and rollbacks behave identically.

## 2. HTTPS and offline mode

Browsers enable service workers (the app working without the server), IndexedDB encryption keys and "Add to home
screen" only on secure origins: `https://…` or `http://localhost`. Plain `http://192.168.x.x` works online but
**cannot** work offline. Therefore:

* **Restaurant network (Windows default, `-HttpsMode Lan`)** — Caddy issues certificates from Sofia's own
  certificate authority for the server's IP address and computer name. Each device installs the CA certificate once
  from `http://<server-ip>/sofia-ca.crt` (instructions in `deploy/windows/README.md` and in the Server Manager).
  Give the server a fixed IP (DHCP reservation): the certificate is issued for that address.
* **Public domain** — DNS name pointing at the restaurant/server, ports 80 and 443 forwarded; the certificate is
  public, so no installation on devices. Also enables the public booking page for guests on the internet.
* For Docker on a LAN only, set `SOFIA_SITE_ADDRESS` to a hostname and add `tls internal` in `deploy/caddy/Caddyfile`
  (then distribute Caddy's root certificate from the `caddy_data` volume).

The public booking page and widget must be on a public HTTPS address to be reachable by guests.

## 3. Linux / cloud installation (Docker Compose)

```bash
git clone <this repository> sofia && cd sofia/deploy
./generate-env.sh > .env && chmod 600 .env       # random database passwords, JWT secret, encryption key, setup token
# edit .env: SOFIA_SITE_ADDRESS=sofia.example.com, SOFIA_PUBLIC_URL=https://sofia.example.com, SOFIA_ACME_EMAIL=…
cp /path/to/update-public-key.pem ./update-public-key.pem   # from your release signing (section 6); may stay empty
docker compose up -d --build
docker compose ps                                 # wait until api is "healthy"
grep SOFIA_SETUP_TOKEN .env                       # token for the first-run wizard
```

* PostgreSQL is attached only to the `backend` network and publishes no port.
* `initdb/01-runtime-role.sh` creates the runtime role `sofia_app` (data only, no DDL, cannot modify the audit log);
  migrations and backups run as the owner role.
* Persistent volumes: `pgdata` (database), `sofia` (releases, backups, uploads, config), `caddy_data` (certificates).
  Back up the `.env` file separately — it holds the encryption key for stored integration credentials.
* Copy backups off the server regularly (e.g. `docker run --rm -v sofia_sofia:/s -v $PWD:/out alpine
  tar czf /out/sofia-backups.tgz -C /s backups`, or mount a NAS path for `/opt/sofia/backups`).

## 4. Windows installation

See [deploy/windows/README.md](../deploy/windows/README.md). Summary: extract the bundle, double-click
`Install-Sofia.cmd`, note the address and setup token, install the device certificate on each tablet.
Re-running the installer repairs an installation without touching data or secrets.

## 5. First run

1. Open the address shown by the installer.
2. The setup wizard asks for the **setup token** (printed by the installer / in `.env`), the restaurant name,
   currency and languages, the first branch with opening hours and areas/tables, and the owner account.
   There is no built-in administrator and no default password.
3. Sign in as the owner, enable MFA (Settings › Security), create staff accounts with the matching roles.
4. Settings › Integrations: WhatsApp Business Cloud API, SMTP email, SMS provider, POS connection (optional).
5. Settings › Backups: check the schedule, retention and that the first backup succeeds.

The setup token is useless once the wizard is completed.

## 6. Backups and restore

* **Automatic**: the worker runs `pg_dump -Fc` on the configured schedule (every 6 h / every 12 h / daily / weekly),
  verifies every dump with `pg_restore --list`, records SHA-256 and size, prunes by retention, and alerts
  administrators (in-app notification + health check turns amber/red) when a backup fails or is overdue.
* **Manual**: Settings › Backups › *Create backup*; Server Manager › *Create backup*;
  CLI `sofia backup create`.
* **Before updates and restores** a safety backup is taken automatically (`pre_update`, `pre_restore`).
* **Restore**: Settings › Backups (typed confirmation), Server Manager › *Restore backup…*, or
  `sofia backup restore <id> --yes`. Sequence: safety backup → maintenance mode → `pg_restore --clean
  --single-transaction` as the owner role (extensions are left in place) → re-grant the runtime role → migrations
  → new sync epoch (devices re-download their data; unsynced device changes are kept and re-sent) → maintenance off.
  The `backups` and `system_updates` history survives the restore.
* **Off-site**: copy `backups/` to another disk, NAS or cloud storage. A backup is only as good as its copy that is
  not on the same machine.

## 7. Updates

### Publishing a release (vendor side)

```bash
pnpm release:keys                                  # once: update-keys/sofia-update.private.pem (keep offline!)
                                                   #       update-keys/update-public-key.pem  (ship to servers)
# bump the version in package.json and packages/shared/src/version.ts, add migrations if needed
pnpm release:build                                 # release/sofia-<v>.tar.gz + entry
pnpm release:sign <v> --key update-keys/sofia-update.private.pem --base-url https://updates.example.com/sofia
# upload release/feed.json and release/sofia-<v>.tar.gz to the HTTPS update server
pnpm release:windows                               # optional: new installation bundle
```

The feed entry is signed with Ed25519 over `sofia-release:<version>:<sha256>:<size>:<minFromVersion>`. Mark a
migration `-- sofia:breaking` when it cannot be rolled back without restoring the database; the updater then always
takes (and on failure restores) a database backup.

### Installing an update (restaurant side)

Settings › Updates (permission `system.update`):

1. *Check for updates* — reads the feed (HTTPS), verifies the signature with the installed public key.
2. *Download* — downloads the package, verifies SHA-256 and size. Unsigned or modified packages are rejected.
3. *Install* — pre-update backup → extract to `releases/<new>` → maintenance mode (devices keep working offline)
   → migrations → switch `current.json` → restart API and worker → health check.
4. If the health check fails, the updater **rolls back automatically**: `current.json` back to the previous release,
   database restored from the pre-update backup when migrations ran, services restarted, administrators notified.
5. *Rollback* is also available manually for the previous version; the update history keeps every attempt.

Devices notice the new web app version and offer *Reload to update*; pending offline changes are kept.

## 8. Command line

Windows: `C:\Sofia\sofia.cmd <command>` (administrator prompt). Docker: `docker compose exec api node
/opt/sofia/launcher.mjs cli <command>`. Development: `pnpm --filter @sofia/server cli <command>`.

| Command | Purpose |
|---------|---------|
| `migrate` / `migrate:status` | apply / show database migrations (checksums are verified) |
| `backup create` / `backup list [--json]` / `backup restore <id> --yes` | backups |
| `user reset-password <username> <new-password>` | reset a password (signs the user out everywhere) |
| `user unlock <username>` | clear a lockout after failed sign-ins |
| `maintenance on|off` | maintenance mode (devices continue offline) |
| `health` | full health report (JSON) |
| `export [directory]` | export all data as JSON files |
| `version` | installed version |

## 9. Monitoring

* `GET /health/live` — process alive; `GET /health/ready` — database reachable (used by Docker and the installer).
* `GET /health` — summary for everyone; full report (database latency, migrations, storage, message queue, sync
  conflicts, last backup, integrations, internet, maintenance) for localhost and users with `system.health`.
* Settings › Logs: application events and errors; Settings › Audit: every change with user,
  device and IP; Sync page: devices, pending operations and conflicts.

## 10. Configuration reference

Environment variables (Windows: `C:\Sofia\config\sofia.env`; Docker: `deploy/.env` + Compose).

| Variable | Meaning |
|----------|---------|
| `NODE_ENV` | `production` on servers (requires all secrets below) |
| `HOST`, `PORT` | listen address (default `0.0.0.0:8080`; `127.0.0.1` behind Caddy) |
| `DATABASE_URL` | runtime role connection (`sofia_app`) |
| `DATABASE_OWNER_URL` | owner role connection for migrations, backups, restores |
| `SOFIA_DB_APP_ROLE` | runtime role name to (re-)grant after migrations and restores |
| `SOFIA_JWT_SECRET` | ≥ 32 characters; changing it signs everybody out |
| `SOFIA_ENCRYPTION_KEY` | ≥ 32 characters; encrypts integration credentials and MFA secrets — keep it with backups |
| `SOFIA_SETUP_TOKEN` | one-time token for the first-run wizard |
| `SOFIA_PUBLIC_URL` | public address used in booking links, QR codes and messages |
| `SOFIA_TRUST_PROXY` | `true` behind Caddy/a reverse proxy |
| `SOFIA_DATA_DIR`, `SOFIA_BACKUP_DIR` | uploads/exports and backup folders |
| `SOFIA_PG_BIN` | folder with `pg_dump`/`pg_restore` when not on PATH |
| `SOFIA_INSTALL_ROOT` | folder with `releases/` and `current.json` (set by the launcher) |
| `SOFIA_SERVICE_CONTROLLER` | how the updater restarts services: `launcher` (default), `windows`, `systemd`, `none` |
| `SOFIA_UPDATE_FEED_URL`, `SOFIA_UPDATE_CHANNEL` | signed update feed (HTTPS) and channel |
| `SOFIA_UPDATE_PUBLIC_KEY` | Ed25519 public key (PEM text or file path); default `<install root>/config/update-public-key.pem` |
| `SOFIA_EMBEDDED_WORKER` | run background jobs inside the API process (default only in development) |
| `SOFIA_RATE_LIMIT_MAX`, `SOFIA_LOGIN_RATE_LIMIT` | requests per minute overall / sign-in attempts per minute |
| `SOFIA_LOG_LEVEL` | `info` (default), `warn`, `debug`, … |

## 11. Security checklist

* HTTPS everywhere staff devices connect; HSTS is set by Caddy.
* PostgreSQL never reachable from the network (Windows: localhost + firewall block; Docker: internal network).
* Owner role only in `DATABASE_OWNER_URL`; the application runs as the runtime role.
* MFA enabled for owner, general manager and IT administrator accounts.
* Configuration file and backups readable by administrators only; off-site backup copies encrypted at rest.
* Update private key kept offline; only the public key is installed on servers.
* Review Settings › Audit and failed sign-ins regularly; deactivate accounts of staff who leave.

## 12. Data portability

Settings › Data › *Export everything* downloads a ZIP of CSV files (guests, reservations, visits, notes,
loyalty, feedback, …); `sofia export` writes JSON files. Backups are standard PostgreSQL custom-format dumps that
any PostgreSQL 16 can restore. There is no proprietary storage format.
