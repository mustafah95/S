import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:http';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { closeDb, getDb, q, q1, sql } from '../src/db/pool.js';
import { config } from '../src/config.js';
import { readCurrent, signedPayload, writeCurrent, type ReleaseEntry } from '../src/updater/package.js';
import { runUpdateJob, type UpdaterDeps } from '../src/updater/service.js';
import { setupRestaurant, startTestServer, tomorrow, type Restaurant } from './helpers.js';

/**
 * CRITICAL §82 — update 1.0.0 → 1.1.0: backup, download, verify, migrate, update backend + frontend, restart,
 * health check, confirm, preserve data. Plus failure paths: broken migration and failed health check (rollback).
 */

let app: FastifyInstance;
let r: Restaurant;
let server: Server;
let baseUrl: string;
const work = mkdtempSync(join(tmpdir(), 'sofia-update-'));
const installRoot = join(work, 'install');
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
/** Test migrations are numbered after the newest real migration, so the suite keeps working as migrations are added. */
const LATEST = Math.max(...readdirSync(config.migrationsDir).filter((f) => /^\d+_.*\.sql$/.test(f)).map((f) => Number(f.split('_')[0])));
const mig = (offset: number, name: string) => `${String(LATEST + offset).padStart(3, '0')}_${name}.sql`;
/** Releases are cumulative: every package ships all earlier migrations. */
const V110 = { [mig(1, 'guest_favorite_drink')]: 'ALTER TABLE guests ADD COLUMN favorite_drink text;\n' };
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

async function buildPackage(version: string, extraMigrations: Record<string, string>): Promise<string> {
  const stage = join(work, `stage-${version}`);
  mkdirSync(join(stage, 'server', 'migrations'), { recursive: true });
  mkdirSync(join(stage, 'web'), { recursive: true });
  cpSync(config.migrationsDir, join(stage, 'server', 'migrations'), { recursive: true });
  for (const [name, body] of Object.entries(extraMigrations)) writeFileSync(join(stage, 'server', 'migrations', name), body);
  writeFileSync(join(stage, 'server', 'main.js'), `// Sofia ${version} server bundle\n`);
  writeFileSync(join(stage, 'web', 'index.html'), `<!doctype html><title>Sofia ${version}</title>`);
  writeFileSync(join(stage, 'release.json'), JSON.stringify({ version }));
  const file = join(work, `sofia-${version}.tar.gz`);
  await tar.c({ gzip: true, file, cwd: stage }, ['release.json', 'server', 'web']);
  return file;
}

function releaseEntry(version: string, file: string, minFrom = '1.0.0'): ReleaseEntry {
  const data = readFileSync(file);
  const entry = {
    version,
    releasedAt: new Date().toISOString(),
    notes: { en: `Release ${version}`, ar: `الإصدار ${version}` },
    minFromVersion: minFrom,
    url: `${baseUrl}/${file.split('/').pop()}`,
    sha256: createHash('sha256').update(data).digest('hex'),
    size: data.length,
    signature: '',
  };
  entry.signature = sign(null, Buffer.from(signedPayload(entry)), privateKey).toString('base64');
  return entry;
}

function deps(healthy: (v: string) => boolean, restarts: string[][]): UpdaterDeps {
  return {
    installRoot,
    publicKeyPem,
    downloadsDir: join(work, 'downloads'),
    controller: { kind: 'test', restart: async (s) => void restarts.push(s) },
    // The restarted application reports the version that current.json points to.
    healthCheck: async (v) => {
      if (readCurrent(installRoot)?.version !== v || !healthy(v)) throw new Error(`health check failed for ${v}`);
    },
  };
}

async function createJob(from: string, entry: ReleaseEntry): Promise<string> {
  const row = await q1<{ id: string }>(getDb(), sql`INSERT INTO system_updates (from_version, to_version, status, manifest) VALUES (${from}, ${entry.version}, 'running', ${JSON.stringify(entry)}::jsonb) RETURNING id`);
  return row!.id;
}

async function dataSnapshot() {
  return q1<{ guests: number; reservations: number; audit: number }>(
    getDb(),
    sql`SELECT (SELECT count(*)::int FROM guests) AS guests, (SELECT count(*)::int FROM reservations) AS reservations, (SELECT count(*)::int FROM audit_logs) AS audit`,
  );
}

