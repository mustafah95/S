import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addDays, businessDateOf, parseHHMM, periodsForDate, zId, zIsoDate, type WeeklyHours } from '@sofia/shared';
import { camelRows, getDb, q, q1, sql, type DbOrTx } from '../db/pool.js';
import { assertBranchAccess, branchScope, type RequestContext } from '../lib/context.js';
import { defineRoute } from '../lib/route.js';
import { getBranch, getClosures, liveTables, reservationSettingsOf } from './venue.js';

const rangeQuery = z.object({ from: zIsoDate, to: zIsoDate, branchId: zId.optional() });

function branchFilter(ctx: RequestContext, col: string, branchId?: string) {
  if (branchId) {
    assertBranchAccess(ctx, branchId);
    return sql`AND ${sql.raw(col)} = ${branchId}`;
  }
  const s = branchScope(ctx);
  return s ? (s.length ? sql`AND ${sql.raw(col)} IN ${s}` : sql`AND false`) : sql``;
}

/** Bookable table-minutes in a date range (active tables × opening minutes per day). */
async function capacityMinutes(tx: DbOrTx, ctx: RequestContext, from: string, to: string, branchId?: string): Promise<number> {
  const scope = branchId ? [branchId] : branchScope(ctx);
  const branches = await q<{ id: string; operating_hours: WeeklyHours; tables: number }>(
    tx,
    sql`SELECT b.id, b.operating_hours, (SELECT count(*)::int FROM restaurant_tables t WHERE t.branch_id = b.id AND t.is_active AND t.deleted_at IS NULL) AS tables
        FROM branches b WHERE b.deleted_at IS NULL ${scope ? (scope.length ? sql`AND b.id IN ${scope}` : sql`AND false`) : sql``}`,
  );
  let total = 0;
  for (const b of branches) {
    const closures = await getClosures(tx, b.id, from, to);
    for (let d = from; d <= to; d = addDays(d, 1)) {
      for (const p of periodsForDate(d, b.operating_hours, closures)) {
        let mins = parseHHMM(p.close) - parseHHMM(p.open);
        if (mins <= 0) mins += 1440;
        total += mins * b.tables;
      }
    }
  }
  return total;
}

export async function hostDashboard(ctx: RequestContext, branchId: string) {
  const db = getDb();
  assertBranchAccess(ctx, branchId);
  const branch = await getBranch(db, branchId);
  const settings = reservationSettingsOf(branch);
  const today = businessDateOf(new Date(), branch.timezone);
  const reservations = await q(
    db,
    sql`SELECT r.id, r.code, r.status, r.start_at, r.end_at, r.party_size, r.guest_name, r.guest_id, r.occasion, r.table_ids, r.special_request,
               r.requires_review, r.source, g.vip_level, g.allergies, g.visit_count,
               (SELECT string_agg(t.label, '+') FROM restaurant_tables t WHERE t.id = ANY (r.table_ids)) AS table_labels
        FROM reservations r LEFT JOIN guests g ON g.id = r.guest_id
        WHERE r.branch_id = ${branchId} AND r.business_date = ${today} AND r.deleted_at IS NULL AND r.status <> 'rescheduled'
        ORDER BY r.start_at`,
  );
  const rows = camelRows<Record<string, any>>(reservations);
  const now = Date.now();
  const tables = await liveTables(db, branchId);
  const [waitlist] = await q<{ n: number; parties: number }>(db, sql`SELECT count(*)::int AS n, coalesce(sum(party_size), 0)::int AS parties FROM waitlist_entries WHERE branch_id = ${branchId} AND status IN ('waiting', 'notified') AND deleted_at IS NULL`);
  const vip = ['gold', 'platinum', 'vip', 'vvip'];
  const by = (s: string[]) => rows.filter((r) => s.includes(r.status));
  return {
    date: today,
    totals: {
      reservations: rows.filter((r) => !['cancelled'].includes(r.status)).length,
      covers: rows.filter((r) => !['cancelled', 'no_show'].includes(r.status)).reduce((s, r) => s + r.partySize, 0),
      seated: by(['seated', 'dining']).length,
      completed: by(['completed']).length,
      cancelled: by(['cancelled']).length,
      noShows: by(['no_show']).length,
      waitlist: waitlist?.n ?? 0,
      waitlistCovers: waitlist?.parties ?? 0,
      requiresReview: rows.filter((r) => r.requiresReview).length,
    },
    arrivals: rows.filter((r) => ['pending', 'confirmed', 'checked_in'].includes(r.status) && new Date(r.startAt).getTime() < now + 3 * 3600_000),
    late: rows.filter((r) => ['pending', 'confirmed'].includes(r.status) && new Date(r.startAt).getTime() + settings.lateThresholdMinutes * 60_000 < now),
    vip: rows.filter((r) => vip.includes(r.vipLevel) && r.status !== 'cancelled'),
    occasions: rows.filter((r) => r.occasion && r.status !== 'cancelled'),
    noShows: by(['no_show']),
    tables: {
      available: tables.filter((t) => t.isActive && t.liveStatus === 'available').length,
      occupied: tables.filter((t) => t.liveStatus === 'occupied').length,
      reserved: tables.filter((t) => t.liveStatus === 'reserved').length,
      unavailable: tables.filter((t) => ['cleaning', 'blocked', 'maintenance'].includes(t.liveStatus)).length,
      total: tables.filter((t) => t.isActive).length,
    },
    timeline: rows,
  };
}

