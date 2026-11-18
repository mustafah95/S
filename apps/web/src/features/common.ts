import { useMemo } from 'react';
import {
  ACTIVE_RESERVATION_STATUSES,
  DEFAULT_RESERVATION_SETTINGS,
  DEFAULT_WEEKLY_HOURS,
  addDays,
  businessDateOf,
  durationForParty,
  generateSlots,
  isTableFree,
  pickTables,
  type AllocationForPick,
  type ReservationSettings,
  type ReservationStatus,
  type WeeklyHours,
} from '@sofia/shared';
import { useApp } from '../app/context';
import type { Rec } from '../offline/db';
import { useBranch } from '../offline/hooks';
import { useSyncState } from '../offline/state';

export function useBranchContext() {
  const { branchId } = useApp();
  const branch = useBranch(branchId);
  const tz = (branch?.timezone as string) ?? 'Asia/Baghdad';
  const settings: ReservationSettings = useMemo(
    () => ({
      ...DEFAULT_RESERVATION_SETTINGS,
      ...((branch?.reservationSettings ?? {}) as Partial<ReservationSettings>),
      deposit: { ...DEFAULT_RESERVATION_SETTINGS.deposit, ...(((branch?.reservationSettings as Partial<ReservationSettings>)?.deposit) ?? {}) },
    }),
    [branch],
  );
  const hours = (branch?.operatingHours as WeeklyHours | undefined) ?? DEFAULT_WEEKLY_HOURS;
  const today = businessDateOf(new Date(), tz);
  return { branchId, branch, tz, settings, hours, today };
}

export function useOnline(): boolean {
  const s = useSyncState();
  return s.connection === 'online' || s.connection === 'syncing';
}

/** Table holds derived from local reservations (active statuses, booked tables, plus turnover buffer). */
export function allocationsFrom(reservations: Rec[], bufferMinutes: number, excludeId?: string): AllocationForPick[] {
  return reservations
    .filter((r) => ACTIVE_RESERVATION_STATUSES.includes(r.status as ReservationStatus) && r.id !== excludeId && Array.isArray(r.tableIds))
    .flatMap((r) =>
      (r.tableIds as string[]).map((tableId) => ({
        tableId,
        reservationId: r.id,
        start: new Date(r.startAt).getTime(),
        end: new Date(r.endAt).getTime() + bufferMinutes * 60_000,
      })),
    );
}

/** Offline-capable availability: the same slot + table picking rules the server applies. */
export function localSlots(opts: { date: string; partySize: number; hours: WeeklyHours; settings: ReservationSettings; tz: string; tables: Rec[]; combos: Rec[]; reservations: Rec[]; areaId?: string | null; excludeId?: string }) {
  const duration = durationForParty(opts.settings, opts.partySize);
  const allocations = allocationsFrom(opts.reservations, opts.settings.bufferMinutes, opts.excludeId);
  const now = Date.now();
  return generateSlots(opts.date, opts.hours, opts.settings, opts.tz).map((s) => {
    const start = s.startAt.getTime();
    const end = start + (duration + opts.settings.bufferMinutes) * 60_000;
    const pick = start < now - 15 * 60_000 ? null : pickTables(opts.tables as never, opts.combos as never, allocations, start, end, opts.partySize, { areaId: opts.areaId, now });
    return { time: s.time, startAt: s.startAt, available: !!pick, tableIds: pick?.tableIds ?? [] };
  });
}

export function tableAvailability(tables: Rec[], reservations: Rec[], start: Date, durationMinutes: number, bufferMinutes: number, excludeId?: string) {
  const allocations = allocationsFrom(reservations, bufferMinutes, excludeId);
  const s = start.getTime();
  const e = s + (durationMinutes + bufferMinutes) * 60_000;
  return new Map(tables.map((t) => [t.id, isTableFree(t as never, allocations, s, e, { excludeReservationId: excludeId })]));
}

export function dayRange(date: string): string[] {
  return [addDays(date, -1), date, addDays(date, 1)];
}

export function guestLabel(r: Rec): string {
  return (r.guestName as string) || '—';
}
