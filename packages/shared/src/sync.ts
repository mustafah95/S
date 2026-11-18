import { z } from 'zod';
import { zDateTime, zId } from './schemas.js';

/** Protocol version of the offline sync contract. Bump on breaking changes; the server answers 426 to old clients. */
export const SYNC_PROTOCOL_VERSION = 1;
export const MIN_SUPPORTED_SYNC_PROTOCOL = 1;

/** Entities a device may modify while offline. */
export const SYNC_WRITE_ENTITIES = ['guest', 'guest_note', 'reservation', 'waitlist', 'table'] as const;
export type SyncWriteEntity = (typeof SYNC_WRITE_ENTITIES)[number];

/** Entities a device downloads into IndexedDB. */
export const SYNC_PULL_ENTITIES = [
  'branches',
  'areas',
  'tables',
  'table_combinations',
  'guests',
  'guest_notes',
  'reservations',
  'waitlist',
] as const;
export type SyncPullEntity = (typeof SYNC_PULL_ENTITIES)[number];

export const SYNC_OPS = ['create', 'update', 'delete', 'action'] as const;
export type SyncOpKind = (typeof SYNC_OPS)[number];

export const syncOperationSchema = z.object({
  opId: zId,
  entityType: z.enum(SYNC_WRITE_ENTITIES),
  entityId: zId,
  op: z.enum(SYNC_OPS),
  action: z.string().max(40).optional(),
  payload: z.record(z.string(), z.unknown()),
  /** Server version the client based its change on (absent for create). */
  baseVersion: z.number().int().nonnegative().optional(),
  /** Values of the changed fields as the client last saw them on the server — enables 3-way merge. */
  baseValues: z.record(z.string(), z.unknown()).optional(),
  clientTs: zDateTime,
  userId: zId,
  branchId: zId.nullable().optional(),
});
export type SyncOperation = z.infer<typeof syncOperationSchema>;

export const syncPushSchema = z.object({
  deviceId: zId,
  protocol: z.number().int().min(1),
  ops: z.array(syncOperationSchema).max(200),
});
export type SyncPushRequest = z.infer<typeof syncPushSchema>;

/** 'retry' = transient server error: the op stays queued and later ops in the batch are not processed (order is kept). */
export type SyncOpResultStatus = 'applied' | 'duplicate' | 'conflict' | 'rejected' | 'requires_review' | 'retry';

export interface SyncOpResult {
  opId: string;
  entityType: SyncWriteEntity;
  entityId: string;
  status: SyncOpResultStatus;
  /** Authoritative server record after the operation (camelCase API shape). */
  entity?: Record<string, unknown> | null;
  conflictId?: string;
  /** Fields that were applied when a 3-way merge partially succeeded. */
  mergedFields?: string[];
  /** Fields that conflicted and were kept at the server value. */
  conflictingFields?: string[];
  error?: { code: string; message: string };
  message?: string;
}

export interface SyncPushResponse {
  serverTime: string;
  results: SyncOpResult[];
}

export interface SyncPullResponse {
  serverTime: string;
  /** Changes when the server database is restored from a backup — devices then rebuild their local copy. */
  epoch: string;
  cursor: string;
  hasMore: boolean;
  changes: Partial<Record<SyncPullEntity, Record<string, unknown>[]>>;
}

/** Guest fields whose concurrent modification must be reviewed by a person instead of auto-merged. */
export const GUEST_CRITICAL_FIELDS = ['phone', 'email', 'vipLevel', 'marketingConsent', 'consentChannels', 'birthday'];
/** Guest array fields merged as set additions/removals. */
export const GUEST_SET_FIELDS = ['tags', 'allergies', 'dietary'];
/** Guest free-text fields: on conflict the server value wins and the client text is preserved as a note. */
export const GUEST_TEXT_FIELDS = ['notes'];

/** Reservation fields validated strictly: any concurrent server change raises a conflict. */
export const RESERVATION_STRICT_FIELDS = ['date', 'time', 'partySize', 'durationMinutes', 'tableIds', 'branchId'];

export type ConnectionState = 'online' | 'syncing' | 'offline' | 'server_unavailable';

/** Shallow structural equality suitable for JSON values. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (!jsonEqual(ka, kb)) return false;
    return ka.every((k) => jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/**
 * Three-way set merge: apply the additions and removals the client made (relative to `base`) onto `server`.
 */
export function mergeSet(base: readonly string[], client: readonly string[], server: readonly string[]): string[] {
  const added = client.filter((v) => !base.includes(v));
  const removed = base.filter((v) => !client.includes(v));
  const result = server.filter((v) => !removed.includes(v));
  for (const a of added) if (!result.includes(a)) result.push(a);
  return result;
}
