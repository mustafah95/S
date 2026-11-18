import {
  DEFAULT_RESERVATION_SETTINGS,
  businessDateOf,
  businessToUtc,
  durationForParty,
  normalizePhone,
  utcToZoned,
  uuidv7,
  type GuestCreateInput,
  type GuestUpdateInput,
  type ReservationAction,
  type ReservationCreateInput,
  type ReservationSettings,
  type ReservationUpdateInput,
  type SyncOperation,
  type SyncWriteEntity,
} from '@sofia/shared';
import { db, tableFor, type OutboxOp, type Rec } from './db';
import { syncEngine } from './engine';
import { applyReservationAction, applyReservationPatch, applyTableStatus, applyWaitlistAction } from './ops';

/**
 * Local-first repository. Every write the staff makes — online or offline — goes through here:
 *   1. apply the change optimistically to IndexedDB, and
 *   2. append an operation to the durable outbox in the SAME IndexedDB transaction,
 * then the sync engine pushes it as soon as the server is reachable. The UI reads only from IndexedDB, so
 * it behaves identically with or without a connection.
 */

let currentUserId = '00000000-0000-7000-8000-000000000000';
export function setRepoUser(id: string): void {
  currentUserId = id;
}

function op(entityType: SyncWriteEntity, entityId: string, kind: SyncOperation['op'], payload: Record<string, unknown>, extra: Partial<OutboxOp> = {}): OutboxOp {
  return {
    opId: uuidv7(),
    entityType,
    entityId,
    op: kind,
    payload,
    clientTs: new Date().toISOString(),
    userId: currentUserId,
    status: 'pending',
    attempts: 0,
    ...extra,
  };
}

function strip<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

async function write(entityType: SyncWriteEntity, record: Rec | null, outboxOp: OutboxOp, extraTables: Parameters<typeof db.transaction>[1][] = []): Promise<void> {
  const table = tableFor(entityType);
  await db.transaction('rw', [table, db.outbox, ...(extraTables as never[])], async () => {
    if (record) await table.put(record);
    await db.outbox.add(outboxOp);
  });
  syncEngine.kick();
}

/** Base values (as last confirmed by the server) of the fields being changed — enables 3-way merge. */
function baseOf(rec: Rec, fields: string[]): { baseVersion?: number; baseValues?: Record<string, unknown> } {
  const server = rec._server as Rec | undefined;
  if (!server) return {};
  return { baseVersion: server.version as number, baseValues: Object.fromEntries(fields.map((f) => [f, server[f] ?? null])) };
}

async function branchInfo(branchId: string) {
  const b = await db.branches.get(branchId);
  const settings: ReservationSettings = { ...DEFAULT_RESERVATION_SETTINGS, ...((b?.reservationSettings ?? {}) as Partial<ReservationSettings>) };
  return { tz: (b?.timezone as string) ?? 'Asia/Baghdad', settings };
}

// ---------------------------------------------------------------------------------------------------------
// Guests
// ---------------------------------------------------------------------------------------------------------

export async function createGuest(input: GuestCreateInput): Promise<Rec> {
  const id = input.id ?? uuidv7();
  const now = new Date().toISOString();
  const { id: _i, ...payload } = input;
  const rec: Rec = {
    vipLevel: 'standard',
    tags: [],
    allergies: [],
    dietary: [],
    preferences: {},
    marketingConsent: false,
    visitCount: 0,
    totalSpend: 0,
    avgCheck: 0,
    loyaltyPoints: 0,
    noShowCount: 0,
    ...strip(payload),
    id,
    phoneNormalized: normalizePhone(input.phone ?? null),
    createdAt: now,
    updatedAt: now,
    version: 0,
    _local: true,
    _pending: 1,
  };
  await write('guest', rec, op('guest', id, 'create', strip(payload), { label: `Guest ${input.firstName} ${input.lastName ?? ''}`.trim() }));
  return rec;
}

export async function updateGuest(id: string, patch: GuestUpdateInput): Promise<void> {
  const rec = await db.guests.get(id);
  if (!rec) throw new Error('Guest not found on this device');
  const p = strip(patch as Record<string, unknown>);
  const next: Rec = { ...rec, ...p, _pending: (rec._pending ?? 0) + 1, updatedAt: new Date().toISOString() };
  if (patch.phone !== undefined) next.phoneNormalized = normalizePhone(patch.phone);
  await write('guest', next, op('guest', id, 'update', p, { ...baseOf(rec, Object.keys(p)), label: `Edit guest ${rec.firstName}` }));
}

