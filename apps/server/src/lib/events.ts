import { EventEmitter } from 'node:events';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { config } from '../config.js';
import { getDb, type DbOrTx } from '../db/pool.js';

/**
 * Cross-process event bus: events are published with pg_notify (so they are delivered only when the surrounding
 * transaction commits) and every API process LISTENs and fans them out to its SSE clients.
 */

export type SofiaEvent =
  | { type: 'changes'; entities: string[]; branchId?: string | null }
  | {
      type: 'notification';
      id: string;
      branchId?: string | null;
      userId?: string | null;
      permission?: string | null;
      severity: string;
      title: string;
      notificationType: string;
    }
  | { type: 'maintenance'; enabled: boolean; reason?: string }
  | { type: 'control'; action: 'restart' | 'settings' | 'auth-cache'; target?: string }
  | { type: 'table_freed'; branchId: string; tableIds: string[] };

const CHANNEL = 'sofia_events';
const local = new EventEmitter();
local.setMaxListeners(1000);

let listener: pg.Client | undefined;
let listenerStarting: Promise<void> | undefined;
let stopped = false;

export async function publish(event: SofiaEvent, tx?: DbOrTx): Promise<void> {
  const payload = JSON.stringify(event);
  await (tx ?? getDb()).execute(sql`SELECT pg_notify(${CHANNEL}, ${payload})`);
}

export function subscribe(fn: (e: SofiaEvent) => void): () => void {
  local.on('event', fn);
  return () => local.off('event', fn);
}

/** Emit only inside this process (used in tests and when the listener is not running). */
export function emitLocal(e: SofiaEvent): void {
  local.emit('event', e);
}

export function startEventListener(): Promise<void> {
  if (listenerStarting) return listenerStarting;
  stopped = false;
  listenerStarting = (async () => {
    const connect = async (): Promise<void> => {
      const client = new pg.Client({ connectionString: config.databaseUrl, application_name: 'sofia-events' });
      client.on('notification', (msg) => {
        if (msg.channel !== CHANNEL || !msg.payload) return;
        try {
          local.emit('event', JSON.parse(msg.payload) as SofiaEvent);
        } catch {
          /* ignore malformed payloads */
        }
      });
      client.on('error', () => undefined);
      client.on('end', () => {
        listener = undefined;
        if (!stopped) setTimeout(() => void connect().catch(() => undefined), 3000);
      });
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      listener = client;
    };
    await connect();
  })();
  return listenerStarting;
}

export async function stopEventListener(): Promise<void> {
  stopped = true;
  listenerStarting = undefined;
  const l = listener;
  listener = undefined;
  if (l) await l.end().catch(() => undefined);
}
