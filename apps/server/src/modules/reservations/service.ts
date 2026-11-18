import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  ACTIVE_RESERVATION_STATUSES,
  VIP_RANK,
  addDays,
  businessToUtc,
  canTransition,
  combinedCapacity,
  depositFor,
  durationForParty,
  generateReservationCode,
  isWithinOpeningHours,
  normalizePhone,
  pickTables,
  utcToZoned,
  type AllocationForPick,
  type ReservationAction,
  type ReservationCreateInput,
  type ReservationStatus,
  type ReservationUpdateInput,
  type VipLevel,
  type WeeklyHours,
} from '@sofia/shared';
import { pgArray, q, schema, sql, type DbOrTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { can, assertBranchAccess, type RequestContext } from '../../lib/context.js';
import { AppError, forbidden, isPgError, notFound, pgErrorOf, tableUnavailable, unprocessable } from '../../lib/errors.js';
import { publish } from '../../lib/events.js';
import { notifyStaff } from '../../lib/system-events.js';
import { createGuest, refreshGuestStats } from '../guests/service.js';
import { getBranch, getClosures, reservationSettingsOf } from '../venue.js';
import { queueReservationMessage } from '../notifications/service.js';

export type ReservationRow = typeof schema.reservations.$inferSelect;
type Branch = typeof schema.branches.$inferSelect;

export type ReservationOrigin = 'online' | 'offline' | 'public' | 'api' | 'pos';

export function reservationView(r: ReservationRow, timeZone?: string) {
  const { confirmationToken: _c, feedbackToken: _f, ...rest } = r;
  return { ...rest, time: timeZone ? utcToZoned(r.startAt, timeZone).time : undefined };
}

export async function getReservation(tx: DbOrTx, id: string, forUpdate = false): Promise<ReservationRow> {
  const base = tx.select().from(schema.reservations).where(eq(schema.reservations.id, id));
  const [r] = forUpdate ? await base.for('update') : await base;
  if (!r || r.deletedAt) throw notFound('Reservation');
  return r;
}

async function addEvent(
  tx: DbOrTx,
  ctx: RequestContext,
  reservationId: string,
  type: string,
  from: string | null,
  to: string | null,
  data: Record<string, unknown> = {},
) {
  await tx.insert(schema.reservationEvents).values({
    reservationId,
    type,
    fromStatus: from,
    toStatus: to,
    data,
    userId: ctx.offlineUserId ?? ctx.user?.id ?? null,
    deviceId: ctx.deviceId ?? null,
  });
}

// ---------------------------------------------------------------------------------------------------------
// Availability data
// ---------------------------------------------------------------------------------------------------------

export async function loadPickData(tx: DbOrTx, branchId: string, from: Date, to: Date) {
  const tables = await tx
    .select()
    .from(schema.restaurantTables)
    .where(and(eq(schema.restaurantTables.branchId, branchId), isNull(schema.restaurantTables.deletedAt)));
  const combos = await tx
    .select()
    .from(schema.tableCombinations)
    .where(and(eq(schema.tableCombinations.branchId, branchId), isNull(schema.tableCombinations.deletedAt)));
  const allocs = await q<{ table_id: string; reservation_id: string | null; lo: Date; hi: Date }>(
    tx,
    sql`SELECT table_id, reservation_id, lower(period) AS lo, upper(period) AS hi FROM table_allocations
        WHERE branch_id = ${branchId} AND active AND period && tstzrange(${from.toISOString()}::timestamptz, ${to.toISOString()}::timestamptz)`,
  );
  const allocations: AllocationForPick[] = allocs.map((a) => ({
    tableId: a.table_id,
    reservationId: a.reservation_id,
    start: new Date(a.lo).getTime(),
    end: new Date(a.hi).getTime(),
  }));
  return { tables, combos, allocations };
}

// ---------------------------------------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------------------------------------

interface TimeWindow {
  startAt: Date;
  endAt: Date;
  /** End including the turnover buffer — the period the table is held. */
  holdUntil: Date;
  duration: number;
}

function computeWindow(branch: Branch, date: string, time: string, partySize: number, duration?: number): TimeWindow {
  const settings = reservationSettingsOf(branch);
  const d = duration ?? durationForParty(settings, partySize);
  const startAt = businessToUtc(date, time, branch.timezone);
  const endAt = new Date(startAt.getTime() + d * 60_000);
  return { startAt, endAt, holdUntil: new Date(endAt.getTime() + settings.bufferMinutes * 60_000), duration: d };
}

async function assertOpen(tx: DbOrTx, ctx: RequestContext, branch: Branch, date: string, startAt: Date, override: boolean) {
  if (override) {
    if (!can(ctx, 'reservations.override')) throw forbidden('Booking outside opening hours requires the reservations.override permission');
    return;
  }
  const closures = await getClosures(tx, branch.id, addDays(date, -1), addDays(date, 1));
  if (!isWithinOpeningHours(startAt, date, branch.operatingHours as WeeklyHours, branch.timezone, closures)) {
    throw unprocessable('outside_hours', 'The restaurant is closed at the selected time');
  }
}

async function validateTables(tx: DbOrTx, ctx: RequestContext, branchId: string, tableIds: string[], partySize: number, override: boolean) {
  if (!tableIds.length) return;
  const tables = await tx.select().from(schema.restaurantTables).where(inArray(schema.restaurantTables.id, tableIds));
  if (tables.length !== new Set(tableIds).size || tables.some((t) => t.branchId !== branchId || t.deletedAt || !t.isActive)) {
    throw unprocessable('invalid_tables', 'One or more tables are not available in this branch');
  }
  const cap = combinedCapacity(tables);
  if (partySize > cap.max && !(override && can(ctx, 'reservations.override'))) {
    throw unprocessable('insufficient_capacity', `Selected tables seat at most ${cap.max} guests`, { capacity: cap.max });
  }
}

/** Insert table allocations inside a savepoint; the exclusion constraint rejects overlaps atomically. */
async function allocate(
  tx: DbOrTx,
  ctx: RequestContext,
  r: { id: string; branchId: string },
  tableIds: string[],
  from: Date,
  to: Date,
): Promise<void> {
  if (!tableIds.length) return;
  try {
    await tx.transaction(async (sp) => {
      for (const tableId of tableIds) {
        await sp.execute(sql`INSERT INTO table_allocations (reservation_id, table_id, branch_id, period, created_by)
                             VALUES (${r.id}, ${tableId}, ${r.branchId},
                                     tstzrange(${from.toISOString()}::timestamptz, ${to.toISOString()}::timestamptz, '[)'),
                                     ${ctx.user?.id ?? null})`);
      }
    });
  } catch (err) {
    if (isPgError(err, '23P01')) throw tableUnavailable({ tableIds });
    throw err;
  }
}

async function releaseAllocations(tx: DbOrTx, reservationId: string, at?: Date): Promise<string[]> {
  const rows = await q<{ table_id: string }>(
    tx,
    at
      ? sql`UPDATE table_allocations SET active = false, released_at = now(),
               period = CASE WHEN lower(period) < ${at.toISOString()}::timestamptz AND upper(period) > ${at.toISOString()}::timestamptz
                             THEN tstzrange(lower(period), ${at.toISOString()}::timestamptz, '[)') ELSE period END
            WHERE reservation_id = ${reservationId} AND active RETURNING table_id`
      : sql`UPDATE table_allocations SET active = false, released_at = now() WHERE reservation_id = ${reservationId} AND active RETURNING table_id`,
  );
  return rows.map((r) => r.table_id);
}

async function resolveGuest(tx: DbOrTx, ctx: RequestContext, input: Pick<ReservationCreateInput, 'guestId' | 'guest'>) {
  if (input.guestId) {
    const [g] = await tx.select().from(schema.guests).where(eq(schema.guests.id, input.guestId));
    if (!g || g.deletedAt) {
      if (g?.mergedIntoId) return (await tx.select().from(schema.guests).where(eq(schema.guests.id, g.mergedIntoId)))[0] ?? null;
      throw unprocessable('invalid_guest', 'Guest not found');
    }
    return g;
  }
  if (input.guest) {
    const phone = normalizePhone(input.guest.phone ?? null);
    if (phone) {
      const [existing] = await tx
        .select()
        .from(schema.guests)
        .where(and(eq(schema.guests.phoneNormalized, phone), isNull(schema.guests.deletedAt), isNull(schema.guests.mergedIntoId)));
      if (existing) return existing;
    }
    const { guest } = await createGuest(tx, ctx, { ...input.guest, source: 'reservation' });
    return guest;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------------------

export interface CreateOptions {
  origin: ReservationOrigin;
  /** Offline sync: keep the reservation without tables (flagged for review) instead of failing on overlap. */
  keepOnTableConflict?: boolean;
  clientCreatedAt?: Date;
  initialStatus?: ReservationStatus;
  skipHoursCheck?: boolean;
}

export interface CreateResult {
  reservation: ReservationRow;
  created: boolean;
  tableConflict?: { tableIds: string[]; message: string };
  depositRequired: number;
}

export async function createReservation(
  tx: DbOrTx,
  ctx: RequestContext,
  input: ReservationCreateInput,
  opts: CreateOptions,
): Promise<CreateResult> {
  if (input.id) {
    const [existing] = await tx.select().from(schema.reservations).where(eq(schema.reservations.id, input.id));
    if (existing) return { reservation: existing, created: false, depositRequired: 0 };
  }
  assertBranchAccess(ctx, input.branchId);
  const branch = await getBranch(tx, input.branchId);
  const settings = reservationSettingsOf(branch);
  const w = computeWindow(branch, input.date, input.time, input.partySize, input.durationMinutes);
  const isWalkIn = input.source === 'walk_in';

  if (!opts.skipHoursCheck && !isWalkIn) await assertOpen(tx, ctx, branch, input.date, w.startAt, input.overrideHours);
  if (opts.origin !== 'offline' && !isWalkIn && w.endAt.getTime() < Date.now() && !(input.overrideHours && can(ctx, 'reservations.override'))) {
    throw unprocessable('in_the_past', 'The selected time has already passed');
  }

  const guest = await resolveGuest(tx, ctx, input);
  let tableIds = [...new Set(input.tableIds ?? [])];
  await validateTables(tx, ctx, branch.id, tableIds, input.partySize, input.overrideHours);

  if (!tableIds.length && input.autoAssignTable) {
    const data = await loadPickData(tx, branch.id, w.startAt, w.holdUntil);
    const vipRank = guest ? VIP_RANK[guest.vipLevel as VipLevel] ?? 0 : 0;
    const pick = pickTables(data.tables, data.combos, data.allocations, w.startAt.getTime(), w.holdUntil.getTime(), input.partySize, {
      areaId: input.areaId,
      onlineOnly: opts.origin === 'public',
      allowVipTables: !(opts.origin === 'public' && settings.holdVipTablesForVip && vipRank < VIP_RANK.gold),
    });
    if (pick) tableIds = pick.tableIds;
    else if (opts.origin === 'public' && settings.requireTableForOnline) {
      throw new AppError(409, 'no_availability', 'No table is available at the selected time. Please choose another time.');
    }
  }

  const deposit = opts.origin === 'public' ? depositFor(settings, input.partySize) : input.depositAmount ?? 0;
  let status: ReservationStatus = opts.initialStatus ?? input.status ?? 'confirmed';
  if (opts.origin === 'public') status = deposit > 0 || !settings.autoConfirmOnline ? 'pending' : 'confirmed';
  if (isWalkIn) status = 'seated';

  let areaId = input.areaId ?? null;
  if (!areaId && tableIds.length) {
    const [t] = await tx.select({ areaId: schema.restaurantTables.areaId }).from(schema.restaurantTables).where(eq(schema.restaurantTables.id, tableIds[0]!));
    areaId = t?.areaId ?? null;
  }

  let inserted: ReservationRow | undefined;
  for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
    try {
      inserted = await tx.transaction(async (sp) => {
        const [row] = await sp
          .insert(schema.reservations)
          .values({
            id: input.id,
            code: generateReservationCode(),
            branchId: branch.id,
            guestId: guest?.id ?? null,
            guestName: guest ? [guest.firstName, guest.lastName].filter(Boolean).join(' ') : input.guest?.firstName ?? null,
            guestPhone: guest?.phone ?? input.guest?.phone ?? null,
            businessDate: input.date,
            startAt: w.startAt,
            endAt: w.endAt,
            durationMinutes: w.duration,
            partySize: input.partySize,
            areaId,
            tableIds,
            status,
            occasion: input.occasion ?? null,
            source: input.source,
            notes: input.notes ?? null,
            specialRequest: input.specialRequest ?? null,
            depositAmount: deposit || null,
            depositCurrency: deposit ? settings.deposit.currency : null,
            paymentStatus: deposit > 0 ? (input.paymentStatus ?? 'pending') : (input.paymentStatus ?? 'not_required'),
            assignedStaffId: input.assignedStaffId ?? null,
            origin: opts.origin,
            clientCreatedAt: opts.clientCreatedAt ?? null,
            checkedInAt: isWalkIn ? new Date() : null,
            seatedAt: isWalkIn ? new Date() : null,
            createdBy: ctx.offlineUserId ?? ctx.user?.id ?? null,
            updatedBy: ctx.user?.id ?? null,
          })
          .returning();
        return row;
      });
    } catch (err) {
      if (!(isPgError(err, '23505') && String(pgErrorOf(err)?.constraint).includes('code'))) throw err;
    }
  }
  if (!inserted) throw new Error('Could not allocate a reservation code');
  let reservation = inserted;

  let tableConflict: CreateResult['tableConflict'];
  const holdFrom = isWalkIn ? new Date(Math.min(Date.now(), w.startAt.getTime())) : w.startAt;
  try {
    await allocate(tx, ctx, reservation, tableIds, holdFrom, w.holdUntil);
  } catch (err) {
    if (!(err instanceof AppError && err.code === 'table_unavailable' && opts.keepOnTableConflict)) throw err;
    tableConflict = { tableIds, message: err.message };
    const [flagged] = await tx
      .update(schema.reservations)
      .set({
        tableIds: [],
        requiresReview: true,
        reviewReason: 'Created offline: the selected table was booked by another device for an overlapping time.',
      })
      .where(eq(schema.reservations.id, reservation.id))
      .returning();
    reservation = flagged!;
  }

  await addEvent(tx, ctx, reservation.id, isWalkIn ? 'walk_in' : 'created', null, reservation.status, {
    origin: opts.origin,
    tableIds: reservation.tableIds,
    tableConflict: tableConflict ?? null,
  });
  await audit(tx, ctx, {
    action: isWalkIn ? 'reservation.walk_in' : 'reservation.create',
    entityType: 'reservation',
    entityId: reservation.id,
    branchId: reservation.branchId,
    after: reservation,
    meta: { origin: opts.origin },
  });
  await refreshGuestStats(tx, reservation.guestId);
  if (reservation.status === 'confirmed' && !isWalkIn) await queueReservationMessage(tx, 'reservation_confirmation', reservation);
  await publish({ type: 'changes', entities: ['reservations', 'tables'], branchId: reservation.branchId }, tx);
  return { reservation, created: true, tableConflict, depositRequired: deposit };
}

// ---------------------------------------------------------------------------------------------------------
// Update / reallocate
// ---------------------------------------------------------------------------------------------------------

const TIME_FIELDS = ['date', 'time', 'partySize', 'durationMinutes', 'tableIds'] as const;

export async function updateReservation(
  tx: DbOrTx,
  ctx: RequestContext,
  id: string,
  patch: ReservationUpdateInput,
  opts: { expectedVersion?: number; origin?: ReservationOrigin } = {},
): Promise<ReservationRow> {
  const before = await getReservation(tx, id, true);
  assertBranchAccess(ctx, before.branchId);
  if (opts.expectedVersion !== undefined && opts.expectedVersion !== before.version) {
    throw new AppError(409, 'version_conflict', 'This reservation was changed by someone else. Reload and try again.', { currentVersion: before.version });
  }
  const branch = await getBranch(tx, before.branchId);
  const active = ACTIVE_RESERVATION_STATUSES.includes(before.status as ReservationStatus);
  const timeChanged = TIME_FIELDS.some((f) => patch[f] !== undefined);
  if (timeChanged && !active) throw unprocessable('not_editable', 'Only active reservations can be moved or re-seated');

  const set: Partial<ReservationRow> = { updatedBy: ctx.user?.id ?? null };
  const simple = ['occasion', 'source', 'notes', 'specialRequest', 'depositAmount', 'paymentStatus', 'assignedStaffId', 'areaId', 'posCheckRef'] as const;
  for (const f of simple) if (patch[f] !== undefined) (set as Record<string, unknown>)[f] = patch[f];

  if (patch.guestId !== undefined) {
    const g = patch.guestId ? await resolveGuest(tx, ctx, { guestId: patch.guestId }) : null;
    set.guestId = g?.id ?? null;
    set.guestName = g ? [g.firstName, g.lastName].filter(Boolean).join(' ') : before.guestName;
    set.guestPhone = g?.phone ?? before.guestPhone;
  }

  if (timeChanged) {
    const date = patch.date ?? before.businessDate;
    const time = patch.time ?? utcToZoned(before.startAt, branch.timezone).time;
    const partySize = patch.partySize ?? before.partySize;
    const durationChangedExplicitly = patch.durationMinutes !== undefined;
    const w = computeWindow(branch, date, time, partySize, durationChangedExplicitly ? patch.durationMinutes : patch.partySize !== undefined ? undefined : before.durationMinutes);
    const moved = w.startAt.getTime() !== before.startAt.getTime();
    if (moved && ['pending', 'confirmed'].includes(before.status)) await assertOpen(tx, ctx, branch, date, w.startAt, patch.overrideHours ?? false);
    const tableIds = patch.tableIds ? [...new Set(patch.tableIds)] : before.tableIds;
    await validateTables(tx, ctx, branch.id, tableIds, partySize, patch.overrideHours ?? false);
    const seatedAlready = ['seated', 'dining'].includes(before.status);
    const holdFrom = seatedAlready ? new Date(Math.min(Date.now(), w.startAt.getTime())) : w.startAt;
    await releaseAllocations(tx, id);
    await allocate(tx, ctx, before, tableIds, holdFrom, w.holdUntil);
    Object.assign(set, {
      businessDate: date,
      startAt: w.startAt,
      endAt: w.endAt,
      durationMinutes: w.duration,
      partySize,
      tableIds,
      requiresReview: tableIds.length ? false : before.requiresReview,
      reviewReason: tableIds.length ? null : before.reviewReason,
    });
    if (tableIds.length && !set.areaId && !before.areaId) {
      const [t] = await tx.select({ areaId: schema.restaurantTables.areaId }).from(schema.restaurantTables).where(eq(schema.restaurantTables.id, tableIds[0]!));
      set.areaId = t?.areaId ?? null;
    }
  }

  const [after] = await tx.update(schema.reservations).set(set).where(eq(schema.reservations.id, id)).returning();
  await addEvent(tx, ctx, id, 'updated', before.status, after!.status, { fields: Object.keys(patch) });
  await audit(tx, ctx, { action: 'reservation.update', entityType: 'reservation', entityId: id, branchId: before.branchId, before, after });
  if (before.guestId !== after!.guestId) {
    await refreshGuestStats(tx, before.guestId);
    await refreshGuestStats(tx, after!.guestId);
  }
  await publish({ type: 'changes', entities: ['reservations', 'tables'], branchId: before.branchId }, tx);
  return after!;
}

// ---------------------------------------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------------------------------------

const ACTION_TARGET: Record<Exclude<ReservationAction, 'assign_tables'>, ReservationStatus> = {
  confirm: 'confirmed',
  check_in: 'checked_in',
  seat: 'seated',
  start_dining: 'dining',
  complete: 'completed',
  cancel: 'cancelled',
  no_show: 'no_show',
};

const ACTION_PERMISSION: Record<ReservationAction, Parameters<typeof can>[1]> = {
  confirm: 'reservations.update',
  check_in: 'checkin.manage',
  seat: 'checkin.manage',
  start_dining: 'checkin.manage',
  complete: 'checkin.manage',
  cancel: 'reservations.cancel',
  no_show: 'checkin.manage',
  assign_tables: 'reservations.update',
};

export function permissionForAction(action: ReservationAction) {
  return ACTION_PERMISSION[action];
}

export async function transitionReservation(
  tx: DbOrTx,
  ctx: RequestContext,
  id: string,
  action: ReservationAction,
  input: { reason?: string | null; tableIds?: string[]; at?: string },
): Promise<ReservationRow> {
  if (!can(ctx, ACTION_PERMISSION[action])) throw forbidden(`Missing permission: ${ACTION_PERMISSION[action]}`);
  if (action === 'assign_tables') {
    return updateReservation(tx, ctx, id, { tableIds: input.tableIds ?? [] });
  }
  const before = await getReservation(tx, id, true);
  assertBranchAccess(ctx, before.branchId);
  const target = ACTION_TARGET[action];
  if (before.status === target) return before;
  if (!canTransition(before.status as ReservationStatus, target)) {
    throw new AppError(409, 'invalid_transition', `Cannot change a ${before.status} reservation to ${target}`, { from: before.status, to: target });
  }
  const at = input.at ? new Date(input.at) : new Date();
  const branch = await getBranch(tx, before.branchId);
  const settings = reservationSettingsOf(branch);
  const set: Partial<ReservationRow> = { status: target, updatedBy: ctx.user?.id ?? null };
  let freed: string[] = [];

  switch (target) {
    case 'confirmed':
      if (before.status === 'cancelled' || before.status === 'no_show') {
        await allocate(tx, ctx, before, before.tableIds, before.startAt, new Date(before.endAt.getTime() + settings.bufferMinutes * 60_000));
      }
      break;
    case 'checked_in':
      set.checkedInAt = at;
      if (before.status === 'no_show') {
        await allocate(tx, ctx, before, before.tableIds, at, new Date(before.endAt.getTime() + settings.bufferMinutes * 60_000));
        set.noShowAt = null;
      }
      break;
    case 'seated': {
      set.seatedAt = at;
      set.checkedInAt = before.checkedInAt ?? at;
      const tableIds = input.tableIds?.length ? [...new Set(input.tableIds)] : before.tableIds;
      await validateTables(tx, ctx, before.branchId, tableIds, before.partySize, true);
      // Early arrival: the party occupies the table(s) from now for the normal duration. The database rejects
      // the seating if the table is still in use. Late or on-time arrivals keep their booked slot.
      const early = at.getTime() < before.startAt.getTime();
      const tablesChanged = tableIds.join() !== before.tableIds.join();
      const from = early ? at : before.startAt;
      const end = early ? new Date(at.getTime() + before.durationMinutes * 60_000) : before.endAt;
      const activeAllocs = await q(tx, sql`SELECT 1 FROM table_allocations WHERE reservation_id = ${id} AND active`);
      if (early || tablesChanged || activeAllocs.length !== tableIds.length) {
        await releaseAllocations(tx, id);
        await allocate(tx, ctx, before, tableIds, from, new Date(end.getTime() + settings.bufferMinutes * 60_000));
      }
      set.tableIds = tableIds;
      if (early) set.startAt = at;
      set.endAt = end;
      set.requiresReview = tableIds.length ? false : before.requiresReview;
      break;
    }
    case 'dining':
      set.diningAt = at;
      break;
    case 'completed':
      set.completedAt = at;
      freed = await releaseAllocations(tx, id, at);
      if (settings.markCleaningAfterComplete && freed.length) {
        await tx
          .update(schema.restaurantTables)
          .set({ manualStatus: 'cleaning', manualStatusAt: at, manualStatusUntil: new Date(at.getTime() + settings.bufferMinutes * 60_000), manualStatusReason: 'Turnover after service' })
          .where(inArray(schema.restaurantTables.id, freed));
      }
      break;
    case 'cancelled':
      set.cancelledAt = at;
      set.cancelReason = input.reason ?? null;
      freed = await releaseAllocations(tx, id);
      break;
    case 'no_show':
      set.noShowAt = at;
      freed = await releaseAllocations(tx, id);
      break;
    default:
      break;
  }

  const [after] = await tx.update(schema.reservations).set(set).where(eq(schema.reservations.id, id)).returning();
  await addEvent(tx, ctx, id, action, before.status, target, {
    reason: input.reason ?? null,
    tableIds: after!.tableIds,
    ...(after!.startAt.getTime() !== before.startAt.getTime() ? { bookedStartAt: before.startAt.toISOString(), early: true } : {}),
  });
  await audit(tx, ctx, { action: `reservation.${action}`, entityType: 'reservation', entityId: id, branchId: before.branchId, before, after });
  await refreshGuestStats(tx, after!.guestId);

  if (target === 'confirmed') await queueReservationMessage(tx, 'reservation_confirmation', after!);
  if (target === 'cancelled') await queueReservationMessage(tx, 'reservation_cancelled', after!);
  if ((target === 'checked_in' || target === 'seated') && !before.checkedInAt && after!.guestId) {
    const [g] = await tx.select().from(schema.guests).where(eq(schema.guests.id, after!.guestId));
    if (g && VIP_RANK[g.vipLevel as VipLevel] >= VIP_RANK.gold) {
      await notifyStaff(
        {
          type: 'vip_arrival',
          title: `VIP arrival: ${[g.firstName, g.lastName].filter(Boolean).join(' ')} (${g.vipLevel.toUpperCase()})`,
          body: `Party of ${after!.partySize} · ${after!.code}${after!.occasion ? ` · ${after!.occasion}` : ''}`,
          severity: 'warning',
          branchId: after!.branchId,
          permission: 'reservations.read',
          data: { reservationId: id, guestId: g.id },
        },
        tx,
      );
    }
  }
  if (freed.length) await publish({ type: 'table_freed', branchId: before.branchId, tableIds: freed }, tx);
  await publish({ type: 'changes', entities: ['reservations', 'tables'], branchId: before.branchId }, tx);
  return after!;
}

// ---------------------------------------------------------------------------------------------------------
// Reschedule (old reservation → status "rescheduled", new reservation linked to it)
// ---------------------------------------------------------------------------------------------------------

export async function rescheduleReservation(
  tx: DbOrTx,
  ctx: RequestContext,
  id: string,
  input: { newId?: string; date: string; time: string; partySize?: number; tableIds?: string[]; autoAssignTable?: boolean; reason?: string | null },
) {
  const before = await getReservation(tx, id, true);
  assertBranchAccess(ctx, before.branchId);
  if (!canTransition(before.status as ReservationStatus, 'rescheduled')) {
    throw new AppError(409, 'invalid_transition', `Cannot reschedule a ${before.status} reservation`);
  }
  await releaseAllocations(tx, id);
  const { reservation: next } = await createReservation(
    tx,
    ctx,
    {
      id: input.newId,
      branchId: before.branchId,
      guestId: before.guestId,
      date: input.date,
      time: input.time,
      partySize: input.partySize ?? before.partySize,
      tableIds: input.tableIds,
      autoAssignTable: input.autoAssignTable ?? !input.tableIds?.length,
      areaId: before.areaId,
      occasion: before.occasion as ReservationCreateInput['occasion'],
      source: before.source as ReservationCreateInput['source'],
      notes: before.notes,
      specialRequest: before.specialRequest,
      depositAmount: before.depositAmount,
      paymentStatus: before.paymentStatus as ReservationCreateInput['paymentStatus'],
      status: before.status === 'pending' ? 'pending' : 'confirmed',
      overrideHours: false,
    },
    { origin: 'online', initialStatus: before.status === 'pending' ? 'pending' : 'confirmed' },
  );
  await tx.update(schema.reservations).set({ rescheduledFromId: id }).where(eq(schema.reservations.id, next.id));
  const [old] = await tx
    .update(schema.reservations)
    .set({ status: 'rescheduled', rescheduledToId: next.id, updatedBy: ctx.user?.id ?? null })
    .where(eq(schema.reservations.id, id))
    .returning();
  await addEvent(tx, ctx, id, 'rescheduled', before.status, 'rescheduled', { newReservationId: next.id, reason: input.reason ?? null });
  await audit(tx, ctx, { action: 'reservation.reschedule', entityType: 'reservation', entityId: id, branchId: before.branchId, before, after: old, meta: { newReservationId: next.id } });
  const [fresh] = await tx.select().from(schema.reservations).where(eq(schema.reservations.id, next.id));
  await queueReservationMessage(tx, 'reservation_rescheduled', fresh!);
  await publish({ type: 'changes', entities: ['reservations', 'tables'], branchId: before.branchId }, tx);
  return { previous: old!, reservation: fresh! };
}

export async function reservationEvents(tx: DbOrTx, id: string) {
  return q(
    tx,
    sql`SELECT e.id, e.type, e.from_status AS "fromStatus", e.to_status AS "toStatus", e.data, e.at, e.device_id AS "deviceId",
               u.display_name AS "userName"
        FROM reservation_events e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.reservation_id = ${id} ORDER BY e.at`,
  );
}

export { pgArray };
