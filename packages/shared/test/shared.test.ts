import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESERVATION_SETTINGS,
  DEFAULT_ROLES,
  PERMISSIONS,
  canTransition,
  compareVersions,
  durationForParty,
  generateSlots,
  isWithinOpeningHours,
  mergeSet,
  normalizePhone,
  renderTemplate,
  utcToZoned,
  uuidv7,
  zonedToUtc,
  guestCreateSchema,
  reservationCreateSchema,
  syncPushSchema,
} from '../src/index.js';

describe('time zones', () => {
  it('converts Baghdad wall-clock time to UTC (UTC+3, no DST)', () => {
    const d = zonedToUtc('2026-11-18', '20:30', 'Asia/Baghdad');
    expect(d.toISOString()).toBe('2026-11-18T17:30:00.000Z');
    expect(utcToZoned(d, 'Asia/Baghdad')).toMatchObject({ date: '2026-11-18', time: '20:30', weekday: 3 });
  });

  it('handles DST zones', () => {
    // 2026-03-29 02:30 does not exist in Europe/Berlin; 2026-07-01 is UTC+2
    expect(zonedToUtc('2026-07-01', '12:00', 'Europe/Berlin').toISOString()).toBe('2026-07-01T10:00:00.000Z');
    expect(zonedToUtc('2026-01-15', '12:00', 'Europe/Berlin').toISOString()).toBe('2026-01-15T11:00:00.000Z');
  });
});

describe('reservation rules', () => {
  const weekly = Array.from({ length: 7 }, () => [{ open: '18:00', close: '01:00' }]);

  it('generates slots across midnight and respects last seating', () => {
    const slots = generateSlots('2026-11-18', weekly, DEFAULT_RESERVATION_SETTINGS, 'Asia/Baghdad');
    expect(slots[0]!.time).toBe('18:00');
    // close 01:00 - 60 min last seating = 00:00 → last slot 00:00 on the next calendar day
    expect(slots.at(-1)!.time).toBe('00:00');
    expect(slots.at(-1)!.startAt.toISOString()).toBe('2026-11-18T21:00:00.000Z');
    expect(slots).toHaveLength(13);
  });

  it('honours closures', () => {
    const slots = generateSlots('2026-11-18', weekly, DEFAULT_RESERVATION_SETTINGS, 'Asia/Baghdad', [
      { date: '2026-11-18', periods: null },
    ]);
    expect(slots).toHaveLength(0);
  });

  it('checks opening hours including the late part of the previous business day', () => {
    const afterMidnight = zonedToUtc('2026-11-19', '00:30', 'Asia/Baghdad');
    expect(isWithinOpeningHours(afterMidnight, '2026-11-19', weekly, 'Asia/Baghdad')).toBe(true);
    const morning = zonedToUtc('2026-11-19', '10:00', 'Asia/Baghdad');
    expect(isWithinOpeningHours(morning, '2026-11-19', weekly, 'Asia/Baghdad')).toBe(false);
  });

  it('picks duration by party size', () => {
    expect(durationForParty(DEFAULT_RESERVATION_SETTINGS, 2)).toBe(90);
    expect(durationForParty(DEFAULT_RESERVATION_SETTINGS, 4)).toBe(120);
    expect(durationForParty(DEFAULT_RESERVATION_SETTINGS, 20)).toBe(120);
  });

  it('enforces the status state machine', () => {
    expect(canTransition('confirmed', 'seated')).toBe(true);
    expect(canTransition('completed', 'seated')).toBe(false);
    expect(canTransition('cancelled', 'seated')).toBe(false);
    expect(canTransition('seated', 'cancelled')).toBe(false);
  });
});

describe('utilities', () => {
  it('generates sortable v7 UUIDs accepted by the schema', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a < b).toBe(true);
    expect(a[14]).toBe('7');
    expect(guestCreateSchema.safeParse({ id: a, firstName: 'Ali' }).success).toBe(true);
  });

  it('normalises Iraqi phone numbers', () => {
    expect(normalizePhone('0770 123 4567')).toBe('+9647701234567');
    expect(normalizePhone('+964 770 123 4567')).toBe('+9647701234567');
    expect(normalizePhone('00964-770-123-4567')).toBe('+9647701234567');
    expect(normalizePhone('12')).toBeNull();
  });

  it('merges sets three-way', () => {
    expect(mergeSet(['a', 'b'], ['a', 'c'], ['a', 'b', 'd'])).toEqual(['a', 'd', 'c']);
  });

  it('renders templates', () => {
    expect(renderTemplate('Hi {{name}}, table {{ table }}', { name: 'Sara', table: 5 })).toBe('Hi Sara, table 5');
  });

  it('compares versions', () => {
    expect(compareVersions('1.1.0', '1.0.9')).toBeGreaterThan(0);
    expect(compareVersions('2.0.4', '2.1.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });
});

describe('schemas and RBAC', () => {
  it('validates reservations', () => {
    const ok = reservationCreateSchema.safeParse({
      branchId: uuidv7(),
      date: '2026-11-18',
      time: '20:00',
      partySize: 4,
    });
    expect(ok.success).toBe(true);
    expect(reservationCreateSchema.safeParse({ branchId: uuidv7(), date: '18/11', time: '8pm', partySize: 0 }).success).toBe(
      false,
    );
  });

  it('validates sync push payloads', () => {
    const r = syncPushSchema.safeParse({
      deviceId: uuidv7(),
      protocol: 1,
      ops: [
        {
          opId: uuidv7(),
          entityType: 'guest',
          entityId: uuidv7(),
          op: 'create',
          payload: { firstName: 'Ali' },
          clientTs: new Date().toISOString(),
          userId: uuidv7(),
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('defines all 14 roles with valid permissions', () => {
    expect(DEFAULT_ROLES).toHaveLength(14);
    for (const role of DEFAULT_ROLES) {
      for (const p of role.permissions) expect(PERMISSIONS).toContain(p);
    }
    const host = DEFAULT_ROLES.find((r) => r.key === 'host')!;
    expect(host.permissions).toContain('reservations.create');
    expect(host.permissions).not.toContain('system.update');
  });
});
