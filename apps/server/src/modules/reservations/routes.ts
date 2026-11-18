import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  VIP_RANK,
  addDays,
  businessDateOf,
  businessToUtc,
  durationForParty,
  generateSlots,
  pickTables,
  rescheduleSchema,
  reservationActionSchema,
  reservationCreateSchema,
  reservationListQuerySchema,
  reservationUpdateSchema,
  zId,
  zIsoDate,
  zTime,
  type VipLevel,
  type WeeklyHours,
} from '@sofia/shared';
import { camelRows, getDb, q, sql } from '../../db/pool.js';
import { assertBranchAccess, branchScope } from '../../lib/context.js';
import { defineRoute, idParams } from '../../lib/route.js';
import { getBranch, getClosures, reservationSettingsOf } from '../venue.js';
import {
  createReservation,
  getReservation,
  loadPickData,
  permissionForAction,
  rescheduleReservation,
  reservationEvents,
  reservationView,
  transitionReservation,
  updateReservation,
} from './service.js';

export async function computeAvailability(
  branchId: string,
  date: string,
  partySize: number,
  opts: { areaId?: string | null; publicMode?: boolean; guestVip?: VipLevel } = {},
) {
  const db = getDb();
  const branch = await getBranch(db, branchId);
  const settings = reservationSettingsOf(branch);
  const closures = await getClosures(db, branchId, addDays(date, -1), addDays(date, 1));
  const slots = generateSlots(date, branch.operatingHours as WeeklyHours, settings, branch.timezone, closures);
  if (!slots.length) return { date, timezone: branch.timezone, slots: [] as { time: string; startAt: string; available: boolean; tableIds: string[] }[] };
  const duration = durationForParty(settings, partySize);
  const from = slots[0]!.startAt;
  const to = new Date(slots.at(-1)!.startAt.getTime() + (duration + settings.bufferMinutes) * 60_000);
  const data = await loadPickData(db, branchId, from, to);
  const now = Date.now();
  const allowVip = !(opts.publicMode && settings.holdVipTablesForVip && VIP_RANK[opts.guestVip ?? 'standard'] < VIP_RANK.gold);
  return {
    date,
    timezone: branch.timezone,
    durationMinutes: duration,
    slots: slots.map((s) => {
      const start = s.startAt.getTime();
      const end = start + (duration + settings.bufferMinutes) * 60_000;
      const tooSoon = opts.publicMode && start < now + settings.minNoticeMinutes * 60_000;
      const past = start < now - 15 * 60_000;
      const pick = tooSoon || past
        ? null
        : pickTables(data.tables, data.combos, data.allocations, start, end, partySize, {
            areaId: opts.areaId,
            onlineOnly: opts.publicMode,
            allowVipTables: allowVip,
            now,
          });
      return { time: s.time, startAt: s.startAt.toISOString(), available: !!pick, tableIds: opts.publicMode ? [] : pick?.tableIds ?? [] };
    }),
  };
}

