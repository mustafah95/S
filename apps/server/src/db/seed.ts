import { sql } from 'drizzle-orm';
import { DEFAULT_ROLES } from '@sofia/shared';
import { q, type DbOrTx } from './pool.js';

/**
 * Idempotent reference data. Runs after every migration:
 * - system roles are created once; permissions that a release adds to a default role are granted once
 *   (tracked in roles.seeded_permissions) so a Super Admin's later removals are respected;
 * - default message templates, system segments and loyalty configuration are inserted only when missing.
 */
export async function seedReferenceData(tx: DbOrTx): Promise<void> {
  for (const role of DEFAULT_ROLES) {
    const [row] = await q<{ id: string; seeded_permissions: string[] }>(
      tx,
      sql`INSERT INTO roles (key, name_en, name_ar, all_branches, is_system)
          VALUES (${role.key}, ${role.name.en}, ${role.name.ar}, ${role.allBranches}, true)
          ON CONFLICT (key) DO UPDATE SET name_en = roles.name_en
          RETURNING id, seeded_permissions`,
    );
    const toGrant = role.permissions.filter((p) => !row!.seeded_permissions.includes(p));
    for (const p of toGrant) {
      await tx.execute(
        sql`INSERT INTO role_permissions (role_id, permission) VALUES (${row!.id}, ${p}) ON CONFLICT DO NOTHING`,
      );
    }
    if (toGrant.length) {
      await tx.execute(
        sql`UPDATE roles SET seeded_permissions = seeded_permissions || ${sql.param(toGrant)}::text[], updated_at = now()
            WHERE id = ${row!.id}`,
      );
    }
  }

  for (const t of DEFAULT_TEMPLATES) {
    await tx.execute(sql`
      INSERT INTO message_templates (key, channel, language, subject, body)
      VALUES (${t.key}, ${t.channel}, ${t.language}, ${t.subject ?? null}, ${t.body})
      ON CONFLICT (key, channel, language) DO NOTHING`);
  }

  for (const s of SYSTEM_SEGMENTS) {
    await tx.execute(sql`
      INSERT INTO segments (key, name, name_ar, description, is_system, match, rules)
      VALUES (${s.key}, ${s.name}, ${s.nameAr}, ${s.description}, true, 'all', ${JSON.stringify(s.rules)}::jsonb)
      ON CONFLICT (key) DO NOTHING`);
  }

  const [{ n }] = (await q<{ n: number }>(tx, sql`SELECT count(*)::int AS n FROM loyalty_tiers`)) as [{ n: number }];
  if (n === 0) {
    const tiers = [
      { name: 'Classic', nameAr: 'كلاسيك', min: 0, mult: 1, color: '#8C7B6B' },
      { name: 'Silver', nameAr: 'فضي', min: 1000, mult: 1.1, color: '#A8A9AD' },
      { name: 'Gold', nameAr: 'ذهبي', min: 3000, mult: 1.25, color: '#C9A26B' },
      { name: 'Platinum', nameAr: 'بلاتيني', min: 8000, mult: 1.5, color: '#5B5F66' },
    ];
    let order = 0;
    for (const t of tiers) {
      await tx.execute(sql`INSERT INTO loyalty_tiers (name, name_ar, min_points, multiplier, color, sort_order)
                           VALUES (${t.name}, ${t.nameAr}, ${t.min}, ${t.mult}, ${t.color}, ${order++})`);
    }
    const rules = [
      { type: 'points_per_currency', name: '1 point per 1,000 IQD', config: { currencyUnit: 1000, points: 1 } },
      { type: 'visit', name: 'Visit bonus', config: { points: 10 } },
      { type: 'birthday', name: 'Birthday gift', config: { points: 200 } },
      { type: 'spend_threshold', name: 'Big table bonus', config: { threshold: 500000, points: 100 } },
      { type: 'referral', name: 'Referral reward', config: { points: 150 } },
    ];
    for (const r of rules) {
      await tx.execute(sql`INSERT INTO loyalty_rules (type, name, config) VALUES (${r.type}, ${r.name}, ${JSON.stringify(r.config)}::jsonb)`);
    }
    const rewards = [
      { name: 'Complimentary dessert', nameAr: 'حلوى مجانية', type: 'free_item', cost: 300, value: 0 },
      { name: '10% off the bill', nameAr: 'خصم 10٪ على الفاتورة', type: 'discount_percent', cost: 800, value: 10 },
      { name: '50,000 IQD voucher', nameAr: 'قسيمة 50,000 دينار', type: 'voucher', cost: 1500, value: 50000 },
    ];
    for (const r of rewards) {
      await tx.execute(sql`INSERT INTO loyalty_rewards (name, name_ar, type, points_cost, value)
                           VALUES (${r.name}, ${r.nameAr}, ${r.type}, ${r.cost}, ${r.value})`);
    }
  }
}

