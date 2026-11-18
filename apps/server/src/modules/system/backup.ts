import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { copyFile, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { APP_VERSION, utcToZoned, parseHHMM } from '@sofia/shared';
import { config } from '../../config.js';
import { getDb, q, q1, sql } from '../../db/pool.js';
import { migrationStatus } from '../../db/migrator.js';
import { audit } from '../../lib/audit.js';
import type { RequestContext } from '../../lib/context.js';
import { AppError } from '../../lib/errors.js';
import { publish } from '../../lib/events.js';
import { getSetting, putSetting } from '../../lib/settings.js';
import { logEvent, notifyStaff } from '../../lib/system-events.js';

export type BackupKind = 'scheduled' | 'manual' | 'pre_update' | 'pre_restore';

/** Tables whose rows survive a restore (they describe the server's own history, not business data). Parent first. */
const PRESERVED_TABLES = ['backups', 'system_updates'] as const;

export interface BackupRecord {
  id: string;
  file_name: string;
  file_path: string;
  size_bytes: number | null;
  sha256: string | null;
  kind: BackupKind;
  status: string;
  verify_status: string | null;
  started_at: Date;
  finished_at: Date | null;
  error: string | null;
}

function pgTool(name: 'pg_dump' | 'pg_restore' | 'psql'): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  return config.pgBin ? join(config.pgBin, exe) : exe;
}

/** Run a PostgreSQL client tool with the connection string passed via environment (never on the command line). */
function runPg(tool: 'pg_dump' | 'pg_restore' | 'psql', args: string[], connectionString: string): Promise<{ code: number; stderr: string; stdout: string }> {
  const url = new URL(connectionString);
  const env = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: url.pathname.replace(/^\//, ''),
    PGSSLMODE: url.searchParams.get('sslmode') ?? process.env.PGSSLMODE ?? 'prefer',
  };
  return new Promise((resolve, reject) => {
    const child = spawn(pgTool(tool), args, { env, windowsHide: true });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.stdout.on('data', (d) => {
      if (stdout.length < 1_000_000) stdout += d.toString();
    });
    child.on('error', (err) => reject(new Error(`${tool} could not be started: ${err.message}. Set SOFIA_PG_BIN to the PostgreSQL bin directory.`)));
    child.on('close', (code) => resolve({ code: code ?? 1, stderr: stderr.slice(-4000), stdout }));
  });
}

async function fileSha256(path: string): Promise<string> {
  const h = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path).on('data', (c) => h.update(c)).on('end', resolve).on('error', reject);
  });
  return h.digest('hex');
}

function stamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/** pg_restore --list must succeed and the archive must contain core tables. Optionally restore into a scratch DB. */
export async function verifyBackupFile(path: string, mode: 'list' | 'full' = 'list'): Promise<void> {
  const list = await runPg('pg_restore', ['--list', path], config.databaseOwnerUrl);
  if (list.code !== 0) throw new Error(`pg_restore --list failed: ${list.stderr}`);
  for (const t of ['reservations', 'guests', 'schema_migrations']) {
    if (!new RegExp(`TABLE DATA public ${t} `).test(list.stdout)) throw new Error(`Backup does not contain table ${t}`);
  }
  if (mode === 'full') {
    const scratch = `sofia_verify_${randomBytes(4).toString('hex')}`;
    const admin = new URL(config.databaseOwnerUrl);
    const created = await runPg('psql', ['-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${scratch}`], admin.toString());
    if (created.code !== 0) throw new Error(`Full verification needs CREATEDB privilege: ${created.stderr}`);
    try {
      const target = new URL(config.databaseOwnerUrl);
      target.pathname = `/${scratch}`;
      const r = await runPg('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--dbname', scratch, path], target.toString());
      if (r.code !== 0) throw new Error(`Test restore failed: ${r.stderr}`);
    } finally {
      await runPg('psql', ['-c', `DROP DATABASE IF EXISTS ${scratch}`], admin.toString());
    }
  }
}

export async function createBackup(kind: BackupKind, ctx?: RequestContext): Promise<BackupRecord> {
  const db = getDb();
  const settings = await getSetting('backup');
  if (!existsSync(config.backupDir)) mkdirSync(config.backupDir, { recursive: true });
  const dbName = new URL(config.databaseOwnerUrl).pathname.replace(/^\//, '') || 'sofia';
  const fileName = `sofia_${dbName}_${stamp()}_${kind}.dump`;
  const filePath = join(config.backupDir, fileName);
  let schemaVersion: number | null = null;
  try {
    schemaVersion = (await migrationStatus(config.databaseOwnerUrl, config.migrationsDir)).current;
  } catch {
    /* informational only */
  }
  const [row] = await q<BackupRecord>(
    db,
    sql`INSERT INTO backups (file_name, file_path, kind, status, app_version, schema_version, created_by)
        VALUES (${fileName}, ${filePath}, ${kind}, 'running', ${APP_VERSION}, ${schemaVersion}, ${ctx?.user?.id ?? null}) RETURNING *`,
  );
  try {
    const dump = await runPg('pg_dump', ['--format=custom', '--compress=6', '--no-owner', '--no-privileges', '--file', filePath], config.databaseOwnerUrl);
    if (dump.code !== 0) throw new Error(`pg_dump failed: ${dump.stderr}`);
    const size = (await stat(filePath)).size;
    const digest = await fileSha256(filePath);
    await verifyBackupFile(filePath, settings.verifyMode);
    let externalPath: string | null = null;
    if (settings.externalDirectory) {
      try {
        if (!existsSync(settings.externalDirectory)) mkdirSync(settings.externalDirectory, { recursive: true });
        externalPath = join(settings.externalDirectory, fileName);
        await copyFile(filePath, externalPath);
      } catch (err) {
        externalPath = null;
        await logEvent('warn', 'backup', `Backup created but the external copy failed: ${(err as Error).message}`, { file: fileName });
        await notifyStaff({ type: 'backup_external_failed', title: 'External backup copy failed', body: (err as Error).message, severity: 'warning', permission: 'system.backup' });
      }
    }
    const [done] = await q<BackupRecord>(
      db,
      sql`UPDATE backups SET status = 'completed', size_bytes = ${size}, sha256 = ${digest}, verify_status = 'passed', verified_at = now(),
                             external_copy_path = ${externalPath}, finished_at = now()
          WHERE id = ${row!.id} RETURNING *`,
    );
    await logEvent('info', 'backup', `Backup ${fileName} completed (${Math.round(size / 1024)} KiB, verified)`, { kind, sha256: digest });
    if (ctx) await audit(db, ctx, { action: 'backup.create', entityType: 'backup', entityId: row!.id, meta: { kind, fileName } });
    return done!;
  } catch (err) {
    const message = (err as Error).message.slice(0, 2000);
    await db.execute(sql`UPDATE backups SET status = 'failed', error = ${message}, finished_at = now() WHERE id = ${row!.id}`);
    await logEvent('error', 'backup', `Backup failed: ${message}`, { kind });
    await notifyStaff({ type: 'backup_failed', title: 'Database backup FAILED', body: message, severity: 'critical', permission: 'system.backup' });
    await rm(filePath, { force: true }).catch(() => undefined);
    throw new AppError(500, 'backup_failed', `Backup failed: ${message}`);
  }
}

/** Delete backups older than the retention period, always keeping the newest `keepMinimum`. */
export async function pruneBackups(): Promise<number> {
  const s = await getSetting('backup');
  const db = getDb();
  const old = await q<{ id: string; file_path: string }>(
    db,
    sql`SELECT id, file_path FROM backups WHERE status = 'completed' AND kind <> 'pre_update'
          AND started_at < now() - make_interval(days => ${s.retentionDays})
          AND id NOT IN (SELECT id FROM backups WHERE status = 'completed' ORDER BY started_at DESC LIMIT ${s.keepMinimum})`,
  );
  for (const b of old) {
    await rm(b.file_path, { force: true }).catch(() => undefined);
    await db.execute(sql`UPDATE backups SET status = 'deleted' WHERE id = ${b.id}`);
  }
  if (old.length) await logEvent('info', 'backup', `Retention removed ${old.length} old backup(s)`);
  return old.length;
}

/** Is a scheduled backup due? Slots are anchored at the configured time of day in the restaurant time zone. */
export async function scheduledBackupDue(now = new Date()): Promise<boolean> {
  const s = await getSetting('backup');
  if (!s.enabled) return false;
  const g = await getSetting('general');
  const intervalH = { daily: 24, every_6_hours: 6, every_12_hours: 12, weekly: 168 }[s.frequency];
  const local = utcToZoned(now, g.timezone);
  const minutesSinceAnchor = (((parseHHMM(local.time) - parseHHMM(s.timeOfDay)) % 1440) + 1440) % 1440;
  let slotStart = new Date(now.getTime() - minutesSinceAnchor * 60_000);
  if (intervalH < 24) {
    while (slotStart.getTime() + intervalH * 3600_000 <= now.getTime()) slotStart = new Date(slotStart.getTime() + intervalH * 3600_000);
  }
  const lastWindowStart = intervalH === 168 ? new Date(now.getTime() - 167 * 3600_000) : slotStart;
  const recent = await q1(getDb(), sql`SELECT 1 FROM backups WHERE kind = 'scheduled' AND status IN ('running', 'completed') AND started_at >= ${lastWindowStart.toISOString()}::timestamptz LIMIT 1`);
  const failedRecently = await q1(getDb(), sql`SELECT 1 FROM backups WHERE kind = 'scheduled' AND status = 'failed' AND started_at > now() - interval '30 minutes' LIMIT 1`);
  return !recent && !failedRecently;
}

export async function getBackup(id: string): Promise<BackupRecord> {
  const b = await q1<BackupRecord>(getDb(), sql`SELECT * FROM backups WHERE id = ${id}`);
  if (!b) throw new AppError(404, 'not_found', 'Backup not found');
  return b;
}

export async function setMaintenance(enabled: boolean, reason = ''): Promise<void> {
  await putSetting(getDb(), { requestId: 'maintenance', ip: '127.0.0.1', system: 'maintenance' }, 'system.maintenance', {
    enabled,
    reason,
    since: enabled ? new Date().toISOString() : null,
  });
  await publish({ type: 'maintenance', enabled, reason });
  await publish({ type: 'control', action: 'settings' });
}

/**
 * Restore a backup: pre-restore safety backup → maintenance mode → pg_restore (single transaction) → migrations →
 * exit maintenance. Devices keep working offline during the restore and resync afterwards.
 */
export async function restoreBackup(id: string, ctx: RequestContext, after?: () => Promise<void>): Promise<{ preRestoreBackupId: string }> {
  const b = await getBackup(id);
  if (b.status !== 'completed' || !existsSync(b.file_path)) throw new AppError(422, 'backup_unavailable', 'Backup file is missing or incomplete');
  if (b.sha256 && (await fileSha256(b.file_path)) !== b.sha256) throw new AppError(422, 'backup_corrupt', 'Backup checksum mismatch — the file was modified or damaged');
  await verifyBackupFile(b.file_path, 'list');
  const safety = await createBackup('pre_restore', ctx);
  await setMaintenance(true, 'Restoring a database backup');
  await logEvent('warn', 'backup', `Restore of ${b.file_name} started`, { by: ctx.user?.id });
  try {
    const dbName = new URL(config.databaseOwnerUrl).pathname.replace(/^\//, '');
    const [{ hwm }] = (await q<{ hwm: number }>(getDb(), sql`SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS hwm FROM sofia_sync_seq`)) as [{ hwm: number }];
    // Maintenance mode already blocks new writes; only sessions stuck inside a transaction could block the
    // restore's locks, so those (and only those) are terminated. Idle pooled connections stay usable.
    await getDb().execute(sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                              WHERE datname = ${dbName} AND pid <> pg_backend_pid()
                                AND state IN ('idle in transaction', 'idle in transaction (aborted)')
                                AND state_change < now() - interval '30 seconds'`).catch(() => undefined);
    // Operational history (backup catalogue, update history) must describe what really happened, so it is carried
    // over the restore instead of being rewound to the backup's point in time.
    const preserved: Record<string, unknown[]> = {};
    for (const t of PRESERVED_TABLES) preserved[t] = await q(getDb(), sql`SELECT * FROM ${sql.identifier(t)}`);
    const r = await runPg('pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error', '--dbname', dbName, b.file_path], config.databaseOwnerUrl);
    if (r.code !== 0) throw new Error(`pg_restore failed: ${r.stderr}`);
    await getDb().transaction(async (tx) => {
      for (const t of [...PRESERVED_TABLES].reverse()) await tx.execute(sql`DELETE FROM ${sql.identifier(t)}`);
      for (const t of PRESERVED_TABLES) {
        await tx.execute(sql`INSERT INTO ${sql.identifier(t)} SELECT * FROM json_populate_recordset(NULL::${sql.identifier(t)}, ${JSON.stringify(preserved[t])}::json)`);
      }
    });
    // The change feed must never move backwards (devices hold cursors), and devices must rebuild their local copy.
    await getDb().execute(sql`SELECT setval('sofia_sync_seq', greatest(${hwm}::bigint + 1, (SELECT last_value FROM sofia_sync_seq)))`);
    await putSetting(getDb(), { requestId: 'restore', ip: '127.0.0.1', system: 'restore' }, 'system.epoch', { epoch: randomBytes(8).toString('hex') });
    if (after) await after();
    await logEvent('warn', 'backup', `Database restored from ${b.file_name}`, { safetyBackup: safety.file_name });
    await audit(getDb(), ctx, { action: 'backup.restore', entityType: 'backup', entityId: id, meta: { file: b.file_name, safetyBackupId: safety.id } });
    return { preRestoreBackupId: safety.id };
  } finally {
    await setMaintenance(false);
  }
}

export async function listBackups() {
  return q(
    getDb(),
    sql`SELECT b.id, b.file_name AS "fileName", b.size_bytes AS "sizeBytes", b.sha256, b.kind, b.status, b.verify_status AS "verifyStatus",
               b.verified_at AS "verifiedAt", b.external_copy_path AS "externalCopyPath", b.app_version AS "appVersion",
               b.schema_version AS "schemaVersion", b.started_at AS "startedAt", b.finished_at AS "finishedAt", b.error,
               u.display_name AS "createdByName"
        FROM backups b LEFT JOIN users u ON u.id = b.created_by
        WHERE b.status <> 'deleted' ORDER BY b.started_at DESC LIMIT 200`,
  );
}

export { basename };
