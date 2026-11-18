import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDb, getDb, q, q1, sql } from '../src/db/pool.js';
import { scheduledBackupDue } from '../src/modules/system/backup.js';
import { createStaff, setupRestaurant, startTestServer, type Restaurant } from './helpers.js';

let app: FastifyInstance;
let r: Restaurant;

beforeAll(async () => {
  app = await startTestServer();
  r = await setupRestaurant(app);
});
afterAll(async () => {
  await app.close();
  await closeDb();
});

describe('backup & restore', () => {
  it('creates a verified backup and restores it without moving the sync feed backwards', async () => {
    await r.admin.post('/api/v1/guests', { firstName: 'Kept' });
    const b = await r.admin.post('/api/v1/backups');
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ status: 'completed', verify_status: 'passed', kind: 'manual' });
    expect(b.body.sha256).toMatch(/^[0-9a-f]{64}$/);

    await r.admin.post('/api/v1/guests', { firstName: 'AfterBackup' });
    const seqBefore = await q1<{ v: number }>(getDb(), sql`SELECT last_value AS v FROM sofia_sync_seq`);

    expect((await r.admin.post(`/api/v1/backups/${b.body.id}/restore`, { confirm: 'nope' })).status).toBe(422);
    const restored = await r.admin.post(`/api/v1/backups/${b.body.id}/restore`, { confirm: 'RESTORE' });
    expect(restored.status).toBe(200);
    const names = (await q<{ first_name: string }>(getDb(), sql`SELECT first_name FROM guests`)).map((g) => g.first_name);
    expect(names).toContain('Kept');
    expect(names).not.toContain('AfterBackup');
    const seqAfter = await q1<{ v: number }>(getDb(), sql`SELECT last_value AS v FROM sofia_sync_seq`);
    expect(seqAfter!.v).toBeGreaterThan(seqBefore!.v);
    // a pre-restore safety backup exists
    const kinds = (await r.admin.get('/api/v1/backups')).body.map((x: { kind: string }) => x.kind);
    expect(kinds).toContain('pre_restore');
    // the system left maintenance mode and accepts writes again
    expect((await r.admin.post('/api/v1/guests', { firstName: 'AfterRestore' })).status).toBe(200);
  });

  it('only administrators can back up or restore', async () => {
    const host = await createStaff(app, r.admin, 'host', [r.branchId]);
    expect((await host.client.post('/api/v1/backups')).status).toBe(403);
    const gm = await createStaff(app, r.admin, 'general_manager', [r.branchId]);
    const list = await gm.client.get('/api/v1/backups');
    expect(list.status).toBe(200);
    expect((await gm.client.post(`/api/v1/backups/${list.body[0].id}/restore`, { confirm: 'RESTORE' })).status).toBe(403);
  });

  it('schedules the next automatic backup after the configured time', async () => {
    await getDb().execute(sql`DELETE FROM backups WHERE kind = 'scheduled'`);
    await r.admin.put('/api/v1/settings/backup', { value: { enabled: true, frequency: 'every_6_hours', timeOfDay: '00:00' } });
    expect(await scheduledBackupDue()).toBe(true);
    await getDb().execute(sql`INSERT INTO backups (file_name, file_path, kind, status, finished_at) VALUES ('x', '/tmp/x', 'scheduled', 'completed', now() - interval '1 day')`);
    expect(await scheduledBackupDue()).toBe(false);
  });

  it('reports backup and system health to administrators', async () => {
    const status = await r.admin.get('/api/v1/system/status');
    expect(status.body.server.services.map((s: { name: string }) => s.name)).toEqual(['PostgreSQL', 'API Server', 'Web Server', 'Sync Engine', 'Backup Service', 'Update Service']);
    expect(status.body.health.checks.backup.lastSuccessAt).toBeTruthy();
    const logs = await r.admin.get('/api/v1/system/logs?category=backup');
    expect(logs.body.length).toBeGreaterThan(0);
  });
});