beforeAll(async () => {
  app = await startTestServer();
  r = await setupRestaurant(app);
  server = createServer((req, res) => {
    const f = join(work, req.url!.slice(1));
    if (!existsSync(f)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/gzip' }).end(readFileSync(f));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // Installed release 1.0.0
  mkdirSync(join(installRoot, 'releases', '1.0.0', 'server'), { recursive: true });
  writeFileSync(join(installRoot, 'releases', '1.0.0', 'server', 'main.js'), '// 1.0.0');
  cpSync(config.migrationsDir, join(installRoot, 'releases', '1.0.0', 'server', 'migrations'), { recursive: true });
  writeCurrent(installRoot, { version: '1.0.0' });
  // Business data that must survive every update.
  await r.admin.post('/api/v1/reservations', { branchId: r.branchId, date: tomorrow(), time: '20:00', partySize: 4, guest: { firstName: 'Before', lastName: 'Update', phone: '07700000001' } });
});

afterAll(async () => {
  server.close();
  await app.close();
  await closeDb();
});

describe('CRITICAL §82 — Update Center', () => {
  it('updates 1.0.0 → 1.1.0 with backup, verification, migration, restart, health check and no data loss', async () => {
    const before = await dataSnapshot();
    const pkg = await buildPackage('1.1.0', V110);
    const entry = releaseEntry('1.1.0', pkg);
    const jobId = await createJob('1.0.0', entry);
    const restarts: string[][] = [];
    const status = await runUpdateJob(jobId, deps(() => true, restarts));
    expect(status).toBe('completed');

    const job = await q1<{ status: string; steps: { step: string; status: string }[]; backup_id: string; migrations_applied: number[] }>(getDb(), sql`SELECT * FROM system_updates WHERE id = ${jobId}`);
    const done = job!.steps.filter((s) => s.status === 'done').map((s) => s.step);
    // 1 backup · 2 download · 3 verify · 4 migrate · 5+6 backend & frontend · 7 restart · 8 health · 9 confirm
    expect(done).toEqual(['backing_up', 'downloading', 'verifying', 'installing', 'migrating', 'switching', 'restarting', 'health_check']);
    expect(job!.status).toBe('completed');
    const backup = await q1<{ kind: string; status: string; file_path: string }>(getDb(), sql`SELECT kind, status, file_path FROM backups WHERE id = ${job!.backup_id}`);
    expect(backup).toMatchObject({ kind: 'pre_update', status: 'completed' });
    expect(existsSync(backup!.file_path)).toBe(true);
    expect(job!.migrations_applied).toEqual([LATEST + 1]);
    const col = await q(getDb(), sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'guests' AND column_name = 'favorite_drink'`);
    expect(col).toHaveLength(1);
    expect(readFileSync(join(installRoot, 'releases', '1.1.0', 'web', 'index.html'), 'utf8')).toContain('1.1.0');
    expect(existsSync(join(installRoot, 'releases', '1.1.0', 'server', 'main.js'))).toBe(true);
    expect(readCurrent(installRoot)).toMatchObject({ version: '1.1.0', previous: '1.0.0' });
    expect(restarts).toEqual([['api', 'worker']]);
    const after = await dataSnapshot();
    expect(after!.guests).toBe(before!.guests);
    expect(after!.reservations).toBe(before!.reservations);
    const m = await q1<{ enabled: boolean }>(getDb(), sql`SELECT (value->>'enabled')::boolean AS enabled FROM app_settings WHERE key = 'system.maintenance'`);
    expect(m!.enabled).toBe(false);
  });

  it('refuses a tampered package (signature/checksum) and changes nothing', async () => {
    const pkg = await buildPackage('1.2.0', V110);
    const entry = { ...releaseEntry('1.2.0', pkg, '1.1.0') };
    writeFileSync(pkg, Buffer.concat([readFileSync(pkg), Buffer.from('tampered')]));
    const jobId = await createJob('1.1.0', entry);
    const status = await runUpdateJob(jobId, deps(() => true, []));
    expect(status).toBe('failed');
    const job = await q1<{ error: string }>(getDb(), sql`SELECT error FROM system_updates WHERE id = ${jobId}`);
    expect(job!.error).toMatch(/Checksum mismatch/);
    expect(readCurrent(installRoot)!.version).toBe('1.1.0');
  });

  it('stops safely when a migration fails (transactional migration, nothing switched)', async () => {
    const before = await dataSnapshot();
    const pkg = await buildPackage('1.2.1', { ...V110, [mig(2, 'broken')]: 'ALTER TABLE does_not_exist ADD COLUMN x int;\n' });
    const jobId = await createJob('1.1.0', releaseEntry('1.2.1', pkg, '1.1.0'));
    const status = await runUpdateJob(jobId, deps(() => true, []));
    expect(['failed', 'rolled_back']).toContain(status);
    expect(readCurrent(installRoot)!.version).toBe('1.1.0');
    const v = await q(getDb(), sql`SELECT version FROM schema_migrations WHERE version = ${LATEST + 2}`);
    expect(v).toHaveLength(0);
    expect(await dataSnapshot()).toMatchObject({ guests: before!.guests, reservations: before!.reservations });
  });

  it('rolls back application AND database when the new version fails its health check', async () => {
    const before = await dataSnapshot();
    const pkg = await buildPackage('1.3.0', { ...V110, [mig(2, 'loyalty_note')]: 'ALTER TABLE loyalty_transactions ADD COLUMN note text;\n' });
    const jobId = await createJob('1.1.0', releaseEntry('1.3.0', pkg, '1.1.0'));
    const restarts: string[][] = [];
    const status = await runUpdateJob(jobId, deps((v) => v !== '1.3.0', restarts));
    const dbg = await q1<{ error: string; steps: unknown }>(getDb(), sql`SELECT error, steps FROM system_updates WHERE id = ${jobId}`);
    expect(status, JSON.stringify(dbg)).toBe('rolled_back');
    expect(readCurrent(installRoot)!.version).toBe('1.1.0');
    const col = await q(getDb(), sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'loyalty_transactions' AND column_name = 'note'`);
    expect(col).toHaveLength(0); // database restored from the pre-update backup
    const m = await q(getDb(), sql`SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1`);
    expect(m[0]!.version).toBe(LATEST + 1);
    expect(restarts).toHaveLength(2); // restart into 1.3.0, then back into 1.1.0
    const after = await dataSnapshot();
    expect(after!.guests).toBe(before!.guests);
    expect(after!.reservations).toBe(before!.reservations);
    const epoch = await q1<{ e: string }>(getDb(), sql`SELECT value->>'epoch' AS e FROM app_settings WHERE key = 'system.epoch'`);
    expect(epoch!.e).toMatch(/^[0-9a-f]{16}$/); // devices are told to rebuild their local copy
  });

  it('keeps installed releases side by side (rollback targets); tampered packages are never extracted', () => {
    expect(readdirSync(join(installRoot, 'releases')).filter((d) => !d.startsWith('.')).sort()).toEqual(['1.0.0', '1.1.0', '1.2.1', '1.3.0']);
  });
});

describe('migration safety', () => {
  it('refuses to run when an applied migration file was modified', async () => {
    const { runMigrations } = await import('../src/db/migrator.js');
    const dir = mkdtempSync(join(tmpdir(), 'sofia-mig-'));
    cpSync(config.migrationsDir, dir, { recursive: true });
    writeFileSync(join(dir, mig(1, 'guest_favorite_drink')), 'ALTER TABLE guests ADD COLUMN favorite_drink text;\n');
    writeFileSync(join(dir, '001_initial.sql'), readFileSync(join(dir, '001_initial.sql'), 'utf8') + '\n-- edited');
    await expect(runMigrations(config.databaseOwnerUrl, dir)).rejects.toThrow(/modified after it was applied/);
  });

  it('keeps the Drizzle schema in sync with the database (no drift)', async () => {
    const schema = await import('../src/db/schema.js');
    const { getTableConfig, PgTable } = await import('drizzle-orm/pg-core');
    const dbCols = await q<{ table_name: string; column_name: string }>(getDb(), sql`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`);
    const actual = new Map<string, Set<string>>();
    for (const c of dbCols) actual.set(c.table_name, (actual.get(c.table_name) ?? new Set()).add(c.column_name));
    for (const t of Object.values(schema)) {
      if (!(t instanceof PgTable)) continue;
      const cfg = getTableConfig(t);
      for (const col of cfg.columns) expect(actual.get(cfg.name)?.has(col.name), `${cfg.name}.${col.name}`).toBe(true);
    }
  });
});
