import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  businessDateOf,
  durationForParty,
  pickTables,
  utcToZoned,
  waitlistCreateSchema,
  waitlistSeatSchema,
  waitlistUpdateSchema,
  walkInSchema,
  zId,
} from '@sofia/shared';
import { getDb, schema, type DbOrTx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { assertBranchAccess, branchScope, type RequestContext } from '../lib/context.js';
import { AppError, notFound, unprocessable } from '../lib/errors.js';
import { publish } from '../lib/events.js';
import { defineRoute, idParams } from '../lib/route.js';
import { createReservation, loadPickData, reservationView } from './reservations/service.js';
import { getBranch, reservationSettingsOf } from './venue.js';
import { queueGuestMessage } from './notifications/service.js';

type Entry = typeof schema.waitlistEntries.$inferSelect;

async function getEntry(tx: DbOrTx, id: string, forUpdate = false): Promise<Entry> {
  const base = tx.select().from(schema.waitlistEntries).where(eq(schema.waitlistEntries.id, id));
  const [e] = forUpdate ? await base.for('update') : await base;
  if (!e || e.deletedAt) throw notFound('Waitlist entry');
  return e;
}

export async function addToWaitlist(tx: DbOrTx, ctx: RequestContext, input: z.infer<typeof waitlistCreateSchema>): Promise<Entry> {
  if (input.id) {
    const [existing] = await tx.select().from(schema.waitlistEntries).where(eq(schema.waitlistEntries.id, input.id));
    if (existing) return existing;
  }
  assertBranchAccess(ctx, input.branchId);
  let isVip = input.isVip;
  if (input.guestId) {
    const [g] = await tx.select().from(schema.guests).where(eq(schema.guests.id, input.guestId));
    if (!g) throw unprocessable('invalid_guest', 'Guest not found');
    isVip = isVip || ['gold', 'platinum', 'vip', 'vvip'].includes(g.vipLevel);
  }
  const [e] = await tx
    .insert(schema.waitlistEntries)
    .values({
      ...input,
      isVip,
      desiredTime: input.desiredTime ? new Date(input.desiredTime) : null,
      createdBy: ctx.offlineUserId ?? ctx.user?.id ?? null,
      updatedBy: ctx.user?.id ?? null,
    })
    .returning();
  await audit(tx, ctx, { action: 'waitlist.add', entityType: 'waitlist', entityId: e!.id, branchId: e!.branchId, after: e });
  await publish({ type: 'changes', entities: ['waitlist'], branchId: e!.branchId }, tx);
  return e!;
}

export async function updateWaitlist(tx: DbOrTx, ctx: RequestContext, id: string, patch: z.infer<typeof waitlistUpdateSchema>): Promise<Entry> {
  const before = await getEntry(tx, id, true);
  assertBranchAccess(ctx, before.branchId);
  const [after] = await tx
    .update(schema.waitlistEntries)
    .set({ ...patch, desiredTime: patch.desiredTime === undefined ? undefined : patch.desiredTime ? new Date(patch.desiredTime) : null, updatedBy: ctx.user?.id ?? null })
    .where(eq(schema.waitlistEntries.id, id))
    .returning();
  await audit(tx, ctx, { action: 'waitlist.update', entityType: 'waitlist', entityId: id, branchId: before.branchId, before, after });
  await publish({ type: 'changes', entities: ['waitlist'], branchId: before.branchId }, tx);
  return after!;
}

export async function waitlistAction(
  tx: DbOrTx,
  ctx: RequestContext,
  id: string,
  action: 'notify' | 'seat' | 'cancel',
  input: Partial<z.infer<typeof waitlistSeatSchema>> = {},
) {
  const before = await getEntry(tx, id, true);
  assertBranchAccess(ctx, before.branchId);
  if (['seated', 'cancelled', 'expired'].includes(before.status)) {
    if ((action === 'seat' && before.status === 'seated') || (action === 'cancel' && before.status === 'cancelled')) return { entry: before, reservation: null };
    throw new AppError(409, 'invalid_transition', `Waitlist entry is already ${before.status}`);
  }
  let reservation = null;
  const set: Partial<Entry> = { updatedBy: ctx.user?.id ?? null };
  if (action === 'notify') {
    set.status = 'notified';
    set.notifiedAt = new Date();
    if (before.guestId) {
      const [g] = await tx.select().from(schema.guests).where(eq(schema.guests.id, before.guestId));
      if (g) await queueGuestMessage(tx, { guest: g, key: 'waitlist_ready', vars: {}, branchId: before.branchId, dedupeKey: `waitlist_ready:${id}:${Date.now()}` });
    }
  } else if (action === 'cancel') {
    set.status = 'cancelled';
    set.cancelledAt = new Date();
  } else {
    if (!input.tableIds?.length) throw unprocessable('tables_required', 'Select a table to seat the party');
    const branch = await getBranch(tx, before.branchId);
    const now = new Date();
    const local = utcToZoned(now, branch.timezone);
    const result = await createReservation(
      tx,
      ctx,
      {
        id: input.reservationId,
        branchId: before.branchId,
        guestId: before.guestId,
        guest: before.guestId ? undefined : { firstName: before.guestName, phone: before.phone, email: null },
        date: businessDateOf(now, branch.timezone),
        time: local.time,
        partySize: before.partySize,
        durationMinutes: input.durationMinutes,
        tableIds: input.tableIds,
        areaId: before.areaId,
        source: 'walk_in',
        notes: before.notes,
        autoAssignTable: false,
        overrideHours: false,
      },
      { origin: ctx.offlineUserId ? 'offline' : 'online', skipHoursCheck: true },
    );
    reservation = result.reservation;
    await tx.update(schema.reservations).set({ waitlistEntryId: id }).where(eq(schema.reservations.id, reservation.id));
    set.status = 'seated';
    set.seatedAt = now;
    set.reservationId = reservation.id;
  }
  const [after] = await tx.update(schema.waitlistEntries).set(set).where(eq(schema.waitlistEntries.id, id)).returning();
  await audit(tx, ctx, { action: `waitlist.${action}`, entityType: 'waitlist', entityId: id, branchId: before.branchId, before, after });
  await publish({ type: 'changes', entities: ['waitlist'], branchId: before.branchId }, tx);
  return { entry: after!, reservation };
}

/** Waiting parties that fit the given (just freed) table, VIPs and priority first. */
export async function waitlistSuggestions(tx: DbOrTx, branchId: string, tableId?: string) {
  const waiting = await tx
    .select()
    .from(schema.waitlistEntries)
    .where(and(eq(schema.waitlistEntries.branchId, branchId), inArray(schema.waitlistEntries.status, ['waiting', 'notified']), isNull(schema.waitlistEntries.deletedAt)))
    .orderBy(asc(schema.waitlistEntries.createdAt));
  const now = Date.now();
  let tables = await tx.select().from(schema.restaurantTables).where(and(eq(schema.restaurantTables.branchId, branchId), isNull(schema.restaurantTables.deletedAt)));
  if (tableId) tables = tables.filter((t) => t.id === tableId);
  const branch = await getBranch(tx, branchId);
  const settings = reservationSettingsOf(branch);
  const data = await loadPickData(tx, branchId, new Date(now), new Date(now + 6 * 3600_000));
  const ranked = waiting
    .filter((w) => !w.desiredTime || w.desiredTime.getTime() <= now + w.flexibleMinutes * 60_000)
    .sort((a, b) => Number(b.isVip) - Number(a.isVip) || b.priority - a.priority || a.createdAt.getTime() - b.createdAt.getTime());
  const out = [];
  for (const w of ranked) {
    const end = now + (durationForParty(settings, w.partySize) + settings.bufferMinutes) * 60_000;
    const pick = pickTables(tables, tableId ? [] : data.combos, data.allocations, now, end, w.partySize, { areaId: w.areaId, now });
    if (pick) out.push({ entry: w, tableIds: pick.tableIds, waitedMinutes: Math.round((now - w.createdAt.getTime()) / 60_000) });
  }
  return out;
}

/** Walk-in: seat now when a table is free, otherwise (optionally) add the party to the waitlist. */
export async function handleWalkIn(tx: DbOrTx, ctx: RequestContext, input: z.infer<typeof walkInSchema>) {
  assertBranchAccess(ctx, input.branchId);
  const branch = await getBranch(tx, input.branchId);
  const settings = reservationSettingsOf(branch);
  const now = new Date();
  let tableIds = input.tableIds ?? [];
  if (!tableIds.length) {
    const end = now.getTime() + ((input.durationMinutes ?? durationForParty(settings, input.partySize)) + settings.bufferMinutes) * 60_000;
    const data = await loadPickData(tx, branch.id, now, new Date(end));
    tableIds = pickTables(data.tables, data.combos, data.allocations, now.getTime(), end, input.partySize, { areaId: input.areaId, now: now.getTime() })?.tableIds ?? [];
  }
  if (!tableIds.length) {
    if (!input.waitIfNoTable) throw new AppError(409, 'no_table', 'No suitable table is free right now');
    const guestName = input.guest ? [input.guest.firstName, input.guest.lastName].filter(Boolean).join(' ') : 'Walk-in';
    const entry = await addToWaitlist(tx, ctx, {
      id: input.id,
      branchId: input.branchId,
      guestId: input.guestId ?? null,
      guestName,
      phone: input.guest?.phone ?? null,
      partySize: input.partySize,
      areaId: input.areaId ?? null,
      quotedWaitMinutes: input.quotedWaitMinutes ?? null,
      notes: input.notes ?? null,
      flexibleMinutes: 60,
      priority: 0,
      isVip: false,
    });
    return { seated: false as const, waitlistEntry: entry, reservation: null };
  }
  const local = utcToZoned(now, branch.timezone);
  const { reservation } = await createReservation(
    tx,
    ctx,
    {
      id: input.id,
      branchId: input.branchId,
      guestId: input.guestId ?? null,
      guest: input.guest,
      date: businessDateOf(now, branch.timezone),
      time: local.time,
      partySize: input.partySize,
      durationMinutes: input.durationMinutes,
      tableIds,
      areaId: input.areaId,
      source: 'walk_in',
      notes: input.notes,
      autoAssignTable: false,
      overrideHours: false,
    },
    { origin: ctx.offlineUserId ? 'offline' : 'online', skipHoursCheck: true },
  );
  if (input.posCheckRef) await tx.update(schema.reservations).set({ posCheckRef: input.posCheckRef }).where(eq(schema.reservations.id, reservation.id));
  return { seated: true as const, reservation, waitlistEntry: null };
}

export async function registerWaitlistRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  defineRoute(app, { method: 'GET', url: '/api/v1/waitlist', summary: 'Waitlist entries', tags: ['Waitlist'], permission: 'waitlist.read', query: z.object({ branchId: zId.optional(), status: z.string().max(100).optional() }) }, async ({ query, ctx }) => {
    if (query.branchId) assertBranchAccess(ctx, query.branchId);
    const scope = branchScope(ctx);
    const statuses = (query.status ?? 'waiting,notified').split(',');
    return db
      .select()
      .from(schema.waitlistEntries)
      .where(
        and(
          isNull(schema.waitlistEntries.deletedAt),
          inArray(schema.waitlistEntries.status, statuses),
          query.branchId ? eq(schema.waitlistEntries.branchId, query.branchId) : undefined,
          scope ? inArray(schema.waitlistEntries.branchId, scope.length ? scope : ['00000000-0000-0000-0000-000000000000']) : undefined,
        ),
      )
      .orderBy(asc(schema.waitlistEntries.createdAt));
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/waitlist', summary: 'Add a party to the waitlist', tags: ['Waitlist'], permission: 'waitlist.manage', body: waitlistCreateSchema }, async ({ body, ctx }) =>
    db.transaction((tx) => addToWaitlist(tx, ctx, body)),
  );

  defineRoute(app, { method: 'PATCH', url: '/api/v1/waitlist/:id', summary: 'Update a waitlist entry', tags: ['Waitlist'], permission: 'waitlist.manage', params: idParams, body: waitlistUpdateSchema }, async ({ params, body, ctx }) =>
    db.transaction((tx) => updateWaitlist(tx, ctx, params.id, body)),
  );

  defineRoute(app, { method: 'POST', url: '/api/v1/waitlist/:id/notify', summary: 'Notify the guest that the table is ready', tags: ['Waitlist'], permission: 'waitlist.manage', params: idParams }, async ({ params, ctx }) =>
    db.transaction((tx) => waitlistAction(tx, ctx, params.id, 'notify')),
  );

  defineRoute(app, { method: 'POST', url: '/api/v1/waitlist/:id/seat', summary: 'Seat a waiting party (creates a seated walk-in reservation)', tags: ['Waitlist'], permission: 'waitlist.manage', params: idParams, body: waitlistSeatSchema }, async ({ params, body, ctx }) => {
    const r = await db.transaction((tx) => waitlistAction(tx, ctx, params.id, 'seat', body));
    return { entry: r.entry, reservation: r.reservation ? reservationView(r.reservation) : null };
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/waitlist/:id/cancel', summary: 'Remove a party from the waitlist', tags: ['Waitlist'], permission: 'waitlist.manage', params: idParams }, async ({ params, ctx }) =>
    db.transaction((tx) => waitlistAction(tx, ctx, params.id, 'cancel')),
  );

  defineRoute(app, { method: 'GET', url: '/api/v1/waitlist/suggestions', summary: 'Suitable waiting parties for free tables', tags: ['Waitlist'], permission: 'waitlist.read', query: z.object({ branchId: zId, tableId: zId.optional() }) }, async ({ query, ctx }) => {
    assertBranchAccess(ctx, query.branchId);
    return waitlistSuggestions(db, query.branchId, query.tableId);
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/walk-ins', summary: 'Register a walk-in: seat now or add to the waitlist', tags: ['Waitlist'], permission: 'reservations.create', body: walkInSchema }, async ({ body, ctx }) => {
    const r = await db.transaction((tx) => handleWalkIn(tx, ctx, body));
    return { ...r, reservation: r.reservation ? reservationView(r.reservation) : null };
  });
}