export async function addGuestNote(guestId: string, body: string, branchId?: string | null, isPinned = false): Promise<Rec> {
  const id = uuidv7();
  const now = new Date().toISOString();
  const rec: Rec = { id, guestId, body, isPinned, kind: 'note', branchId: branchId ?? null, createdAt: now, createdBy: currentUserId, _local: true, _pending: 1 };
  await write('guest_note', rec, op('guest_note', id, 'create', { guestId, body, isPinned, branchId: branchId ?? null }, { label: 'Guest note' }));
  return rec;
}

// ---------------------------------------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------------------------------------

export async function createReservation(input: ReservationCreateInput): Promise<Rec> {
  const id = input.id ?? uuidv7();
  const { tz, settings } = await branchInfo(input.branchId);
  const duration = input.durationMinutes ?? durationForParty(settings, input.partySize);
  const start = businessToUtc(input.date, input.time, tz);
  const guest = input.guestId ? await db.guests.get(input.guestId) : undefined;
  const isWalkIn = input.source === 'walk_in';
  const now = new Date().toISOString();
  let areaId = input.areaId ?? null;
  if (!areaId && input.tableIds?.length) areaId = ((await db.diningTables.get(input.tableIds[0]!))?.areaId as string) ?? null;
  const rec: Rec = {
    id,
    code: `LOCAL-${id.slice(-6).toUpperCase()}`,
    branchId: input.branchId,
    guestId: input.guestId ?? null,
    guestName: guest ? [guest.firstName, guest.lastName].filter(Boolean).join(' ') : input.guest?.firstName ?? null,
    guestPhone: guest?.phone ?? input.guest?.phone ?? null,
    businessDate: input.date,
    time: input.time,
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + duration * 60_000).toISOString(),
    durationMinutes: duration,
    partySize: input.partySize,
    areaId,
    tableIds: input.tableIds ?? [],
    status: isWalkIn ? 'seated' : input.status ?? 'confirmed',
    occasion: input.occasion ?? null,
    source: input.source,
    notes: input.notes ?? null,
    specialRequest: input.specialRequest ?? null,
    seatedAt: isWalkIn ? now : null,
    checkedInAt: isWalkIn ? now : null,
    requiresReview: false,
    origin: 'offline',
    createdAt: now,
    updatedAt: now,
    version: 0,
    _local: true,
    _pending: 1,
  };
  const { id: _i, ...payload } = input;
  await write('reservation', rec, op('reservation', id, 'create', strip(payload as Record<string, unknown>), { branchId: input.branchId, label: `${isWalkIn ? 'Walk-in' : 'Reservation'} ${rec.guestName ?? ''} ${input.date} ${input.time}`.trim() }));
  return rec;
}

export async function updateReservation(id: string, patch: ReservationUpdateInput): Promise<void> {
  const rec = await db.reservations.get(id);
  if (!rec) throw new Error('Reservation not found on this device');
  const { tz, settings } = await branchInfo(rec.branchId);
  const p = strip(patch as Record<string, unknown>);
  const next = applyReservationPatch(rec, p, tz, (party) => durationForParty(settings, party));
  next._pending = (rec._pending ?? 0) + 1;
  const server = rec._server as Rec | undefined;
  const baseValues = server
    ? Object.fromEntries(Object.keys(p).map((k) => [k, k === 'date' ? server.businessDate : k === 'time' ? server.time : server[k] ?? null]))
    : undefined;
  await write('reservation', next, op('reservation', id, 'update', p, { baseVersion: server?.version as number | undefined, baseValues, branchId: rec.branchId, label: `Edit ${rec.code}` }));
}

export async function reservationAction(id: string, action: ReservationAction, payload: { reason?: string; tableIds?: string[] } = {}): Promise<void> {
  const rec = await db.reservations.get(id);
  if (!rec) throw new Error('Reservation not found on this device');
  const at = new Date().toISOString();
  const next = applyReservationAction(rec, action, payload, at);
  next._pending = (rec._pending ?? 0) + 1;
  await write('reservation', next, op('reservation', id, 'action', strip({ ...payload, at }), { action, branchId: rec.branchId, label: `${action.replace('_', ' ')} ${rec.code}` }));
}

// ---------------------------------------------------------------------------------------------------------
// Walk-ins, waitlist, tables
// ---------------------------------------------------------------------------------------------------------

