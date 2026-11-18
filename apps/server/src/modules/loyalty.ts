import type { FastifyInstance } from 'fastify';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { loyaltyAdjustSchema, loyaltyConfigSchema, loyaltyRedeemSchema, utcToZoned, zId } from '@sofia/shared';
import { camelRows, getDb, q, q1, schema, sql, type DbOrTx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import type { RequestContext } from '../lib/context.js';
import { notFound, unprocessable } from '../lib/errors.js';
import { publish } from '../lib/events.js';
import { defineRoute } from '../lib/route.js';
import { getSetting, putSetting } from '../lib/settings.js';

type TxnType = 'earn' | 'redeem' | 'adjust' | 'expire' | 'bonus';

export interface PointsInput {
  guestId: string;
  points: number;
  type: TxnType;
  reason: string;
  branchId?: string | null;
  ruleId?: string | null;
  rewardId?: string | null;
  invoiceId?: string | null;
  reservationId?: string | null;
  idempotencyKey?: string | null;
}

/** Append to the points ledger, update the balance and re-evaluate the tier — atomically and idempotently. */
export async function applyPoints(tx: DbOrTx, ctx: RequestContext, input: PointsInput): Promise<{ applied: boolean; balance: number }> {
  if (input.idempotencyKey) {
    const dup = await q1(tx, sql`SELECT 1 FROM loyalty_transactions WHERE idempotency_key = ${input.idempotencyKey}`);
    if (dup) return { applied: false, balance: -1 };
  }
  const guest = await q1<{ loyalty_points: number; loyalty_lifetime_points: number; deleted_at: Date | null }>(
    tx,
    sql`SELECT loyalty_points, loyalty_lifetime_points, deleted_at FROM guests WHERE id = ${input.guestId} FOR UPDATE`,
  );
  if (!guest || guest.deleted_at) throw notFound('Guest');
  const balance = guest.loyalty_points + input.points;
  if (balance < 0) throw unprocessable('insufficient_points', `Not enough points (balance ${guest.loyalty_points})`);
  const lifetime = guest.loyalty_lifetime_points + (input.type === 'earn' || input.type === 'bonus' ? Math.max(0, input.points) : 0);
  await tx.execute(sql`INSERT INTO loyalty_transactions (guest_id, branch_id, type, points, balance_after, reason, rule_id, reward_id, invoice_id,
                                                         reservation_id, idempotency_key, created_by)
                       VALUES (${input.guestId}, ${input.branchId ?? null}, ${input.type}, ${input.points}, ${balance}, ${input.reason},
                               ${input.ruleId ?? null}, ${input.rewardId ?? null}, ${input.invoiceId ?? null}, ${input.reservationId ?? null},
                               ${input.idempotencyKey ?? null}, ${ctx.user?.id ?? null})`);
  const tier = await q1<{ id: string }>(tx, sql`SELECT id FROM loyalty_tiers WHERE deleted_at IS NULL AND min_points <= ${lifetime} ORDER BY min_points DESC LIMIT 1`);
  await tx.execute(sql`UPDATE guests SET loyalty_points = ${balance}, loyalty_lifetime_points = ${lifetime}, loyalty_tier_id = ${tier?.id ?? null} WHERE id = ${input.guestId}`);
  await publish({ type: 'changes', entities: ['guests'] }, tx);
  return { applied: true, balance };
}

async function activeRules(tx: DbOrTx, type: string) {
  return tx
    .select()
    .from(schema.loyaltyRules)
    .where(and(eq(schema.loyaltyRules.type, type), eq(schema.loyaltyRules.isActive, true), isNull(schema.loyaltyRules.deletedAt)));
}

async function multiplier(tx: DbOrTx, guestId: string): Promise<number> {
  const row = await q1<{ m: number }>(tx, sql`SELECT coalesce(t.multiplier, 1)::float AS m FROM guests g LEFT JOIN loyalty_tiers t ON t.id = g.loyalty_tier_id WHERE g.id = ${guestId}`);
  return row?.m ?? 1;
}

/** Points for a closed POS invoice (spend rules), applied once per invoice and rule. */
export async function earnForInvoice(tx: DbOrTx, ctx: RequestContext, invoice: { id: string; guestId: string | null; branchId: string; totalBase: number; status: string }) {
  if (!invoice.guestId || invoice.status !== 'closed') return;
  const loyalty = await getSetting('loyalty', tx);
  if (!loyalty.enabled) return;
  const mult = await multiplier(tx, invoice.guestId);
  for (const rule of await activeRules(tx, 'points_per_currency')) {
    const cfg = rule.config as { currencyUnit?: number; points?: number };
    const pts = Math.floor((invoice.totalBase / (cfg.currencyUnit || 1000)) * (cfg.points ?? 1) * mult);
    if (pts > 0) await applyPoints(tx, ctx, { guestId: invoice.guestId, points: pts, type: 'earn', reason: rule.name, branchId: invoice.branchId, ruleId: rule.id, invoiceId: invoice.id, idempotencyKey: `inv:${invoice.id}:${rule.id}` });
  }
  for (const rule of await activeRules(tx, 'spend_threshold')) {
    const cfg = rule.config as { threshold?: number; points?: number };
    if (cfg.threshold && invoice.totalBase >= cfg.threshold && cfg.points) {
      await applyPoints(tx, ctx, { guestId: invoice.guestId, points: cfg.points, type: 'bonus', reason: rule.name, branchId: invoice.branchId, ruleId: rule.id, invoiceId: invoice.id, idempotencyKey: `thr:${invoice.id}:${rule.id}` });
    }
  }
}

/** Visit points when a reservation is completed. */
export async function earnForVisit(tx: DbOrTx, ctx: RequestContext, reservation: { id: string; guestId: string | null; branchId: string }) {
  if (!reservation.guestId) return;
  const loyalty = await getSetting('loyalty', tx);
  if (!loyalty.enabled) return;
  for (const rule of await activeRules(tx, 'visit')) {
    const pts = (rule.config as { points?: number }).points ?? 0;
    if (pts > 0) await applyPoints(tx, ctx, { guestId: reservation.guestId, points: pts, type: 'earn', reason: rule.name, branchId: reservation.branchId, ruleId: rule.id, reservationId: reservation.id, idempotencyKey: `visit:${reservation.id}:${rule.id}` });
  }
}

export async function birthdayPoints(ctx: RequestContext): Promise<number> {
  const db = getDb();
  const loyalty = await getSetting('loyalty');
  if (!loyalty.enabled) return 0;
  const g = await getSetting('general');
  const today = utcToZoned(new Date(), g.timezone).date;
  let n = 0;
  for (const rule of await activeRules(db, 'birthday')) {
    const pts = (rule.config as { points?: number }).points ?? 0;
    if (!pts) continue;
    const guests = await q<{ id: string }>(
      db,
      sql`SELECT id FROM guests WHERE deleted_at IS NULL AND anonymized_at IS NULL AND birthday IS NOT NULL
            AND extract(month FROM birthday) = ${Number(today.slice(5, 7))} AND extract(day FROM birthday) = ${Number(today.slice(8, 10))}`,
    );
    for (const guest of guests) {
      const r = await db.transaction((tx) => applyPoints(tx, ctx, { guestId: guest.id, points: pts, type: 'bonus', reason: rule.name, ruleId: rule.id, idempotencyKey: `bday:${guest.id}:${today.slice(0, 4)}:${rule.id}` }));
      if (r.applied) n++;
    }
  }
  return n;
}

/** Inactivity expiry: balances of guests without any earning for N months expire. */
export async function expireInactivePoints(ctx: RequestContext): Promise<number> {
  const loyalty = await getSetting('loyalty');
  if (!loyalty.enabled || !loyalty.pointsExpiryMonths) return 0;
  const db = getDb();
  const stale = await q<{ id: string; loyalty_points: number }>(
    db,
    sql`SELECT g.id, g.loyalty_points FROM guests g WHERE g.loyalty_points > 0 AND g.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM loyalty_transactions t WHERE t.guest_id = g.id AND t.type IN ('earn', 'bonus', 'redeem')
                          AND t.created_at > now() - make_interval(months => ${loyalty.pointsExpiryMonths}))
        LIMIT 500`,
  );
  for (const g of stale) {
    await db.transaction((tx) => applyPoints(tx, ctx, { guestId: g.id, points: -g.loyalty_points, type: 'expire', reason: `Expired after ${loyalty.pointsExpiryMonths} months of inactivity`, idempotencyKey: `exp:${g.id}:${new Date().toISOString().slice(0, 10)}` }));
  }
  return stale.length;
}

export async function loyaltyConfig(tx: DbOrTx = getDb()) {
  const settings = await getSetting('loyalty', tx);
  const [tiers, rules, rewards] = await Promise.all([
    tx.select().from(schema.loyaltyTiers).where(isNull(schema.loyaltyTiers.deletedAt)).orderBy(asc(schema.loyaltyTiers.minPoints)),
    tx.select().from(schema.loyaltyRules).where(isNull(schema.loyaltyRules.deletedAt)),
    tx.select().from(schema.loyaltyRewards).where(isNull(schema.loyaltyRewards.deletedAt)).orderBy(asc(schema.loyaltyRewards.pointsCost)),
  ]);
  return { ...settings, tiers, rules, rewards };
}

/** Replace-style upsert of a config list: rows not in the payload are soft-deleted. */
async function syncList<T extends { id?: string }>(tx: DbOrTx, table: typeof schema.loyaltyTiers | typeof schema.loyaltyRules | typeof schema.loyaltyRewards, items: T[], userId: string | null) {
  const existing = await tx.select({ id: table.id }).from(table).where(isNull(table.deletedAt));
  const keep = new Set(items.filter((i) => i.id).map((i) => i.id));
  for (const e of existing) if (!keep.has(e.id)) await tx.update(table).set({ deletedAt: new Date(), updatedBy: userId } as never).where(eq(table.id, e.id));
  for (const item of items) {
    const { id, ...values } = item as T & Record<string, unknown>;
    if (id && existing.some((e) => e.id === id)) await tx.update(table).set({ ...values, updatedBy: userId } as never).where(eq(table.id, id));
    else await tx.insert(table).values({ ...values, createdBy: userId } as never);
  }
}

export async function registerLoyaltyRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  defineRoute(app, { method: 'GET', url: '/api/v1/loyalty/config', summary: 'Loyalty programme: tiers, earning rules, rewards', tags: ['Loyalty'], permission: 'loyalty.read' }, async () => loyaltyConfig());

  defineRoute(app, { method: 'PUT', url: '/api/v1/loyalty/config', summary: 'Configure the loyalty programme', tags: ['Loyalty'], permission: 'loyalty.configure', body: loyaltyConfigSchema }, async ({ body, ctx }) =>
    db.transaction(async (tx) => {
      const before = await loyaltyConfig(tx);
      await putSetting(tx, ctx, 'loyalty', { enabled: body.enabled, pointsExpiryMonths: body.pointsExpiryMonths });
      await syncList(tx, schema.loyaltyTiers, body.tiers, ctx.user!.id);
      await syncList(tx, schema.loyaltyRules, body.rules, ctx.user!.id);
      await syncList(tx, schema.loyaltyRewards, body.rewards, ctx.user!.id);
      const after = await loyaltyConfig(tx);
      await audit(tx, ctx, { action: 'loyalty.configure', entityType: 'loyalty', entityId: 'config', before: before as never, after: after as never });
      return after;
    }),
  );

  defineRoute(app, { method: 'GET', url: '/api/v1/loyalty/guests/:guestId', summary: 'Points balance, tier, history and redeemable rewards of a guest', tags: ['Loyalty'], permission: 'loyalty.read', params: z.object({ guestId: zId }) }, async ({ params }) => {
    const g = await q1<Record<string, unknown>>(
      db,
      sql`SELECT g.id, g.first_name, g.last_name, g.loyalty_number, g.loyalty_points, g.loyalty_lifetime_points, t.name AS tier_name, t.name_ar AS tier_name_ar, t.color AS tier_color,
                 (SELECT min(min_points) FROM loyalty_tiers nt WHERE nt.deleted_at IS NULL AND nt.min_points > g.loyalty_lifetime_points) AS next_tier_points
          FROM guests g LEFT JOIN loyalty_tiers t ON t.id = g.loyalty_tier_id WHERE g.id = ${params.guestId}`,
    );
    if (!g) throw notFound('Guest');
    const txns = await q(db, sql`SELECT t.*, u.display_name AS created_by_name FROM loyalty_transactions t LEFT JOIN users u ON u.id = t.created_by WHERE t.guest_id = ${params.guestId} ORDER BY t.created_at DESC LIMIT 200`);
    const rewards = await db.select().from(schema.loyaltyRewards).where(and(eq(schema.loyaltyRewards.isActive, true), isNull(schema.loyaltyRewards.deletedAt))).orderBy(asc(schema.loyaltyRewards.pointsCost));
    return { guest: camelRows([g])[0], transactions: camelRows(txns), rewards: rewards.map((r) => ({ ...r, redeemable: r.pointsCost <= Number(g.loyalty_points) })) };
  });

  defineRoute(app, { method: 'POST', url: '/api/v1/loyalty/adjust', summary: 'Manual points adjustment (audited)', tags: ['Loyalty'], permission: 'loyalty.adjust', body: loyaltyAdjustSchema }, async ({ body, ctx }) =>
    db.transaction(async (tx) => {
      const r = await applyPoints(tx, ctx, { guestId: body.guestId, points: body.points, type: 'adjust', reason: body.reason, branchId: body.branchId, idempotencyKey: body.id ? `adj:${body.id}` : null });
      await audit(tx, ctx, { action: 'loyalty.adjust', entityType: 'guest', entityId: body.guestId, meta: { points: body.points, reason: body.reason } });
      return r;
    }),
  );

  defineRoute(app, { method: 'POST', url: '/api/v1/loyalty/redeem', summary: 'Redeem a reward for a guest', tags: ['Loyalty'], permission: 'loyalty.redeem', body: loyaltyRedeemSchema }, async ({ body, ctx }) =>
    db.transaction(async (tx) => {
      const [reward] = await tx.select().from(schema.loyaltyRewards).where(eq(schema.loyaltyRewards.id, body.rewardId));
      if (!reward || reward.deletedAt || !reward.isActive) throw notFound('Reward');
      const r = await applyPoints(tx, ctx, { guestId: body.guestId, points: -reward.pointsCost, type: 'redeem', reason: reward.name, rewardId: reward.id, branchId: body.branchId, reservationId: body.reservationId, idempotencyKey: body.id ? `red:${body.id}` : null });
      await audit(tx, ctx, { action: 'loyalty.redeem', entityType: 'guest', entityId: body.guestId, meta: { reward: reward.name, points: reward.pointsCost } });
      return { ...r, reward };
    }),
  );

  defineRoute(app, { method: 'POST', url: '/api/v1/loyalty/referral', summary: 'Award referral points to the guest who referred a new guest', tags: ['Loyalty'], permission: 'loyalty.adjust', body: z.object({ referrerId: zId, referredGuestId: zId }) }, async ({ body, ctx }) =>
    db.transaction(async (tx) => {
      const results = [];
      for (const rule of await activeRules(tx, 'referral')) {
        const pts = (rule.config as { points?: number }).points ?? 0;
        if (pts > 0) results.push(await applyPoints(tx, ctx, { guestId: body.referrerId, points: pts, type: 'bonus', reason: rule.name, ruleId: rule.id, idempotencyKey: `ref:${body.referredGuestId}:${rule.id}` }));
      }
      await audit(tx, ctx, { action: 'loyalty.referral', entityType: 'guest', entityId: body.referrerId, meta: { referred: body.referredGuestId } });
      return { applied: results.some((r) => r.applied) };
    }),
  );
}
