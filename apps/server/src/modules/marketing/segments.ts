import { eq } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { segmentRuleSchema } from '@sofia/shared';
import { z } from 'zod';
import { schema, sql, type DbOrTx } from '../../db/pool.js';
import { notFound } from '../../lib/errors.js';
import { getSetting } from '../../lib/settings.js';

type Rule = z.infer<typeof segmentRuleSchema>;

const NUMERIC: Record<string, SQL> = {
  total_spend: sql`g.total_spend`,
  visit_count: sql`g.visit_count`,
  avg_check: sql`g.avg_check`,
  no_show_count: sql`g.no_show_count`,
  loyalty_points: sql`g.loyalty_points`,
  days_since_last_visit: sql`(current_date - (g.last_visit_at)::date)`,
  days_since_first_visit: sql`(current_date - (g.first_visit_at)::date)`,
  birthday_in_days: sql`sofia_days_until_yearly(g.birthday)`,
  anniversary_in_days: sql`sofia_days_until_yearly(g.anniversary)`,
};
const TEXT: Record<string, SQL> = {
  vip_level: sql`g.vip_level`,
  home_branch_id: sql`g.home_branch_id::text`,
  preferred_language: sql`g.preferred_language`,
};

const OPS: Record<string, SQL> = { eq: sql`=`, neq: sql`<>`, gt: sql`>`, gte: sql`>=`, lt: sql`<`, lte: sql`<=` };

/** Compile one segment rule into a parameterised SQL predicate over the `guests g` alias (fields are whitelisted). */
export function ruleToSql(rule: Rule): SQL {
  if (rule.field === 'tag') {
    const values = Array.isArray(rule.value) ? rule.value.map(String) : [String(rule.value)];
    return rule.op === 'neq' ? sql`NOT (g.tags && ${sql.param(values)}::text[])` : sql`(g.tags && ${sql.param(values)}::text[])`;
  }
  const col = NUMERIC[rule.field] ?? TEXT[rule.field];
  if (!col) throw new Error(`Unsupported segment field ${rule.field}`);
  if (rule.op === 'in') {
    const values = (Array.isArray(rule.value) ? rule.value : [rule.value]).map(String);
    return sql`(${col})::text IN ${values}`;
  }
  if (rule.op === 'contains') return sql`(${col})::text ILIKE ${'%' + String(rule.value) + '%'}`;
  const v = NUMERIC[rule.field] ? Number(rule.value) : String(rule.value);
  return sql`(${col} ${OPS[rule.op]!} ${v})`;
}

export async function compileRules(rules: Rule[], match: 'all' | 'any'): Promise<SQL> {
  const settings = await getSetting('guests');
  const resolved = rules.map((r) =>
    r.value === '$highSpenderThreshold' ? { ...r, value: settings.highSpenderThreshold } : r.value === '$frequentVisits' ? { ...r, value: settings.frequentVisitsIn90Days } : r,
  );
  if (!resolved.length) return sql`true`;
  return sql`(${sql.join(resolved.map(ruleToSql), match === 'any' ? sql` OR ` : sql` AND `)})`;
}

/** SQL predicate for a stored segment (by key or id). */
export async function segmentWhere(tx: DbOrTx, keyOrId: string): Promise<SQL> {
  const isId = /^[0-9a-f-]{36}$/i.test(keyOrId);
  const [seg] = await tx.select().from(schema.segments).where(isId ? eq(schema.segments.id, keyOrId) : eq(schema.segments.key, keyOrId));
  if (!seg || seg.deletedAt) throw notFound('Segment');
  const rules = z.array(segmentRuleSchema).parse(seg.rules);
  return compileRules(rules, seg.match as 'all' | 'any');
}
