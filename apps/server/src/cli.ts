import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { APP_VERSION, passwordSchema } from '@sofia/shared';
import { config } from './config.js';
import { migrationStatus, runMigrations, applyRuntimeGrants } from './db/migrator.js';
import { getDb, q, q1, sql } from './db/pool.js';
import { seedReferenceData } from './db/seed.js';
import { systemContext } from './lib/context.js';
import { hashPassword } from './lib/crypto.js';

const HELP = `Sofia's Resto-Lounge — administration CLI (v${APP_VERSION})

  migrate                     apply pending database migrations
  migrate:status              show applied / pending migrations
  backup create               create a verified backup now
  backup list [--json]        list backups
  backup restore <id> --yes   restore a backup (safety backup is taken first)
  user reset-password <username> <new-password>
  user unlock <username>
  maintenance on|off          toggle maintenance mode (devices keep working offline)
  health                      print the health report (JSON)
  export <directory>          export all data as JSON files (data portability)
  version                     print the application version
`;

export async function runCli(args: string[]): Promise<number> {
  const [cmd, sub, ...rest] = args;
  const log = (m: string) => console.log(m);
  switch (cmd) {
    case 'migrate': {
      const r = await runMigrations(config.databaseOwnerUrl, config.migrationsDir, { log });
      if (config.dbAppRole) await applyRuntimeGrants(config.databaseOwnerUrl, config.dbAppRole);
      await getDb().transaction((tx) => seedReferenceData(tx));
      log(r.applied.length ? `Applied ${r.applied.length} migration(s).` : 'Database is up to date.');
      return 0;
    }
    case 'migrate:status': {
      const s = await migrationStatus(config.databaseOwnerUrl, config.migrationsDir);
      log(JSON.stringify({ current: s.current, latest: s.latest, pending: s.pending, checksumMismatches: s.checksumMismatches }, null, 2));
      return s.checksumMismatches.length ? 2 : 0;
    }
    case 'backup': {
      const { createBackup, listBackups, restoreBackup } = await import('./modules/system/backup.js');
      if (sub === 'create') {
        const b = await createBackup('manual', systemContext('cli'));
        log(`Backup created: ${b.file_path} (${b.size_bytes} bytes, sha256 ${b.sha256})`);
        return 0;
      }
      if (sub === 'list') {
        const list = (await listBackups()) as Record<string, unknown>[];
        if (rest.includes('--json')) log(JSON.stringify(list));
        else for (const b of list) log(`${b.id}  ${b.status}  ${b.kind}  ${b.fileName}  ${b.sizeBytes ?? ''}`);
        return 0;
      }
      if (sub === 'restore') {
        if (!rest.includes('--yes')) {
          log('Refusing to restore without --yes (this replaces the current database).');
          return 1;
        }
        const r = await restoreBackup(rest[0]!, systemContext('cli'), async () => {
          await runMigrations(config.databaseOwnerUrl, config.migrationsDir, { log });
          await getDb().transaction((tx) => seedReferenceData(tx));
        });
        log(`Restored. Safety backup taken before restore: ${r.preRestoreBackupId}`);
        return 0;
      }
      break;
    }
    case 'user': {
      const username = rest[0];
      if (!username) break;
      const user = await q1<{ id: string }>(getDb(), sql`SELECT id FROM users WHERE username = ${username} AND deleted_at IS NULL`);
      if (!user) {
        log(`User ${username} not found`);
        return 1;
      }
      if (sub === 'reset-password') {
        const pw = passwordSchema.safeParse(rest[1] ?? '');
        if (!pw.success) {
          log(pw.error.issues.map((i) => i.message).join('; '));
          return 1;
        }
        await getDb().execute(sql`UPDATE users SET password_hash = ${await hashPassword(pw.data)}, failed_login_count = 0, locked_until = NULL, password_changed_at = now() WHERE id = ${user.id}`);
        await getDb().execute(sql`UPDATE user_sessions SET revoked_at = now(), revoke_reason = 'cli_password_reset' WHERE user_id = ${user.id} AND revoked_at IS NULL`);
        await getDb().execute(sql`INSERT INTO audit_logs (action, entity_type, entity_id, meta) VALUES ('user.password_reset', 'user', ${user.id}, '{"via":"cli"}'::jsonb)`);
        log('Password reset; all sessions of this user were signed out.');
        return 0;
      }
      if (sub === 'unlock') {
        await getDb().execute(sql`UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ${user.id}`);
        log('Account unlocked.');
        return 0;
      }
      break;
    }
    case 'maintenance': {
      const { setMaintenance } = await import('./modules/system/backup.js');
      await setMaintenance(sub === 'on', sub === 'on' ? 'Maintenance by administrator' : '');
      log(`Maintenance mode ${sub === 'on' ? 'enabled' : 'disabled'}.`);
      return 0;
    }
    case 'health': {
      const { healthReport } = await import('./modules/health.js');
      log(JSON.stringify(await healthReport(), null, 2));
      return 0;
    }
    case 'export': {
      const dir = sub ?? join(config.dataDir, 'exports', new Date().toISOString().slice(0, 10));
      mkdirSync(dir, { recursive: true });
      const { EXPORT_TABLES } = await import('./modules/export.js');
      for (const t of EXPORT_TABLES) {
        const rows = await q(getDb(), sql`SELECT ${sql.raw(t.columns)} FROM ${sql.identifier(t.table)}`);
        writeFileSync(join(dir, `${t.table}.json`), JSON.stringify(rows, null, 1));
        log(`${t.table}: ${rows.length} rows`);
      }
      log(`Export written to ${dir}`);
      return 0;
    }
    case 'version':
      log(APP_VERSION);
      return 0;
    default:
      break;
  }
  console.log(HELP);
  return cmd ? 1 : 0;
}
