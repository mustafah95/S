import { and, eq, gt, isNull, lte, sql as dsql } from 'drizzle-orm';
import { z } from 'zod';
import {
  GUEST_CRITICAL_FIELDS,
  GUEST_SET_FIELDS,
  GUEST_TEXT_FIELDS,
  RESERVATION_STRICT_FIELDS,
  addDays,
  businessDateOf,
  guestCreateSchema,
  guestNoteSchema,
  guestUpdateSchema,
  isWithinOpeningHours,
  jsonEqual,
  mergeSet,
  reservationActionSchema,
  reservationCreateSchema,
  reservationUpdateSchema,
  tableStatusSchema,
  utcToZoned,
  waitlistCreateSchema,
  waitlistSeatSchema,
  waitlistUpdateSchema,
  type SyncOpResult,
  type SyncOperation,
  type SyncPullEntity,
  type WeeklyHours,
} from '@sofia/shared';
import { getDb, q, q1, schema, sql, type DbOrTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { branchScope, can, type RequestContext } from '../../lib/context.js';
import { AppError, forbidden, fromPgError } from '../../lib/errors.js';
import { publish } from '../../lib/events.js';
import { logEvent, notifyStaff } from '../../lib/system-events.js';
import { getSetting } from '../../lib/settings.js';
import { addGuestNote, createGuest, getGuest, guestView, updateGuest } from '../guests/service.js';
import {
  createReservation,
  getReservation,
  permissionForAction,
  reservationView,
  transitionReservation,
  updateReservation,
} from '../reservations/service.js';
import { getBranch, getClosures, setTableStatus } from '../venue.js';
import { addToWaitlist, updateWaitlist, waitlistAction } from '../waitlist.js';

type Conflict = {
  kind: 'version_conflict' | 'reservation_overlap' | 'invalid_transition' | 'validation' | 'duplicate_guest';
  summary: string;
  branchId?: string | null;
  serverSnapshot?: unknown;
  fieldConflicts?: unknown;
};

interface ApplyOutcome {
  status: 'applied' | 'conflict';
  entity: Record<string, unknown> | null;
  conflict?: Conflict;
  mergedFields?: string[];
  conflictingFields?: string[];
  message?: string;
}

function need(ctx: RequestContext, permission: Parameters<typeof can>[1]): void {
  if (!can(ctx, permission)) throw forbidden(`Missing permission: ${permission}`);
}

async function createConflictRecord(tx: DbOrTx, ctx: RequestContext, op: SyncOperation, c: Conflict): Promise<string> {
  const [row] = await q<{ id: string }>(
    tx,
    sql`INSERT INTO sync_conflicts (operation_id, entity_type, entity_id, branch_id, kind, summary, client_payload, server_snapshot,
                                    field_conflicts, device_id, user_id)
        VALUES (${op.opId}, ${op.entityType}, ${op.entityId}, ${c.branchId ?? null}, ${c.kind}, ${c.summary},
                ${JSON.stringify(op.payload)}::jsonb, ${JSON.stringify(c.serverSnapshot ?? null)}::jsonb,
                ${JSON.stringify(c.fieldConflicts ?? null)}::jsonb, ${ctx.deviceId ?? null}, ${op.userId})
        RETURNING id`,
  );
  await notifyStaff(
    {
      type: c.kind === 'duplicate_guest' ? 'duplicate_guest' : 'sync_conflict',
      title: c.kind === 'duplicate_guest' ? 'Possible duplicate guest created offline' : 'Synchronisation conflict needs review',
      body: c.summary,
      severity: c.kind === 'duplicate_guest' ? 'info' : 'warning',
      branchId: c.branchId ?? null,
      permission: c.kind === 'duplicate_guest' ? 'guests.merge' : 'sync.review',
      data: { conflictId: row!.id, entityType: op.entityType, entityId: op.entityId },
    },
    tx,
  );
  return row!.id;
}

// ---------------------------------------------------------------------------------------------------------
// Guests — three-way field merge
// ---------------------------------------------------------------------------------------------------------

async function applyGuestOp(tx: DbOrTx, ctx: RequestContext, op: SyncOperation): Promise<ApplyOutcome> {
  if (op.op === 'create') {
    need(ctx, 'guests.create');
    const input = guestCreateSchema.parse({ ...op.payload, id: op.entityId });
    const r = await createGuest(tx, ctx, input, { action: 'guest.create_offline' });
    const strong = r.duplicates.filter((d) => d.reasons.includes('phone') || d.reasons.includes('email'));
    if (r.created && strong.length) {
      return {
        status: 'applied',
        entity: guestView(r.guest),
        message: 'Saved. A guest with the same phone or e-mail already exists — flagged for merge review.',
        conflict: {
          kind: 'duplicate_guest',
          summary: `Guest "${r.guest.firstName} ${r.guest.lastName ?? ''}" created offline matches ${strong.length} existing profile(s) by ${strong[0]!.reasons.join('/')}.`,
          serverSnapshot: { candidates: strong },
        },
      };
    }
    return { status: 'applied', entity: guestView(r.guest) };
  }
  if (op.op === 'update') {
    need(ctx, 'guests.update');
    const patch = guestUpdateSchema.parse(op.payload);
    const server = await getGuest(tx, op.entityId, { forUpdate: true });
    if (op.baseVersion === undefined || op.baseVersion === server.version) {
      const after = await updateGuest(tx, ctx, op.entityId, patch, { action: 'guest.update_offline' });
      return { status: 'applied', entity: guestView(after), mergedFields: Object.keys(patch) };
    }
    const apply: Record<string, unknown> = {};
    const conflicts: { field: string; base: unknown; client: unknown; server: unknown }[] = [];
    const preservedText: string[] = [];
    const base = op.baseValues ?? {};
    const serverRec = server as unknown as Record<string, unknown>;
    const clientNewer = new Date(op.clientTs).getTime() > server.updatedAt.getTime();
    for (const [field, clientValue] of Object.entries(patch)) {
      const current = serverRec[field] instanceof Date ? (serverRec[field] as Date).toISOString() : serverRec[field];
      if (jsonEqual(current, clientValue)) continue;
      if (GUEST_SET_FIELDS.includes(field)) {
        apply[field] = mergeSet((base[field] as string[]) ?? [], (clientValue as string[]) ?? [], (current as string[]) ?? []);
      } else if (field in base && jsonEqual(current, base[field])) {
        apply[field] = clientValue;
      } else if (GUEST_CRITICAL_FIELDS.includes(field)) {
        conflicts.push({ field, base: base[field], client: clientValue, server: current });
      } else if (GUEST_TEXT_FIELDS.includes(field)) {
        if (clientValue) preservedText.push(String(clientValue));
      } else if (clientNewer) {
        apply[field] = clientValue;
      }
    }
    const after = Object.keys(apply).length
      ? await updateGuest(tx, ctx, op.entityId, apply as z.infer<typeof guestUpdateSchema>, { action: 'guest.merge_offline' })
      : server;
    for (const text of preservedText) {
      await addGuestNote(tx, ctx, {
        guestId: op.entityId,
        body: `Offline edit preserved (device ${ctx.deviceId?.slice(0, 8) ?? '?'}, ${op.clientTs}):\n${text}`,
        kind: 'offline_merge',
      });
    }
    if (conflicts.length) {
      return {
        status: 'conflict',
        entity: guestView(after),
        mergedFields: Object.keys(apply),
        conflictingFields: conflicts.map((c) => c.field),
        conflict: {
          kind: 'version_conflict',
          summary: `Guest ${server.firstName} ${server.lastName ?? ''}: ${conflicts.map((c) => c.field).join(', ')} changed on another device while this device was offline.`,
          serverSnapshot: guestView(server),
          fieldConflicts: conflicts,
        },
      };
    }
    return { status: 'applied', entity: guestView(after), mergedFields: Object.keys(apply) };
  }
  throw new AppError(422, 'unsupported_operation', `Operation ${op.op} is not supported for guests while offline`);
}

// ---------------------------------------------------------------------------------------------------------
// Reservations — strict validation
// ---------------------------------------------------------------------------------------------------------

async function reservationApi(tx: DbOrTx, id: string) {
  const r = await getReservation(tx, id);
  const b = await getBranch(tx, r.branchId);
  return reservationView(r, b.timezone) as unknown as Record<string, unknown>;
}

async function applyReservationOp(tx: DbOrTx, ctx: RequestContext, op: SyncOperation): Promise<ApplyOutcome> {
  if (op.op === 'create') {
    need(ctx, 'reservations.create');
    const input = reservationCreateSchema.parse({ ...op.payload, id: op.entityId });
    const result = await createReservation(tx, ctx, input, {
      origin: 'offline',
      keepOnTableConflict: true,
      clientCreatedAt: new Date(op.clientTs),
      skipHoursCheck: true,
    });
    if (!result.created) return { status: 'applied', entity: await reservationApi(tx, op.entityId), message: 'Already synchronised' };
    let r = result.reservation;
    const branch = await getBranch(tx, r.branchId);
    if (result.tableConflict) {
      return {
        status: 'conflict',
        entity: await reservationApi(tx, r.id),
        message: 'Saved, but the table was booked by another device. A manager must assign another table/time.',
        conflict: {
          kind: 'reservation_overlap',
          branchId: r.branchId,
          summary: `Offline reservation ${r.code} (${r.guestName ?? 'guest'}, ${r.partySize} pax, ${r.businessDate} ${utcToZoned(r.startAt, branch.timezone).time}) overlaps an existing booking of the requested table.`,
          serverSnapshot: { requestedTableIds: result.tableConflict.tableIds },
        },
      };
    }
    if (input.source !== 'walk_in') {
      const closures = await getClosures(tx, branch.id, addDays(input.date, -1), addDays(input.date, 1));
      if (!isWithinOpeningHours(r.startAt, input.date, branch.operatingHours as WeeklyHours, branch.timezone, closures) && !input.overrideHours) {
        const [flagged] = await tx
          .update(schema.reservations)
          .set({ requiresReview: true, reviewReason: 'Created offline outside opening hours' })
          .where(eq(schema.reservations.id, r.id))
          .returning();
        r = flagged!;
        return {
          status: 'conflict',
          entity: await reservationApi(tx, r.id),
          conflict: { kind: 'validation', branchId: r.branchId, summary: `Offline reservation ${r.code} is outside opening hours.` },
        };
      }
    }
    return { status: 'applied', entity: await reservationApi(tx, r.id) };
  }

  if (op.op === 'update') {
    need(ctx, 'reservations.update');
    const patch = reservationUpdateSchema.parse(op.payload);
    const server = await getReservation(tx, op.entityId, true);
    const branch = await getBranch(tx, server.branchId);
    const serverApi: Record<string, unknown> = {
      date: server.businessDate,
      time: utcToZoned(server.startAt, branch.timezone).time,
      partySize: server.partySize,
      durationMinutes: server.durationMinutes,
      tableIds: server.tableIds,
      branchId: server.branchId,
    };
    const strictTouched = Object.keys(patch).filter((k) => RESERVATION_STRICT_FIELDS.includes(k));
    const base = op.baseValues ?? {};
    const changedOnServer =
      op.baseVersion !== undefined &&
      op.baseVersion !== server.version &&
      strictTouched.some((f) => f in base && !jsonEqual(serverApi[f], base[f]) && !jsonEqual(serverApi[f], (patch as Record<string, unknown>)[f]));
    if (changedOnServer) {
      const safe = Object.fromEntries(Object.entries(patch).filter(([k]) => !RESERVATION_STRICT_FIELDS.includes(k)));
      if (Object.keys(safe).length) await updateReservation(tx, ctx, op.entityId, safe);
      return {
        status: 'conflict',
        entity: await reservationApi(tx, op.entityId),
        conflictingFields: strictTouched,
        conflict: {
          kind: 'version_conflict',
          branchId: server.branchId,
          summary: `Reservation ${server.code}: time/party/table was changed on another device while this device was offline.`,
          serverSnapshot: serverApi,
          fieldConflicts: strictTouched.map((f) => ({ field: f, base: base[f], client: (patch as Record<string, unknown>)[f], server: serverApi[f] })),
        },
      };
    }
    try {
      await updateReservation(tx, ctx, op.entityId, patch);
    } catch (err) {
      if (err instanceof AppError && err.code === 'table_unavailable') {
        return {
          status: 'conflict',
          entity: await reservationApi(tx, op.entityId),
          conflict: { kind: 'reservation_overlap', branchId: server.branchId, summary: `Reservation ${server.code}: the new table/time is no longer available.`, serverSnapshot: serverApi },
        };
      }
      throw err;
    }
    return { status: 'applied', entity: await reservationApi(tx, op.entityId) };
  }

  if (op.op === 'action') {
    const input = reservationActionSchema.parse({ ...op.payload, action: op.action ?? op.payload.action });
    need(ctx, permissionForAction(input.action));
    const server = await getReservation(tx, op.entityId);
    try {
      await transitionReservation(tx, ctx, op.entityId, input.action, { reason: input.reason, tableIds: input.tableIds, at: input.at ?? op.clientTs });
    } catch (err) {
      if (err instanceof AppError && (err.code === 'invalid_transition' || err.code === 'table_unavailable')) {
        return {
          status: 'conflict',
          entity: await reservationApi(tx, op.entityId),
          conflict: {
            kind: err.code === 'invalid_transition' ? 'invalid_transition' : 'reservation_overlap',
            branchId: server.branchId,
            summary: `Reservation ${server.code}: offline action "${input.action}" could not be applied (${err.message}).`,
            serverSnapshot: { status: server.status },
          },
        };
      }
      throw err;
    }
    return { status: 'applied', entity: await reservationApi(tx, op.entityId) };
  }
  throw new AppError(422, 'unsupported_operation', `Operation ${op.op} is not supported for reservations`);
}

// ---------------------------------------------------------------------------------------------------------

async function applyOp(tx: DbOrTx, ctx: RequestContext, op: SyncOperation): Promise<ApplyOutcome> {
  switch (op.entityType) {
    case 'guest':
      return applyGuestOp(tx, ctx, op);
    case 'guest_note': {
      need(ctx, 'guests.update');
      const input = guestNoteSchema.parse({ ...op.payload, id: op.entityId });
      return { status: 'applied', entity: (await addGuestNote(tx, ctx, input)) as unknown as Record<string, unknown> };
    }
    case 'reservation':
      return applyReservationOp(tx, ctx, op);
    case 'waitlist': {
      need(ctx, 'waitlist.manage');
      if (op.op === 'create') {
        const e = await addToWaitlist(tx, ctx, waitlistCreateSchema.parse({ ...op.payload, id: op.entityId }));
        return { status: 'applied', entity: e as unknown as Record<string, unknown> };
      }
      if (op.op === 'update') {
        const e = await updateWaitlist(tx, ctx, op.entityId, waitlistUpdateSchema.parse(op.payload));
        return { status: 'applied', entity: e as unknown as Record<string, unknown> };
      }
      const action = z.enum(['notify', 'seat', 'cancel']).parse(op.action);
      const seat = action === 'seat' ? waitlistSeatSchema.parse(op.payload) : undefined;
      try {
        const r = await waitlistAction(tx, ctx, op.entityId, action, seat);
        return { status: 'applied', entity: r.entry as unknown as Record<string, unknown> };
      } catch (err) {
        if (err instanceof AppError && (err.code === 'table_unavailable' || err.code === 'invalid_transition')) {
          const [e] = await tx.select().from(schema.waitlistEntries).where(eq(schema.waitlistEntries.id, op.entityId));
          return {
            status: 'conflict',
            entity: (e ?? null) as unknown as Record<string, unknown>,
            conflict: { kind: err.code === 'table_unavailable' ? 'reservation_overlap' : 'invalid_transition', branchId: e?.branchId, summary: `Waitlist ${action} for ${e?.guestName ?? 'guest'} failed: ${err.message}` },
          };
        }
        throw err;
      }
    }
    case 'table': {
      need(ctx, 'tables.status');
      if (op.action !== 'set_status') throw new AppError(422, 'unsupported_operation', 'Only table status changes can be made offline');
      const t = await setTableStatus(tx, ctx, op.entityId, tableStatusSchema.parse(op.payload));
      return { status: 'applied', entity: t as unknown as Record<string, unknown> };
    }
    default:
      throw new AppError(422, 'unsupported_entity', 'Unsupported entity');
  }
}

/** Process a batch of offline operations in order. Each operation commits independently. */
export async function processPush(ctx: RequestContext, deviceId: string, ops: SyncOperation[]): Promise<SyncOpResult[]> {
  const db = getDb();
  const results: SyncOpResult[] = [];
  await touchDevice(ctx, deviceId, true);
  for (const op of ops) {
    const base = { opId: op.opId, entityType: op.entityType, entityId: op.entityId };
    const prior = await q1<{ status: string; result: SyncOpResult | null; conflict_id: string | null }>(
      db,
      sql`SELECT status, result, conflict_id FROM sync_operations WHERE id = ${op.opId}`,
    );
    if (prior) {
      results.push({ ...(prior.result ?? base), ...base, status: 'duplicate', conflictId: prior.conflict_id ?? undefined } as SyncOpResult);
      continue;
    }
    const opCtx: RequestContext = {
      ...ctx,
      deviceId,
      offlineUserId: op.userId !== ctx.user?.id ? op.userId : undefined,
    };
    let result: SyncOpResult;
    try {
      result = await db.transaction(async (tx) => {
        const outcome = await applyOp(tx, opCtx, op);
        let conflictId: string | undefined;
        if (outcome.conflict) conflictId = await createConflictRecord(tx, opCtx, op, outcome.conflict);
        const r: SyncOpResult = {
          ...base,
          status: outcome.status,
          entity: outcome.entity,
          conflictId,
          mergedFields: outcome.mergedFields,
          conflictingFields: outcome.conflictingFields,
          message: outcome.message,
        };
        await recordOp(tx, ctx, deviceId, op, outcome.status, r, conflictId);
        return r;
      });
    } catch (err) {
      const e = err instanceof AppError ? err : fromPgError(err);
      if (!e || e.status >= 500) {
        await logEvent('error', 'sync', `Sync operation failed (will retry): ${(err as Error).message}`, { opId: op.opId, entityType: op.entityType });
        results.push({ ...base, status: 'retry', error: { code: 'server_error', message: 'Temporary server error — will retry automatically' } });
        break;
      }
      result = { ...base, status: 'rejected', error: { code: e.code, message: e.message } };
      await recordOp(db, ctx, deviceId, op, 'rejected', result);
      await logEvent('warn', 'sync', `Offline operation rejected: ${e.message}`, { opId: op.opId, entityType: op.entityType, entityId: op.entityId, code: e.code });
    }
    results.push(result);
  }
  return results;
}

async function recordOp(tx: DbOrTx, ctx: RequestContext, deviceId: string, op: SyncOperation, status: string, result: SyncOpResult, conflictId?: string) {
  const { entity: _e, ...stored } = result;
  await tx.execute(sql`INSERT INTO sync_operations (id, device_id, user_id, session_user_id, entity_type, entity_id, operation, action,
                                                    payload, base_version, client_ts, status, result, conflict_id)
                       VALUES (${op.opId}, ${deviceId}, ${op.userId}, ${ctx.user!.id}, ${op.entityType}, ${op.entityId}, ${op.op},
                               ${op.action ?? null}, ${JSON.stringify(op.payload)}::jsonb, ${op.baseVersion ?? null}, ${op.clientTs},
                               ${status}, ${JSON.stringify(stored)}::jsonb, ${conflictId ?? null})
                       ON CONFLICT (id) DO NOTHING`);
}

export async function touchDevice(ctx: RequestContext, deviceId: string, synced: boolean, clientVersion?: string): Promise<void> {
  await getDb().execute(sql`INSERT INTO devices (id, user_id, user_agent, last_ip, last_seen_at, last_sync_at, client_version)
                            VALUES (${deviceId}, ${ctx.user?.id ?? null}, ${ctx.userAgent?.slice(0, 300) ?? null}, ${ctx.ip || null}, now(),
                                    ${synced ? sql`now()` : sql`NULL`}, ${clientVersion ?? null})
                            ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, user_agent = EXCLUDED.user_agent,
                              last_ip = EXCLUDED.last_ip, last_seen_at = now(),
                              last_sync_at = COALESCE(EXCLUDED.last_sync_at, devices.last_sync_at),
                              client_version = COALESCE(EXCLUDED.client_version, devices.client_version)`);
}

// ---------------------------------------------------------------------------------------------------------
// Pull — change feed
// ---------------------------------------------------------------------------------------------------------

const PULL_WINDOW = 5000;
export const RESERVATION_HISTORY_DAYS = 30;

export async function processPull(ctx: RequestContext, cursorRaw: string | undefined) {
  const db = getDb();
  const cursor = Math.max(0, Number(cursorRaw ?? 0) || 0);
  const hwm = await db.transaction(async (tx) => {
    const [row] = await q<{ hwm: number }>(tx, sql`SELECT sofia_sync_high_water_mark() AS hwm`);
    return Number(row!.hwm);
  });
  const upper = Math.min(hwm, cursor + PULL_WINDOW);
  const scope = branchScope(ctx);
  const inScope = (col: ReturnType<typeof dsql.raw> | typeof schema.areas.branchId) =>
    scope === null ? undefined : scope.length ? dsql`${col} IN ${scope}` : dsql`false`;
  const range = <T extends { syncSeq: unknown }>(t: T) => and(gt(t.syncSeq as never, cursor), lte(t.syncSeq as never, upper));
  const changes: Partial<Record<SyncPullEntity, Record<string, unknown>[]>> = {};
  if (upper > cursor) {
    changes.branches = (await db.select().from(schema.branches).where(and(range(schema.branches), inScope(schema.branches.id as never)))) as never;
    changes.areas = (await db.select().from(schema.areas).where(and(range(schema.areas), inScope(schema.areas.branchId)))) as never;
    changes.tables = (await db.select().from(schema.restaurantTables).where(and(range(schema.restaurantTables), inScope(schema.restaurantTables.branchId as never)))) as never;
    changes.table_combinations = (await db.select().from(schema.tableCombinations).where(and(range(schema.tableCombinations), inScope(schema.tableCombinations.branchId as never)))) as never;
    if (can(ctx, 'guests.read')) {
      const guests = await db.select().from(schema.guests).where(range(schema.guests));
      changes.guests = guests.map(guestView) as never;
      changes.guest_notes = (await db.select().from(schema.guestNotes).where(range(schema.guestNotes))) as never;
    }
    if (can(ctx, 'reservations.read')) {
      const since = addDays(new Date().toISOString().slice(0, 10), -RESERVATION_HISTORY_DAYS);
      const rows = await db
        .select()
        .from(schema.reservations)
        .where(and(range(schema.reservations), inScope(schema.reservations.branchId as never), dsql`${schema.reservations.businessDate} >= ${since}`));
      const tz = new Map((await db.select({ id: schema.branches.id, tz: schema.branches.timezone }).from(schema.branches)).map((b) => [b.id, b.tz]));
      changes.reservations = rows.map((r) => reservationView(r, tz.get(r.branchId))) as never;
    }
    if (can(ctx, 'waitlist.read')) {
      changes.waitlist = (await db
        .select()
        .from(schema.waitlistEntries)
        .where(and(range(schema.waitlistEntries), inScope(schema.waitlistEntries.branchId as never), dsql`${schema.waitlistEntries.createdAt} > now() - interval '2 days'`))) as never;
    }
  }
  const { epoch } = await getSetting('system.epoch');
  return { serverTime: new Date().toISOString(), epoch, cursor: String(upper), hasMore: upper < hwm, changes };
}

// ---------------------------------------------------------------------------------------------------------
// Conflict review
// ---------------------------------------------------------------------------------------------------------

export async function resolveConflict(
  ctx: RequestContext,
  id: string,
  resolution: 'keep_server' | 'take_client' | 'custom' | 'dismiss',
  values?: Record<string, unknown>,
) {
  return getDb().transaction(async (tx) => {
    const c = await q1<{
      id: string;
      kind: string;
      status: string;
      entity_type: string;
      entity_id: string;
      branch_id: string | null;
      field_conflicts: { field: string; client: unknown }[] | null;
      client_payload: Record<string, unknown>;
      server_snapshot: Record<string, unknown> | null;
    }>(tx, sql`SELECT * FROM sync_conflicts WHERE id = ${id} FOR UPDATE`);
    if (!c) throw new AppError(404, 'not_found', 'Conflict not found');
    if (c.status !== 'open') throw new AppError(409, 'already_resolved', 'This conflict has already been resolved');
    if (c.branch_id && branchScope(ctx) && !branchScope(ctx)!.includes(c.branch_id)) throw forbidden();

    if (resolution === 'take_client' || resolution === 'custom') {
      if (c.entity_type === 'guest' && c.kind === 'version_conflict') {
        const patch = resolution === 'custom' ? values ?? {} : Object.fromEntries((c.field_conflicts ?? []).map((f) => [f.field, f.client]));
        await updateGuest(tx, ctx, c.entity_id, guestUpdateSchema.parse(patch), { action: 'guest.conflict_resolution' });
      } else if (c.entity_type === 'reservation') {
        const patch =
          resolution === 'custom'
            ? reservationUpdateSchema.parse(values ?? {})
            : c.kind === 'reservation_overlap'
              ? { tableIds: (c.server_snapshot?.requestedTableIds as string[]) ?? [] }
              : reservationUpdateSchema.parse(Object.fromEntries((c.field_conflicts ?? []).map((f) => [f.field, f.client])));
        await updateReservation(tx, ctx, c.entity_id, patch);
      } else {
        throw new AppError(422, 'unsupported_resolution', 'Resolve this conflict by editing the record directly, then dismiss it');
      }
    }
    if (c.entity_type === 'reservation') {
      await tx.update(schema.reservations).set({ requiresReview: false, reviewReason: null }).where(eq(schema.reservations.id, c.entity_id));
    }
    const status = { keep_server: 'resolved_server', take_client: 'resolved_client', custom: 'resolved_custom', dismiss: 'dismissed' }[resolution];
    await tx.execute(sql`UPDATE sync_conflicts SET status = ${status}, resolved_at = now(), resolved_by = ${ctx.user!.id},
                                resolution = ${JSON.stringify({ resolution, values: values ?? null })}::jsonb WHERE id = ${id}`);
    await audit(tx, ctx, { action: 'sync.conflict_resolve', entityType: c.entity_type, entityId: c.entity_id, branchId: c.branch_id, meta: { conflictId: id, kind: c.kind, resolution, values } });
    await publish({ type: 'changes', entities: ['reservations', 'guests'], branchId: c.branch_id }, tx);
    return { ok: true, status };
  });
}

export async function syncStatus(ctx: RequestContext, deviceId?: string) {
  const db = getDb();
  const [stats] = await q<Record<string, number>>(
    db,
    sql`SELECT
          count(*) FILTER (WHERE received_at > now() - interval '24 hours')::int AS ops_24h,
          count(*) FILTER (WHERE status = 'applied')::int AS applied_total,
          count(*) FILTER (WHERE status = 'rejected' AND received_at > now() - interval '7 days')::int AS rejected_7d,
          count(*) FILTER (WHERE status = 'conflict')::int AS conflicts_total
        FROM sync_operations`,
  );
  const [open] = await q<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM sync_conflicts WHERE status = 'open'`);
  const devices = can(ctx, 'sync.review')
    ? await q(db, sql`SELECT d.id, d.name, d.user_agent AS "userAgent", d.last_seen_at AS "lastSeenAt", d.last_sync_at AS "lastSyncAt",
                             d.client_version AS "clientVersion", u.display_name AS "userName",
                             (SELECT count(*)::int FROM sync_operations o WHERE o.device_id = d.id) AS "opsTotal"
                      FROM devices d LEFT JOIN users u ON u.id = d.user_id ORDER BY d.last_seen_at DESC LIMIT 50`)
    : [];
  const mine = deviceId
    ? await q1(db, sql`SELECT count(*) FILTER (WHERE status IN ('applied'))::int AS synced, count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
                              count(*) FILTER (WHERE status = 'conflict')::int AS conflicts, max(received_at) AS "lastSync"
                       FROM sync_operations WHERE device_id = ${deviceId}`)
    : null;
  return { serverTime: new Date().toISOString(), server: 'online', stats, openConflicts: open?.n ?? 0, devices, device: mine };
}

export { businessDateOf };