interface TemplateSeed {
  key: string;
  channel: string;
  language: 'ar' | 'en';
  subject?: string;
  body: string;
}

const T: Record<string, { en: string; ar: string; subjectEn?: string; subjectAr?: string }> = {
  reservation_confirmation: {
    subjectEn: "Your reservation at {{restaurant}} is confirmed",
    subjectAr: 'تأكيد حجزك في {{restaurant}}',
    en: "Dear {{guest_name}}, your table at {{restaurant}} ({{branch}}) is confirmed for {{date}} at {{time}} for {{party_size}} guests. Reservation number: {{code}}. Manage your booking: {{manage_url}}",
    ar: 'عزيزي/عزيزتي {{guest_name}}، تم تأكيد حجز طاولتك في {{restaurant}} ({{branch}}) بتاريخ {{date}} الساعة {{time}} لعدد {{party_size}} أشخاص. رقم الحجز: {{code}}. لإدارة الحجز: {{manage_url}}',
  },
  reservation_reminder: {
    subjectEn: 'Reminder: your reservation today at {{time}}',
    subjectAr: 'تذكير: حجزك اليوم الساعة {{time}}',
    en: 'Hello {{guest_name}}, a friendly reminder of your reservation at {{restaurant}} today at {{time}} for {{party_size}}. We look forward to welcoming you. Ref {{code}}',
    ar: 'مرحباً {{guest_name}}، نذكّرك بحجزك في {{restaurant}} اليوم الساعة {{time}} لعدد {{party_size}}. يسعدنا استقبالك. رقم الحجز {{code}}',
  },
  reservation_cancelled: {
    subjectEn: 'Your reservation {{code}} was cancelled',
    subjectAr: 'تم إلغاء حجزك {{code}}',
    en: 'Dear {{guest_name}}, your reservation {{code}} at {{restaurant}} on {{date}} at {{time}} has been cancelled. We hope to see you soon.',
    ar: 'عزيزي/عزيزتي {{guest_name}}، تم إلغاء حجزك رقم {{code}} في {{restaurant}} بتاريخ {{date}} الساعة {{time}}. نتطلع لرؤيتك قريباً.',
  },
  reservation_rescheduled: {
    subjectEn: 'Your reservation has been moved to {{date}} {{time}}',
    subjectAr: 'تم تعديل موعد حجزك إلى {{date}} {{time}}',
    en: 'Dear {{guest_name}}, your reservation at {{restaurant}} is now on {{date}} at {{time}} for {{party_size}}. New reservation number: {{code}}.',
    ar: 'عزيزي/عزيزتي {{guest_name}}، تم تعديل موعد حجزك في {{restaurant}} إلى {{date}} الساعة {{time}} لعدد {{party_size}}. رقم الحجز الجديد: {{code}}.',
  },
  waitlist_ready: {
    en: 'Hello {{guest_name}}, your table at {{restaurant}} is ready! Please come to the host stand within 10 minutes.',
    ar: 'مرحباً {{guest_name}}، طاولتك في {{restaurant}} جاهزة! يرجى التوجه إلى مكتب الاستقبال خلال 10 دقائق.',
  },
  birthday: {
    subjectEn: 'Happy birthday from {{restaurant}}',
    subjectAr: 'عيد ميلاد سعيد من {{restaurant}}',
    en: 'Happy birthday {{guest_name}}! Celebrate with us at {{restaurant}} — a special treat awaits you this month.',
    ar: 'عيد ميلاد سعيد {{guest_name}}! احتفل معنا في {{restaurant}} — مفاجأة خاصة بانتظارك هذا الشهر.',
  },
  feedback_request: {
    subjectEn: 'How was your evening at {{restaurant}}?',
    subjectAr: 'كيف كانت أمسيتك في {{restaurant}}؟',
    en: 'Thank you for dining with us, {{guest_name}}. We would love your feedback: {{feedback_url}}',
    ar: 'شكراً لزيارتك {{guest_name}}. يسعدنا سماع رأيك: {{feedback_url}}',
  },
  marketing: {
    subjectEn: 'News from {{restaurant}}',
    subjectAr: 'جديد {{restaurant}}',
    en: '{{message}}\n\nReply STOP to opt out: {{opt_out_url}}',
    ar: '{{message}}\n\nلإلغاء الاشتراك أرسل STOP: {{opt_out_url}}',
  },
};