export async function seatWalkIn(input: { branchId: string; partySize: number; tableIds: string[]; guestId?: string | null; guestName?: string; notes?: string | null }): Promise<Rec> {
  const { tz } = await branchInfo(input.branchId);
  const now = new Date();
  return createReservation({
    branchId: input.branchId,
    guestId: input.guestId ?? null,
    guest: input.guestId ? undefined : { firstName: input.guestName || 'Walk-in', email: null },
    date: businessDateOf(now, tz),
    time: utcToZoned(now, tz).time,
    partySize: input.partySize,
    tableIds: input.tableIds,
    source: 'walk_in',
    notes: input.notes ?? null,
    autoAssignTable: false,
    overrideHours: false,
  });
}

export async function addToWaitlist(input: { branchId: string; guestName: string; phone?: string | null; partySize: number; guestId?: string | null; quotedWaitMinutes?: number | null; notes?: string | null; isVip?: boolean; areaId?: string | null; flexibleMinutes?: number; priority?: number }): Promise<Rec> {
  const id = uuidv7();
  const now = new Date().toISOString();
  const payload = strip({ branchId: input.branchId, guestName: input.guestName, phone: input.phone ?? null, partySize: input.partySize, guestId: input.guestId ?? null, quotedWaitMinutes: input.quotedWaitMinutes ?? null, notes: input.notes ?? null, isVip: input.isVip ?? false, areaId: input.areaId ?? null, flexibleMinutes: input.flexibleMinutes ?? 30, priority: input.priority ?? 0 });
  const rec: Rec = { ...payload, id, status: 'waiting', createdAt: now, updatedAt: now, version: 0, _local: true, _pending: 1 };
  await write('waitlist', rec, op('waitlist', id, 'create', payload, { branchId: input.branchId, label: `Waitlist ${input.guestName} (${input.partySize})` }));
  return rec;
}

export async function waitlistAction(id: string, action: 'notify' | 'cancel' | 'seat', seat?: { tableIds: string[] }): Promise<void> {
  const rec = await db.waitlist.get(id);
  if (!rec) throw new Error('Waitlist entry not found on this device');
  const at = new Date().toISOString();
  const payload: Record<string, unknown> = {};
  if (action === 'seat' && seat) {
    payload.tableIds = seat.tableIds;
    payload.reservationId = uuidv7();
  }
  const next = applyWaitlistAction(rec, action, payload, at);
  next._pending = (rec._pending ?? 0) + 1;
  const extra = action === 'seat' ? [db.reservations] : [];
  await db.transaction('rw', [db.waitlist, db.outbox, ...extra], async () => {
    await db.waitlist.put(next);
    if (action === 'seat' && seat) {
      const { tz, settings } = await branchInfo(rec.branchId);
      const now = new Date();
      const duration = durationForParty(settings, rec.partySize);
      await db.reservations.put({
        id: payload.reservationId as string,
        code: `LOCAL-${(payload.reservationId as string).slice(-6).toUpperCase()}`,
        branchId: rec.branchId,
        guestId: rec.guestId ?? null,
        guestName: rec.guestName,
        businessDate: businessDateOf(now, tz),
        time: utcToZoned(now, tz).time,
        startAt: now.toISOString(),
        endAt: new Date(now.getTime() + duration * 60_000).toISOString(),
        durationMinutes: duration,
        partySize: rec.partySize,
        tableIds: seat.tableIds,
        status: 'seated',
        source: 'walk_in',
        seatedAt: at,
        _local: true,
        _pending: 1,
      });
    }
    await db.outbox.add(op('waitlist', id, 'action', payload, { action, branchId: rec.branchId, label: `Waitlist ${action} ${rec.guestName}` }));
  });
  syncEngine.kick();
}

export async function setTableStatus(tableId: string, status: 'available' | 'cleaning' | 'blocked' | 'maintenance', reason?: string): Promise<void> {
  const rec = await db.diningTables.get(tableId);
  if (!rec) throw new Error('Table not found on this device');
  const payload = strip({ status, reason: reason ?? null });
  const next = applyTableStatus(rec, payload, new Date().toISOString());
  next._pending = (rec._pending ?? 0) + 1;
  await write('table', next, op('table', tableId, 'action', payload, { action: 'set_status', branchId: rec.branchId, label: `Table ${rec.label} → ${status}` }));
}
