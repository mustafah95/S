import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNull } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { utcToZoned, zId, zIsoDate } from '@sofia/shared';
import { getDb, q, schema, sql } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { assertBranchAccess, branchScope, can, type RequestContext } from '../lib/context.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { defineRoute, idParams } from '../lib/route.js';
import { getSetting } from '../lib/settings.js';
import { toCsv } from './export.js';
import { AGGREGATE_AR, REPORT_AR, renderReportPdf } from './reports-pdf.js';
import { ltr } from '../lib/pdf.js';

/**
 * Report builder. Datasets expose a whitelist of columns (SQL expressions are fixed server-side), so user
 * input only selects among them and supplies parameterised values — no SQL injection surface.
 */
type ColType = 'text' | 'number' | 'date' | 'datetime' | 'boolean';
interface Column {
  sql: string;
  type: ColType;
  label: string;
}
interface Dataset {
  label: string;
  from: string;
  dateColumn: string;
  branchColumn: string | null;
  permission: 'reports.read' | 'pos.read' | 'guests.read' | 'feedback.read';
  columns: Record<string, Column>;
}

const DATASETS: Record<string, Dataset> = {
  reservations: {
    label: 'Reservations',
    from: 'reservations r JOIN branches b ON b.id = r.branch_id LEFT JOIN guests g ON g.id = r.guest_id LEFT JOIN areas a ON a.id = r.area_id',
    dateColumn: 'r.business_date',
    branchColumn: 'r.branch_id',
    permission: 'reports.read',
    columns: {
      code: { sql: 'r.code', type: 'text', label: 'Reservation #' },
      date: { sql: 'r.business_date', type: 'date', label: 'Date' },
      time: { sql: "to_char(r.start_at AT TIME ZONE b.timezone, 'HH24:MI')", type: 'text', label: 'Time' },
      hour: { sql: 'extract(hour FROM r.start_at AT TIME ZONE b.timezone)::int', type: 'number', label: 'Hour' },
      weekday: { sql: "trim(to_char(r.business_date, 'Day'))", type: 'text', label: 'Weekday' },
      branch: { sql: 'b.name', type: 'text', label: 'Branch' },
      area: { sql: 'a.name', type: 'text', label: 'Area' },
      guest: { sql: "coalesce(g.first_name || ' ' || coalesce(g.last_name, ''), r.guest_name)", type: 'text', label: 'Guest' },
      vipLevel: { sql: 'g.vip_level', type: 'text', label: 'VIP' },
      partySize: { sql: 'r.party_size', type: 'number', label: 'Party size' },
      status: { sql: 'r.status', type: 'text', label: 'Status' },
      source: { sql: 'r.source', type: 'text', label: 'Source' },
      occasion: { sql: 'r.occasion', type: 'text', label: 'Occasion' },
      deposit: { sql: 'r.deposit_amount', type: 'number', label: 'Deposit' },
      origin: { sql: 'r.origin', type: 'text', label: 'Created' },
    },
  },
  guests: {
    label: 'Guests',
    from: 'guests g LEFT JOIN loyalty_tiers t ON t.id = g.loyalty_tier_id',
    dateColumn: 'g.created_at::date',
    branchColumn: null,
    permission: 'guests.read',
    columns: {
      name: { sql: "g.first_name || ' ' || coalesce(g.last_name, '')", type: 'text', label: 'Name' },
      phone: { sql: 'g.phone', type: 'text', label: 'Phone' },
      email: { sql: 'g.email', type: 'text', label: 'E-mail' },
      vipLevel: { sql: 'g.vip_level', type: 'text', label: 'VIP' },
      tier: { sql: 't.name', type: 'text', label: 'Loyalty tier' },
      points: { sql: 'g.loyalty_points', type: 'number', label: 'Points' },
      visits: { sql: 'g.visit_count', type: 'number', label: 'Visits' },
      totalSpend: { sql: 'g.total_spend', type: 'number', label: 'Total spend' },
      avgCheck: { sql: 'g.avg_check', type: 'number', label: 'Average check' },
      noShows: { sql: 'g.no_show_count', type: 'number', label: 'No-shows' },
      firstVisit: { sql: 'g.first_visit_at::date', type: 'date', label: 'First visit' },
      lastVisit: { sql: 'g.last_visit_at::date', type: 'date', label: 'Last visit' },
      marketingConsent: { sql: 'g.marketing_consent', type: 'boolean', label: 'Marketing consent' },
      language: { sql: 'g.preferred_language', type: 'text', label: 'Language' },
      created: { sql: 'g.created_at::date', type: 'date', label: 'Created' },
    },
  },
  invoices: {
    label: 'POS invoices',
    from: 'pos_invoices i JOIN branches b ON b.id = i.branch_id LEFT JOIN guests g ON g.id = i.guest_id',
    dateColumn: 'i.closed_at::date',
    branchColumn: 'i.branch_id',
    permission: 'pos.read',
    columns: {
      invoice: { sql: 'i.invoice_number', type: 'text', label: 'Invoice' },
      date: { sql: 'i.closed_at::date', type: 'date', label: 'Date' },
      branch: { sql: 'b.name', type: 'text', label: 'Branch' },
      table: { sql: 'i.table_label', type: 'text', label: 'Table' },
      guest: { sql: "g.first_name || ' ' || coalesce(g.last_name, '')", type: 'text', label: 'Guest' },
      total: { sql: 'i.total_base', type: 'number', label: 'Total' },
      discount: { sql: 'i.discount', type: 'number', label: 'Discount' },
      tax: { sql: 'i.tax', type: 'number', label: 'Tax' },
      serviceCharge: { sql: 'i.service_charge', type: 'number', label: 'Service charge' },
      paymentMethod: { sql: 'i.payment_method', type: 'text', label: 'Payment' },
      status: { sql: 'i.status', type: 'text', label: 'Status' },
      matched: { sql: 'i.match_method', type: 'text', label: 'Matched by' },
    },
  },
  feedback: {
    label: 'Feedback',
    from: 'feedback f JOIN branches b ON b.id = f.branch_id LEFT JOIN guests g ON g.id = f.guest_id',
    dateColumn: 'f.submitted_at::date',
    branchColumn: 'f.branch_id',
    permission: 'feedback.read',
    columns: {
      date: { sql: 'f.submitted_at::date', type: 'date', label: 'Date' },
      branch: { sql: 'b.name', type: 'text', label: 'Branch' },
      guest: { sql: "g.first_name || ' ' || coalesce(g.last_name, '')", type: 'text', label: 'Guest' },
      overall: { sql: 'f.overall_rating', type: 'number', label: 'Overall' },
      food: { sql: 'f.food_rating', type: 'number', label: 'Food' },
      service: { sql: 'f.service_rating', type: 'number', label: 'Service' },
      atmosphere: { sql: 'f.atmosphere_rating', type: 'number', label: 'Atmosphere' },
      complaint: { sql: 'f.is_complaint', type: 'boolean', label: 'Complaint' },
      comment: { sql: 'f.comment', type: 'text', label: 'Comment' },
    },
  },
  loyalty: {
    label: 'Loyalty transactions',
    from: 'loyalty_transactions l JOIN guests g ON g.id = l.guest_id LEFT JOIN branches b ON b.id = l.branch_id',
    dateColumn: 'l.created_at::date',
    branchColumn: null,
    permission: 'reports.read',
    columns: {
      date: { sql: 'l.created_at::date', type: 'date', label: 'Date' },
      guest: { sql: "g.first_name || ' ' || coalesce(g.last_name, '')", type: 'text', label: 'Guest' },
      type: { sql: 'l.type', type: 'text', label: 'Type' },
      points: { sql: 'l.points', type: 'number', label: 'Points' },
      reason: { sql: 'l.reason', type: 'text', label: 'Reason' },
      branch: { sql: 'b.name', type: 'text', label: 'Branch' },
    },
  },
};