const DEFAULT_TEMPLATES: TemplateSeed[] = Object.entries(T).flatMap(([key, t]) =>
  (['whatsapp', 'sms', 'email'] as const).flatMap((channel) => [
    { key, channel, language: 'en' as const, subject: channel === 'email' ? t.subjectEn ?? key : undefined, body: t.en },
    { key, channel, language: 'ar' as const, subject: channel === 'email' ? t.subjectAr ?? key : undefined, body: t.ar },
  ]),
);

const SYSTEM_SEGMENTS = [
  { key: 'vip', name: 'VIP guests', nameAr: 'كبار الضيوف', description: 'VIP level gold or above', rules: [{ field: 'vip_level', op: 'in', value: ['gold', 'platinum', 'vip', 'vvip'] }] },
  { key: 'high_spender', name: 'High spenders', nameAr: 'الأعلى إنفاقاً', description: 'Lifetime spend above the configured threshold', rules: [{ field: 'total_spend', op: 'gte', value: '$highSpenderThreshold' }] },
  { key: 'frequent', name: 'Frequent guests', nameAr: 'الضيوف الدائمون', description: 'At least 4 visits', rules: [{ field: 'visit_count', op: 'gte', value: 4 }] },
  { key: 'new', name: 'New guests (30 days)', nameAr: 'ضيوف جدد (30 يوماً)', description: 'First visit within the last 30 days', rules: [{ field: 'days_since_first_visit', op: 'lte', value: 30 }] },
  { key: 'inactive', name: 'Inactive (90+ days)', nameAr: 'غير نشطين (90+ يوماً)', description: 'No visit for 90 days or more', rules: [{ field: 'days_since_last_visit', op: 'gte', value: 90 }] },
  { key: 'birthday_month', name: 'Birthday in next 30 days', nameAr: 'عيد ميلاد خلال 30 يوماً', description: 'Birthday within the next 30 days', rules: [{ field: 'birthday_in_days', op: 'lte', value: 30 }] },
  { key: 'anniversary_month', name: 'Anniversary in next 30 days', nameAr: 'ذكرى سنوية خلال 30 يوماً', description: 'Anniversary within the next 30 days', rules: [{ field: 'anniversary_in_days', op: 'lte', value: 30 }] },
  { key: 'no_visit_30', name: 'No visit 30 days', nameAr: 'لا زيارة منذ 30 يوماً', description: 'Last visit 30+ days ago', rules: [{ field: 'days_since_last_visit', op: 'gte', value: 30 }] },
  { key: 'no_visit_60', name: 'No visit 60 days', nameAr: 'لا زيارة منذ 60 يوماً', description: 'Last visit 60+ days ago', rules: [{ field: 'days_since_last_visit', op: 'gte', value: 60 }] },
  { key: 'no_visit_90', name: 'No visit 90 days', nameAr: 'لا زيارة منذ 90 يوماً', description: 'Last visit 90+ days ago', rules: [{ field: 'days_since_last_visit', op: 'gte', value: 90 }] },
];
