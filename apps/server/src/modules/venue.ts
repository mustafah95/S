import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  DEFAULT_RESERVATION_SETTINGS,
  areaSchema,
  areaUpdateSchema,
  branchSchema,
  branchUpdateSchema,
  closureSchema,
  effectiveTableStatus,
  tableCombinationSchema,
  tableLayoutSchema,
  tableSchema,
  tableStatusSchema,
  tableUpdateSchema,
  todayIn,
  addDays,
  zId,
  type ReservationSettings,
  type ReservationStatus,
} from '@sofia/shared';
import { getDb, schema, sql, q, type DbOrTx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { assertBranchAccess, branchScope, type RequestContext } from '../lib/context.js';
import { notFound, unprocessable } from '../lib/errors.js';
import { publish } from '../lib/events.js';
import { defineRoute, idParams } from '../lib/route.js';

type Branch = typeof schema.branches.$inferSelect;
type Table = typeof schema.restaurantTables.$inferSelect;

export function reservationSettingsOf(branch: Pick<Branch, 'reservationSettings'>): ReservationSettings {
  const s = (branch.reservationSettings ?? {}) as Partial<ReservationSettings>;
  return {
    ...DEFAULT_RESERVATION_SETTINGS,
    ...s,
    deposit: { ...DEFAULT_RESERVATION_SETTINGS.deposit, ...(s.deposit ?? {}) },
    cancellationPolicy: { ...DEFAULT_RESERVATION_SETTINGS.cancellationPolicy, ...(s.cancellationPolicy ?? {}) },
  };
}

export async function getBranch(tx: DbOrTx, id: string): Promise<Branch> {
  const [b] = await tx.select().from(schema.branches).where(and(eq(schema.branches.id, id), isNull(schema.branches.deletedAt)));
  if (!b) throw notFound('Branch');
  return b;
}

export function branchView(b: Branch) {
  return { ...b, reservationSettings: reservationSettingsOf(b) };
}

export async function getClosures(tx: DbOrTx, branchId: string, from: string, to: string) {
  const rows = await tx
    .select()
    .from(schema.branchClosures)
    .where(and(eq(schema.branchClosures.branchId, branchId), sql`${schema.branchClosures.date} BETWEEN ${from} AND ${to}`));
  return rows.map((r) => ({ id: r.id, date: r.date as unknown as string, reason: r.reason, periods: (r.periods as { open: string; close: string }[] | null) ?? null }));
}

// ---------------------------------------------------------------------------------------------------------
// Table status (shared by REST and offline sync)
// ---------------------------------------------------------------------------------------------------------

export async function setTableStatus(
  tx: DbOrTx,
  ctx: RequestContext,
  tableId: string,
  input: z.infer<typeof tableStatusSchema>,
): Promise<Table> {
  const [before] = await tx.select().from(schema.restaurantTables).where(eq(schema.restaurantTables.id, tableId)).for('update');
  if (!before || before.deletedAt) throw notFound('Table');
  assertBranchAccess(ctx, before.branchId);
  const [after] = await tx
    .update(schema.restaurantTables)
    .set({
      manualStatus: input.status,
      manualStatusReason: input.reason ?? null,
      manualStatusUntil: input.until ? new Date(input.until) : null,
      manualStatusAt: new Date(),
      updatedBy: ctx.user?.id ?? null,
    })
    .where(eq(schema.restaurantTables.id, tableId))
    .returning();
  await audit(tx, ctx, { action: 'table.status', entityType: 'table', entityId: tableId, branchId: before.branchId, before, after });
  await publish({ type: 'changes', entities: ['tables'], branchId: before.branchId }, tx);
  if (input.status === 'available' && before.manualStatus !== 'available') {
    await publish({ type: 'table_freed', branchId: before.branchId, tableIds: [tableId] }, tx);
  }
  return after!;
}

export async function liveTables(tx: DbOrTx, branchId: string, now = new Date()) {
  const branch = await getBranch(tx, branchId);
  const tables = await tx
    .select()
    .from(schema.restaurantTables)
    .where(and(eq(schema.restaurantTables.branchId, branchId), isNull(schema.restaurantTables.deletedAt)))
    .orderBy(asc(schema.restaurantTables.label));
  const today = todayIn(branch.timezone, now);
  const res = await q<{
    id: string;
    code: string;
    status: ReservationStatus;
    start_at: Date;
    end_at: Date;
    table_ids: string[];
    party_size: number;
    guest_name: string | null;
    guest_id: string | null;
    vip_level: string | null;
    occasion: string | null;
  }>(
    tx,
    sql`SELECT r.id, r.code, r.status, r.start_at, r.end_at, r.table_ids, r.party_size, r.guest_name, r.guest_id,
               g.vip_level, r.occasion
        FROM reservations r LEFT JOIN guests g ON g.id = r.guest_id
        WHERE r.branch_id = ${branchId} AND r.deleted_at IS NULL
          AND r.business_date BETWEEN ${addDays(today, -1)} AND ${addDays(today, 1)}
          AND r.status IN ('pending','confirmed','checked_in','seated','dining')`,
  );
  const reservations = res.map((r) => ({
    id: r.id,
    code: r.code,
    status: r.status,
    startAt: r.start_at,
    endAt: r.end_at,
    tableIds: r.table_ids,
    partySize: r.party_size,
    guestName: r.guest_name,
    guestId: r.guest_id,
    vipLevel: r.vip_level,
    occasion: r.occasion,
  }));
  return tables.map((t) => {
    const s = effectiveTableStatus(t, reservations, now);
    return { ...t, liveStatus: s.status, current: s.current ?? null, next: s.next ?? null };
  });
}

// ---------------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------------

const branchQuery = z.object({ branchId: zId.optional() });

export async function registerVenueRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // Branches -----------------------------------------------------------------------------------------------
  defineRoute(app, { method: 'GET', url: '/api/v1/branches', summary: 'List branches visible to the user', tags: ['Branches'], permission: 'branches.read' }, async ({ ctx }) => {
    const scope = branchScope(ctx);
    const rows = await db
      .select()
      .from(schema.branches)
      .where(and(isNull(schema.branches.deletedAt), scope ? inArray(schema.branches.id, scope.length ? scope : ['00000000-0000-0000-0000-000000000000']) : undefined))
      .orderBy(asc(schema.branches.name));
    return rows.map(branchView);
  });

  defineRoute(app, { method: 'GET', url: '/api/v1/branches/:id', summary: 'Get a branch', tags: ['Branches'], permission: 'branches.read', params: idParams }, async ({ params, ctx }) => {
    assertBranchAccess(ctx, params.id);
    return branchView(await getBranch(db, params.id));
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/branches', summary: 'Create a branch', tags: ['Branches'], permission: 'branches.manage', body: branchSchema }, async ({ body, ctx }) =>
    db.transaction(async (tx) => {
      const [b] = await tx
        .insert(schema.branches)
        .values({ ...body, reservationSettings: body.reservationSettings ?? DEFAULT_RESERVATION_SETTINGS, createdBy: ctx.user?.id })
        .returning();
      await audit(tx, ctx, { action: 'branch.create', entityType: 'branch', entityId: b!.id, branchId: b!.id, after: b });
      await publish({ type: 'changes', entities: ['branches'] }, tx);
      return branchView(b!);
    }),
  );

  defineRoute(app, { method: 'PATCH', url: '/api/v1/branches/:id', summary: 'Update branch details, hours and reservation settings', tags: ['Branches'], permission: ['branches.manage', 'settings.manage'], params: idParams, body: branchUpdateSchema }, async ({ params, body, ctx }) =>
    db.transaction(async (tx) => {
      assertBranchAccess(ctx, params.id);
      const before = await getBranch(tx, params.id);
      if (!ctx.user?.permissions.has('branches.manage') && (body.code !== undefined || body.isActive !== undefined)) {
        throw unprocessable('forbidden_field', 'Only head office can change branch code or activation');
      }
      const patch: Partial<Branch> = { ...(body as Partial<Branch>), updatedBy: ctx.user?.id ?? null };
      if (body.reservationSettings) patch.reservationSettings = { ...reservationSettingsOf(before), ...body.reservationSettings };
      const [after] = await tx.update(schema.branches).set(patch).where(eq(schema.branches.id, params.id)).returning();
      await audit(tx, ctx, { action: 'branch.update', entityType: 'branch', entityId: params.id, branchId: params.id, before, after });
      await publish({ type: 'changes', entities: ['branches'] }, tx);
      return branchView(after!);
    }),
  );

  defineRoute(app, { method: 'GET', url: '/api/v1/branches/:id/closures', summary: 'Special closures / holiday hours', tags: ['Branches'], permission: 'branches.read', params: idParams }, async ({ params, ctx }) => {
    assertBranchAccess(ctx, params.id);
    const today = new Date().toISOString().slice(0, 10);
    return getClosures(db, params.id, addDays(today, -30), addDays(today, 730));
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/branches/:id/closures', summary: 'Add a closure or special opening hours for a date', tags: ['Branches'], permission: 'settings.manage', params: idParams, body: closureSchema }, async ({ params, body, ctx }) =>
    db.transaction(async (tx) => {
      assertBranchAccess(ctx, params.id);
      const [row] = await tx
        .insert(schema.branchClosures)
        .values({ branchId: params.id, date: body.date, reason: body.reason ?? null, periods: body.periods, createdBy: ctx.user?.id })
        .onConflictDoUpdate({ target: [schema.branchClosures.branchId, schema.branchClosures.date], set: { reason: body.reason ?? null, periods: body.periods } })
        .returning();
      await audit(tx, ctx, { action: 'branch.closure', entityType: 'branch', entityId: params.id, branchId: params.id, after: row });
      await tx.update(schema.branches).set({ updatedBy: ctx.user?.id ?? null }).where(eq(schema.branches.id, params.id));
      return row;
    }),
  );

  defineRoute(app, { method: 'DELETE', url: '/api/v1/branches/:id/closures/:closureId', summary: 'Remove a closure', tags: ['Branches'], permission: 'settings.manage', params: z.object({ id: zId, closureId: zId }) }, async ({ params, ctx }) =>
    db.transaction(async (tx) => {
      assertBranchAccess(ctx, params.id);
      const [row] = await tx.delete(schema.branchClosures).where(and(eq(schema.branchClosures.id, params.closureId), eq(schema.branchClosures.branchId, params.id))).returning();
      if (!row) throw notFound('Closure');
      await audit(tx, ctx, { action: 'branch.closure_delete', entityType: 'branch', entityId: params.id, branchId: params.id, before: row });
      return { ok: true };
    }),
  );

  // Areas ---------------------------------------------------------------------------------------------------
  defineRoute(app, { method: 'GET', url: '/api/v1/areas', summary: 'Dining areas', tags: ['Floor plan'], permission: 'tables.read', query: branchQuery }, async ({ query, ctx }) => {
    if (query.branchId) assertBranchAccess(ctx, query.branchId);
    const scope = branchScope(ctx);
    return db
      .select()
      .from(schema.areas)
      .where(
        and(
          isNull(schema.areas.deletedAt),
          query.branchId ? eq(schema.areas.branchId, query.branchId) : undefined,
          scope ? inArray(schema.areas.branchId, scope.length ? scope : ['00000000-0000-0000-0000-000000000000']) : undefined,
        ),
      )
      .orderBy(asc(schema.areas.sortOrder), asc(schema.areas.name));
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/areas', summary: 'Create a dining area', tags: ['Floor plan'], permission: 'tables.manage', body: areaSchema }, async ({ body, ctx }) =>
    db.transaction(async (tx) => {
      assertBranchAccess(ctx, body.branchId);
      const [a] = await tx.insert(schema.areas).values({ ...body, createdBy: ctx.user?.id }).returning();
      await audit(tx, ctx, { action: 'area.create', entityType: 'area', entityId: a!.id, branchId: a!.branchId, after: a });
      await publish({ type: 'changes', entities: ['areas'], branchId: a!.branchId }, tx);
      return a;
    }),
  );

  defineRoute(app, { method: 'PATCH', url: '/api/v1/areas/:id', summary: 'Update a dining area (incl. floor plan decor)', tags: ['Floor plan'], permission: 'tables.manage', params: idParams, body: areaUpdateSchema }, async ({ params, body, ctx }) =>
    db.transaction(async (tx) => {
      const [before] = await tx.select().from(schema.areas).where(eq(schema.areas.id, params.id));
      if (!before || before.deletedAt) throw notFound('Area');
      assertBranchAccess(ctx, before.branchId);
      const [after] = await tx.update(schema.areas).set({ ...body, updatedBy: ctx.user?.id ?? null }).where(eq(schema.areas.id, params.id)).returning();
      await audit(tx, ctx, { action: 'area.update', entityType: 'area', entityId: params.id, branchId: before.branchId, before, after });
      await publish({ type: 'changes', entities: ['areas'], branchId: before.branchId }, tx);
      return after;
    }),
  );

  defineRoute(app, { method: 'DELETE', url: '/api/v1/areas/:id', summary: 'Archive a dining area (must have no active tables)', tags: ['Floor plan'], permission: 'tables.manage', params: idParams }, async ({ params, ctx }) =>
    db.transaction(async (tx) => {
      const [before] = await tx.select().from(schema.areas).where(eq(schema.areas.id, params.id));
      if (!before || before.deletedAt) throw notFound('Area');
      assertBranchAccess(ctx, before.branchId);
      const active = await tx.select({ id: schema.restaurantTables.id }).from(schema.restaurantTables).where(and(eq(schema.restaurantTables.areaId, params.id), isNull(schema.restaurantTables.deletedAt)));
      if (active.length) throw unprocessable('area_not_empty', 'Move or remove the tables of this area first');
      await tx.update(schema.areas).set({ deletedAt: new Date(), updatedBy: ctx.user?.id ?? null }).where(eq(schema.areas.id, params.id));
      await audit(tx, ctx, { action: 'area.delete', entityType: 'area', entityId: params.id, branchId: before.branchId, before });
      await publish({ type: 'changes', entities: ['areas'], branchId: before.branchId }, tx);
      return { ok: true };
    }),
  );

  // Tables --------------------------------------------------------------------------------------------------
  defineRoute(app, { method: 'GET', url: '/api/v1/tables', summary: 'Tables of a branch', tags: ['Floor plan'], permission: 'tables.read', query: branchQuery }, async ({ query, ctx }) => {
    if (query.branchId) assertBranchAccess(ctx, query.branchId);
    const scope = branchScope(ctx);
    return db
      .select()
      .from(schema.restaurantTables)
      .where(
        and(
          isNull(schema.restaurantTables.deletedAt),
          query.branchId ? eq(schema.restaurantTables.branchId, query.branchId) : undefined,
          scope ? inArray(schema.restaurantTables.branchId, scope.length ? scope : ['00000000-0000-0000-0000-000000000000']) : undefined,
        ),
      )
      .orderBy(asc(schema.restaurantTables.label));
  });

  defineRoute(app, { method: 'GET', url: '/api/v1/tables/live', summary: 'Real-time table status for the floor plan', tags: ['Floor plan'], permission: 'tables.read', query: z.object({ branchId: zId }) }, async ({ query, ctx }) => {
    assertBranchAccess(ctx, query.branchId);
    return liveTables(db, query.branchId);
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/tables', summary: 'Create a table', tags: ['Floor plan'], permission: 'tables.manage', body: tableSchema }, async ({ body, ctx }) =>
    db.transaction(async (tx) => {
      assertBranchAccess(ctx, body.branchId);
      const [area] = await tx.select().from(schema.areas).where(eq(schema.areas.id, body.areaId));
      if (!area || area.branchId !== body.branchId) throw unprocessable('invalid_area', 'Area does not belong to this branch');
      const [t] = await tx.insert(schema.restaurantTables).values({ ...body, createdBy: ctx.user?.id }).returning();
      await audit(tx, ctx, { action: 'table.create', entityType: 'table', entityId: t!.id, branchId: t!.branchId, after: t });
      await publish({ type: 'changes', entities: ['tables'], branchId: t!.branchId }, tx);
      return t;
    }),
  );

  defineRoute(app, { method: 'PATCH', url: '/api/v1/tables/:id', summary: 'Update a table', tags: ['Floor plan'], permission: 'tables.manage', params: idParams, body: tableUpdateSchema }, async ({ params, body, ctx }) =>
    db.transaction(async (tx) => {
      const [before] = await tx.select().from(schema.restaurantTables).where(eq(schema.restaurantTables.id, params.id));
      if (!before || before.deletedAt) throw notFound('Table');
      assertBranchAccess(ctx, before.branchId);
      const merged = { ...before, ...body };
      if (merged.minCapacity > merged.maxCapacity) throw unprocessable('invalid_capacity', 'Minimum capacity must not exceed maximum capacity');
      const [after] = await tx.update(schema.restaurantTables).set({ ...body, updatedBy: ctx.user?.id ?? null }).where(eq(schema.restaurantTables.id, params.id)).returning();
      await audit(tx, ctx, { action: 'table.update', entityType: 'table', entityId: params.id, branchId: before.branchId, before, after });
      await publish({ type: 'changes', entities: ['tables'], branchId: before.branchId }, tx);
      return after;
    }),
  );

  defineRoute(app, { method: 'DELETE', url: '/api/v1/tables/:id', summary: 'Archive a table (future reservations must be moved first)', tags: ['Floor plan'], permission: 'tables.manage', params: idParams }, async ({ params, ctx }) =>
    db.transaction(async (tx) => {
      const [before] = await tx.select().from(schema.restaurantTables).where(eq(schema.restaurantTables.id, params.id));
      if (!before || before.deletedAt) throw notFound('Table');
      assertBranchAccess(ctx, before.branchId);
      const future = await q(tx, sql`SELECT 1 FROM table_allocations WHERE table_id = ${params.id} AND active AND upper(period) > now() LIMIT 1`);
      if (future.length) throw unprocessable('table_has_reservations', 'This table has upcoming reservations. Move them before removing the table.');
      await tx.update(schema.restaurantTables).set({ deletedAt: new Date(), isActive: false, updatedBy: ctx.user?.id ?? null }).where(eq(schema.restaurantTables.id, params.id));
      await audit(tx, ctx, { action: 'table.delete', entityType: 'table', entityId: params.id, branchId: before.branchId, before });
      await publish({ type: 'changes', entities: ['tables'], branchId: before.branchId }, tx);
      return { ok: true };
    }),
  );

  defineRoute(app, { method: 'PUT', url: '/api/v1/tables/layout', summary: 'Save floor-plan positions for many tables (drag & drop)', tags: ['Floor plan'], permission: 'tables.manage', body: tableLayoutSchema }, async ({ body, ctx }) =>
    db.transaction(async (tx) => {
      const ids = body.tables.map((t) => t.id);
      if (!ids.length) return { updated: 0 };
      const existing = await tx.select().from(schema.restaurantTables).where(inArray(schema.restaurantTables.id, ids));
      const branchIds = new Set(existing.map((e) => e.branchId));
      for (const b of branchIds) assertBranchAccess(ctx, b);
      for (const t of body.tables) {
        const { id, ...pos } = t;
        await tx.update(schema.restaurantTables).set({ ...pos, updatedBy: ctx.user?.id ?? null }).where(eq(schema.restaurantTables.id, id));
      }
      await audit(tx, ctx, { action: 'floorplan.layout', entityType: 'floor_plan', entityId: [...branchIds].join(','), meta: { tables: ids.length } });
      for (const b of branchIds) await publish({ type: 'changes', entities: ['tables'], branchId: b }, tx);
      return { updated: ids.length };
    }),
  );

  defineRoute(app, { method: 'POST', url: '/api/v1/tables/:id/status', summary: 'Set manual table status (available, cleaning, blocked, maintenance)', tags: ['Floor plan'], permission: 'tables.status', params: idParams, body: tableStatusSchema }, async ({ params, body, ctx }) =>
    db.transaction((tx) => setTableStatus(tx, ctx, params.id, body)),
  );

  // Combinations ----------------------------------------------------------------------------------------------
  defineRoute(app, { method: 'GET', url: '/api/v1/table-combinations', summary: 'Predefined table combinations', tags: ['Floor plan'], permission: 'tables.read', query: branchQuery }, async ({ query, ctx }) => {
    if (query.branchId) assertBranchAccess(ctx, query.branchId);
    return db
      .select()
      .from(schema.tableCombinations)
      .where(and(isNull(schema.tableCombinations.deletedAt), query.branchId ? eq(schema.tableCombinations.branchId, query.branchId) : undefined));
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/table-combinations', summary: 'Define a table combination (e.g. T1 + T2)', tags: ['Floor plan'], permission: 'tables.manage', body: tableCombinationSchema }, async ({ body, ctx }) =>
    db.transaction(async (tx) => {
      assertBranchAccess(ctx, body.branchId);
      const tables = await tx.select().from(schema.restaurantTables).where(inArray(schema.restaurantTables.id, body.tableIds));
      if (tables.length !== body.tableIds.length || tables.some((t) => t.branchId !== body.branchId || t.deletedAt)) {
        throw unprocessable('invalid_tables', 'All tables must exist in this branch');
      }
      const [c] = await tx.insert(schema.tableCombinations).values({ ...body, createdBy: ctx.user?.id }).returning();
      await audit(tx, ctx, { action: 'combination.create', entityType: 'table_combination', entityId: c!.id, branchId: body.branchId, after: c });
      await publish({ type: 'changes', entities: ['table_combinations'], branchId: body.branchId }, tx);
      return c;
    }),
  );

  defineRoute(app, { method: 'DELETE', url: '/api/v1/table-combinations/:id', summary: 'Remove a table combination', tags: ['Floor plan'], permission: 'tables.manage', params: idParams }, async ({ params, ctx }) =>
    db.transaction(async (tx) => {
      const [before] = await tx.select().from(schema.tableCombinations).where(eq(schema.tableCombinations.id, params.id));
      if (!before || before.deletedAt) throw notFound('Combination');
      assertBranchAccess(ctx, before.branchId);
      await tx.update(schema.tableCombinations).set({ deletedAt: new Date(), updatedBy: ctx.user?.id ?? null }).where(eq(schema.tableCombinations.id, params.id));
      await audit(tx, ctx, { action: 'combination.delete', entityType: 'table_combination', entityId: params.id, branchId: before.branchId, before });
      await publish({ type: 'changes', entities: ['table_combinations'], branchId: before.branchId }, tx);
      return { ok: true };
    }),
  );
}
