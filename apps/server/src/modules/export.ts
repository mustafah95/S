import type { FastifyInstance } from 'fastify';
import { Zip, ZipDeflate, strToU8 } from 'fflate';
import { APP_VERSION } from '@sofia/shared';
import { getDb, q, sql } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { defineRoute } from '../lib/route.js';

/**
 * Full data export (no vendor lock-in, §53/§89): every business table as CSV and JSON in one ZIP.
 * Secrets (password hashes, MFA secrets, encrypted integration credentials) are never exported.
 */
export const EXPORT_TABLES: { table: string; columns: string }[] = [
  { table: 'branches', columns: '*' },
  { table: 'branch_closures', columns: '*' },
  { table: 'areas', columns: '*' },
  { table: 'restaurant_tables', columns: '*' },
  { table: 'table_combinations', columns: '*' },
  { table: 'guests', columns: '*' },
  { table: 'guest_notes', columns: '*' },
  { table: 'guest_occasions', columns: '*' },
  { table: 'reservations', columns: '*' },
  { table: 'reservation_events', columns: '*' },
  { table: 'table_allocations', columns: 'id, reservation_id, table_id, branch_id, lower(period) AS period_start, upper(period) AS period_end, kind, active, reason, created_at' },
  { table: 'waitlist_entries', columns: '*' },
  { table: 'loyalty_tiers', columns: '*' },
  { table: 'loyalty_rules', columns: '*' },
  { table: 'loyalty_rewards', columns: '*' },
  { table: 'loyalty_transactions', columns: '*' },
  { table: 'pos_invoices', columns: '*' },
  { table: 'pos_invoice_items', columns: '*' },
  { table: 'feedback', columns: '*' },
  { table: 'complaints', columns: '*' },
  { table: 'segments', columns: '*' },
  { table: 'campaigns', columns: '*' },
  { table: 'campaign_recipients', columns: '*' },
  { table: 'message_templates', columns: '*' },
  { table: 'users', columns: 'id, username, email, display_name, role_id, is_active, preferred_language, mfa_enabled, last_login_at, created_at, deleted_at' },
  { table: 'roles', columns: 'id, key, name_en, name_ar, all_branches, is_system' },
  { table: 'role_permissions', columns: '*' },
  { table: 'user_branches', columns: '*' },
  { table: 'app_settings', columns: "id, key, branch_id, value, updated_at" },
  { table: 'audit_logs', columns: '*' },
];

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]!);
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // neutralise spreadsheet formula injection
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n');
}

export async function registerExportRoutes(app: FastifyInstance): Promise<void> {
  defineRoute(app, { method: 'GET', url: '/api/v1/export/full', summary: 'Download every business table as CSV + JSON (ZIP)', tags: ['Data ownership'], permission: 'data.export' }, async ({ reply, ctx }) => {
    const db = getDb();
    await audit(db, ctx, { action: 'data.export_full', entityType: 'system', entityId: 'export' });
    reply.hijack();
    const res = reply.raw;
    const name = `sofia-export-${new Date().toISOString().slice(0, 10)}.zip`;
    res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${name}"` });
    const zip = new Zip((err, chunk, final) => {
      if (err) return res.destroy(err);
      res.write(Buffer.from(chunk));
      if (final) res.end();
    });
    const add = (path: string, content: string) => {
      const f = new ZipDeflate(path, { level: 6 });
      zip.add(f);
      f.push(strToU8(content), true);
    };
    add('README.txt', `Sofia's Resto-Lounge data export\nVersion ${APP_VERSION}\nCreated ${new Date().toISOString()}\n\nEach table is provided as CSV (UTF-8, Excel compatible) and JSON.\nFor a complete database copy use Settings → System → Backups (PostgreSQL format).\n`);
    for (const t of EXPORT_TABLES) {
      const rows = await q(db, sql`SELECT ${sql.raw(t.columns)} FROM ${sql.identifier(t.table)}`);
      add(`csv/${t.table}.csv`, toCsv(rows));
      add(`json/${t.table}.json`, JSON.stringify(rows));
    }
    zip.end();
  });
}
