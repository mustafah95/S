# Testing

All server tests run against a **real PostgreSQL 16** (no mocks of the database): the exclusion constraint, row-level
security on the audit log, advisory locks of the sync feed and the migration runner are part of what is tested.

## Running

```bash
pnpm install
pnpm test:db:start              # PostgreSQL 16 on 127.0.0.1:54329 (binaries from /usr/lib/postgresql/*/bin or PGBIN=…)
pnpm typecheck                  # strict TypeScript in all packages
pnpm test                       # unit + integration suites below
pnpm e2e                        # browser end-to-end (needs Playwright's Chromium; builds are used from apps/*/dist)
```

Each server test file creates its own fresh database, runs all migrations and seeds reference data, so files are
independent and can run in parallel.

## Suites

| Suite | Tests | Covers |
|-------|------:|--------|
| `packages/shared/test/shared.test.ts` | 15 | Baghdad/DST time conversion, slots across midnight, closures, opening hours, durations, reservation state machine, UUIDv7, Iraqi phone normalisation, three-way set merge, templates, version comparison, reservation and sync schemas, all 14 roles |
| `apps/web/test/offline.test.ts` | 6 | local-first repository (record + outbox written together), local reservation codes and times, base version/values for three-way merge, optimistic status actions and queue order, rebase of pending edits on fresh server data |
| `apps/server/test/auth.test.ts` | 10 | first-run wizard (setup token, no default credentials, cannot run twice), lockout, CSRF, refresh-token rotation and reuse detection, TOTP MFA, RBAC denials, branch scope, role-escalation guard, append-only audit log for the runtime role |
| `apps/server/test/reservations.test.ts` | 9 | reservation creation, **§81 double booking**, turnover buffer, opening hours and capacity, auto-assignment and combinations, full lifecycle with guest statistics, cancel/reschedule, walk-ins and waitlist, idempotent client ids |
| `apps/server/test/sync.test.ts` | 8 | **§80 offline → PostgreSQL exactly once**, pull feed, offline reservation that lost its table (kept, flagged, staff notified), three-way guest merge with conflicts on critical fields, impossible offline transitions, rejected operations remembered, branch-filtered pull |
| `apps/server/test/business.test.ts` | 10 | POS signed webhook + matching + CRM/loyalty, CSV import, loyalty redemption, consent-aware marketing delivery, public booking with QR and cancellation token, bot/oversize rejection, low ratings → complaints, dashboards, report export CSV/Excel, full data export |
| `apps/server/test/update.test.ts` | 7 | **§82 update 1.0.0 → 1.1.0**, tampered package refused, failing migration stops safely, automatic rollback of application and database on failed health check, side-by-side releases, modified-migration refusal, Drizzle schema drift check |
| `apps/server/test/backup.test.ts` | 4 | verified backup and restore (sync feed never moves backwards, new epoch), permissions, scheduling, health report |
| `apps/server/test/push.test.ts` | 7 | Web Push: only browser push services accepted (SSRF), opt-in with reservation token, consent for offers, delivery to a local stand-in push service whose messages the test **decrypts** (RFC 8291) and whose **VAPID signature it verifies** (RFC 8292), expired subscriptions revoked, consent-aware push campaigns, redirects never followed, renew/unsubscribe/anonymise |
| `apps/server/test/reports-pdf.test.ts` | 4 | bidirectional text ordering (Arabic, numbers, Latin, brackets, isolated dates), multi-page Arabic PDF with embedded font, grouped English/Arabic PDFs with totals, empty result, export permission |
| `e2e/critical-offline-sync.mjs` | 1 scenario | see below |
| `e2e/guest-push.mjs` | 1 scenario | full Chromium: online booking → "turn on notifications" → subscription and consent in PostgreSQL → guest service worker (scope `/r/` only) shows the pushed Arabic notification → "turn off" revokes it |

Totals at the time of writing: 80 automated tests + two browser scenarios, all passing.

## The three critical scenarios

### §80 — offline creation and automatic synchronisation

* **API level** (`sync.test.ts`): a device pushes operations created while the server was down; the server applies
  them exactly once, writes audit entries with the device id, and a repeated push returns `duplicate`.
* **Browser level** (`e2e/critical-offline-sync.mjs`, real Chromium, real server, real PostgreSQL):
  1. server ON — sign in, the service worker takes control, create a reservation in the UI → row in PostgreSQL;
  2. server process **killed** — the page reloads from the service worker cache, the user unlocks offline, creates a
     guest, a note and a reservation (`LOCAL-…` code, "3 changes waiting");
  3. server started again — the app detects it on its own and uploads the queue; the reservation shows its `SR-…`
     server number;
  4. PostgreSQL contains exactly one guest, one reservation, one note, the audit entries carry the device id and all
     5 operations are `applied` once.

### §81 — two devices book the same table at the same moment

`reservations.test.ts` and the e2e script send two concurrent requests for the same table and time. Exactly one
returns 201; the other returns 409 with "Table no longer available. Please select another table/time." The guarantee
comes from the PostgreSQL exclusion constraint on `table_allocations` (`EXCLUDE USING gist (table_id WITH =,
period WITH &&) WHERE (active)`), not from application checks.

### §82 — update from 1.0.0 to 1.1.0

`update.test.ts` builds real signed packages (Ed25519 + SHA-256), serves them from a local feed (plain HTTP is accepted only for localhost) and
runs the updater: pre-update backup → verification → extraction → migration (adds a column and data) → switch
`current.json` → restart → health check, then checks that all existing data is intact. Further cases: a tampered
package is rejected before extraction, a failing migration leaves the system untouched, and a release that fails
its health check is rolled back together with its database changes.

## Manual verification performed

* Least-privilege deployment: owner role + runtime role (no superuser): setup, reservations, backup, **restore**,
  and denial of `UPDATE/DELETE audit_logs`, `CREATE TABLE`, `DROP TABLE` for the runtime role.
* Bundled release run from the Windows-style directory layout on Linux with the exact `sofia.env` format the
  Windows installer writes: launcher (`api`, `worker`, `updater`, `cli`), migrations, health, web app, backups.
* Visual checks of the staff app (Arabic RTL and English), public booking page on a phone viewport.
* PDF reports rendered to images (`pdftoppm`) and inspected in Arabic and English, single- and multi-page; PDF
  download from the staff app's report page; PDF generation from the bundled release (fonts and metrics shipped).

## Not covered by automated tests

* Windows installer, Server Manager and uninstaller (PowerShell; not yet run on Windows).
* Docker image build (no Docker daemon in the development environment; `docker compose config` validates the file).
* Real WhatsApp / SMS / SMTP / POS vendor endpoints — adapters are tested against stubbed HTTP servers.
* Real Web Push services (FCM, Mozilla, Apple, Microsoft) — tested against a local stand-in that checks the protocol.
* iOS Safari / Android Chrome on real devices (service worker and IndexedDB behaviour was tested in Chromium).
