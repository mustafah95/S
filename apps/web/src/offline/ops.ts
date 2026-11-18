import { businessToUtc, type ReservationAction } from '@sofia/shared';
import type { OutboxOp, Rec } from './db';

/** Optimistic effect of a reservation action, mirrored from the server state machine. */
export function applyReservationAction(r: Rec, action: string, payload: Record<string, unknown>, at: string): Rec {
  const out = { ...r };
  switch (action as ReservationAction) {
    case 'confirm':
      out.status = 'confirmed';
      break;
    case 'check_in':
      out.status = 'checked_in';
      out.checkedInAt = at;
      break;
    case 'seat':
      out.status = 'seated';
      out.seatedAt = at;
      out.checkedInAt ??= at;
      if (Array.isArray(payload.tableIds) && payload.tableIds.length) out.tableIds = payload.tableIds;
      break;
    case 'start_dining':
      out.status = 'dining';
      out.diningAt = at;
      break;
    case 'complete':
      out.status = 'completed';
      out.completedAt = at;
      break;
    case 'cancel':
      out.status = 'cancelled';
      out.cancelledAt = at;
      out.cancelReason = payload.reason ?? null;
      break;
    case 'no_show':
      out.status = 'no_show';
      out.noShowAt = at;
      break;
    case 'assign_tables':
      out.tableIds = (payload.tableIds as string[]) ?? [];
      break;
  }
  return out;
}

/** Reservation field edits; date/time/party changes recompute the local start/end. */
export function applyReservationPatch(r: Rec, patch: Record<string, unknown>, tz: string, durationFor?: (party: number) => number): Rec {
  const out: Rec = { ...r, ...patch };
  if (patch.date !== undefined || patch.time !== undefined || patch.partySize !== undefined || patch.durationMinutes !== undefined) {
    const date = (patch.date as string) ?? r.businessDate;
    const time = (patch.time as string) ?? r.time;
    const duration = (patch.durationMinutes as number) ?? (patch.partySize !== undefined && durationFor ? durationFor(patch.partySize as number) : r.durationMinutes);
    if (date && time) {
      const start = businessToUtc(date, time, tz);
      out.businessDate = date;
      out.time = time;
      out.startAt = start.toISOString();
      out.endAt = new Date(start.getTime() + (duration ?? 120) * 60_000).toISOString();
      out.durationMinutes = duration;
    }
  }
  delete out.date;
  delete out.overrideHours;
  return out;
}

export function applyWaitlistAction(w: Rec, action: string, payload: Record<string, unknown>, at: string): Rec {
  const out = { ...w };
  if (action === 'notify') {
    out.status = 'notified';
    out.notifiedAt = at;
  } else if (action === 'cancel') {
    out.status = 'cancelled';
    out.cancelledAt = at;
  } else if (action === 'seat') {
    out.status = 'seated';
    out.seatedAt = at;
    out.reservationId = payload.reservationId ?? null;
  }
  return out;
}

export function applyTableStatus(t: Rec, payload: Record<string, unknown>, at: string): Rec {
  return { ...t, manualStatus: payload.status, manualStatusReason: payload.reason ?? null, manualStatusUntil: payload.until ?? null, manualStatusAt: at };
}

export interface RebaseContext {
  tzFor: (branchId: string) => string;
  durationFor: (branchId: string, party: number) => number;
}

/** Re-apply still-pending local operations on top of a fresh server record (local edits are never lost). */
export function rebase(server: Rec, pending: OutboxOp[], ctx: RebaseContext): Rec {
  let rec: Rec = { ...server };
  for (const op of pending) {
    if (op.op === 'update') {
      rec =
        op.entityType === 'reservation'
          ? applyReservationPatch(rec, op.payload, ctx.tzFor(rec.branchId), (p) => ctx.durationFor(rec.branchId, p))
          : { ...rec, ...op.payload };
    } else if (op.op === 'action') {
      if (op.entityType === 'reservation') rec = applyReservationAction(rec, op.action!, op.payload, op.clientTs);
      else if (op.entityType === 'waitlist') rec = applyWaitlistAction(rec, op.action!, op.payload, op.clientTs);
      else if (op.entityType === 'table') rec = applyTableStatus(rec, op.payload, op.clientTs);
    }
  }
  return { ...rec, _server: server, _pending: pending.length, _local: false };
}
