import pg from 'pg';
import { config } from '../config.js';
import { getDb, q, sql } from '../db/pool.js';
import { systemContext } from '../lib/context.js';
import { publish } from '../lib/events.js';
import { getSetting } from '../lib/settings.js';
import { logEvent } from '../lib/system-events.js';
import { processOutbox, queueReservationMessage, queueGuestMessage } from '../modules/notifications/service.js';
import { transitionReservation } from '../modules/reservations/service.js';
import { reservationSettingsOf } from '../modules/venue.js';
import { createBackup, pruneBackups, scheduledBackupDue } from '../modules/system/backup.js';
import { anonymizeGuest } from '../modules/guests/service.js';
import { utcToZoned } from '@sofia/shared';
import { pollDueConnections } from '../modules/pos.js';
import { sendDueCampaigns } from '../modules/marketing/routes.js';
import { birthdayPoints, expireInactivePoints } from '../modules/loyalty.js';

/**
 * Background worker. Queue processing (notification outbox) is safe in any number of processes (SKIP LOCKED);
 * scheduled jobs run only in the process that holds the scheduler advisory lock (leader election), so an API with
 * an embedded worker and a dedicated worker never double-run a job.
 */

const LEADER_LOCK = 73010003;
type Job = { name: string; everyMs: number; leaderOnly: boolean; run: () => Promise<unknown>; last?: number; running?: boolean };

const ctx = systemContext('worker');
const extraJobs: Job[] = [];

/** Modules (POS polling, campaigns, loyalty) register additional jobs here. */
export function registerJob(name: string, everyMs: number, run: () => Promise<unknown>, leaderOnly = true): void {
  extraJobs.push({ name, everyMs, run, leaderOnly });
}

async function sendReminders() {
  const db = getDb();
  const due = await q<{ id: string; reservation_settings: Record<string, unknown> }>(
    db,
    sql`SELECT r.id, b.reservation_settings FROM reservations r JOIN branches b ON b.id = r.branch_id
        WHERE r.status = 'confirmed' AND r.reminder_sent_at IS NULL AND r.deleted_at IS NULL
          AND r.start_at > now() AND r.start_at < now() + interval '48 hours'`,
  );
  for (const d of due) {
    const settings = reservationSettingsOf({ reservationSettings: d.reservation_settings });
    if (!settings.reminderHoursBefore) continue;
    await db.transaction(async (tx) => {
      const [r] = await q<typeof import('../db/schema.js').reservations.$inferSelect>(
        tx,
        sql`SELECT * FROM reservations WHERE id = ${d.id} AND reminder_sent_at IS NULL
              AND start_at <= now() + make_interval(hours => ${settings.reminderHoursBefore}) FOR UPDATE SKIP LOCKED`,
      );
      if (!r) return;
      const res = (await tx.query.reservations.findFirst({ where: (t, { eq }) => eq(t.id, d.id) }))!;
      await queueReservationMessage(tx, 'reservation_reminder', res);
      await tx.execute(sql`UPDATE reservations SET reminder_sent_at = now() WHERE id = ${d.id}`);
    });
  }
}

async function autoNoShow() {
  const db = getDb();
  const late = await q<{ id: string; reservation_settings: Record<string, unknown>; start_at: Date }>(
    db,
    sql`SELECT r.id, r.start_at, b.reservation_settings FROM reservations r JOIN branches b ON b.id = r.branch_id
        WHERE r.status IN ('pending', 'confirmed') AND r.deleted_at IS NULL AND r.start_at < now() - interval '5 minutes'
          AND r.start_at > now() - interval '2 days'`,
  );
  for (const r of late) {
    const s = reservationSettingsOf({ reservationSettings: r.reservation_settings });
    if (new Date(r.start_at).getTime() + s.noShowGraceMinutes * 60_000 > Date.now()) continue;
    await db
      .transaction((tx) => transitionReservation(tx, ctx, r.id, 'no_show', { reason: `Automatically marked after ${s.noShowGraceMinutes} minutes` }))
      .catch((err) => logEvent('warn', 'worker', `Auto no-show failed for ${r.id}: ${(err as Error).message}`));
  }
}

async function feedbackRequests() {
  const db = getDb();
  const done = await q<{ id: string; reservation_settings: Record<string, unknown>; completed_at: Date }>(
    db,
    sql`SELECT r.id, r.completed_at, b.reservation_settings FROM reservations r JOIN branches b ON b.id = r.branch_id
        WHERE r.status = 'completed' AND r.feedback_requested_at IS NULL AND r.guest_id IS NOT NULL
          AND r.completed_at > now() - interval '2 days'`,
  );
  for (const r of done) {
    const s = reservationSettingsOf({ reservationSettings: r.reservation_settings });
    if (new Date(r.completed_at).getTime() + s.feedbackDelayMinutes * 60_000 > Date.now()) continue;
    await db.transaction(async (tx) => {
      const res = await tx.query.reservations.findFirst({ where: (t, { eq }) => eq(t.id, r.id) });
      if (!res || res.feedbackRequestedAt) return;
      await queueReservationMessage(tx, 'feedback_request', res);
      await tx.execute(sql`UPDATE reservations SET feedback_requested_at = now() WHERE id = ${r.id}`);
    });
  }
}

