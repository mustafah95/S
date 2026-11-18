import { getDb, schema, type DbOrTx } from '../db/pool.js';
import { publish } from './events.js';

export type EventCategory = 'app' | 'security' | 'sync' | 'update' | 'backup' | 'integration' | 'error' | 'worker';
export type EventLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Record a categorised operational event (shown in Settings → System → Logs). Failures to log never break the
 * calling operation.
 */
export async function logEvent(
  level: EventLevel,
  category: EventCategory,
  message: string,
  data?: Record<string, unknown>,
  tx: DbOrTx = getDb(),
): Promise<void> {
  try {
    await tx.insert(schema.systemEvents).values({
      level,
      category,
      message: message.slice(0, 2000),
      data: data ?? null,
      processRole: process.env.SOFIA_PROCESS_ROLE ?? 'api',
    });
  } catch (err) {
    console.error('Failed to record system event', (err as Error).message);
  }
}

export interface StaffNotificationInput {
  type: string;
  title: string;
  body?: string;
  severity?: 'info' | 'success' | 'warning' | 'critical';
  branchId?: string | null;
  userId?: string | null;
  /** Audience: users holding this permission (and access to the branch). */
  permission?: string | null;
  data?: Record<string, unknown>;
}

/** Create an in-app staff notification and push it to connected devices. */
export async function notifyStaff(input: StaffNotificationInput, tx: DbOrTx = getDb()): Promise<string> {
  const [row] = await tx
    .insert(schema.inAppNotifications)
    .values({
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      severity: input.severity ?? 'info',
      branchId: input.branchId ?? null,
      userId: input.userId ?? null,
      permission: input.permission ?? null,
      data: input.data ?? {},
    })
    .returning({ id: schema.inAppNotifications.id });
  await publish(
    {
      type: 'notification',
      id: row!.id,
      branchId: input.branchId ?? null,
      userId: input.userId ?? null,
      permission: input.permission ?? null,
      severity: input.severity ?? 'info',
      title: input.title,
      notificationType: input.type,
    },
    tx,
  );
  return row!.id;
}
