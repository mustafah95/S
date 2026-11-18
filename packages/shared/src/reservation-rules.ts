import type { ReservationStatus } from './enums.js';
import { addDays, minutesToHHMM, parseHHMM, weekdayOf, zonedToUtc } from './time.js';

/** Opening period in branch-local wall-clock time. `close` <= `open` means the period ends after midnight. */
export interface OpeningPeriod {
  open: string;
  close: string;
}

/** Index 0 = Sunday … 6 = Saturday. An empty list means closed that day. */
export type WeeklyHours = OpeningPeriod[][];

export const DEFAULT_WEEKLY_HOURS: WeeklyHours = Array.from({ length: 7 }, () => [{ open: '12:00', close: '00:00' }]);

export interface DurationRule {
  maxPartySize: number;
  minutes: number;
}

export interface ReservationSettings {
  slotIntervalMinutes: number;
  defaultDurationMinutes: number;
  durationRules: DurationRule[];
  bufferMinutes: number;
  maxAdvanceDays: number;
  minNoticeMinutes: number;
  lastSeatingBeforeCloseMinutes: number;
  maxOnlinePartySize: number;
  onlineBookingEnabled: boolean;
  autoConfirmOnline: boolean;
  requireTableForOnline: boolean;
  deposit: {
    enabled: boolean;
    minPartySize: number;
    amountPerGuest: number;
    currency: string;
  };
  cancellationCutoffHours: number;
  cancellationPolicy: { en: string; ar: string };
  noShowGraceMinutes: number;
  lateThresholdMinutes: number;
  reminderHoursBefore: number;
  feedbackDelayMinutes: number;
  markCleaningAfterComplete: boolean;
  holdVipTablesForVip: boolean;
}

export const DEFAULT_RESERVATION_SETTINGS: ReservationSettings = {
  slotIntervalMinutes: 30,
  defaultDurationMinutes: 120,
  durationRules: [
    { maxPartySize: 2, minutes: 90 },
    { maxPartySize: 4, minutes: 120 },
    { maxPartySize: 8, minutes: 150 },
  ],
  bufferMinutes: 15,
  maxAdvanceDays: 60,
  minNoticeMinutes: 60,
  lastSeatingBeforeCloseMinutes: 60,
  maxOnlinePartySize: 10,
  onlineBookingEnabled: true,
  autoConfirmOnline: true,
  requireTableForOnline: true,
  deposit: { enabled: false, minPartySize: 8, amountPerGuest: 10000, currency: 'IQD' },
  cancellationCutoffHours: 4,
  cancellationPolicy: {
    en: 'Please cancel at least 4 hours before your reservation. Tables are held for 15 minutes after the booked time.',
    ar: 'يرجى الإلغاء قبل 4 ساعات على الأقل من موعد الحجز. تُحجز الطاولة لمدة 15 دقيقة بعد الموعد المحدد.',
  },
  noShowGraceMinutes: 30,
  lateThresholdMinutes: 15,
  reminderHoursBefore: 3,
  feedbackDelayMinutes: 90,
  markCleaningAfterComplete: true,
  holdVipTablesForVip: true,
};

export function durationForParty(settings: ReservationSettings, partySize: number): number {
  const rules = [...settings.durationRules].sort((a, b) => a.maxPartySize - b.maxPartySize);
  for (const r of rules) if (partySize <= r.maxPartySize) return r.minutes;
  return settings.defaultDurationMinutes;
}

/** Allowed status transitions — the reservation state machine. */
export const RESERVATION_TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  pending: ['confirmed', 'checked_in', 'seated', 'cancelled', 'no_show', 'rescheduled'],
  confirmed: ['checked_in', 'seated', 'cancelled', 'no_show', 'rescheduled', 'pending'],
  checked_in: ['seated', 'cancelled', 'confirmed'],
  seated: ['dining', 'completed'],
  dining: ['completed'],
  completed: [],
  cancelled: ['pending', 'confirmed'],
  no_show: ['confirmed', 'checked_in'],
  rescheduled: [],
};

export function canTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return from === to || RESERVATION_TRANSITIONS[from].includes(to);
}

export interface Slot {
  /** Business date the slot belongs to (YYYY-MM-DD) */
  date: string;
  /** Local wall-clock time HH:mm */
  time: string;
  startAt: Date;
}

export interface Closure {
  date: string;
  /** null = closed all day; otherwise special opening periods for that date */
  periods: OpeningPeriod[] | null;
}

