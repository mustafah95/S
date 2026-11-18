import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { APP_VERSION } from '@sofia/shared';

/**
 * Sofia migration runner.
 *
 * - Migrations are numbered SQL files (`001_initial.sql`, `002_guest_crm.sql`, …) applied in order.
 * - Each runs inside its own transaction together with its `schema_migrations` row, so a failing migration leaves
 *   the database exactly as it was (`-- sofia:no-transaction` opts out, for statements such as
 *   CREATE INDEX CONCURRENTLY).
 * - A session advisory lock prevents two processes (e.g. API and updater) from migrating at the same time.
 * - SHA-256 checksums of applied files are verified on every run: a migration edited after it was applied stops
 *   the run instead of silently diverging.
 * - `-- sofia:breaking` marks a contract (destructive) migration; the update center then requires a database
 *   restore to roll the application back past it.
 */

export interface MigrationFile {
  version: number;
  name: string;
  file: string;
  sql: string;
  checksum: string;
  breaking: boolean;
  transactional: boolean;
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  appliedAt: Date;
  appVersion: string | null;
  executionMs: number;
  breaking: boolean;
}

export interface MigrationResult {
  applied: MigrationFile[];
  alreadyApplied: number;
}

const LOCK_KEY = 73010002;

export function readMigrations(dir: string): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => /^\d{3,}_[a-z0-9_]+\.sql$/i.test(f))
    .sort();
  const seen = new Set<number>();
  return files.map((file) => {
    const version = Number(file.split('_')[0]);
    if (seen.has(version)) throw new Error(`Duplicate migration version ${version}`);
    seen.add(version);
    const sql = readFileSync(join(dir, file), 'utf8');
    return {
      version,
      name: file.replace(/^\d+_/, '').replace(/\.sql$/, ''),
      file,
      sql,
      checksum: createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex'),
      breaking: /^--\s*sofia:breaking/m.test(sql),
      transactional: !/^--\s*sofia:no-transaction/m.test(sql),
    };
  });
}

async function ensureTable(client: pg.ClientBase): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      app_version text,
      execution_ms integer NOT NULL DEFAULT 0,
      breaking boolean NOT NULL DEFAULT false
    )`);
}

export async function appliedMigrations(client: pg.ClientBase): Promise<AppliedMigration[]> {
  await ensureTable(client);
  const { rows } = await client.query(
    `SELECT version, name, checksum, applied_at, app_version, execution_ms, breaking FROM schema_migrations ORDER BY version`,
  );
  return rows.map((r) => ({
    version: r.version,
    name: r.name,
    checksum: r.checksum,
    appliedAt: r.applied_at,
    appVersion: r.app_version,
    executionMs: r.execution_ms,
    breaking: r.breaking,
  }));
}

export interface MigrationStatus {
  current: number;
  latest: number;
  pending: { version: number; name: string; breaking: boolean }[];
  applied: AppliedMigration[];
  checksumMismatches: number[];
}

export async function migrationStatus(connectionString: string, dir: string): Promise<MigrationStatus> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const files = readMigrations(dir);
    const applied = await appliedMigrations(client);
    const appliedSet = new Map(applied.map((a) => [a.version, a]));
    return {
      current: applied.at(-1)?.version ?? 0,
      latest: files.at(-1)?.version ?? 0,
      pending: files.filter((f) => !appliedSet.has(f.version)).map((f) => ({ version: f.version, name: f.name, breaking: f.breaking })),
      applied,
      checksumMismatches: files
        .filter((f) => appliedSet.has(f.version) && appliedSet.get(f.version)!.checksum !== f.checksum)
        .map((f) => f.version),
    };
  } finally {
    await client.end();
  }
}

export async function runMigrations(
  connectionString: string,
  dir: string,
  opts: { log?: (msg: string) => void; appVersion?: string; targetVersion?: number } = {},
): Promise<MigrationResult> {
  const log = opts.log ?? (() => undefined);
  const client = new pg.Client({ connectionString, application_name: 'sofia-migrator' });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    try {
      const files = readMigrations(dir);
      const applied = await appliedMigrations(client);
      const byVersion = new Map(applied.map((a) => [a.version, a]));

      for (const f of files) {
        const a = byVersion.get(f.version);
        if (a && a.checksum !== f.checksum) {
          throw new Error(
            `Migration ${f.file} was modified after it was applied (checksum mismatch). Refusing to continue.`,
          );
        }
      }
      const knownVersions = new Set(files.map((f) => f.version));
      const unknown = applied.filter((a) => !knownVersions.has(a.version));
      if (unknown.length) {
        throw new Error(
          `Database has migrations unknown to this release (${unknown.map((u) => u.version).join(', ')}). ` +
            'The database is newer than the application — install the matching or newer release.',
        );
      }

      const pending = files.filter(
        (f) => !byVersion.has(f.version) && (opts.targetVersion === undefined || f.version <= opts.targetVersion),
      );
      for (const f of pending) {
        const started = Date.now();
        log(`Applying migration ${f.file}${f.breaking ? ' (breaking)' : ''}`);
        if (f.transactional) await client.query('BEGIN');
        try {
          await client.query(f.sql);
          await client.query(
            `INSERT INTO schema_migrations (version, name, checksum, app_version, execution_ms, breaking)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [f.version, f.name, f.checksum, opts.appVersion ?? APP_VERSION, Date.now() - started, f.breaking],
          );
          if (f.transactional) await client.query('COMMIT');
        } catch (err) {
          if (f.transactional) await client.query('ROLLBACK').catch(() => undefined);
          throw new Error(`Migration ${f.file} failed: ${(err as Error).message}`);
        }
      }
      return { applied: pending, alreadyApplied: applied.length };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    await client.end();
  }
}

/**
 * Least-privilege grants for the runtime database role (separate from the owner role that runs migrations).
 * The runtime role gets DML only; audit_logs is insert/select only.
 */
export async function applyRuntimeGrants(connectionString: string, appRole: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(appRole)) throw new Error('Invalid role name');
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [appRole]);
    if (!rows.length) return;
    await client.query(`
      GRANT USAGE ON SCHEMA public TO ${appRole};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appRole};
      GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${appRole};
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${appRole};
      REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM ${appRole};
      REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON schema_migrations FROM ${appRole};
    `);
  } finally {
    await client.end();
  }
}