const reportSchema = z.object({
  dataset: z.string().max(40),
  columns: z.array(z.string().max(40)).min(1).max(30),
  filters: z
    .array(z.object({ column: z.string().max(40), op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'in']), value: z.union([z.string().max(200), z.number(), z.boolean(), z.array(z.string().max(100)).max(50)]) }))
    .max(20)
    .default([]),
  groupBy: z.array(z.string().max(40)).max(3).default([]),
  aggregates: z.array(z.object({ column: z.string().max(40), fn: z.enum(['count', 'sum', 'avg', 'min', 'max']) })).max(10).default([]),
  sort: z.object({ column: z.string().max(60), dir: z.enum(['asc', 'desc']).default('asc') }).optional(),
  from: zIsoDate.optional(),
  to: zIsoDate.optional(),
  branchId: zId.optional(),
  limit: z.number().int().min(1).max(50000).default(1000),
});
type ReportInput = z.infer<typeof reportSchema>;

const OPS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const;

export async function runReport(ctx: RequestContext, input: ReportInput) {
  const ds = DATASETS[input.dataset];
  if (!ds) throw badRequest('Unknown dataset');
  if (!can(ctx, ds.permission)) throw forbidden(`Missing permission: ${ds.permission}`);
  const col = (k: string) => {
    const c = ds.columns[k];
    if (!c) throw badRequest(`Unknown column ${k}`);
    return c;
  };
  const conds = [sql`true`];
  if (input.dataset === 'guests') conds.push(sql`g.deleted_at IS NULL AND g.merged_into_id IS NULL`);
  if (input.from) conds.push(sql`${sql.raw(ds.dateColumn)} >= ${input.from}::date`);
  if (input.to) conds.push(sql`${sql.raw(ds.dateColumn)} <= ${input.to}::date`);
  if (ds.branchColumn) {
    if (input.branchId) {
      assertBranchAccess(ctx, input.branchId);
      conds.push(sql`${sql.raw(ds.branchColumn)} = ${input.branchId}`);
    } else {
      const s = branchScope(ctx);
      if (s) conds.push(s.length ? sql`${sql.raw(ds.branchColumn)} IN ${s}` : sql`false`);
    }
  }
  for (const f of input.filters) {
    const c = sql.raw(col(f.column).sql);
    if (f.op === 'contains') conds.push(sql`(${c})::text ILIKE ${'%' + String(f.value) + '%'}`);
    else if (f.op === 'in') conds.push(sql`(${c})::text IN ${(Array.isArray(f.value) ? f.value : [String(f.value)]).map(String)}`);
    else conds.push(sql`(${c}) ${sql.raw(OPS[f.op])} ${f.value}`);
  }
  const grouped = input.groupBy.length > 0;
  const selects = grouped
    ? [
        ...input.groupBy.map((k) => sql`${sql.raw(col(k).sql)} AS ${sql.identifier(k)}`),
        sql`count(*)::int AS "count"`,
        ...input.aggregates.filter((a) => a.fn !== 'count').map((a) => sql`round(${sql.raw(a.fn)}((${sql.raw(col(a.column).sql)})::numeric), 2)::float AS ${sql.identifier(`${a.fn}_${a.column}`)}`),
      ]
    : input.columns.map((k) => sql`${sql.raw(col(k).sql)} AS ${sql.identifier(k)}`);
  const allowedSort = new Set([...(grouped ? [...input.groupBy, 'count', ...input.aggregates.map((a) => `${a.fn}_${a.column}`)] : input.columns)]);
  const order = input.sort && allowedSort.has(input.sort.column) ? sql`ORDER BY ${sql.identifier(input.sort.column)} ${sql.raw(input.sort.dir)}` : sql``;
  const group = grouped ? sql`GROUP BY ${sql.join(input.groupBy.map((k) => sql.raw(col(k).sql)), sql`, `)}` : sql``;
  const rows = await q(getDb(), sql`SELECT ${sql.join(selects, sql`, `)} FROM ${sql.raw(ds.from)} WHERE ${sql.join(conds, sql` AND `)} ${group} ${order} LIMIT ${input.limit}`);
  const ar = (k: string) => REPORT_AR[input.dataset]?.columns[k] ?? col(k).label;
  const plain = (k: string) => ({ key: k, label: col(k).label, labelAr: ar(k), type: col(k).type, summable: false });
  const headers = grouped
    ? [
        ...input.groupBy.map(plain),
        { key: 'count', label: 'Count', labelAr: AGGREGATE_AR.count!, type: 'number' as ColType, summable: true },
        ...input.aggregates
          .filter((a) => a.fn !== 'count')
          .map((a) => ({ key: `${a.fn}_${a.column}`, label: `${a.fn.toUpperCase()} ${col(a.column).label}`, labelAr: `${AGGREGATE_AR[a.fn]} ${ar(a.column)}`, type: 'number' as ColType, summable: a.fn === 'sum' })),
      ]
    : input.columns.map(plain);
  return { headers, rows, dataset: ds.label, datasetAr: REPORT_AR[input.dataset]?.label ?? ds.label };
}

