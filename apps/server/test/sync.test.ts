import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SYNC_PROTOCOL_VERSION, uuidv7, type SyncOperation } from '@sofia/shared';
import { closeDb, getDb, q, sql } from '../src/db/pool.js';
import { ApiClient, createStaff, setupPayload, setupRestaurant, startTestServer, tomorrow, type Restaurant } from './helpers.js';

let app: FastifyInstance;
let r: Restaurant;
let host: { client: ApiClient; userId: string };
let manager: { client: ApiClient; userId: string };

beforeAll(async () => {
  app = await startTestServer();
  r = await setupRestaurant(app);
  host = await createStaff(app, r.admin, 'host', [r.branchId]);
  manager = await createStaff(app, r.admin, 'reservation_manager', [r.branchId]);
});
afterAll(async () => {
  await app.close();
  await closeDb();
});

function op(userId: string, partial: Omit<SyncOperation, 'opId' | 'clientTs' | 'userId'> & { clientTs?: string }): SyncOperation {
  return { opId: uuidv7(), clientTs: new Date().toISOString(), userId, ...partial };
}

async function push(c: ApiClient, ops: SyncOperation[]) {
  const res = await c.post('/api/v1/sync/push', { deviceId: c.deviceId, protocol: SYNC_PROTOCOL_VERSION, ops });
  expect(res.status).toBe(200);
  return res.body.results as { status: string; entity: any; conflictId?: string; error?: { code: string }; conflictingFields?: string[]; mergedFields?: string[] }[];
}

describe('CRITICAL §80 — offline operations reach PostgreSQL exactly once', () => {
  it('server ON: a reservation pushed by the device is stored in PostgreSQL', async () => {
    const id = uuidv7();
    const [res] = await push(host.client, [
      op(host.userId, { entityType: 'reservation', entityId: id, op: 'create', branchId: r.branchId, payload: { branchId: r.branchId, date: tomorrow(), time: '19:00', partySize: 2, tableIds: [r.tables.T1], guest: { firstName: 'Online', lastName: 'Guest' } } }),
    ]);
    expect(res!.status).toBe('applied');
    const rows = await q(getDb(), sql`SELECT status, origin FROM reservations WHERE id = ${id}`);
    expect(rows[0]).toMatchObject({ status: 'confirmed', origin: 'offline' });
  });

  it('server OFF → ON: guest + reservation + notes queued offline are applied, audited and never duplicated', async () => {
    const guestId = uuidv7();
    const resId = uuidv7();
    const noteId = uuidv7();
    // Recorded while the server was unreachable (client timestamps in the past).
    const offlineAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const batch = [
      op(host.userId, { entityType: 'guest', entityId: guestId, op: 'create', clientTs: offlineAt, payload: { firstName: 'Noor', lastName: 'Ali', phone: '0750 555 1234', allergies: ['shellfish'] } }),
      op(host.userId, { entityType: 'reservation', entityId: resId, op: 'create', clientTs: offlineAt, branchId: r.branchId, payload: { branchId: r.branchId, guestId, date: tomorrow(), time: '21:00', partySize: 4, tableIds: [r.tables.T2], notes: 'Window seat please', source: 'phone' } }),
      op(host.userId, { entityType: 'guest_note', entityId: noteId, op: 'create', clientTs: offlineAt, payload: { guestId, body: 'Prefers sparkling water' } }),
    ];
    const results = await push(host.client, batch);
    expect(results.map((x) => x.status)).toEqual(['applied', 'applied', 'applied']);

    const db = getDb();
    expect((await q(db, sql`SELECT first_name FROM guests WHERE id = ${guestId}`))[0]).toMatchObject({ first_name: 'Noor' });
    expect((await q(db, sql`SELECT notes, guest_id, client_created_at FROM reservations WHERE id = ${resId}`))[0]).toMatchObject({ notes: 'Window seat please', guest_id: guestId });
    expect((await q(db, sql`SELECT body FROM guest_notes WHERE id = ${noteId}`))[0]).toMatchObject({ body: 'Prefers sparkling water' });
    const audits = await q<{ action: string; device_id: string }>(db, sql`SELECT action, device_id FROM audit_logs WHERE entity_id IN (${guestId}, ${resId}) ORDER BY id`);
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['guest.create_offline', 'reservation.create', 'guest.note_add']));
    expect(audits.every((a) => a.device_id === host.client.deviceId)).toBe(true);

    // The response was lost and the device pushes the same queue again → no duplicates.
    const replay = await push(host.client, batch);
    expect(replay.map((x) => x.status)).toEqual(['duplicate', 'duplicate', 'duplicate']);
    const counts = await q<{ g: number; r: number; n: number }>(
      db,
      sql`SELECT (SELECT count(*)::int FROM guests WHERE first_name = 'Noor') AS g,
                 (SELECT count(*)::int FROM reservations WHERE notes = 'Window seat please') AS r,
                 (SELECT count(*)::int FROM guest_notes WHERE body = 'Prefers sparkling water') AS n`,
    );
    expect(counts[0]).toEqual({ g: 1, r: 1, n: 1 });
  });

  it('pull returns the changes once and then an empty feed', async () => {
    const first = await host.client.get(`/api/v1/sync/pull?cursor=0&deviceId=${host.client.deviceId}`);
    expect(first.status).toBe(200);
    let cursor = first.body.cursor;
    let pages = [first.body];
    while (pages.at(-1).hasMore) {
      const next = await host.client.get(`/api/v1/sync/pull?cursor=${cursor}`);
      pages.push(next.body);
      cursor = next.body.cursor;
    }
    const guests = pages.flatMap((p) => p.changes.guests ?? []);
    expect(guests.some((g: { firstName: string }) => g.firstName === 'Noor')).toBe(true);
    expect(guests.every((g: Record<string, unknown>) => !('privacyToken' in g))).toBe(true);
    const again = await host.client.get(`/api/v1/sync/pull?cursor=${cursor}`);
    expect(Object.values(again.body.changes).flat()).toHaveLength(0);
  });
});

