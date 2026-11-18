import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql, type SQL } from 'drizzle-orm';
import pg from 'pg';
import { config } from '../config.js';
import * as schema from './schema.js';

// Parse PostgreSQL types into JSON-friendly values for raw queries:
// DATE stays 'YYYY-MM-DD' (no local-midnight Date surprises), BIGINT/NUMERIC become numbers.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

let pool: pg.Pool | undefined;
let database: Db | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: config.databasePoolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: `sofia-${process.env.SOFIA_PROCESS_ROLE ?? 'api'}`,
    });
    pool.on('error', (err) => console.error('PostgreSQL pool error', err.message));
  }
  return pool;
}

export function getDb(): Db {
  if (!database) database = drizzle(getPool(), { schema });
  return database;
}

export async function closeDb(): Promise<void> {
  const p = pool;
  pool = undefined;
  database = undefined;
  if (p) await p.end();
}

/** Run raw parameterised SQL (drizzle `sql` template) and return rows. */
export async function q<T = Record<string, unknown>>(tx: DbOrTx, query: SQL): Promise<T[]> {
  const res = await tx.execute(query);
  return res.rows as T[];
}

export async function q1<T = Record<string, unknown>>(tx: DbOrTx, query: SQL): Promise<T | undefined> {
  const rows = await q<T>(tx, query);
  return rows[0];
}

export function withTx<T>(fn: (tx: Tx) => Promise<T>, db: Db = getDb()): Promise<T> {
  return db.transaction(fn);
}

/** snake_case → camelCase keys for raw SQL rows. */
export function camel<T = Record<string, unknown>>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())] = v;
  return out as T;
}

export function camelRows<T = Record<string, unknown>>(rows: Record<string, unknown>[]): T[] {
  return rows.map((r) => camel<T>(r));
}

export { sql, schema };

/** Bind a JS array as ONE PostgreSQL array parameter (drizzle expands bare arrays into tuples). */
export const pgArray = (values: readonly unknown[]) => sql.param(values);