const OP_TEXT = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=', contains: '~', in: ':' } as const;

/** Builds the PDF for an export: title, period, branch, grouping, filters, who generated it and when. */
async function reportPdf(ctx: RequestContext, body: ReportInput & { language?: 'ar' | 'en'; title?: string }, r: Awaited<ReturnType<typeof runReport>>): Promise<Buffer> {
  const general = await getSetting('general');
  const branding = await getSetting('branding');
  const lang = body.language ?? (general.defaultLanguage === 'en' ? 'en' : 'ar');
  const ar = lang === 'ar';
  const ds = DATASETS[body.dataset]!;
  const label = (k: string) => (ar ? REPORT_AR[body.dataset]?.columns[k] : undefined) ?? ds.columns[k]?.label ?? k;
  const meta: string[] = [];
  if (body.from || body.to) meta.push(`${ar ? 'الفترة' : 'Period'}: ${ltr(body.from ?? '…')} – ${ltr(body.to ?? '…')}`);
  if (ds.branchColumn) {
    const branch = body.branchId ? (await q<{ name: string; name_ar: string | null }>(getDb(), sql`SELECT name, name_ar FROM branches WHERE id = ${body.branchId}`))[0] : undefined;
    meta.push(`${ar ? 'الفرع' : 'Branch'}: ${branch ? (ar && branch.name_ar ? branch.name_ar : branch.name) : ar ? 'جميع الفروع المتاحة' : 'All accessible branches'}`);
  }
  if (body.groupBy.length) meta.push(`${ar ? 'مجمّع حسب' : 'Grouped by'}: ${body.groupBy.map(label).join('، ')}`);
  if (body.filters.length) meta.push(`${ar ? 'التصفية' : 'Filters'}: ${body.filters.map((f) => `${label(f.column)} ${OP_TEXT[f.op]} ${Array.isArray(f.value) ? f.value.join('/') : String(f.value)}`).join(' · ')}`);
  const now = utcToZoned(new Date(), general.timezone);
  const generatedAt = `${now.date} ${now.time}`;
  const who = ctx.user?.displayName ?? ctx.user?.username ?? '';
  meta.push(ar ? `${r.rows.length} صف · أُنشئ في ${ltr(generatedAt)} بواسطة ${who}` : `${r.rows.length} rows · generated ${generatedAt} by ${who}`);
  return renderReportPdf({
    lang,
    title: body.title || (ar ? `تقرير ${r.datasetAr}` : `${r.dataset} report`),
    restaurant: ar && branding.restaurantNameAr ? branding.restaurantNameAr : branding.restaurantName,
    meta,
    generatedAt,
    columns: r.headers.map((h) => ({ key: h.key, label: ar ? h.labelAr : h.label, type: h.type, numeric: h.type === 'number', summable: h.summable })),
    rows: r.rows as Record<string, unknown>[],
    truncated: r.rows.length >= body.limit,
  });
}