export async function ownerDashboard(ctx: RequestContext, from: string, to: string, branchId?: string) {
  const db = getDb();
  const rf = branchFilter(ctx, 'r.branch_id', branchId);
  const inf = branchFilter(ctx, 'i.branch_id', branchId);
  const [res] = await q<Record<string, number>>(
    db,
    sql`SELECT count(*) FILTER (WHERE status <> 'rescheduled')::int AS reservations,
               coalesce(sum(party_size) FILTER (WHERE status IN ('seated', 'dining', 'completed')), 0)::int AS covers,
               count(*) FILTER (WHERE status = 'no_show')::int AS no_shows,
               count(*) FILTER (WHERE status = 'cancelled')::int AS cancellations,
               count(*) FILTER (WHERE source = 'walk_in')::int AS walk_ins,
               coalesce(sum(extract(epoch FROM (coalesce(completed_at, end_at) - coalesce(seated_at, start_at))) / 60)
                        FILTER (WHERE status IN ('seated', 'dining', 'completed')), 0)::float AS seated_minutes,
               coalesce(sum(extract(epoch FROM (coalesce(completed_at, end_at) - coalesce(seated_at, start_at))) / 60 * cardinality(table_ids))
                        FILTER (WHERE status IN ('seated', 'dining', 'completed')), 0)::float AS table_minutes
        FROM reservations r WHERE r.deleted_at IS NULL AND r.business_date BETWEEN ${from} AND ${to} ${rf}`,
  );
  const [rev] = await q<Record<string, number>>(
    db,
    sql`SELECT coalesce(sum(i.total_base), 0)::float AS revenue, count(*)::int AS invoices,
               coalesce(sum(i.total_base) FILTER (WHERE g.vip_level IN ('gold', 'platinum', 'vip', 'vvip')), 0)::float AS vip_revenue,
               coalesce(sum(i.covers), 0)::int AS invoice_covers
        FROM pos_invoices i LEFT JOIN guests g ON g.id = i.guest_id
        WHERE i.status = 'closed' AND i.deleted_at IS NULL AND i.closed_at >= ${from}::date AND i.closed_at < (${to}::date + 1) ${inf}`,
  );
  const [guests] = await q<Record<string, number>>(
    db,
    sql`WITH visitors AS (
          SELECT DISTINCT r.guest_id FROM reservations r
          WHERE r.guest_id IS NOT NULL AND r.status IN ('seated', 'dining', 'completed') AND r.business_date BETWEEN ${from} AND ${to} ${rf}
        )
        SELECT count(*)::int AS visitors,
               count(*) FILTER (WHERE g.first_visit_at >= ${from}::date)::int AS new_guests,
               count(*) FILTER (WHERE g.first_visit_at < ${from}::date)::int AS returning_guests
        FROM visitors v JOIN guests g ON g.id = v.guest_id`,
  );
  const [mkt] = await q<{ cost: number; campaigns: number }>(db, sql`SELECT coalesce(sum(cost), 0)::float AS cost, count(*)::int AS campaigns FROM campaigns WHERE status = 'sent' AND sent_at >= ${from}::date AND sent_at < (${to}::date + 1)`);
  const [mktRevenue] = await q<{ revenue: number }>(
    db,
    sql`SELECT coalesce(sum(i.total_base), 0)::float AS revenue FROM pos_invoices i
        WHERE i.status = 'closed' AND EXISTS (SELECT 1 FROM campaign_recipients cr JOIN campaigns c ON c.id = cr.campaign_id
              WHERE cr.guest_id = i.guest_id AND cr.status = 'sent' AND c.sent_at >= ${from}::date AND c.sent_at < (${to}::date + 1)
                AND i.closed_at BETWEEN c.sent_at AND c.sent_at + make_interval(days => c.attribution_days)) ${inf}`,
  );
  const series = await q(
    db,
    sql`SELECT d::date AS date,
               (SELECT count(*)::int FROM reservations r WHERE r.business_date = d::date AND r.status <> 'rescheduled' AND r.deleted_at IS NULL ${rf}) AS reservations,
               (SELECT coalesce(sum(party_size), 0)::int FROM reservations r WHERE r.business_date = d::date AND r.status IN ('seated','dining','completed') AND r.deleted_at IS NULL ${rf}) AS covers,
               (SELECT coalesce(sum(total_base), 0)::float FROM pos_invoices i WHERE i.status = 'closed' AND i.closed_at >= d AND i.closed_at < d + interval '1 day' ${inf}) AS revenue
        FROM generate_series(${from}::date, ${to}::date, interval '1 day') d ORDER BY d`,
  );
  const capacity = await capacityMinutes(db, ctx, from, to, branchId);
  const revenue = rev?.revenue ?? 0;
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  return {
    range: { from, to },
    reservations: res?.reservations ?? 0,
    covers: res?.covers ?? 0,
    walkIns: res?.walk_ins ?? 0,
    revenue,
    invoices: rev?.invoices ?? 0,
    averageCheck: rev?.invoices ? Math.round(revenue / rev.invoices) : 0,
    revenuePerCover: res?.covers ? Math.round(revenue / res.covers) : 0,
    occupancyRate: pct(res?.table_minutes ?? 0, capacity),
    noShowRate: pct(res?.no_shows ?? 0, res?.reservations ?? 0),
    cancellationRate: pct(res?.cancellations ?? 0, res?.reservations ?? 0),
    vipRevenue: rev?.vip_revenue ?? 0,
    newCustomers: guests?.new_guests ?? 0,
    returningCustomers: guests?.returning_guests ?? 0,
    retentionRate: pct(guests?.returning_guests ?? 0, guests?.visitors ?? 0),
    tableUtilization: pct(res?.table_minutes ?? 0, capacity),
    marketing: { campaigns: mkt?.campaigns ?? 0, cost: mkt?.cost ?? 0, attributedRevenue: mktRevenue?.revenue ?? 0, roi: mkt?.cost ? Math.round((((mktRevenue?.revenue ?? 0) - mkt.cost) / mkt.cost) * 1000) / 10 : null },
    series: camelRows(series),
  };
}

