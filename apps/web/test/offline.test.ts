import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@sofia/shared';
import { db } from '../src/offline/db';
import { rebase, applyReservationAction } from '../src/offline/ops';
import { addGuestNote, createGuest, createReservation, reservationAction, setRepoUser, updateGuest } from '../src/offline/repo';

const branchId = uuidv7();
const userId = uuidv7();

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  setRepoUser(userId);
  await db.branches.put({ id: branchId, name: 'Main', timezone: 'Asia/Baghdad', reservationSettings: {}, operatingHours: [] });
});

describe('local-first repository', () => {
  it('writes the record and its outbox operation in one step (offline-safe)', async () => {
    const g = await createGuest({ firstName: 'Noor', phone: '0770 123 4567' });
    const local = await db.guests.get(g.id);
    expect(local).toMatchObject({ firstName: 'Noor', phoneNormalized: '+9647701234567', _local: true, _pending: 1 });
    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ entityType: 'guest', entityId: g.id, op: 'create', status: 'pending', userId });
  });

  it('computes reservation times locally and queues the API payload', async () => {
    const g = await createGuest({ firstName: 'Layla' });
    const r = await createReservation({ branchId, guestId: g.id, date: '2026-11-20', time: '00:30', partySize: 2, source: 'phone', autoAssignTable: false, overrideHours: false });
    expect(r.code).toMatch(/^LOCAL-/);
    // 00:30 belongs to the business day of the 20th → calendar 21st, Baghdad UTC+3
    expect(r.startAt).toBe('2026-11-20T21:30:00.000Z');
    expect(r.guestName).toBe('Layla');
    const op = (await db.outbox.toArray()).find((o) => o.entityType === 'reservation')!;
    expect(op.payload).toMatchObject({ date: '2026-11-20', time: '00:30', guestId: g.id });
    expect(op.payload).not.toHaveProperty('id');
  });

  it('records base version and base values for three-way merge', async () => {
    const id = uuidv7();
    const server = { id, firstName: 'Zaid', phone: '0770', tags: ['Regular'], version: 4 };
    await db.guests.put({ ...server, _server: server, _pending: 0 });
    await updateGuest(id, { tags: ['Regular', 'VIP'] });
    const op = (await db.outbox.toArray()).at(-1)!;
    expect(op).toMatchObject({ op: 'update', baseVersion: 4, baseValues: { tags: ['Regular'] }, payload: { tags: ['Regular', 'VIP'] } });
    expect((await db.guests.get(id))!.tags).toEqual(['Regular', 'VIP']);
  });

  it('applies status actions optimistically and keeps queue order', async () => {
    const r = await createReservation({ branchId, date: '2026-11-20', time: '20:00', partySize: 4, source: 'phone', autoAssignTable: false, overrideHours: false });
    await reservationAction(r.id, 'check_in');
    await reservationAction(r.id, 'seat', { tableIds: [uuidv7()] });
    await addGuestNote(uuidv7(), 'note');
    const local = await db.reservations.get(r.id);
    expect(local!.status).toBe('seated');
    expect(local!._pending).toBe(3);
    const ops = await db.outbox.orderBy('seq').toArray();
    expect(ops.map((o) => o.action ?? o.op)).toEqual(['create', 'check_in', 'seat', 'create']);
  });
});

describe('rebase', () => {
  it('re-applies pending local edits on top of fresh server data', () => {
    const server = { id: '1', branchId, status: 'confirmed', notes: 'server', businessDate: '2026-11-20', time: '20:00', durationMinutes: 120, version: 7 };
    const pending = [
      { opId: 'a', entityType: 'reservation', entityId: '1', op: 'update', payload: { notes: 'local' }, clientTs: '2026-11-20T10:00:00Z', userId, status: 'pending', attempts: 0 },
      { opId: 'b', entityType: 'reservation', entityId: '1', op: 'action', action: 'check_in', payload: {}, clientTs: '2026-11-20T10:01:00Z', userId, status: 'pending', attempts: 0 },
    ] as never;
    const out = rebase(server as never, pending, { tzFor: () => 'Asia/Baghdad', durationFor: () => 120 });
    expect(out).toMatchObject({ notes: 'local', status: 'checked_in', version: 7, _pending: 2, _local: false });
    expect(out._server).toEqual(server);
  });

  it('mirrors the server state machine for optimistic actions', () => {
    const r = applyReservationAction({ id: '1', status: 'confirmed' } as never, 'cancel', { reason: 'guest called' }, '2026-11-20T10:00:00Z');
    expect(r).toMatchObject({ status: 'cancelled', cancelReason: 'guest called' });
  });
});