export async function registerReportRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  defineRoute(app, { method: 'GET', url: '/api/v1/reports/datasets', summary: 'Datasets and columns available to the report builder', tags: ['Reports'], permission: 'reports.read' }, async ({ ctx }) =>
    Object.entries(DATASETS)
      .filter(([, d]) => can(ctx, d.permission))
      .map(([key, d]) => ({ key, label: d.label, labelAr: REPORT_AR[key]?.label ?? d.label, columns: Object.entries(d.columns).map(([k, c]) => ({ key: k, label: c.label, labelAr: REPORT_AR[key]?.columns[k] ?? c.label, type: c.type })) })),
  );

  defineRoute(app, { method: 'POST', url: '/api/v1/reports/run', summary: 'Run a report (filters, grouping, sorting, date range)', tags: ['Reports'], permission: 'reports.read', body: reportSchema }, async ({ body, ctx }) => runReport(ctx, body));

  defineRoute(app, { method: 'POST', url: '/api/v1/reports/export', summary: 'Export a report as PDF, CSV, Excel or JSON', tags: ['Reports'], permission: 'reports.export', body: reportSchema.extend({ format: z.enum(['pdf', 'csv', 'xlsx', 'json']), language: z.enum(['ar', 'en']).optional(), title: z.string().trim().max(120).optional() }) }, async ({ body, ctx, reply }) => {
    const r = await runReport(ctx, body);
    await audit(db, ctx, { action: 'report.export', entityType: 'report', entityId: body.dataset, meta: { format: body.format, rows: r.rows.length } });
    const name = `sofia-${body.dataset}-${new Date().toISOString().slice(0, 10)}`;
    if (body.format === 'pdf') {
      const pdf = await reportPdf(ctx, body, r);
      return reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${name}.pdf"`).send(pdf);
    }
    if (body.format === 'json') {
      reply.header('content-disposition', `attachment; filename="${name}.json"`);
      return r.rows;
    }
    if (body.format === 'csv') {
      const labelled = r.rows.map((row) => Object.fromEntries(r.headers.map((h) => [h.label, (row as Record<string, unknown>)[h.key]])));
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${name}.csv"`).send(toCsv(labelled));
    }
    const wb = new ExcelJS.Workbook();
    wb.creator = "Sofia's Resto-Lounge";
    const ws = wb.addWorksheet(r.dataset.slice(0, 31));
    ws.columns = r.headers.map((h) => ({ header: h.label, key: h.key, width: Math.max(12, h.label.length + 4) }));
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6B1420' } };
    for (const row of r.rows) ws.addRow(row);
    const buf = await wb.xlsx.writeBuffer();
    return reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="${name}.xlsx"`)
      .send(Buffer.from(buf));
  });

  defineRoute(app, { method: 'GET', url: '/api/v1/reports/saved', summary: 'Saved report definitions', tags: ['Reports'], permission: 'reports.read' }, async ({ ctx }) =>
    db.select().from(schema.savedReports).where(and(isNull(schema.savedReports.deletedAt), sql`(${schema.savedReports.isShared} OR ${schema.savedReports.createdBy} = ${ctx.user!.id})`)).orderBy(desc(schema.savedReports.createdAt)),
  );

  defineRoute(app, { method: 'POST', url: '/api/v1/reports/saved', summary: 'Save a report definition', tags: ['Reports'], permission: 'reports.read', body: z.object({ name: z.string().trim().min(1).max(120), definition: reportSchema, isShared: z.boolean().default(true) }) }, async ({ body, ctx }) => {
    const [row] = await db.insert(schema.savedReports).values({ name: body.name, dataset: body.definition.dataset, definition: body.definition, isShared: body.isShared, createdBy: ctx.user!.id }).returning();
    return row;
  });

  defineRoute(app, { method: 'DELETE', url: '/api/v1/reports/saved/:id', summary: 'Delete a saved report', tags: ['Reports'], permission: 'reports.read', params: idParams }, async ({ params, ctx }) => {
    const [row] = await db.update(schema.savedReports).set({ deletedAt: new Date() }).where(and(eq(schema.savedReports.id, params.id), eq(schema.savedReports.createdBy, ctx.user!.id))).returning();
    if (!row) throw notFound('Saved report');
    return { ok: true };
  });
}
