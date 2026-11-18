import { and, eq, isNull } from 'drizzle-orm';
import { randomInt } from 'node:crypto';
import {
  normalizeEmail,
  normalizePhone,
  type GuestCreateInput,
  type GuestUpdateInput,
} from '@sofia/shared';
import { camelRows, getDb, q, schema, sql, type DbOrTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { can, type RequestContext } from '../../lib/context.js';
import { forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { publish } from '../../lib/events.js';
import { getSetting } from '../../lib/settings.js';

export type GuestRow = typeof schema.guests.$inferSelect;

/** API representation of a guest (internal tokens removed). */
export function guestView(g: GuestRow) {
  const { privacyToken: _p, ...rest } = g;
  return rest;
}

async function nextLoyaltyNumber(tx: DbOrTx): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const candidate = `SL${randomInt(10_000_000, 99_999_999)}`;
    const rows = await tx.select({ id: schema.guests.id }).from(schema.guests).where(eq(schema.guests.loyaltyNumber, candidate));
    if (!rows.length) return candidate;
  }
  throw new Error('Could not allocate a loyalty number');
}

export async function getGuest(tx: DbOrTx, id: string, opts: { forUpdate?: boolean; includeDeleted?: boolean } = {}): Promise<GuestRow> {
  const base = tx.select().from(schema.guests).where(eq(schema.guests.id, id));
  const [g] = opts.forUpdate ? await base.for('update') : await base;
  if (!g || (!opts.includeDeleted && g.deletedAt)) throw notFound('Guest');
  return g;
}

function guardSensitiveChanges(ctx: RequestContext, before: Partial<GuestRow> | null, patch: GuestUpdateInput): void {
  if (patch.vipLevel !== undefined && patch.vipLevel !== (before?.vipLevel ?? 'standard') && !can(ctx, 'guests.vip')) {
    if (!(before === null && patch.vipLevel === 'standard')) throw forbidden('Changing VIP level requires the guests.vip permission');
  }
}