async function housekeeping() {
  const db = getDb();
  const freed = await q<{ id: string; branch_id: string }>(
    db,
    sql`UPDATE restaurant_tables SET manual_status = 'available', manual_status_reason = NULL, manual_status_until = NULL, manual_status_at = now()
        WHERE manual_status <> 'available' AND manual_status_until IS NOT NULL AND manual_status_until < now() RETURNING id, branch_id`,
  );
  const byBranch = new Map<string, string[]>();
  for (const t of freed) byBranch.set(t.branch_id, [...(byBranch.get(t.branch_id) ?? []), t.id]);
  for (const [branchId, tableIds] of byBranch) {
    await publish({ type: 'table_freed', branchId, tableIds });
    await publish({ type: 'changes', entities: ['tables'], branchId });
  }
  await db.execute(sql`UPDATE waitlist_entries SET status = 'expired' WHERE status IN ('waiting', 'notified') AND created_at < now() - interval '8 hours'`);
  await db.execute(sql`DELETE FROM user_sessions WHERE expires_at < now() - interval '7 days' OR (rotated_at IS NOT NULL AND rotated_at < now() - interval '2 days')`);
  await db.execute(sql`DELETE FROM system_events WHERE at < now() - interval '180 days'`);
  await db.execute(sql`DELETE FROM in_app_notifications WHERE created_at < now() - interval '60 days'`);
  await db.execute(sql`DELETE FROM guest_push_subscriptions WHERE revoked_at < now() - interval '30 days'`);
}

async function birthdayGreetings() {
  const n = await getSetting('notifications');
  const g = await getSetting('general');
  if (!n.sendBirthday) return;
  const local = utcToZoned(new Date(), g.timezone);
  if (local.time < '10:00') return;
  const db = getDb();
  const guests = await db.query.guests.findMany({
    where: (t, { and, isNull, eq }) =>
      and(isNull(t.deletedAt), eq(t.marketingConsent, true), sql`extract(month FROM ${t.birthday}) = ${Number(local.date.slice(5, 7))} AND extract(day FROM ${t.birthday}) = ${Number(local.date.slice(8, 10))}`),
    limit: 500,
  });
  for (const guest of guests) {
    await queueGuestMessage(db, { guest, key: 'birthday', vars: {}, isMarketing: true, dedupeKey: `birthday:${guest.id}:${local.date.slice(0, 4)}` });
  }
}

async function dataRetention() {
  const s = await getSetting('guests');
  if (!s.dataRetentionMonths) return;
  const db = getDb();
  const stale = await q<{ id: string }>(
    db,
    sql`SELECT g.id FROM guests g WHERE g.deleted_at IS NULL AND g.anonymized_at IS NULL
          AND coalesce(g.last_visit_at, g.created_at) < now() - make_interval(months => ${s.dataRetentionMonths})
          AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.guest_id = g.id AND r.start_at > now())
        LIMIT 200`,
  );
  for (const g of stale) await db.transaction((tx) => anonymizeGuest(tx, systemContext('retention'), g.id));
  if (stale.length) await logEvent('info', 'worker', `Data retention anonymised ${stale.length} inactive guest profile(s)`);
}

async function scheduledBackup() {
  if (!(await scheduledBackupDue())) return;
  await createBackup('scheduled').catch(() => undefined);
  await pruneBackups();
}

export async function startWorker(): Promise<() => Promise<void>> {
  const jobs: Job[] = [
    { name: 'outbox', everyMs: 5_000, leaderOnly: false, run: () => processOutbox() },
    { name: 'reminders', everyMs: 60_000, leaderOnly: true, run: sendReminders },
    { name: 'no-show', everyMs: 60_000, leaderOnly: true, run: autoNoShow },
    { name: 'feedback', everyMs: 120_000, leaderOnly: true, run: feedbackRequests },
    { name: 'housekeeping', everyMs: 60_000, leaderOnly: true, run: housekeeping },
    { name: 'birthday', everyMs: 3_600_000, leaderOnly: true, run: birthdayGreetings },
    { name: 'retention', everyMs: 24 * 3_600_000, leaderOnly: true, run: dataRetention },
    { name: 'backup', everyMs: 60_000, leaderOnly: true, run: scheduledBackup },
    { name: 'pos-poll', everyMs: 60_000, leaderOnly: true, run: pollDueConnections },
    { name: 'campaigns', everyMs: 60_000, leaderOnly: true, run: sendDueCampaigns },
    { name: 'loyalty-birthday', everyMs: 3_600_000, leaderOnly: true, run: () => birthdayPoints(ctx) },
    { name: 'loyalty-expiry', everyMs: 24 * 3_600_000, leaderOnly: true, run: () => expireInactivePoints(ctx) },
    ...extraJobs,
  ];

  const lockClient = new pg.Client({ connectionString: config.databaseUrl, application_name: 'sofia-scheduler' });
  let leader = false;
  await lockClient.connect().catch(() => undefined);
  const tryLead = async () => {
    try {
      if (!leader) leader = (await lockClient.query('SELECT pg_try_advisory_lock($1) AS ok', [LEADER_LOCK])).rows[0]?.ok === true;
    } catch {
      leader = false;
    }
  };
  await tryLead();

  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    await tryLead();
    const now = Date.now();
    for (const job of jobs) {
      if (job.running || (job.leaderOnly && !leader)) continue;
      if (job.last && now - job.last < job.everyMs) continue;
      job.last = now;
      job.running = true;
      job
        .run()
        .catch((err) => logEvent('error', 'worker', `Job ${job.name} failed: ${(err as Error).message}`))
        .finally(() => (job.running = false));
    }
  };
  const timer = setInterval(() => void tick(), 2_000);
  void tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await lockClient.end().catch(() => undefined);
  };
}