export async function registerAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  defineRoute(app, { method: 'GET', url: '/api/v1/analytics/host', summary: "Host dashboard: today's arrivals, VIPs, waitlist, tables, late guests", tags: ['Analytics'], permission: 'analytics.host', query: z.object({ branchId: zId }) }, async ({ query, ctx }) =>
    hostDashboard(ctx, query.branchId),
  );

  defineRoute(app, { method: 'GET', url: '/api/v1/analytics/owner', summary: 'Owner dashboard KPIs for a date range', tags: ['Analytics'], permission: 'analytics.owner', query: rangeQuery }, async ({ query, ctx }) =>
    ownerDashboard(ctx, query.from, query.to, query.branchId),
  );

  defineRoute(app, { method: 'GET', url: '/api/v1/analytics/reservations', summary: 'Reservations per day / hour, party size, source, status', tags: ['Analytics'], permission: ['analytics.owner', 'reports.read'], query: rangeQuery }, async ({ query, ctx }) => {
    const rf = branchFilter(ctx, 'r.branch_id', query.branchId);
    const base = sql`FROM reservations r JOIN branches b ON b.id = r.branch_id WHERE r.deleted_at IS NULL AND r.status <> 'rescheduled' AND r.business_date BETWEEN ${query.from} AND ${query.to} ${rf}`;
    const [perDay, perHour, partySizes, sources, statuses] = await Promise.all([
      q(db, sql`SELECT r.business_date AS date, count(*)::int AS reservations, sum(r.party_size)::int AS covers ${base} GROUP BY 1 ORDER BY 1`),
      q(db, sql`SELECT extract(hour FROM r.start_at AT TIME ZONE b.timezone)::int AS hour, count(*)::int AS reservations ${base} GROUP BY 1 ORDER BY 1`),
      q(db, sql`SELECT r.party_size, count(*)::int AS reservations ${base} GROUP BY 1 ORDER BY 1`),
      q(db, sql`SELECT r.source, count(*)::int AS reservations ${base} GROUP BY 1 ORDER BY 2 DESC`),
      q(db, sql`SELECT r.status, count(*)::int AS reservations ${base} GROUP BY 1 ORDER BY 2 DESC`),
    ]);
    return { perDay: camelRows(perDay), perHour, partySizes: camelRows(partySizes), sources, statuses };
  });

  defineRoute(app, { method: 'GET', url: '/api/v1/analytics/guests', summary: 'New, returning, VIP, high-value and inactive guests', tags: ['Analytics'], permission: ['analytics.owner', 'reports.read'], query: rangeQuery }, async ({ query }) => {
    const [counts] = await q(
      db,
      sql`SELECT count(*)::int AS total,
                 count(*) FILTER (WHERE first_visit_at >= ${query.from}::date AND first_visit_at < ${query.to}::date + 1)::int AS new_in_range,
                 count(*) FILTER (WHERE visit_count >= 2)::int AS returning,
                 count(*) FILTER (WHERE vip_level IN ('gold', 'platinum', 'vip', 'vvip'))::int AS vip,
                 count(*) FILTER (WHERE total_spend >= (SELECT coalesce((value->>'highSpenderThreshold')::numeric, 1000000) FROM app_settings WHERE key = 'guests' AND branch_id IS NULL UNION ALL SELECT 1000000 LIMIT 1))::int AS high_value,
                 count(*) FILTER (WHERE last_visit_at < now() - interval '90 days')::int AS inactive,
                 count(*) FILTER (WHERE marketing_consent AND opted_out_at IS NULL)::int AS marketing_consent
          FROM guests WHERE deleted_at IS NULL AND merged_into_id IS NULL`,
    );
    const top = await q(db, sql`SELECT id, first_name, last_name, vip_level, visit_count, total_spend, avg_check, last_visit_at FROM guests
                                WHERE deleted_at IS NULL AND merged_into_id IS NULL ORDER BY total_spend DESC LIMIT 20`);
    const vipMix = await q(db, sql`SELECT vip_level, count(*)::int AS guests FROM guests WHERE deleted_at IS NULL AND merged_into_id IS NULL GROUP BY 1 ORDER BY 2 DESC`);
    return { counts: camelRows([counts!])[0], topGuests: camelRows(top), vipMix: camelRows(vipMix) };
  });

  defineRoute(app, { method: 'GET', url: '/api/v1/analytics/tables', summary: 'Utilisation, turnover, revenue per table and per seat', tags: ['Analytics'], permission: ['analytics.owner', 'reports.read'], query: rangeQuery }, async ({ query, ctx }) => {
    const tf = branchFilter(ctx, 't.branch_id', query.branchId);
    const days = Math.max(1, Math.round((new Date(query.to).getTime() - new Date(query.from).getTime()) / 86400_000) + 1);
    const capacity = await capacityMinutes(db, ctx, query.from, query.to, query.branchId);
    const tableCount = await q1<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM restaurant_tables t WHERE t.is_active AND t.deleted_at IS NULL ${tf}`);
    const perTableCapacity = tableCount?.n ? capacity / tableCount.n : 0;
    const rows = await q(
      db,
      sql`SELECT t.id, t.label, t.max_capacity AS seats, a.name AS area,
                 count(DISTINCT r.id)::int AS seatings,
                 coalesce(sum(extract(epoch FROM (coalesce(r.completed_at, r.end_at) - coalesce(r.seated_at, r.start_at))) / 60), 0)::float AS occupied_minutes,
                 coalesce((SELECT sum(i.total_base) FROM pos_invoices i WHERE i.table_id = t.id AND i.status = 'closed'
                           AND i.closed_at >= ${query.from}::date AND i.closed_at < ${query.to}::date + 1), 0)::float AS revenue
          FROM restaurant_tables t JOIN areas a ON a.id = t.area_id
          LEFT JOIN reservations r ON t.id = ANY (r.table_ids) AND r.status IN ('seated', 'dining', 'completed') AND r.business_date BETWEEN ${query.from} AND ${query.to}
          WHERE t.deleted_at IS NULL ${tf}
          GROUP BY t.id, t.label, t.max_capacity, a.name ORDER BY t.label`,
    );
    return camelRows<{ seatings: number; occupiedMinutes: number; revenue: number; seats: number }>(rows).map((t) => ({
      ...t,
      turnoverPerDay: Math.round((t.seatings / days) * 100) / 100,
      utilization: perTableCapacity ? Math.round((t.occupiedMinutes / perTableCapacity) * 1000) / 10 : 0,
      revenuePerSeat: t.seats ? Math.round(t.revenue / t.seats) : 0,
    }));
  });
}
