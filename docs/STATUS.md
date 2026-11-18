# Project status

Honest state of the platform against the specification: what is implemented and verified, what is implemented but
still has to be proven in a real restaurant environment, and what is not implemented. Updated 2026-11-18, version 1.0.0.

## 1. Implemented and verified

"Verified" means covered by the automated suites in [TESTING.md](TESTING.md) (69 tests on real PostgreSQL plus a
real-browser end-to-end scenario) or by the manual checks listed there.

| Specification | Where |
|---------------|-------|
| PostgreSQL 16 as the single central database; versioned, checksummed migrations (§15, §23, §83) | `apps/server/migrations`, `db/migrator.ts` |
| Database security: localhost/internal network only, owner vs runtime role, append-only audit log (§16, §55) | migrations 001–009, `applyRuntimeGrants`, Docker/Windows deployment |
| Offline operation: local data, offline sign-in, reservations, guests, notes, walk-ins, check-in, table operations, waitlist, sync queue, status indicator (§9–§12, §60, §73, §74) | `apps/web/src/offline`, e2e scenario |
| Automatic synchronisation, idempotent operations, conflict management and sync dashboard (§11–§13, §58, §59) | `modules/sync`, `features/sync/SyncPage.tsx` |
| Reservation conflict protection — double booking impossible (§14, §81) | exclusion constraint, `reservations.test.ts`, e2e |
| Automatic and manual backups with verification, retention, restore, least-privilege restore (§17, §18) | `modules/system/backup.ts`, `backup.test.ts` |
| System Update Center: check, download, verify (Ed25519 + SHA-256), install, migrate, restart, health check, history, automatic and manual rollback (§21–§24, §26, §70–§72, §82) | `updater/`, Settings › Updates, `update.test.ts` |
| Client auto update with *Update now / Later*, no stale assets (§25) | service worker prompt in `Layout.tsx` |
| Branches, users, 14 roles, granular RBAC, branch scope, MFA, lockout, first administrator without default credentials (§27, §28, §54, §86) | `auth.test.ts` |
| Guest 360° CRM: profile, history, spending, VIP levels, occasions, allergies, preferences, tags, duplicates and merge, privacy (§29, §30, §38, §39, §41, §62, §88) | `modules/guests`, guest profile page |
| Reservation engine, floor plan, table combinations, waitlist, walk-in, check-in (§31–§37) | `reservations.test.ts`, floor plan page |
| POS integration: signed webhook, CSV import, invoice → reservation/table → guest spending → CRM/loyalty (§40) | `business.test.ts` |
| Loyalty: points, tiers, rewards, birthday/visit/spend/referral rules, expiry (§42) | `modules/loyalty.ts` |
| Marketing: 10 system segments + custom rules, campaigns, consent and opt-out (§43) | `business.test.ts` |
| Feedback and complaints with category, severity, employee, resolution, compensation, follow-up (§44, §45) | `modules/feedback.ts` |
| Public booking page, widget, QR code, confirmation with policy, calendar file, self-service cancellation (§46–§48) | `business.test.ts`, visual check |
| Notifications: confirmation, reminder, cancellation, rescheduling, waitlist, birthday, VIP arrival, feedback, marketing (§49) | notification outbox + worker |
| Host and owner dashboards incl. occupancy, retention, VIP revenue and marketing ROI; analytics (§51, §52) | `business.test.ts` |
| Report builder with CSV / Excel / JSON export (§63) | `reports.ts` |
| Data ownership: full ZIP/CSV export, JSON export via CLI, standard SQL backups (§53, §89) | `business.test.ts` |
| Global search, Arabic RTL / English LTR, IQD + USD, responsive layout, branding (§61, §64–§66, §69, §2) | visual checks |
| API: versioned `/api/v1`, OpenAPI/Swagger, validation, rate limiting, security headers, CSRF, same-origin policy (no CORS opened), request logs (§56, §87) | `app.ts`, `/api/v1/docs` |
| Health checks and logging (§77, §78) | `/health`, Settings › Logs |
| First-run wizard covering all 13 listed steps (§85) | `SetupWizard.tsx`, `auth.test.ts` |
| Release packaging, launcher with restart and crash back-off (§19, §22) | `scripts/build-release.mjs`, `deploy/runtime/launcher.mjs` |

## 2. Implemented, but not yet proven in a real environment

| Item | What is missing | Needed |
|------|-----------------|--------|
| Windows installer, Sofia Server Manager, uninstaller, Inno Setup wrapper (§6, §7, §19, §20, §84) | Not executed on Windows yet (no Windows machine in the development environment); only static checks and a Linux simulation of the installed layout | a test run on a spare Windows 10/11 or Server PC |
| HTTPS on the restaurant network (Caddy with its own CA) and public-domain HTTPS (§8) | Caddy configurations are written but were not executed here | the Windows test run; a domain for the public option |
| Docker image (§76) | `docker compose config` validates; the image was not built (no Docker daemon available) | `docker compose up --build` on a Linux host |
| WhatsApp Business Cloud API, SMTP, SMS (Twilio / generic HTTP) (§50) | Adapters tested only against stub HTTP servers | WhatsApp Business account + approved templates, SMTP and SMS credentials |
| POS REST polling adapter (§40, §57) | Generic adapter tested against a stub | the POS vendor's API documentation and credentials (vendor-specific mapping) |
| Offline mode on iOS Safari / Android Chrome | Tested in Chromium (desktop) | test on the restaurant's tablets and phones |

## 3. Not implemented / known limitations

| Item | Status |
|------|--------|
| Online deposit payment (§46 step 9) | Deposits are calculated, shown to the guest with payment instructions and recorded by staff (cash, card terminal, transfer reference). No payment gateway is integrated and no card data is ever handled. Integrating a gateway requires a merchant account with a provider available in Iraq. |
| Push notifications to guests (§43 channel) | Not implemented; the push channel reports "not available". Staff receive in-app notifications. WhatsApp, SMS and email are implemented. |
| Server-generated PDF reports (§63) | Reports print to PDF from the browser (print stylesheet). CSV and Excel files are generated by the server. |
| Vendor-specific POS connectors | Only the generic REST / signed webhook / CSV integration exists. |
| Code-signed Windows installer | Requires a code-signing certificate; unsigned builds trigger a SmartScreen warning. |
| Update server | The vendor must host `feed.json` and packages over HTTPS and ship the public key (`deploy/update-public-key.pem` is empty in the repository on purpose). |

## 4. Operational constraints to be aware of

* Offline mode needs HTTPS (or localhost) on every device and one online sign-in per user and device before it can
  be used offline; the offline sign-in is valid for 72 hours by default (configurable).
* With the restaurant-network HTTPS option every device must install the restaurant's CA certificate once and the
  server needs a fixed IP address.
* Changes made offline that conflict with the server (e.g. the table was taken meanwhile) are kept and flagged for
  staff review instead of being silently discarded or overwritten.
