import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { addDays, uuidv7 } from '@sofia/shared';
import { closeDb, getDb, q, sql } from '../src/db/pool.js';
import { ApiClient, createStaff, setupRestaurant, startTestServer, tomorrow, type Restaurant } from './helpers.js';

let app: FastifyInstance;
let r: Restaurant;
let host: ApiClient;

beforeAll(async () => {
  app = await startTestServer();
  r = await setupRestaurant(app);
  host = (await createStaff(app, r.admin, 'host', [r.branchId])).client;
});
afterAll(async () => {
  await app.close();
  await closeDb();
});

const base = () => ({ branchId: r.branchId, date: tomorrow(), time: '20:00', partySize: 4, source: 'phone' });

describe('reservation engine', () => {
  it('creates a reservation with an inline guest and stores it in PostgreSQL', async () => {
    const res = await host.post('/api/v1/reservations', { ...base(), tableIds: [r.tables.T2], guest: { firstName: 'Layla', lastName: 'Hassan', phone: '0770 111 2233' }, occasion: 'birthday' });
    expect(res.status).toBe(201);
    expect(res.body.reservation.code).toMatch(/^SR-[A-Z0-9]{6}$/);
    expect(res.body.reservation.status).toBe('confirmed');
    expect(res.body.reservation.time).toBe('20:00');
    const rows = await q(getDb(), sql`SELECT r.party_size, g.phone_normalized FROM reservations r JOIN guests g ON g.id = r.guest_id WHERE r.id = ${res.body.reservation.id}`);
    expect(rows[0]).toMatchObject({ party_size: 4, phone_normalized: '+9647701112233' });
    const alloc = await q(getDb(), sql`SELECT count(*)::int AS n FROM table_allocations WHERE reservation_id = ${res.body.reservation.id} AND active`);
    expect(alloc[0]!.n).toBe(1);
  });

  it('CRITICAL §81: two devices booking the same table at the same time → exactly one succeeds', async () => {
    const deviceA = (await createStaff(app, r.admin, 'host', [r.branchId])).client;
    const deviceB = (await createStaff(app, r.admin, 'reception', [r.branchId])).client;
    const body = (name: string) => ({ ...base(), time: '18:00', partySize: 2, tableIds: [r.tables.T1], guest: { firstName: name } });
    const [a, b] = await Promise.all([deviceA.post('/api/v1/reservations', body('Device A guest')), deviceB.post('/api/v1/reservations', body('Device B guest'))]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe('table_unavailable');
    expect(loser.body.error.message).toBe('Table no longer available. Please select another table/time.');
    const active = await q(getDb(), sql`SELECT count(*)::int AS n FROM table_allocations WHERE table_id = ${r.tables.T1} AND active`);
    expect(active[0]!.n).toBe(1);
    // the losing reservation was rolled back completely
    const res = await q(getDb(), sql`SELECT count(*)::int AS n FROM reservations WHERE guest_name IN ('Device A guest', 'Device B guest')`);
    expect(res[0]!.n).toBe(1);
  });

  it('allows back-to-back bookings but enforces the turnover buffer', async () => {
    const first = await host.post('/api/v1/reservations', { ...base(), time: '13:00', partySize: 4, tableIds: [r.tables.T3] });
    expect(first.status).toBe(201);
    // 4 pax → 120 min + 15 min buffer → table held until 15:15
    const tooEarly = await host.post('/api/v1/reservations', { ...base(), time: '15:00', partySize: 2, tableIds: [r.tables.T3] });
    expect(tooEarly.status).toBe(409);
    const ok = await host.post('/api/v1/reservations', { ...base(), time: '15:30', partySize: 2, tableIds: [r.tables.T3] });
    expect(ok.status).toBe(201);
  });

  it('validates opening hours and capacity', async () => {
    const closed = await host.post('/api/v1/reservations', { ...base(), time: '09:00' });
    expect(closed.status).toBe(422);
    expect(closed.body.error.code).toBe('outside_hours');
    const tooBig = await host.post('/api/v1/reservations', { ...base(), partySize: 9, tableIds: [r.tables.T1] });
    expect(tooBig.status).toBe(422);
    expect(tooBig.body.error.code).toBe('insufficient_capacity');
    // a host cannot override hours, a manager can
    expect((await host.post('/api/v1/reservations', { ...base(), time: '09:00', overrideHours: true })).status).toBe(403);
    expect((await r.admin.post('/api/v1/reservations', { ...base(), time: '09:00', overrideHours: true })).status).toBe(201);
  });

  it('auto-assigns the best fitting table and supports table combinations', async () => {
    const auto = await host.post('/api/v1/reservations', { ...base(), time: '22:00', partySize: 3, autoAssignTable: true });
    expect(auto.status).toBe(201);
    expect(auto.body.reservation.tableIds).toHaveLength(1);
    const combo = await r.admin.post('/api/v1/table-combinations', { branchId: r.branchId, name: 'T2+T3', tableIds: [r.tables.T2, r.tables.T3], minCapacity: 5, maxCapacity: 8 });
    expect(combo.status).toBe(200);
    // Combined capacity: party of 7 at T2+T3 (4+4) is accepted
    const big = await host.post('/api/v1/reservations', { ...base(), date: addDays(tomorrow(), 1), time: '19:00', partySize: 7, tableIds: [r.tables.T2, r.tables.T3] });
    expect(big.status).toBe(201);
    const slots = await host.get(`/api/v1/availability/slots?branchId=${r.branchId}&date=${addDays(tomorrow(), 2)}&partySize=7`);
    expect(slots.body.slots.some((s: { available: boolean }) => s.available)).toBe(true);
  });

  it('runs the full service lifecycle with timeline and guest statistics', async () => {
    const created = await host.post('/api/v1/reservations', { ...base(), date: addDays(tomorrow(), 3), time: '21:00', partySize: 2, tableIds: [r.tables.P1], guest: { firstName: 'Omar', phone: '07801234567' } });
    const id = created.body.reservation.id;
    expect((await host.post(`/api/v1/reservations/${id}/check-in`)).body.status).toBe('checked_in');
    const seatRes = await host.post(`/api/v1/reservations/${id}/seat`);
    expect(seatRes.body.status, JSON.stringify(seatRes.body)).toBe('seated');
    expect((await host.post(`/api/v1/reservations/${id}/start-dining`)).body.status).toBe('dining');
    expect((await host.post(`/api/v1/reservations/${id}/complete`)).body.status).toBe('completed');
    const illegal = await host.post(`/api/v1/reservations/${id}/seat`);
    expect(illegal.status).toBe(409);
    expect(illegal.body.error.code).toBe('invalid_transition');
    const events = await host.get(`/api/v1/reservations/${id}/events`);
    expect(events.body.map((e: { type: string }) => e.type)).toEqual(['created', 'check_in', 'seat', 'start_dining', 'complete']);
    const guest = await q(getDb(), sql`SELECT visit_count, reservation_count FROM guests WHERE id = ${created.body.reservation.guestId}`);
    expect(guest[0]).toMatchObject({ visit_count: 1, reservation_count: 1 });
    // table released and marked for cleaning
    const live = await host.get(`/api/v1/tables/live?branchId=${r.branchId}`);
    expect(live.body.find((t: { id: string }) => t.id === r.tables.P1).liveStatus).toBe('cleaning');
  });

  it('cancels (releasing the table) and reschedules with a linked reservation', async () => {
    const d = addDays(tomorrow(), 4);
    const a = await host.post('/api/v1/reservations', { ...base(), date: d, time: '20:00', tableIds: [r.tables.T4] });
    const cancel = await host.post(`/api/v1/reservations/${a.body.reservation.id}/cancel`, { reason: 'Guest called' });
    expect(cancel.body.status).toBe('cancelled');
    const again = await host.post('/api/v1/reservations', { ...base(), date: d, time: '20:00', tableIds: [r.tables.T4] });
    expect(again.status).toBe(201);
    const moved = await host.post(`/api/v1/reservations/${again.body.reservation.id}/reschedule`, { date: d, time: '22:30', tableIds: [r.tables.T4] });
    expect(moved.status).toBe(200);
    expect(moved.body.previous.status).toBe('rescheduled');
    expect(moved.body.reservation.rescheduledFromId).toBe(again.body.reservation.id);
    expect(moved.body.reservation.time).toBe('22:30');
  });

  it('handles walk-ins: seats immediately or joins the waitlist, then seats from the waitlist', async () => {
    // block every table for now so the walk-in has to wait
    const tables = Object.values(r.tables);
    for (const t of tables) await r.admin.post(`/api/v1/tables/${t}/status`, { status: 'blocked', reason: 'test' });
    const w = await host.post('/api/v1/walk-ins', { branchId: r.branchId, partySize: 2, guest: { firstName: 'Walk', lastName: 'In' }, quotedWaitMinutes: 15 });
    expect(w.body.seated).toBe(false);
    const entryId = w.body.waitlistEntry.id;
    for (const t of tables) await r.admin.post(`/api/v1/tables/${t}/status`, { status: 'available' });
    const sugg = await host.get(`/api/v1/waitlist/suggestions?branchId=${r.branchId}&tableId=${r.tables.T1}`);
    expect(sugg.body[0].entry.id).toBe(entryId);
    const seated = await host.post(`/api/v1/waitlist/${entryId}/seat`, { tableIds: [r.tables.T1] });
    expect(seated.body.entry.status).toBe('seated');
    expect(seated.body.reservation.status).toBe('seated');
    expect(seated.body.reservation.source).toBe('walk_in');
    const live = await host.get(`/api/v1/tables/live?branchId=${r.branchId}`);
    expect(live.body.find((t: { id: string }) => t.id === r.tables.T1).liveStatus).toBe('occupied');
  });

  it('is idempotent for client-generated ids (safe retries)', async () => {
    const id = uuidv7();
    const body = { ...base(), id, date: addDays(tomorrow(), 5), time: '19:30', partySize: 2, tableIds: [r.tables.T1] };
    const first = await host.post('/api/v1/reservations', body);
    const second = await host.post('/api/v1/reservations', body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    const n = await q(getDb(), sql`SELECT count(*)::int AS n FROM reservations WHERE id = ${id}`);
    expect(n[0]!.n).toBe(1);
  });
});