export async function registerReservationRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  defineRoute(app, { method: 'GET', url: '/api/v1/reservations', summary: 'List reservations (filters: branch, date range, status, guest, search)', tags: ['Reservations'], permission: 'reservations.read', query: reservationListQuerySchema }, async ({ query, ctx }) => {
    const conds = [sql`r.deleted_at IS NULL`];
    const scope = branchScope(ctx);
    if (query.branchId) {
      assertBranchAccess(ctx, query.branchId);
      conds.push(sql`r.branch_id = ${query.branchId}`);
    } else if (scope) conds.push(scope.length ? sql`r.branch_id IN ${scope}` : sql`false`);
    if (query.from) conds.push(sql`r.business_date >= ${query.from}`);
    if (query.to) conds.push(sql`r.business_date <= ${query.to}`);
    if (query.status) conds.push(sql`r.status IN ${query.status.split(',').map((s) => s.trim())}`);
    if (query.guestId) conds.push(sql`r.guest_id = ${query.guestId}`);
    if (query.requiresReview) conds.push(sql`r.requires_review`);
    if (query.q) {
      const t = `%${query.q.toLowerCase()}%`;
      conds.push(sql`(lower(r.code) LIKE ${t} OR lower(coalesce(r.guest_name, '')) LIKE ${t} OR coalesce(r.guest_phone, '') LIKE ${t})`);
    }
    const where = sql.join(conds, sql` AND `);
    const offset = (query.page - 1) * query.pageSize;
    const rows = await q(
      db,
      sql`SELECT r.*, b.timezone, g.vip_level, g.allergies, g.visit_count,
                 (SELECT string_agg(t.label, '+' ORDER BY t.label) FROM restaurant_tables t WHERE t.id = ANY (r.table_ids)) AS table_labels
          FROM reservations r JOIN branches b ON b.id = r.branch_id LEFT JOIN guests g ON g.id = r.guest_id
          WHERE ${where} ORDER BY r.start_at LIMIT ${query.pageSize} OFFSET ${offset}`,
    );
    const [{ n }] = (await q<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM reservations r WHERE ${where}`)) as [{ n: number }];
    return {
      items: camelRows<Record<string, unknown>>(rows).map(({ confirmationToken: _c, feedbackToken: _f, ...r }) => r),
      total: n,
      page: query.page,
      pageSize: query.pageSize,
    };
  });

  defineRoute(app, { method: 'GET', url: '/api/v1/reservations/:id', summary: 'Get a reservation', tags: ['Reservations'], permission: 'reservations.read', params: idParams }, async ({ params, ctx }) => {
    const r = await getReservation(db, params.id);
    assertBranchAccess(ctx, r.branchId);
    const branch = await getBranch(db, r.branchId);
    return reservationView(r, branch.timezone);
  });

  defineRoute(app, { method: 'GET', url: '/api/v1/reservations/:id/events', summary: 'Reservation timeline', tags: ['Reservations'], permission: 'reservations.read', params: idParams }, async ({ params, ctx }) => {
    const r = await getReservation(db, params.id);
    assertBranchAccess(ctx, r.branchId);
    return reservationEvents(db, params.id);
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/reservations', summary: 'Create a reservation (409 table_unavailable when the table was just taken)', tags: ['Reservations'], permission: 'reservations.create', body: reservationCreateSchema }, async ({ body, ctx, reply }) => {
    const result = await db.transaction((tx) => createReservation(tx, ctx, body, { origin: 'online' }));
    const branch = await getBranch(db, result.reservation.branchId);
    reply.code(result.created ? 201 : 200);
    return { reservation: reservationView(result.reservation, branch.timezone), created: result.created };
  });

  defineRoute(app, { method: 'PATCH', url: '/api/v1/reservations/:id', summary: 'Update a reservation (time, party, tables, notes …)', tags: ['Reservations'], permission: 'reservations.update', params: idParams, body: reservationUpdateSchema.extend({ expectedVersion: z.number().int().optional() }) }, async ({ params, body, ctx }) => {
    const { expectedVersion, ...patch } = body;
    const r = await db.transaction((tx) => updateReservation(tx, ctx, params.id, patch, { expectedVersion }));
    return reservationView(r, (await getBranch(db, r.branchId)).timezone);
  });

  for (const action of ['confirm', 'check-in', 'seat', 'start-dining', 'complete', 'cancel', 'no-show', 'assign-tables'] as const) {
    const key = action.replace('-', '_') as z.infer<typeof reservationActionSchema>['action'];
    defineRoute(
      app,
      {
        method: 'POST',
        url: `/api/v1/reservations/:id/${action}`,
        summary: `Reservation action: ${action}`,
        tags: ['Reservations'],
        permission: permissionForAction(key),
        params: idParams,
        body: reservationActionSchema.omit({ action: true }),
      },
      async ({ params, body, ctx }) => {
        const r = await db.transaction((tx) => transitionReservation(tx, ctx, params.id, key, { reason: body.reason, tableIds: body.tableIds, at: body.at }));
        return reservationView(r, (await getBranch(db, r.branchId)).timezone);
      },
    );
  }

  defineRoute(app, { method: 'POST', url: '/api/v1/reservations/:id/reschedule', summary: 'Reschedule (creates a linked reservation, old one becomes "rescheduled")', tags: ['Reservations'], permission: 'reservations.update', params: idParams, body: rescheduleSchema }, async ({ params, body, ctx }) => {
    const r = await db.transaction((tx) => rescheduleReservation(tx, ctx, params.id, body));
    const tz = (await getBranch(db, r.reservation.branchId)).timezone;
    return { previous: reservationView(r.previous, tz), reservation: reservationView(r.reservation, tz) };
  });

  // Availability -----------------------------------------------------------------------------------------------
  defineRoute(app, { method: 'GET', url: '/api/v1/availability/slots', summary: 'Bookable time slots for a date and party size', tags: ['Availability'], permission: 'reservations.read', query: z.object({ branchId: zId, date: zIsoDate, partySize: z.coerce.number().int().min(1).max(500), areaId: zId.optional() }) }, async ({ query, ctx }) => {
    assertBranchAccess(ctx, query.branchId);
    return computeAvailability(query.branchId, query.date, query.partySize, { areaId: query.areaId });
  });

  defineRoute(app, { method: 'GET', url: '/api/v1/availability/tables', summary: 'Free and suggested tables at a given time', tags: ['Availability'], permission: 'reservations.read', query: z.object({ branchId: zId, date: zIsoDate, time: zTime, partySize: z.coerce.number().int().min(1).max(500), durationMinutes: z.coerce.number().int().min(15).max(720).optional(), excludeReservationId: zId.optional() }) }, async ({ query, ctx }) => {
    assertBranchAccess(ctx, query.branchId);
    const branch = await getBranch(db, query.branchId);
    const settings = reservationSettingsOf(branch);
    const start = businessToUtc(query.date, query.time, branch.timezone);
    const duration = query.durationMinutes ?? durationForParty(settings, query.partySize);
    const end = new Date(start.getTime() + (duration + settings.bufferMinutes) * 60_000);
    const data = await loadPickData(db, branch.id, start, end);
    const { isTableFree } = await import('@sofia/shared');
    const opts = { excludeReservationId: query.excludeReservationId };
    const tables = data.tables
      .filter((t) => t.isActive)
      .map((t) => ({ id: t.id, label: t.label, areaId: t.areaId, minCapacity: t.minCapacity, maxCapacity: t.maxCapacity, isVip: t.isVip, free: isTableFree(t, data.allocations, start.getTime(), end.getTime(), opts), fits: t.minCapacity <= query.partySize && query.partySize <= t.maxCapacity }));
    const suggestion = pickTables(data.tables, data.combos, data.allocations, start.getTime(), end.getTime(), query.partySize, opts);
    return { startAt: start.toISOString(), durationMinutes: duration, tables, suggestion, businessDate: businessDateOf(start, branch.timezone) };
  });
}
