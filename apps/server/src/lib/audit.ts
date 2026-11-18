import { jsonEqual } from '@sofia/shared';
import { schema, type DbOrTx } from '../db/pool.js';
import type { RequestContext } from './context.js';

const IGNORED = new Set([
  'updatedAt',
  'version',
  'syncSeq',
  'createdAt',
  'passwordHash',
  'mfaSecretEnc',
  'mfaRecoveryHashes',
  'secretsEnc',
  'data',
  'statsRefreshedAt',
]);

function normalise(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  return v;
}

/** Return only the fields that changed between two record snapshots. */
export function diff(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): { old: Record<string, unknown> | null; new: Record<string, unknown> | null } {
  if (!before) return { old: null, new: after ? strip(after) : null };
  if (!after) return { old: strip(before), new: null };
  const o: Record<string, unknown> = {};
  const n: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (IGNORED.has(key)) continue;
    const a = normalise(before[key]);
    const b = normalise(after[key]);
    if (!jsonEqual(a, b)) {
      o[key] = a;
      n[key] = b;
    }
  }
  return { old: o, new: n };
}

function strip(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) if (!IGNORED.has(k)) out[k] = normalise(v);
  return out;
}

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  branchId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  meta?: Record<string, unknown>;
}

/** Append an audit log record in the caller's transaction (so the audit trail commits with the change). */
export async function audit(tx: DbOrTx, ctx: RequestContext, entry: AuditEntry): Promise<void> {
  const d = diff(entry.before, entry.after);
  if (entry.before && entry.after && d.new && Object.keys(d.new).length === 0 && !entry.meta) return;
  await tx.insert(schema.auditLogs).values({
    userId: ctx.user?.id ?? null,
    offlineUserId: ctx.offlineUserId ?? null,
    deviceId: ctx.deviceId ?? null,
    ip: ctx.ip || null,
    userAgent: ctx.userAgent?.slice(0, 300) ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    branchId: entry.branchId ?? null,
    oldValues: d.old,
    newValues: d.new,
    meta: { ...(entry.meta ?? {}), ...(ctx.system ? { system: ctx.system } : {}) },
  });
}