/** Opening periods that apply to a business date, honouring special closures / special hours. */
export function periodsForDate(date: string, weekly: WeeklyHours, closures: Closure[] = []): OpeningPeriod[] {
  const special = closures.find((c) => c.date === date);
  if (special) return special.periods ?? [];
  return weekly[weekdayOf(date)] ?? [];
}

/**
 * Generate bookable start times for a business date. Periods that cross midnight produce slots on the next
 * calendar day but they still belong to the business date.
 */
export function generateSlots(
  date: string,
  weekly: WeeklyHours,
  settings: ReservationSettings,
  timeZone: string,
  closures: Closure[] = [],
): Slot[] {
  const slots: Slot[] = [];
  for (const period of periodsForDate(date, weekly, closures)) {
    const open = parseHHMM(period.open);
    let close = parseHHMM(period.close);
    if (close <= open) close += 1440;
    const last = close - settings.lastSeatingBeforeCloseMinutes;
    for (let m = open; m <= last; m += settings.slotIntervalMinutes) {
      const calendarDate = m >= 1440 ? addDays(date, 1) : date;
      const time = minutesToHHMM(m);
      slots.push({ date, time, startAt: zonedToUtc(calendarDate, time, timeZone) });
    }
  }
  return slots.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}

/**
 * Whether a reservation starting at `start` begins inside an opening period of its business date (or inside the
 * previous date's period that runs past midnight). Guests may keep dining after closing time.
 */
export function isWithinOpeningHours(
  start: Date,
  date: string,
  weekly: WeeklyHours,
  timeZone: string,
  closures: Closure[] = [],
): boolean {
  for (const d of [date, addDays(date, -1)]) {
    for (const period of periodsForDate(d, weekly, closures)) {
      const open = parseHHMM(period.open);
      let close = parseHHMM(period.close);
      if (close <= open) close += 1440;
      const openAt = zonedToUtc(d, minutesToHHMM(open), timeZone);
      const closeAt = new Date(openAt.getTime() + (close - open) * 60_000);
      if (start >= openAt && start < closeAt) return true;
    }
  }
  return false;
}

/** Deposit due for a party, or 0 when no deposit rule applies. */
export function depositFor(settings: ReservationSettings, partySize: number): number {
  if (!settings.deposit.enabled || partySize < settings.deposit.minPartySize) return 0;
  return settings.deposit.amountPerGuest * partySize;
}

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Human-friendly reservation number, e.g. SR-7K3Q9M. */
export function generateReservationCode(prefix = 'SR'): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `${prefix}-${out}`;
}

export interface TableStatusInput {
  id: string;
  manualStatus: string;
  manualStatusUntil?: string | Date | null;
  isActive?: boolean;
}

export interface ReservationForStatus {
  id: string;
  status: ReservationStatus;
  startAt: string | Date;
  endAt: string | Date;
  tableIds: string[];
}

export interface EffectiveTableStatus<R extends ReservationForStatus = ReservationForStatus> {
  status: 'available' | 'reserved' | 'occupied' | 'cleaning' | 'blocked' | 'maintenance';
  current?: R;
  next?: R;
}

/**
 * Live status of a table, derived identically on the server and on offline devices:
 * manual states (cleaning / blocked / maintenance) win while they last; otherwise a seated party makes the table
 * occupied, an upcoming reservation within `lookaheadMinutes` makes it reserved.
 */
export function effectiveTableStatus<R extends ReservationForStatus>(
  table: TableStatusInput,
  reservations: R[],
  now: Date = new Date(),
  lookaheadMinutes = 90,
): EffectiveTableStatus<R> {
  const t = now.getTime();
  const mine = reservations
    .filter((r) => r.tableIds.includes(table.id))
    .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
  const current = mine.find((r) => r.status === 'seated' || r.status === 'dining');
  const next = mine.find(
    (r) =>
      ['pending', 'confirmed', 'checked_in'].includes(r.status) &&
      new Date(r.endAt).getTime() > t &&
      new Date(r.startAt).getTime() - t <= lookaheadMinutes * 60_000,
  );
  const manualActive =
    table.manualStatus !== 'available' &&
    (!table.manualStatusUntil || new Date(table.manualStatusUntil).getTime() > t);
  if (manualActive) return { status: table.manualStatus as EffectiveTableStatus['status'], current, next };
  if (current) return { status: 'occupied', current, next };
  if (next) return { status: 'reserved', next };
  return { status: 'available' };
}

