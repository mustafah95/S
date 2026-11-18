import Dexie, { type Table } from 'dexie';
import type { SyncOperation, SyncOpStatus } from '@sofia/shared';

/**
 * Local IndexedDB database (Dexie). Records keep the API's camelCase shape plus local metadata:
 *   _server   last authoritative copy received from the server (base for 3-way merge and rebase)
 *   _pending  number of queued operations not yet confirmed by the server
 *   _local    created on this device and not yet accepted by the server
 *   _error    last rejection message from the server
 */
export interface LocalMeta {
  _server?: Record<string, unknown> | null;
  _pending?: number;
  _local?: boolean;
  _error?: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Rec = Record<string, any> & LocalMeta & { id: string };

export interface OutboxOp extends SyncOperation {
  seq?: number;
  status: SyncOpStatus;
  attempts: number;
  lastError?: string | null;
  syncedAt?: string | null;
  conflictId?: string | null;
  /** Human readable summary shown in the Sync dashboard. */
  label?: string;
}

export class SofiaDB extends Dexie {
  outbox!: Table<OutboxOp, number>;
  guests!: Table<Rec, string>;
  guestNotes!: Table<Rec, string>;
  reservations!: Table<Rec, string>;
  waitlist!: Table<Rec, string>;
  diningTables!: Table<Rec, string>;
  areas!: Table<Rec, string>;
  branches!: Table<Rec, string>;
  combos!: Table<Rec, string>;
  kv!: Table<{ key: string; value: unknown }, string>;

  constructor(name = 'sofia-resto-lounge') {
    super(name);
    this.version(1).stores({
      outbox: '++seq, &opId, status, entityId, [status+seq]',
      guests: 'id, phoneNormalized, firstName, lastName, vipLevel, loyaltyNumber, lastVisitAt',
      guestNotes: 'id, guestId',
      reservations: 'id, code, branchId, businessDate, [branchId+businessDate], guestId, status',
      waitlist: 'id, branchId, status',
      diningTables: 'id, branchId, areaId',
      areas: 'id, branchId',
      branches: 'id',
      combos: 'id, branchId',
      kv: 'key',
    });
  }
}

export const db = new SofiaDB();

export const ENTITY_TABLE = {
  guest: 'guests',
  guest_note: 'guestNotes',
  reservation: 'reservations',
  waitlist: 'waitlist',
  table: 'diningTables',
} as const;

export const PULL_TABLE: Record<string, keyof SofiaDB> = {
  branches: 'branches',
  areas: 'areas',
  tables: 'diningTables',
  table_combinations: 'combos',
  guests: 'guests',
  guest_notes: 'guestNotes',
  reservations: 'reservations',
  waitlist: 'waitlist',
};

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await db.kv.get(key))?.value as T | undefined;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await db.kv.put({ key, value });
}

export function tableFor(entityType: keyof typeof ENTITY_TABLE): Table<Rec, string> {
  return db[ENTITY_TABLE[entityType]] as Table<Rec, string>;
}
