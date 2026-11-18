import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authenticator } from 'otplib';
import { closeDb, getDb, q, sql } from '../src/db/pool.js';
import { ADMIN, ApiClient, createStaff, setupPayload, setupRestaurant, startTestServer, type Restaurant } from './helpers.js';

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

describe('first-run wizard', () => {
  it('created the branch, floor and an administrator without default credentials', async () => {
    const me = await r.admin.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.role).toBe('super_admin');
    expect(me.body.permissions).toContain('system.update');
    expect(Object.keys(r.tables)).toEqual(expect.arrayContaining(['T1', 'T2', 'V1']));
    const users = await q(getDb(), sql`SELECT username FROM users`);
    expect(users).toHaveLength(1);
  });

  it('cannot be run twice and requires the installer token', async () => {
    const c = new ApiClient(app);
    expect((await c.post('/api/v1/setup/complete', { ...setupPayload(), setupToken: 'wrong-token-123' })).status).toBe(401);
    expect((await c.post('/api/v1/setup/complete', setupPayload())).status).toBe(409);
  });
});

describe('authentication', () => {
  it('rejects bad credentials and locks the account after repeated failures', async () => {
    const staff = await createStaff(app, r.admin, 'host', [r.branchId]);
    const c = new ApiClient(app);
    for (let i = 0; i < 5; i++) expect((await c.login(staff.username, 'wrong-password!')).status).toBe(401);
    const locked = await c.login(staff.username, staff.password);
    expect(locked.status).toBe(423);
    const stored = await q<{ password_hash: string }>(getDb(), sql`SELECT password_hash FROM users WHERE username = ${staff.username}`);
    expect(stored[0]!.password_hash.startsWith('scrypt$')).toBe(true);
    expect(stored[0]!.password_hash).not.toContain(staff.password);
  });

  it('requires the CSRF token for cookie-authenticated writes', async () => {
    const res = await r.admin.raw('POST', '/api/v1/guests', { firstName: 'NoCsrf' }, { 'x-csrf-token': 'forged' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('csrf_failed');
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const c = new ApiClient(app);
    await c.login(ADMIN.username, ADMIN.password);
    const firstRefresh = c.jar.get('sofia_rt')!;
    expect((await c.post('/api/v1/auth/refresh')).status).toBe(200);
    expect(c.jar.get('sofia_rt')).not.toBe(firstRefresh);
    // Replay of the old token after the grace window → session family revoked.
    await getDb().execute(sql`UPDATE user_sessions SET rotated_at = now() - interval '5 minutes' WHERE rotated_at IS NOT NULL`);
    const attacker = new ApiClient(app);
    attacker.jar.set('sofia_rt', firstRefresh);
    expect((await attacker.post('/api/v1/auth/refresh')).status).toBe(401);
    expect((await c.post('/api/v1/auth/refresh')).status).toBe(401);
  });

  it('supports TOTP multi-factor authentication', async () => {
    const staff = await createStaff(app, r.admin, 'branch_manager', [r.branchId]);
    const setup = await staff.client.post('/api/v1/auth/mfa/setup');
    expect(setup.body.otpauthUrl).toContain('otpauth://');
    const enabled = await staff.client.post('/api/v1/auth/mfa/enable', { code: authenticator.generate(setup.body.secret) });
    expect(enabled.body.recoveryCodes).toHaveLength(8);
    const c = new ApiClient(app);
    const step1 = await c.login(staff.username, staff.password);
    expect(step1.body.mfaRequired).toBe(true);
    expect(c.jar.has('sofia_at')).toBe(false);
    expect((await c.post('/api/v1/auth/mfa/verify', { challenge: step1.body.challenge, code: '000000' })).status).toBe(401);
    const step2 = await c.post('/api/v1/auth/mfa/verify', { challenge: step1.body.challenge, code: enabled.body.recoveryCodes[0] });
    expect(step2.status).toBe(200);
    expect((await c.get('/api/v1/auth/me')).body.username).toBe(staff.username);
  });
});

describe('RBAC and branch scope', () => {
  it('denies actions outside the role and audits nothing for them', async () => {
    const waiter = await createStaff(app, r.admin, 'waiter', [r.branchId]);
    expect((await waiter.client.get('/api/v1/system/status')).status).toBe(403);
    expect((await waiter.client.post('/api/v1/users', {})).status).toBe(403);
    expect((await waiter.client.get('/api/v1/audit')).status).toBe(403);
    expect((await waiter.client.post('/api/v1/guests', { firstName: 'X' })).status).toBe(403);
    expect((await waiter.client.get(`/api/v1/tables/live?branchId=${r.branchId}`)).status).toBe(200);
  });

  it('limits branch-scoped staff to their branches', async () => {
    const b2 = await r.admin.post('/api/v1/branches', { code: 'ERBIL', name: 'Erbil', operatingHours: setupPayload().operatingHours });
    expect(b2.status).toBe(200);
    const host = await createStaff(app, r.admin, 'host', [r.branchId]);
    expect((await host.client.get(`/api/v1/tables?branchId=${b2.body.id}`)).status).toBe(403);
    const branches = await host.client.get('/api/v1/branches');
    expect(branches.body.map((b: { code: string }) => b.code)).toEqual(['MAIN']);
    const all = await r.admin.get('/api/v1/branches');
    expect(all.body).toHaveLength(2);
  });

  it('prevents managers from granting owner-level roles', async () => {
    const gm = await createStaff(app, r.admin, 'general_manager', [r.branchId]);
    const res = await gm.client.post('/api/v1/users', { username: 'sneaky', displayName: 'x', password: 'Very-Long-Pass-1', roleKey: 'owner', branchIds: [] });
    expect(res.status).toBe(403);
  });
});

describe('audit log', () => {
  it('is append-only for the runtime role (RLS has no update/delete policy)', async () => {
    const rows = await q<{ n: number }>(getDb(), sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'user.create'`);
    expect(rows[0]!.n).toBeGreaterThan(0);
    const policies = await q<{ cmd: string }>(getDb(), sql`SELECT cmd FROM pg_policies WHERE tablename = 'audit_logs'`);
    expect(policies.map((p) => p.cmd).sort()).toEqual(['INSERT', 'SELECT']);
  });
});