// ---------------------------------------------------------------------------------------------------------
// Table assignment (pure — used by the server engine and by offline devices for local warnings)
// ---------------------------------------------------------------------------------------------------------

export interface TableForPick {
  id: string;
  areaId: string;
  label: string;
  capacity: number;
  minCapacity: number;
  maxCapacity: number;
  isVip: boolean;
  isActive: boolean;
  bookableOnline: boolean;
  combinable: boolean;
  manualStatus: string;
  manualStatusUntil?: string | Date | null;
  deletedAt?: string | Date | null;
}

export interface ComboForPick {
  id: string;
  tableIds: string[];
  minCapacity: number;
  maxCapacity: number;
  isActive: boolean;
}

export interface AllocationForPick {
  tableId: string;
  /** epoch ms, inclusive */
  start: number;
  /** epoch ms, exclusive (includes turnover buffer) */
  end: number;
  reservationId?: string | null;
}

export interface PickOptions {
  areaId?: string | null;
  /** Public booking: only tables bookable online. */
  onlineOnly?: boolean;
  /** Keep VIP tables for guests at or above this rank (see VIP_RANK); undefined = no restriction. */
  allowVipTables?: boolean;
  excludeReservationId?: string | null;
  now?: number;
}

export function isTableFree(
  table: TableForPick,
  allocations: AllocationForPick[],
  start: number,
  end: number,
  opts: PickOptions = {},
): boolean {
  if (!table.isActive || table.deletedAt) return false;
  if (opts.onlineOnly && !table.bookableOnline) return false;
  const now = opts.now ?? Date.now();
  const until = table.manualStatusUntil ? new Date(table.manualStatusUntil).getTime() : null;
  if (table.manualStatus === 'blocked' || table.manualStatus === 'maintenance') {
    if (until === null || until > start) return false;
  }
  if (table.manualStatus === 'cleaning' && start < now + 20 * 60_000 && (until === null || until > start)) return false;
  return !allocations.some(
    (a) => a.tableId === table.id && a.reservationId !== opts.excludeReservationId && a.start < end && start < a.end,
  );
}

/**
 * Choose tables for a party: the smallest single table that fits (preferring the requested area and keeping VIP
 * tables free), otherwise the smallest free predefined combination. Returns null when nothing fits.
 */
export function pickTables(
  tables: TableForPick[],
  combos: ComboForPick[],
  allocations: AllocationForPick[],
  start: number,
  end: number,
  partySize: number,
  opts: PickOptions = {},
): { tableIds: string[]; combinationId?: string } | null {
  const usable = tables.filter(
    (t) => isTableFree(t, allocations, start, end, opts) && (opts.allowVipTables !== false || !t.isVip),
  );
  const singles = usable
    .filter((t) => t.minCapacity <= partySize && partySize <= t.maxCapacity)
    .sort(
      (a, b) =>
        Number(opts.areaId ? a.areaId !== opts.areaId : 0) - Number(opts.areaId ? b.areaId !== opts.areaId : 0) ||
        a.maxCapacity - b.maxCapacity ||
        Number(a.isVip) - Number(b.isVip) ||
        a.label.localeCompare(b.label, undefined, { numeric: true }),
    );
  const areaFilter = (t: TableForPick) => !opts.areaId || t.areaId === opts.areaId;
  const bestSingle = singles.find(areaFilter) ?? (opts.areaId ? undefined : singles[0]);
  if (bestSingle) return { tableIds: [bestSingle.id] };
  const usableIds = new Set(usable.filter((t) => t.combinable).map((t) => t.id));
  const byId = new Map(tables.map((t) => [t.id, t]));
  const combo = combos
    .filter(
      (c) =>
        c.isActive &&
        c.minCapacity <= partySize &&
        partySize <= c.maxCapacity &&
        c.tableIds.every((id) => usableIds.has(id)) &&
        (!opts.areaId || c.tableIds.every((id) => byId.get(id)?.areaId === opts.areaId)),
    )
    .sort((a, b) => a.maxCapacity - b.maxCapacity)[0];
  if (combo) return { tableIds: [...combo.tableIds], combinationId: combo.id };
  return null;
}

/** Combined seating capacity of several tables (T1 + T2 …). */
export function combinedCapacity(tables: Pick<TableForPick, 'maxCapacity' | 'minCapacity'>[]): { min: number; max: number } {
  return {
    min: tables.reduce((s, t) => Math.max(s, t.minCapacity), 0),
    max: tables.reduce((s, t) => s + t.maxCapacity, 0),
  };
}