/** Translate validated input into column values (normalised phone/email, consent timestamps). */
export async function guestColumns(patch: GuestUpdateInput, before: GuestRow | null): Promise<Partial<GuestRow>> {
  const settings = await getSetting('guests');
  const out: Partial<GuestRow> = {};
  const assign = <K extends keyof GuestRow>(k: K, v: GuestRow[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  assign('firstName', patch.firstName);
  assign('lastName', patch.lastName ?? (patch.lastName === null ? null : undefined));
  assign('preferredName', patch.preferredName === undefined ? undefined : patch.preferredName);
  if (patch.phone !== undefined) {
    out.phone = patch.phone || null;
    out.phoneNormalized = normalizePhone(patch.phone, settings.defaultCountry);
  }
  assign('whatsapp', patch.whatsapp === undefined ? undefined : patch.whatsapp || null);
  if (patch.email !== undefined) out.email = normalizeEmail(patch.email);
  assign('birthday', patch.birthday === undefined ? undefined : (patch.birthday as string | null));
  assign('anniversary', patch.anniversary === undefined ? undefined : (patch.anniversary as string | null));
  assign('address', patch.address === undefined ? undefined : patch.address);
  assign('company', patch.company === undefined ? undefined : patch.company);
  assign('preferredLanguage', patch.preferredLanguage === undefined ? undefined : patch.preferredLanguage);
  assign('vipLevel', patch.vipLevel);
  assign('tags', patch.tags ? [...new Set(patch.tags)] : undefined);
  assign('notes', patch.notes === undefined ? undefined : patch.notes);
  assign('preferences', patch.preferences);
  assign('allergies', patch.allergies ? [...new Set(patch.allergies)] : undefined);
  assign('dietary', patch.dietary ? [...new Set(patch.dietary)] : undefined);
  assign('homeBranchId', patch.homeBranchId === undefined ? undefined : patch.homeBranchId);
  assign('source', patch.source === undefined ? undefined : patch.source);
  if (patch.marketingConsent !== undefined || patch.consentChannels !== undefined) {
    const consent = patch.marketingConsent ?? before?.marketingConsent ?? false;
    out.marketingConsent = consent;
    if (patch.consentChannels) out.consentChannels = patch.consentChannels;
    out.consentUpdatedAt = new Date();
    if (!consent && before?.marketingConsent) out.optedOutAt = new Date();
    if (consent) out.optedOutAt = null;
  }
  return out;
}

export interface DuplicateCandidate {
  id: string;
  firstName: string;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  vipLevel: string;
  visitCount: number;
  lastVisitAt: string | null;
  reasons: string[];
  score: number;
}

/** Configurable duplicate matching on phone, email and name similarity (pg_trgm). */
export async function findDuplicates(
  tx: DbOrTx,
  input: { phone?: string | null; email?: string | null; firstName?: string | null; lastName?: string | null },
  excludeId?: string,
): Promise<DuplicateCandidate[]> {
  const settings = await getSetting('guests');
  const m = settings.duplicateMatching;
  const phone = m.phone ? normalizePhone(input.phone ?? null, settings.defaultCountry) : null;
  const email = m.email ? normalizeEmail(input.email ?? null) : null;
  const name = m.name && input.firstName ? `${input.firstName} ${input.lastName ?? ''}`.trim().toLowerCase() : null;
  if (!phone && !email && !name) return [];
  const rows = await q<Record<string, unknown>>(
    tx,
    sql`SELECT id, first_name, last_name, phone, email, vip_level, visit_count, last_visit_at,
               (phone_normalized IS NOT DISTINCT FROM ${phone}::text AND ${phone}::text IS NOT NULL) AS phone_match,
               (email = ${email}::citext AND ${email}::text IS NOT NULL) AS email_match,
               CASE WHEN ${name}::text IS NULL THEN 0
                    ELSE similarity(lower(first_name || ' ' || coalesce(last_name, '')), ${name}::text) END AS name_score
        FROM guests
        WHERE deleted_at IS NULL AND merged_into_id IS NULL AND anonymized_at IS NULL
          AND (${excludeId ?? null}::uuid IS NULL OR id <> ${excludeId ?? null}::uuid)
          AND ((${phone}::text IS NOT NULL AND phone_normalized = ${phone}::text)
               OR (${email}::text IS NOT NULL AND email = ${email}::citext)
               OR (${name}::text IS NOT NULL
                   AND lower(coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' || coalesce(preferred_name, '')) % ${name}::text
                   AND similarity(lower(first_name || ' ' || coalesce(last_name, '')), ${name}::text) >= ${m.nameSimilarity}))
        ORDER BY phone_match DESC, email_match DESC, name_score DESC
        LIMIT 10`,
  );
  return rows.map((r) => {
    const reasons: string[] = [];
    if (r.phone_match) reasons.push('phone');
    if (r.email_match) reasons.push('email');
    if (Number(r.name_score) >= m.nameSimilarity) reasons.push('name');
    return {
      id: r.id as string,
      firstName: r.first_name as string,
      lastName: r.last_name as string | null,
      phone: r.phone as string | null,
      email: r.email as string | null,
      vipLevel: r.vip_level as string,
      visitCount: r.visit_count as number,
      lastVisitAt: r.last_visit_at ? new Date(r.last_visit_at as string).toISOString() : null,
      reasons,
      score: (r.phone_match ? 1 : 0) + (r.email_match ? 1 : 0) + Number(r.name_score),
    };
  });
}

export async function createGuest(
  tx: DbOrTx,
  ctx: RequestContext,
  input: GuestCreateInput,
  opts: { action?: string } = {},
): Promise<{ guest: GuestRow; duplicates: DuplicateCandidate[]; created: boolean }> {
  if (input.id) {
    const [existing] = await tx.select().from(schema.guests).where(eq(schema.guests.id, input.id));
    if (existing) return { guest: existing, duplicates: [], created: false };
  }
  guardSensitiveChanges(ctx, null, input);
  const cols = await guestColumns(input, null);
  const duplicates = await findDuplicates(tx, input);
  const [guest] = await tx
    .insert(schema.guests)
    .values({
      ...(cols as typeof schema.guests.$inferInsert),
      id: input.id,
      firstName: input.firstName,
      loyaltyNumber: await nextLoyaltyNumber(tx),
      createdBy: ctx.user?.id ?? null,
      updatedBy: ctx.user?.id ?? null,
    })
    .returning();
  await audit(tx, ctx, { action: opts.action ?? 'guest.create', entityType: 'guest', entityId: guest!.id, after: guest });
  await publish({ type: 'changes', entities: ['guests'] }, tx);
  return { guest: guest!, duplicates, created: true };
}

export async function updateGuest(
  tx: DbOrTx,
  ctx: RequestContext,
  id: string,
  patch: GuestUpdateInput,
  opts: { expectedVersion?: number; action?: string } = {},
): Promise<GuestRow> {
  const before = await getGuest(tx, id, { forUpdate: true });
  if (before.anonymizedAt) throw unprocessable('guest_anonymized', 'This guest profile was anonymised');
  if (opts.expectedVersion !== undefined && opts.expectedVersion !== before.version) {
    throw unprocessable('version_conflict', 'The guest was modified by someone else. Reload and try again.', { currentVersion: before.version });
  }
  guardSensitiveChanges(ctx, before, patch);
  const cols = await guestColumns(patch, before);
  if (!Object.keys(cols).length) return before;
  const [after] = await tx
    .update(schema.guests)
    .set({ ...cols, updatedBy: ctx.user?.id ?? null })
    .where(eq(schema.guests.id, id))
    .returning();
  await audit(tx, ctx, {
    action: opts.action ?? (patch.vipLevel !== undefined && patch.vipLevel !== before.vipLevel ? 'guest.vip_change' : 'guest.update'),
    entityType: 'guest',
    entityId: id,
    before,
    after,
  });
  await publish({ type: 'changes', entities: ['guests'] }, tx);
  return after!;
}

export async function addGuestNote(
  tx: DbOrTx,
  ctx: RequestContext,
  input: { id?: string; guestId: string; body: string; isPinned?: boolean; branchId?: string | null; kind?: string },
) {
  if (input.id) {
    const [existing] = await tx.select().from(schema.guestNotes).where(eq(schema.guestNotes.id, input.id));
    if (existing) return existing;
  }
  await getGuest(tx, input.guestId);
  const [note] = await tx
    .insert(schema.guestNotes)
    .values({
      id: input.id,
      guestId: input.guestId,
      body: input.body,
      isPinned: input.isPinned ?? false,
      branchId: input.branchId ?? null,
      kind: input.kind ?? 'note',
      createdBy: ctx.user?.id ?? null,
      updatedBy: ctx.user?.id ?? null,
    })
    .returning();
  await audit(tx, ctx, { action: 'guest.note_add', entityType: 'guest', entityId: input.guestId, after: { noteId: note!.id, body: input.body } });
  await publish({ type: 'changes', entities: ['guest_notes'] }, tx);
  return note!;
}

/** Merge duplicate profiles into `targetId`; history moves to the surviving profile. */
export async function mergeGuests(tx: DbOrTx, ctx: RequestContext, targetId: string, sourceIds: string[]) {
  const target = await getGuest(tx, targetId, { forUpdate: true });
  const ids = [...new Set(sourceIds)].filter((s) => s !== targetId);
  if (!ids.length) throw unprocessable('nothing_to_merge', 'Select at least one other guest');
  const sources: GuestRow[] = [];
  for (const id of ids) sources.push(await getGuest(tx, id, { forUpdate: true }));

  const tables = [
    'reservations',
    'guest_notes',
    'guest_occasions',
    'loyalty_transactions',
    'pos_invoices',
    'feedback',
    'complaints',
    'waitlist_entries',
    'notification_outbox',
  ];
  for (const t of tables) {
    await tx.execute(sql`UPDATE ${sql.identifier(t)} SET guest_id = ${targetId} WHERE guest_id IN ${ids}`);
  }
  await tx.execute(sql`UPDATE campaign_recipients SET guest_id = ${targetId}
                       WHERE guest_id IN ${ids}
                         AND NOT EXISTS (SELECT 1 FROM campaign_recipients c2 WHERE c2.campaign_id = campaign_recipients.campaign_id AND c2.guest_id = ${targetId})`);

  const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
  let tags = target.tags;
  let allergies = target.allergies;
  let dietary = target.dietary;
  let points = target.loyaltyPoints;
  let lifetime = target.loyaltyLifetimePoints;
  const fill: Partial<GuestRow> = {};
  const vipOrder = ['standard', 'silver', 'gold', 'platinum', 'vip', 'vvip'];
  let vip = target.vipLevel;
  const notes: string[] = [];
  for (const s of sources) {
    tags = union(tags, s.tags);
    allergies = union(allergies, s.allergies);
    dietary = union(dietary, s.dietary);
    points += s.loyaltyPoints;
    lifetime += s.loyaltyLifetimePoints;
    if (vipOrder.indexOf(s.vipLevel) > vipOrder.indexOf(vip)) vip = s.vipLevel;
    for (const f of ['phone', 'phoneNormalized', 'whatsapp', 'email', 'birthday', 'anniversary', 'address', 'company', 'preferredName', 'lastName'] as const) {
      if (!target[f] && !fill[f] && s[f]) (fill as Record<string, unknown>)[f] = s[f];
    }
    if (s.notes) notes.push(s.notes);
    await tx
      .update(schema.guests)
      .set({ mergedIntoId: targetId, deletedAt: new Date(), loyaltyPoints: 0, updatedBy: ctx.user?.id ?? null })
      .where(eq(schema.guests.id, s.id));
  }
  const [after] = await tx
    .update(schema.guests)
    .set({
      ...fill,
      tags,
      allergies,
      dietary,
      vipLevel: vip,
      loyaltyPoints: points,
      loyaltyLifetimePoints: lifetime,
      notes: [target.notes, ...notes].filter(Boolean).join('\n---\n') || null,
      updatedBy: ctx.user?.id ?? null,
    })
    .where(eq(schema.guests.id, targetId))
    .returning();
  await tx.execute(sql`SELECT refresh_guest_stats(${targetId})`);
  await tx.execute(sql`UPDATE sync_conflicts SET status = 'resolved_custom', resolved_at = now(), resolved_by = ${ctx.user?.id ?? null},
                              resolution = '{"merged": true}'::jsonb
                       WHERE kind = 'duplicate_guest' AND status = 'open' AND entity_id IN ${[targetId, ...ids]}`);
  await audit(tx, ctx, { action: 'guest.merge', entityType: 'guest', entityId: targetId, before: target, after, meta: { mergedIds: ids } });
  await publish({ type: 'changes', entities: ['guests', 'reservations', 'guest_notes'] }, tx);
  const [fresh] = await tx.select().from(schema.guests).where(eq(schema.guests.id, targetId));
  return fresh!;
}

/** Privacy: remove personal data while keeping anonymous statistics (reservations, invoices stay counted). */
export async function anonymizeGuest(tx: DbOrTx, ctx: RequestContext, id: string) {
  const before = await getGuest(tx, id, { forUpdate: true });
  const [after] = await tx
    .update(schema.guests)
    .set({
      firstName: 'Anonymised',
      lastName: null,
      preferredName: null,
      phone: null,
      phoneNormalized: null,
      whatsapp: null,
      email: null,
      birthday: null,
      anniversary: null,
      address: null,
      company: null,
      notes: null,
      tags: [],
      preferences: {},
      allergies: [],
      dietary: [],
      marketingConsent: false,
      consentChannels: { whatsapp: false, sms: false, email: false, push: false },
      optedOutAt: new Date(),
      anonymizedAt: new Date(),
      updatedBy: ctx.user?.id ?? null,
    })
    .where(eq(schema.guests.id, id))
    .returning();
  await tx.execute(sql`UPDATE reservations SET guest_name = 'Anonymised', guest_phone = NULL WHERE guest_id = ${id}`);
  await tx.execute(sql`UPDATE guest_notes SET body = '[removed]', deleted_at = now() WHERE guest_id = ${id}`);
  await tx.execute(sql`UPDATE waitlist_entries SET guest_name = 'Anonymised', phone = NULL WHERE guest_id = ${id}`);
  await audit(tx, ctx, { action: 'guest.anonymize', entityType: 'guest', entityId: id, meta: { previousName: `${before.firstName} ${before.lastName ?? ''}`.trim().slice(0, 1) + '…' } });
  await publish({ type: 'changes', entities: ['guests', 'reservations', 'guest_notes'] }, tx);
  return after!;
}

/** Complete personal data export for one guest (data portability / access request). */
export async function exportGuestData(tx: DbOrTx, id: string) {
  const guest = await getGuest(tx, id, { includeDeleted: true });
  const [reservations, notes, occasions, loyalty, invoices, feedback, complaints, messages] = await Promise.all([
    q(tx, sql`SELECT * FROM reservations WHERE guest_id = ${id} ORDER BY start_at`),
    q(tx, sql`SELECT * FROM guest_notes WHERE guest_id = ${id} AND deleted_at IS NULL ORDER BY created_at`),
    q(tx, sql`SELECT * FROM guest_occasions WHERE guest_id = ${id} AND deleted_at IS NULL`),
    q(tx, sql`SELECT * FROM loyalty_transactions WHERE guest_id = ${id} ORDER BY created_at`),
    q(tx, sql`SELECT i.*, (SELECT json_agg(it) FROM pos_invoice_items it WHERE it.invoice_id = i.id) AS items
              FROM pos_invoices i WHERE guest_id = ${id} ORDER BY closed_at`),
    q(tx, sql`SELECT * FROM feedback WHERE guest_id = ${id}`),
    q(tx, sql`SELECT * FROM complaints WHERE guest_id = ${id}`),
    q(tx, sql`SELECT channel, template_key, status, created_at, sent_at, is_marketing FROM notification_outbox WHERE guest_id = ${id}`),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    guest: guestView(guest),
    reservations: camelRows(reservations),
    notes: camelRows(notes),
    occasions: camelRows(occasions),
    loyaltyTransactions: camelRows(loyalty),
    invoices: camelRows(invoices),
    feedback: camelRows(feedback),
    complaints: camelRows(complaints),
    messages: camelRows(messages),
  };
}

/** Guest 360°: profile, aggregates, history and favourites in one call. */
export async function guestProfile(tx: DbOrTx, id: string) {
  const guest = await getGuest(tx, id, { includeDeleted: true });
  const [reservations, invoices, loyalty, feedback, complaints, campaigns, notes, occasions, favTables, favAreas, favItems, favHours, favDays, favBranches, tier, monthly] =
    await Promise.all([
      q(tx, sql`SELECT r.id, r.code, r.branch_id, b.name AS branch_name, r.business_date, r.start_at, r.party_size, r.status,
                       r.occasion, r.source, r.table_ids, r.notes, r.special_request, r.requires_review,
                       (SELECT string_agg(t.label, '+') FROM restaurant_tables t WHERE t.id = ANY (r.table_ids)) AS table_labels,
                       (SELECT sum(total_base) FROM pos_invoices i WHERE i.reservation_id = r.id AND i.status = 'closed') AS spend
                FROM reservations r JOIN branches b ON b.id = r.branch_id
                WHERE r.guest_id = ${id} AND r.deleted_at IS NULL ORDER BY r.start_at DESC LIMIT 100`),
      q(tx, sql`SELECT i.id, i.invoice_number, i.closed_at, i.branch_id, b.name AS branch_name, i.table_label, i.total, i.currency,
                       i.total_base, i.discount, i.tax, i.service_charge, i.payment_method, i.reservation_id,
                       (SELECT json_agg(json_build_object('name', it.name, 'quantity', it.quantity, 'total', it.total) ORDER BY it.total DESC)
                          FROM pos_invoice_items it WHERE it.invoice_id = i.id) AS items
                FROM pos_invoices i JOIN branches b ON b.id = i.branch_id
                WHERE i.guest_id = ${id} AND i.deleted_at IS NULL ORDER BY i.closed_at DESC LIMIT 100`),
      q(tx, sql`SELECT id, type, points, balance_after, reason, created_at FROM loyalty_transactions WHERE guest_id = ${id} ORDER BY created_at DESC LIMIT 100`),
      q(tx, sql`SELECT id, reservation_id, overall_rating, food_rating, service_rating, atmosphere_rating, comment, suggestion, is_complaint, submitted_at
                FROM feedback WHERE guest_id = ${id} AND deleted_at IS NULL ORDER BY submitted_at DESC`),
      q(tx, sql`SELECT id, category, severity, status, description, resolution, created_at FROM complaints WHERE guest_id = ${id} AND deleted_at IS NULL ORDER BY created_at DESC`),
      q(tx, sql`SELECT c.id, c.name, c.channel, cr.status, cr.created_at FROM campaign_recipients cr JOIN campaigns c ON c.id = cr.campaign_id
                WHERE cr.guest_id = ${id} ORDER BY cr.created_at DESC LIMIT 50`),
      q(tx, sql`SELECT id, body, kind, is_pinned, created_at, created_by,
                       (SELECT display_name FROM users u WHERE u.id = n.created_by) AS author
                FROM guest_notes n WHERE guest_id = ${id} AND deleted_at IS NULL ORDER BY is_pinned DESC, created_at DESC`),
      q(tx, sql`SELECT id, type, date, recurring, notes FROM guest_occasions WHERE guest_id = ${id} AND deleted_at IS NULL ORDER BY date`),
      q(tx, sql`SELECT t.label, count(*)::int AS visits FROM reservations r, unnest(r.table_ids) tid JOIN restaurant_tables t ON t.id = tid
                WHERE r.guest_id = ${id} AND r.status IN ('seated','dining','completed') GROUP BY t.label ORDER BY visits DESC LIMIT 3`),
      q(tx, sql`SELECT a.name, a.name_ar, count(*)::int AS visits FROM reservations r JOIN areas a ON a.id = r.area_id
                WHERE r.guest_id = ${id} AND r.status IN ('seated','dining','completed') GROUP BY a.name, a.name_ar ORDER BY visits DESC LIMIT 3`),
      q(tx, sql`SELECT it.name, sum(it.quantity)::float AS quantity, count(DISTINCT i.id)::int AS orders FROM pos_invoice_items it
                JOIN pos_invoices i ON i.id = it.invoice_id WHERE i.guest_id = ${id} AND i.status = 'closed'
                GROUP BY it.name ORDER BY quantity DESC LIMIT 5`),
      q(tx, sql`SELECT extract(hour FROM r.start_at AT TIME ZONE b.timezone)::int AS hour, count(*)::int AS visits
                FROM reservations r JOIN branches b ON b.id = r.branch_id
                WHERE r.guest_id = ${id} AND r.status IN ('seated','dining','completed') GROUP BY 1 ORDER BY visits DESC LIMIT 3`),
      q(tx, sql`SELECT extract(dow FROM r.business_date)::int AS weekday, count(*)::int AS visits FROM reservations r
                WHERE r.guest_id = ${id} AND r.status IN ('seated','dining','completed') GROUP BY 1 ORDER BY visits DESC LIMIT 3`),
      q(tx, sql`SELECT b.id, b.name, b.name_ar, count(*)::int AS visits FROM reservations r JOIN branches b ON b.id = r.branch_id
                WHERE r.guest_id = ${id} AND r.status IN ('seated','dining','completed') GROUP BY b.id, b.name, b.name_ar ORDER BY visits DESC LIMIT 3`),
      guest.loyaltyTierId ? q(tx, sql`SELECT id, name, name_ar, color, multiplier FROM loyalty_tiers WHERE id = ${guest.loyaltyTierId}`) : Promise.resolve([]),
      q(tx, sql`SELECT to_char(date_trunc('month', closed_at), 'YYYY-MM') AS month, sum(total_base)::float AS spend, count(*)::int AS invoices
                FROM pos_invoices WHERE guest_id = ${id} AND status = 'closed' AND closed_at > now() - interval '24 months'
                GROUP BY 1 ORDER BY 1`),
    ]);
  const yearly = new Map<string, number>();
  for (const m of monthly as { month: string; spend: number }[]) yearly.set(m.month.slice(0, 4), (yearly.get(m.month.slice(0, 4)) ?? 0) + m.spend);
  const byBranch = await q(tx, sql`SELECT b.name, sum(i.total_base)::float AS spend, count(*)::int AS invoices FROM pos_invoices i JOIN branches b ON b.id = i.branch_id
                                    WHERE i.guest_id = ${id} AND i.status = 'closed' GROUP BY b.name ORDER BY spend DESC`);
  return {
    guest: guestView(guest),
    tier: tier[0] ? camelRows(tier)[0] : null,
    stats: {
      firstVisitAt: guest.firstVisitAt,
      lastVisitAt: guest.lastVisitAt,
      visitCount: guest.visitCount,
      reservationCount: guest.reservationCount,
      cancellationCount: guest.cancellationCount,
      noShowCount: guest.noShowCount,
      invoiceCount: guest.invoiceCount,
      totalSpend: guest.totalSpend,
      lifetimeValue: guest.totalSpend,
      avgCheck: guest.avgCheck,
      maxCheck: guest.maxCheck,
      revenuePerVisit: guest.visitCount ? Math.round((guest.totalSpend / guest.visitCount) * 100) / 100 : 0,
      monthlySpending: monthly,
      yearlySpending: [...yearly.entries()].map(([year, spend]) => ({ year, spend })),
      revenueByBranch: byBranch,
    },
    favorites: {
      tables: favTables,
      areas: camelRows(favAreas),
      items: favItems,
      hours: favHours,
      weekdays: favDays,
      branches: camelRows(favBranches),
    },
    reservations: camelRows(reservations),
    invoices: camelRows(invoices),
    loyalty: camelRows(loyalty),
    feedback: camelRows(feedback),
    complaints: camelRows(complaints),
    marketing: camelRows(campaigns),
    notes: camelRows(notes),
    occasions: camelRows(occasions),
  };
}

export async function refreshGuestStats(tx: DbOrTx, guestId: string | null | undefined): Promise<void> {
  if (guestId) await tx.execute(sql`SELECT refresh_guest_stats(${guestId})`);
}

export async function activeGuest(tx: DbOrTx, id: string) {
  const [g] = await tx.select().from(schema.guests).where(and(eq(schema.guests.id, id), isNull(schema.guests.deletedAt)));
  return g;
}

export { getDb };
