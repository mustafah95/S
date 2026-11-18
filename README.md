<p align="center"><img src="brand/sofia-logo-burgundy.png" alt="Sofia's Resto-Lounge" width="320"></p>

# Sofia's Resto-Lounge — Restaurant Management Platform

Reservations, Guest 360° CRM, table and floor management, waitlist, POS integration, loyalty, marketing, feedback,
analytics, backups and a signed System Update Center. One PostgreSQL database is the source of truth. Every staff
device keeps working without the server or the internet (local-first PWA) and synchronises automatically when the
connection returns.

Arabic (RTL, default) and English · Iraqi Dinar with optional USD · multi-branch.

## What is in the box

| Area | Highlights |
|------|-----------|
| Reservations | availability engine, opening hours and closures, automatic table assignment and table combinations, state machine (pending → confirmed → seated → completed / no-show / cancelled), deposits recorded by staff, reminders, **double booking impossible at database level** (PostgreSQL exclusion constraint) |
| Floor plan | drag-and-drop layout per area, live table status for all devices (SSE), walk-ins, table combinations |
| Waitlist | quoted waits, table suggestions, notify and seat |
| Guest 360° CRM | profile, visits and spend from POS, preferences, allergies, notes, tags, VIP levels, duplicate detection and merge, consent per channel, data export / anonymisation |
| Offline-first | IndexedDB copy of the working data, outbox of changes, offline sign-in, automatic sync with idempotent operations, three-way merge and a conflict review screen |
| POS | REST polling, signed webhooks, CSV import, invoice-to-guest matching |
| Loyalty | tiers, earning rules, rewards, birthday points, expiry, ledger |
| Marketing | rule-based segments, WhatsApp (official Cloud API) / SMS / email / Web Push campaigns with consent and opt-out |
| Notifications | confirmation, reminder, change, cancellation, table ready, birthday, feedback — WhatsApp, SMS, email or browser notifications the guest turns on from the confirmation page (no provider account needed) |
| Feedback | post-visit survey links, ratings dashboard |
| Analytics & reports | host and owner dashboards, report builder with PDF (Arabic or English, generated on the server) / Excel / CSV / JSON export |
| Public booking | booking page, embeddable widget (`<script src=".../widget.js">`), QR code, confirmation page with calendar file and self-service cancellation |
| Operations | first-run wizard (no default password), RBAC with 14 roles, MFA (TOTP), audit log, verified automatic backups and restore, signed updates with automatic rollback, health checks, full data export |

## Repository layout

```
apps/server         Fastify API, background worker, updater, CLI (TypeScript, Drizzle ORM, PostgreSQL 16)
apps/web            React PWA: staff app, public booking page, widget
packages/shared     Zod schemas, roles and permissions, reservation rules, sync protocol (shared by both sides)
apps/server/migrations   versioned SQL migrations (checksummed)
deploy/             Docker image + Compose + Caddy; Windows installer and Sofia Server Manager; launcher
scripts/            release build, update signing, Windows bundle, local test database
e2e/                browser end-to-end test of the offline → sync scenario
docs/               architecture, operations, testing, status
brand/              official logo and icons
```

## Quick start (development)

Requirements: Node.js 22, pnpm 10, PostgreSQL 16 binaries (`initdb`, `pg_ctl`, `pg_dump`, `pg_restore`).

```bash
pnpm install
pnpm test:db:start                 # local PostgreSQL on port 54329 (data in .data/pg)
pnpm migrate                       # create the schema
pnpm dev:server                    # API on http://localhost:8080 (SOFIA_SETUP_TOKEN=dev-setup-token by default in dev)
pnpm dev:web                       # web app on http://localhost:5173 (proxied to the API)
```

Open the web app, complete the setup wizard, sign in. API documentation: `http://localhost:8080/api/v1/docs`.

## Tests

```bash
pnpm test                          # shared (unit), web (offline engine), server (integration on real PostgreSQL)
pnpm e2e                           # real Chromium + real server + PostgreSQL: offline → sync, double booking
```

The three critical scenarios of the specification — offline creation and automatic sync, two devices booking the
same table, update 1.0.0 → 1.1.0 with rollback — are automated; see [docs/TESTING.md](docs/TESTING.md).

## Installation

| Option | Guide |
|--------|-------|
| Windows PC or server in the restaurant | `pnpm release:build && pnpm release:windows` → `SofiaSetup-<v>-windows.zip` → [deploy/windows/README.md](deploy/windows/README.md) |
| Linux server or cloud VM (Docker) | `cd deploy && ./generate-env.sh > .env && docker compose up -d` → [docs/OPERATIONS.md](docs/OPERATIONS.md) |

Offline mode on tablets and phones requires HTTPS (browsers only allow service workers and local encryption on
secure origins). Both installation options set up HTTPS; see the operations guide.

## Documentation

* [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — architecture, data model, API, security, offline and sync design
* [docs/OPERATIONS.md](docs/OPERATIONS.md) — installation, HTTPS, backups, updates and release signing, CLI, configuration
* [docs/TESTING.md](docs/TESTING.md) — test suites and the critical scenarios
* [docs/STATUS.md](docs/STATUS.md) — what is verified, what still needs a real environment, known limitations

## Brand

The official Sofia's Resto-Lounge logo is used unchanged (`brand/`); transparent variants only remove the
background. Colours: burgundy `#6B1420` / `#3E0B12`, cream `#F3E6D0`, gold `#C9A26B`. PDF reports use IBM Plex Sans
Arabic (SIL Open Font License, `apps/server/assets/fonts/OFL.txt`), the same family as the web app.