describe('conflict management', () => {
  it('keeps an offline reservation that lost its table, flags it for review and notifies staff', async () => {
    const online = await manager.client.post('/api/v1/reservations', { branchId: r.branchId, date: tomorrow(), time: '13:00', partySize: 4, tableIds: [r.tables.T3] });
    expect(online.status).toBe(201);
    const id = uuidv7();
    const [res] = await push(host.client, [
      op(host.userId, { entityType: 'reservation', entityId: id, op: 'create', branchId: r.branchId, payload: { branchId: r.branchId, date: tomorrow(), time: '13:30', partySize: 4, tableIds: [r.tables.T3], guest: { firstName: 'Offline', lastName: 'Booker' } } }),
    ]);
    expect(res!.status).toBe('conflict');
    expect(res!.entity.requiresReview).toBe(true);
    expect(res!.entity.tableIds).toEqual([]);
    const conflicts = await manager.client.get('/api/v1/sync/conflicts');
    const c = conflicts.body.find((x: { entityId: string }) => x.entityId === id);
    expect(c.kind).toBe('reservation_overlap');
    const inbox = await manager.client.get('/api/v1/inbox');
    expect(inbox.body.some((n: { type: string }) => n.type === 'sync_conflict')).toBe(true);
    // host (no sync.review) cannot resolve
    expect((await host.client.post(`/api/v1/sync/conflicts/${c.id}/resolve`, { resolution: 'dismiss' })).status).toBe(403);
    const resolved = await manager.client.post(`/api/v1/sync/conflicts/${c.id}/resolve`, { resolution: 'custom', values: { tableIds: [r.tables.T4] } });
    expect(resolved.status).toBe(200);
    const after = await manager.client.get(`/api/v1/reservations/${id}`);
    expect(after.body).toMatchObject({ requiresReview: false, tableIds: [r.tables.T4] });
  });

  it('merges guest edits three-way and raises a conflict only for critical fields', async () => {
    const created = await manager.client.post('/api/v1/guests', { firstName: 'Zaid', phone: '07701000000', tags: ['Regular'], notes: 'n0', address: 'a0' });
    const g = created.body.guest;
    // Device B (online) edits first.
    await manager.client.patch(`/api/v1/guests/${g.id}`, { phone: '07702000000', tags: ['Regular', 'Corporate'], notes: 'server note' });
    // Device A was offline, based on the original version.
    const [res] = await push(host.client, [
      op(host.userId, {
        entityType: 'guest',
        entityId: g.id,
        op: 'update',
        baseVersion: g.version,
        baseValues: { phone: g.phone, tags: ['Regular'], allergies: [], notes: 'n0', address: 'a0' },
        payload: { phone: '07703000000', tags: ['Regular', 'Window seat'], allergies: ['nuts'], notes: 'device note', address: 'a1' },
      }),
    ]);
    expect(res!.status).toBe('conflict');
    expect(res!.conflictingFields).toEqual(['phone']);
    expect(res!.entity.phone).toBe('07702000000');
    expect(res!.entity.tags.sort()).toEqual(['Corporate', 'Regular', 'Window seat']);
    expect(res!.entity.allergies).toEqual(['nuts']);
    expect(res!.entity.address).toBe('a1');
    expect(res!.entity.notes).toBe('server note');
    const notes = await q(getDb(), sql`SELECT body, kind FROM guest_notes WHERE guest_id = ${g.id}`);
    expect(notes.some((n) => n.kind === 'offline_merge' && String(n.body).includes('device note'))).toBe(true);
    const resolved = await manager.client.post(`/api/v1/sync/conflicts/${res!.conflictId}/resolve`, { resolution: 'take_client' });
    expect(resolved.status).toBe(200);
    expect((await manager.client.get(`/api/v1/guests/${g.id}`)).body.phone).toBe('07703000000');
    const audit = await q(getDb(), sql`SELECT 1 FROM audit_logs WHERE action = 'sync.conflict_resolve' AND entity_id = ${g.id}`);
    expect(audit).toHaveLength(1);
  });

  it('detects impossible status transitions made offline', async () => {
    const created = await manager.client.post('/api/v1/reservations', { branchId: r.branchId, date: tomorrow(), time: '23:00', partySize: 2 });
    const id = created.body.reservation.id;
    await manager.client.post(`/api/v1/reservations/${id}/cancel`, { reason: 'changed plans' });
    const [res] = await push(host.client, [op(host.userId, { entityType: 'reservation', entityId: id, op: 'action', action: 'seat', payload: {} })]);
    expect(res!.status).toBe('conflict');
    expect(res!.entity.status).toBe('cancelled');
  });

  it('rejects invalid or unauthorised operations with a reason (and remembers them)', async () => {
    const waiter = await createStaff(app, r.admin, 'waiter', [r.branchId]);
    const bad = op(waiter.userId, { entityType: 'reservation', entityId: uuidv7(), op: 'create', payload: { branchId: r.branchId, date: tomorrow(), time: '20:00', partySize: 2 } });
    const [res] = await push(waiter.client, [bad]);
    expect(res!.status).toBe('rejected');
    expect(res!.error!.code).toBe('forbidden');
    const invalid = op(host.userId, { entityType: 'guest', entityId: uuidv7(), op: 'create', payload: { firstName: '' } });
    const [inv] = await push(host.client, [invalid]);
    expect(inv!.status).toBe('rejected');
    const [again] = await push(host.client, [invalid]);
    expect(again!.status).toBe('duplicate');
  });

  it('only sends a device the branches its user may see', async () => {
    const erbil = await r.admin.post('/api/v1/branches', { code: 'ERB', name: 'Erbil', operatingHours: setupPayload().operatingHours });
    await r.admin.post('/api/v1/reservations', { branchId: erbil.body.id, date: tomorrow(), time: '20:00', partySize: 2, overrideHours: true });
    let cursor = '0';
    const all: any[] = [];
    for (;;) {
      const p = await host.client.get(`/api/v1/sync/pull?cursor=${cursor}`);
      all.push(...(p.body.changes.reservations ?? []), ...(p.body.changes.branches ?? []));
      cursor = p.body.cursor;
      if (!p.body.hasMore) break;
    }
    expect(all.every((x) => (x.branchId ?? x.id) !== erbil.body.id)).toBe(true);
  });
});
