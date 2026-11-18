import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { normalizePhone, posConnectionSchema, posInvoiceSchema, zId, type PosInvoiceInput } from '@sofia/shared';
import { camelRows, getDb, q, q1, schema, sql, type DbOrTx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { assertBranchAccess, branchScope, systemContext, type RequestContext } from '../lib/context.js';
import { decryptJson, encryptJson, hmacSha256, safeEqual } from '../lib/crypto.js';
import { AppError, badRequest, notFound, unauthorized } from '../lib/errors.js';
import { publish } from '../lib/events.js';
import { defineRoute, idParams } from '../lib/route.js';
import { getSetting } from '../lib/settings.js';
import { logEvent } from '../lib/system-events.js';
import { fetchRestInvoices, mapInvoice, parseInvoiceCsv, type PosConnectionConfig, type PosSecrets } from '../integrations/pos.js';
import { earnForInvoice } from './loyalty.js';
import { refreshGuestStats } from './guests/service.js';

type Connection = typeof schema.posConnections.$inferSelect;

interface MatchResult {
  reservationId: string | null;
  guestId: string | null;
  tableId: string | null;
  method: 'none' | 'reservation_code' | 'pos_check_ref' | 'phone' | 'loyalty_number' | 'table_time';
}

/** Link an invoice to reservation → guest. Explicit references win over the table/time heuristic. */
export async function matchInvoice(tx: DbOrTx, branchId: string, inv: PosInvoiceInput): Promise<MatchResult> {
  const table = inv.tableLabel
    ? await q1<{ id: string }>(tx, sql`SELECT id FROM restaurant_tables WHERE branch_id = ${branchId} AND lower(label) = lower(${inv.tableLabel}) AND deleted_at IS NULL`)
    : undefined;
  const tableId = table?.id ?? null;
  if (inv.reservationCode) {
    const r = await q1<{ id: string; guest_id: string | null }>(tx, sql`SELECT id, guest_id FROM reservations WHERE code = ${inv.reservationCode.toUpperCase()} AND branch_id = ${branchId}`);
    if (r) return { reservationId: r.id, guestId: r.guest_id, tableId, method: 'reservation_code' };
  }
  const byRef = await q1<{ id: string; guest_id: string | null }>(tx, sql`SELECT id, guest_id FROM reservations WHERE pos_check_ref = ${inv.externalId} AND branch_id = ${branchId}`);
  if (byRef) return { reservationId: byRef.id, guestId: byRef.guest_id, tableId, method: 'pos_check_ref' };
  if (inv.loyaltyNumber) {
    const g = await q1<{ id: string }>(tx, sql`SELECT id FROM guests WHERE loyalty_number = ${inv.loyaltyNumber.toUpperCase()} AND deleted_at IS NULL`);
    if (g) return { reservationId: null, guestId: g.id, tableId, method: 'loyalty_number' };
  }
  if (inv.guestPhone) {
    const phone = normalizePhone(inv.guestPhone);
    const g = phone ? await q1<{ id: string }>(tx, sql`SELECT id FROM guests WHERE phone_normalized = ${phone} AND deleted_at IS NULL AND merged_into_id IS NULL ORDER BY last_visit_at DESC NULLS LAST LIMIT 1`) : undefined;
    if (g) return { reservationId: null, guestId: g.id, tableId, method: 'phone' };
  }
  if (tableId) {
    const closed = inv.closedAt;
    const r = await q1<{ id: string; guest_id: string | null }>(
      tx,
      sql`SELECT id, guest_id FROM reservations
          WHERE branch_id = ${branchId} AND ${tableId} = ANY (table_ids) AND status IN ('seated', 'dining', 'completed')
            AND coalesce(seated_at, start_at) <= ${closed}::timestamptz + interval '15 minutes'
            AND coalesce(completed_at, end_at + interval '3 hours') >= ${closed}::timestamptz - interval '30 minutes'
          ORDER BY abs(extract(epoch FROM (coalesce(completed_at, end_at) - ${closed}::timestamptz))) LIMIT 1`,
    );
    if (r) return { reservationId: r.id, guestId: r.guest_id, tableId, method: 'table_time' };
  }
  return { reservationId: null, guestId: null, tableId, method: 'none' };
}

export interface ImportStats {
  fetched: number;
  inserted: number;
  updated: number;
  matched: number;
  errors: { externalId?: string; message: string }[];
}

/** Idempotent invoice import (unique per connection + external id). Updates guest spending and loyalty. */
export async function importInvoices(conn: Connection, raws: unknown[], trigger: string): Promise<ImportStats> {
  const db = getDb();
  const ctx = systemContext(`pos:${conn.name}`);
  const cfg = conn.config as PosConnectionConfig;
  const general = await getSetting('general');
  const stats: ImportStats = { fetched: raws.length, inserted: 0, updated: 0, matched: 0, errors: [] };
  const [run] = await q<{ id: string }>(db, sql`INSERT INTO pos_sync_runs (connection_id, trigger) VALUES (${conn.id}, ${trigger}) RETURNING id`);
  for (const raw of raws) {
    const parsed = posInvoiceSchema.safeParse(mapInvoice(raw, cfg));
    if (!parsed.success) {
      stats.errors.push({ externalId: String((raw as { externalId?: unknown })?.externalId ?? ''), message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      continue;
    }
    const inv = parsed.data;
    await db.transaction(async (tx) => {
      const rate = inv.currency === general.primaryCurrency ? 1 : inv.currency === 'USD' && general.primaryCurrency === 'IQD' ? general.usdToIqdRate : inv.currency === 'IQD' && general.primaryCurrency === 'USD' ? 1 / (general.usdToIqdRate || 1) : 1;
      const m = await matchInvoice(tx, conn.branchId, inv);
      const existing = await q1<{ id: string; guest_id: string | null; match_method: string }>(tx, sql`SELECT id, guest_id, match_method FROM pos_invoices WHERE connection_id = ${conn.id} AND external_id = ${inv.externalId} FOR UPDATE`);
      const keepManual = existing?.match_method === 'manual';
      const values = {
        invoice_number: inv.invoiceNumber ?? null,
        opened_at: inv.openedAt ?? null,
        closed_at: inv.closedAt,
        table_id: m.tableId,
        table_label: inv.tableLabel ?? null,
        covers: inv.covers ?? null,
        subtotal: inv.subtotal,
        discount: inv.discount,
        tax: inv.tax,
        service_charge: inv.serviceCharge,
        total: inv.total,
        currency: inv.currency,
        exchange_rate: rate,
        total_base: Math.round(inv.total * rate * 100) / 100,
        payment_method: inv.paymentMethod ?? null,
        status: inv.status,
        raw: JSON.stringify(raw),
      };
      let id: string;
      if (existing) {
        id = existing.id;
        await tx.execute(sql`UPDATE pos_invoices SET invoice_number = ${values.invoice_number}, opened_at = ${values.opened_at}, closed_at = ${values.closed_at},
                               table_id = ${values.table_id}, table_label = ${values.table_label}, covers = ${values.covers}, subtotal = ${values.subtotal},
                               discount = ${values.discount}, tax = ${values.tax}, service_charge = ${values.service_charge}, total = ${values.total},
                               currency = ${values.currency}, exchange_rate = ${values.exchange_rate}, total_base = ${values.total_base},
                               payment_method = ${values.payment_method}, status = ${values.status}, raw = ${values.raw}::jsonb
                               ${keepManual ? sql`` : sql`, reservation_id = ${m.reservationId}, guest_id = ${m.guestId}, match_method = ${m.method}`}
                             WHERE id = ${id}`);
        await tx.execute(sql`DELETE FROM pos_invoice_items WHERE invoice_id = ${id}`);
        stats.updated++;
      } else {
        const [row] = await q<{ id: string }>(
          tx,
          sql`INSERT INTO pos_invoices (connection_id, branch_id, external_id, invoice_number, opened_at, closed_at, table_id, table_label, reservation_id,
                                        guest_id, covers, subtotal, discount, tax, service_charge, total, currency, exchange_rate, total_base,
                                        payment_method, status, match_method, raw)
              VALUES (${conn.id}, ${conn.branchId}, ${inv.externalId}, ${values.invoice_number}, ${values.opened_at}, ${values.closed_at}, ${values.table_id},
                      ${values.table_label}, ${m.reservationId}, ${m.guestId}, ${values.covers}, ${values.subtotal}, ${values.discount}, ${values.tax},
                      ${values.service_charge}, ${values.total}, ${values.currency}, ${values.exchange_rate}, ${values.total_base}, ${values.payment_method},
                      ${values.status}, ${m.method}, ${values.raw}::jsonb)
              RETURNING id`,
        );
        id = row!.id;
        stats.inserted++;
      }
      for (const it of inv.items) {
        await tx.execute(sql`INSERT INTO pos_invoice_items (invoice_id, external_item_id, name, category, quantity, unit_price, discount, total)
                             VALUES (${id}, ${it.externalItemId ?? null}, ${it.name}, ${it.category ?? null}, ${it.quantity}, ${it.unitPrice}, ${it.discount}, ${it.total})`);
      }
      const guestId = keepManual ? existing!.guest_id : m.guestId;
      if (guestId) {
        stats.matched++;
        await refreshGuestStats(tx, guestId);
        await earnForInvoice(tx, ctx, { id, guestId, branchId: conn.branchId, totalBase: values.total_base, status: inv.status });
      }
      if (existing?.guest_id && existing.guest_id !== guestId) await refreshGuestStats(tx, existing.guest_id);
    });
  }
  await db.execute(sql`UPDATE pos_sync_runs SET finished_at = now(), status = ${stats.errors.length && !stats.inserted && !stats.updated ? 'failed' : 'completed'},
                         fetched = ${stats.fetched}, inserted = ${stats.inserted}, updated = ${stats.updated}, matched = ${stats.matched},
                         error = ${stats.errors.length ? JSON.stringify(stats.errors.slice(0, 20)) : null}
                       WHERE id = ${run!.id}`);
  await db.execute(sql`UPDATE pos_connections SET last_sync_at = now(), last_error = ${stats.errors.length ? `${stats.errors.length} invoice(s) rejected` : null},
                         last_error_at = ${stats.errors.length ? sql`now()` : sql`last_error_at`} WHERE id = ${conn.id}`);
  if (stats.inserted || stats.updated) await publish({ type: 'changes', entities: ['guests'], branchId: conn.branchId });
  return stats;
}

function secretsOf(conn: Connection): PosSecrets {
  return decryptJson<PosSecrets>(conn.secretsEnc) ?? {};
}

export async function pollConnection(conn: Connection, trigger = 'schedule'): Promise<ImportStats> {
  try {
    const result = await fetchRestInvoices(conn.config as PosConnectionConfig, secretsOf(conn), conn.lastCursor);
    const stats = await importInvoices(conn, result.invoices, trigger);
    await getDb().execute(sql`UPDATE pos_connections SET last_cursor = ${result.nextCursor} WHERE id = ${conn.id}`);
    return stats;
  } catch (err) {
    await getDb().execute(sql`UPDATE pos_connections SET last_error = ${(err as Error).message.slice(0, 500)}, last_error_at = now() WHERE id = ${conn.id}`);
    await logEvent('warn', 'integration', `POS ${conn.name}: ${(err as Error).message}`);
    throw new AppError(502, 'pos_unreachable', (err as Error).message);
  }
}

/** Worker job: poll generic_rest connections whose interval elapsed. */
export async function pollDueConnections(): Promise<void> {
  const due = await getDb()
    .select()
    .from(schema.posConnections)
    .where(and(eq(schema.posConnections.provider, 'generic_rest'), eq(schema.posConnections.isActive, true), isNull(schema.posConnections.deletedAt)));
  for (const c of due) {
    if (c.lastSyncAt && Date.now() - c.lastSyncAt.getTime() < c.pollIntervalMinutes * 60_000) continue;
    await pollConnection(c).catch(() => undefined);
  }
}

function connectionView(c: Connection) {
  const { secretsEnc, ...rest } = c;
  const s = decryptJson<PosSecrets>(secretsEnc) ?? {};
  return { ...rest, apiKeySet: !!s.apiKey, webhookSecretSet: !!s.webhookSecret, webhookPath: `/api/v1/pos/webhook/${c.id}` };
}

async function getConnection(tx: DbOrTx, id: string, ctx?: RequestContext): Promise<Connection> {
  const [c] = await tx.select().from(schema.posConnections).where(eq(schema.posConnections.id, id));
  if (!c || c.deletedAt) throw notFound('POS connection');
  if (ctx) assertBranchAccess(ctx, c.branchId);
  return c;
}

export async function registerPosRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  defineRoute(app, { method: 'GET', url: '/api/v1/pos/connections', summary: 'POS connections', tags: ['POS'], permission: 'pos.read' }, async ({ ctx }) => {
    const scope = branchScope(ctx);
    const rows = await db.select().from(schema.posConnections).where(isNull(schema.posConnections.deletedAt));
    return rows.filter((r) => !scope || scope.includes(r.branchId)).map(connectionView);
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/pos/connections', summary: 'Add a POS connection', tags: ['POS'], permission: 'pos.manage', body: posConnectionSchema }, async ({ body, ctx }) =>
    db.transaction(async (tx) => {
      assertBranchAccess(ctx, body.branchId);
      const { apiKey, webhookSecret, ...cfg } = body.config;
      const [c] = await tx
        .insert(schema.posConnections)
        .values({ branchId: body.branchId, name: body.name, provider: body.provider, isActive: body.isActive, pollIntervalMinutes: body.pollIntervalMinutes, config: cfg, secretsEnc: apiKey || webhookSecret ? encryptJson({ apiKey, webhookSecret }) : null, createdBy: ctx.user?.id })
        .returning();
      await audit(tx, ctx, { action: 'pos.connection_create', entityType: 'pos_connection', entityId: c!.id, branchId: body.branchId, after: connectionView(c!) });
      return connectionView(c!);
    }),
  );

  defineRoute(app, { method: 'PATCH', url: '/api/v1/pos/connections/:id', summary: 'Update a POS connection', tags: ['POS'], permission: 'pos.manage', params: idParams, body: posConnectionSchema.omit({ branchId: true }).partial() }, async ({ params, body, ctx }) =>
    db.transaction(async (tx) => {
      const before = await getConnection(tx, params.id, ctx);
      const set: Partial<Connection> = { updatedBy: ctx.user?.id ?? null };
      for (const k of ['name', 'provider', 'isActive', 'pollIntervalMinutes'] as const) if (body[k] !== undefined) (set as Record<string, unknown>)[k] = body[k];
      if (body.config) {
        const { apiKey, webhookSecret, ...cfg } = body.config;
        set.config = { ...(before.config as object), ...cfg };
        if (apiKey || webhookSecret) set.secretsEnc = encryptJson({ ...secretsOf(before), ...(apiKey ? { apiKey } : {}), ...(webhookSecret ? { webhookSecret } : {}) });
      }
      const [after] = await tx.update(schema.posConnections).set(set).where(eq(schema.posConnections.id, params.id)).returning();
      await audit(tx, ctx, { action: 'pos.connection_update', entityType: 'pos_connection', entityId: params.id, branchId: before.branchId, before: connectionView(before), after: connectionView(after!) });
      return connectionView(after!);
    }),
  );

  defineRoute(app, { method: 'POST', url: '/api/v1/pos/connections/:id/test', summary: 'Test connectivity with the POS', tags: ['POS'], permission: 'pos.manage', params: idParams }, async ({ params, ctx }) => {
    const c = await getConnection(db, params.id, ctx);
    if (c.provider !== 'generic_rest') return { ok: true, message: c.provider === 'webhook' ? 'Webhook connections are passive: configure the POS to POST to the webhook URL.' : 'CSV import needs no connectivity.' };
    try {
      const r = await fetchRestInvoices(c.config as PosConnectionConfig, secretsOf(c), c.lastCursor);
      return { ok: true, message: `Connected. ${r.invoices.length} invoice(s) available.` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/pos/connections/:id/sync', summary: 'Fetch invoices from the POS now', tags: ['POS'], permission: 'pos.manage', params: idParams }, async ({ params, ctx }) => {
    const c = await getConnection(db, params.id, ctx);
    if (c.provider !== 'generic_rest') throw badRequest('Only REST connections can be polled');
    return pollConnection(c, 'manual');
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/pos/connections/:id/import', summary: 'Import a POS CSV export (multipart file)', tags: ['POS'], permission: 'pos.manage', params: idParams, bodyLimit: 20 * 1024 * 1024 }, async ({ params, req, ctx }) => {
    const c = await getConnection(db, params.id, ctx);
    const file = await req.file();
    if (!file) throw badRequest('Upload a CSV file');
    const text = (await file.toBuffer()).toString('utf8');
    let rows: Record<string, unknown>[];
    try {
      rows = parseInvoiceCsv(text);
    } catch (err) {
      throw badRequest(`Could not read CSV: ${(err as Error).message}`);
    }
    const stats = await importInvoices(c, rows, 'csv');
    await audit(db, ctx, { action: 'pos.csv_import', entityType: 'pos_connection', entityId: c.id, branchId: c.branchId, meta: { ...stats, errors: stats.errors.length } });
    return stats;
  });

  defineRoute(
    app,
    { method: 'POST', url: '/api/v1/pos/webhook/:id', summary: 'POS push endpoint (HMAC-SHA256 signature in X-Sofia-Signature)', tags: ['POS'], auth: 'none', params: idParams, rateLimit: { max: 600, timeWindow: '1 minute' }, bodyLimit: 5 * 1024 * 1024 },
    async ({ params, req }) => {
      const c = await getConnection(db, params.id).catch(() => {
        throw unauthorized('Unknown connection');
      });
      const secret = secretsOf(c).webhookSecret;
      const sig = String(req.headers['x-sofia-signature'] ?? '').replace(/^sha256=/, '');
      const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
      if (!c.isActive || c.provider !== 'webhook' || !secret || !raw || !sig || !safeEqual(sig, hmacSha256(secret, raw))) {
        await logEvent('warn', 'security', 'POS webhook signature rejected', { connectionId: params.id, ip: req.ip });
        throw unauthorized('Invalid signature');
      }
      const body = req.body as { invoices?: unknown[] } | unknown[];
      const invoices = Array.isArray(body) ? body : body.invoices ?? [body];
      return importInvoices(c, invoices, 'webhook');
    },
  );

  defineRoute(
    app,
    { method: 'GET', url: '/api/v1/pos/invoices', summary: 'Imported POS invoices', tags: ['POS'], permission: 'pos.read', query: z.object({ branchId: zId.optional(), guestId: zId.optional(), from: z.string().max(30).optional(), to: z.string().max(30).optional(), unmatched: z.coerce.boolean().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(500).default(50) }) },
    async ({ query, ctx }) => {
      const scope = branchScope(ctx);
      const conds = [sql`i.deleted_at IS NULL`];
      if (query.branchId) {
        assertBranchAccess(ctx, query.branchId);
        conds.push(sql`i.branch_id = ${query.branchId}`);
      } else if (scope) conds.push(scope.length ? sql`i.branch_id IN ${scope}` : sql`false`);
      if (query.guestId) conds.push(sql`i.guest_id = ${query.guestId}`);
      if (query.from) conds.push(sql`i.closed_at >= ${query.from}::timestamptz`);
      if (query.to) conds.push(sql`i.closed_at < ${query.to}::timestamptz`);
      if (query.unmatched) conds.push(sql`i.guest_id IS NULL`);
      const where = sql.join(conds, sql` AND `);
      const rows = await q(db, sql`SELECT i.id, i.invoice_number, i.external_id, i.closed_at, i.table_label, i.total, i.currency, i.total_base, i.payment_method,
                                          i.status, i.match_method, i.guest_id, i.reservation_id, g.first_name, g.last_name, b.name AS branch_name
                                   FROM pos_invoices i LEFT JOIN guests g ON g.id = i.guest_id JOIN branches b ON b.id = i.branch_id
                                   WHERE ${where} ORDER BY i.closed_at DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
      const [{ n }] = (await q<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM pos_invoices i WHERE ${where}`)) as [{ n: number }];
      return { items: camelRows(rows), total: n };
    },
  );

  defineRoute(app, { method: 'GET', url: '/api/v1/pos/invoices/:id', summary: 'Invoice with items', tags: ['POS'], permission: 'pos.read', params: idParams }, async ({ params, ctx }) => {
    const inv = await q1<Record<string, unknown>>(db, sql`SELECT * FROM pos_invoices WHERE id = ${params.id}`);
    if (!inv) throw notFound('Invoice');
    assertBranchAccess(ctx, inv.branch_id as string);
    const items = await q(db, sql`SELECT * FROM pos_invoice_items WHERE invoice_id = ${params.id} ORDER BY total DESC`);
    return { ...camelRows([inv])[0], items: camelRows(items) };
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/pos/invoices/:id/link', summary: 'Manually link an invoice to a guest / reservation', tags: ['POS'], permission: 'pos.manage', params: idParams, body: z.object({ guestId: zId.nullable(), reservationId: zId.nullable().optional() }) }, async ({ params, body, ctx }) =>
    db.transaction(async (tx) => {
      const inv = await q1<{ id: string; guest_id: string | null; branch_id: string; total_base: number; status: string }>(tx, sql`SELECT id, guest_id, branch_id, total_base, status FROM pos_invoices WHERE id = ${params.id} FOR UPDATE`);
      if (!inv) throw notFound('Invoice');
      assertBranchAccess(ctx, inv.branch_id);
      await tx.execute(sql`UPDATE pos_invoices SET guest_id = ${body.guestId}, reservation_id = ${body.reservationId ?? null}, match_method = 'manual' WHERE id = ${params.id}`);
      await refreshGuestStats(tx, inv.guest_id);
      await refreshGuestStats(tx, body.guestId);
      if (body.guestId) await earnForInvoice(tx, ctx, { id: inv.id, guestId: body.guestId, branchId: inv.branch_id, totalBase: inv.total_base, status: inv.status });
      await audit(tx, ctx, { action: 'pos.invoice_link', entityType: 'pos_invoice', entityId: params.id, branchId: inv.branch_id, before: { guestId: inv.guest_id }, after: { guestId: body.guestId, reservationId: body.reservationId ?? null } });
      return { ok: true };
    }),
  );
}
