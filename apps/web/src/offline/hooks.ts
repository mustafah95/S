import { useLiveQuery } from 'dexie-react-hooks';
import { normalizePhone } from '@sofia/shared';
import { db, kvGet, type Rec } from './db';

export function useBranches(): Rec[] {
  return useLiveQuery(() => db.branches.filter((b) => !b.deletedAt).sortBy('name'), [], []) ?? [];
}

export function useBranch(id: string | null | undefined): Rec | undefined {
  return useLiveQuery(() => (id ? db.branches.get(id) : undefined), [id]);
}

export function useAreas(branchId: string | null | undefined): Rec[] {
  return (
    useLiveQuery(
      async () => (branchId ? (await db.areas.where('branchId').equals(branchId).toArray()).filter((a) => !a.deletedAt).sort((a, b) => a.sortOrder - b.sortOrder) : []),
      [branchId],
      [],
    ) ?? []
  );
}

export function useTables(branchId: string | null | undefined): Rec[] {
  return (
    useLiveQuery(
      async () =>
        branchId
          ? (await db.diningTables.where('branchId').equals(branchId).toArray())
              .filter((t) => !t.deletedAt)
              .sort((a, b) => String(a.label).localeCompare(String(b.label), undefined, { numeric: true }))
          : [],
      [branchId],
      [],
    ) ?? []
  );
}

export function useCombos(branchId: string | null | undefined): Rec[] {
  return useLiveQuery(async () => (branchId ? (await db.combos.where('branchId').equals(branchId).toArray()).filter((c) => !c.deletedAt) : []), [branchId], []) ?? [];
}

export function useReservations(branchId: string | null | undefined, date: string): Rec[] {
  return (
    useLiveQuery(
      async () => (branchId ? (await db.reservations.where('[branchId+businessDate]').equals([branchId, date]).toArray()).filter((r) => !r.deletedAt).sort((a, b) => String(a.startAt).localeCompare(String(b.startAt))) : []),
      [branchId, date],
      [],
    ) ?? []
  );
}

export function useReservationsAround(branchId: string | null | undefined, dates: string[]): Rec[] {
  return (
    useLiveQuery(
      async () => (branchId ? (await db.reservations.where('[branchId+businessDate]').anyOf(dates.map((d) => [branchId, d])).toArray()).filter((r) => !r.deletedAt) : []),
      [branchId, dates.join()],
      [],
    ) ?? []
  );
}

export function useReservation(id: string | null | undefined): Rec | undefined {
  return useLiveQuery(() => (id ? db.reservations.get(id) : undefined), [id]);
}

export function useGuest(id: string | null | undefined): Rec | undefined {
  return useLiveQuery(() => (id ? db.guests.get(id) : undefined), [id]);
}

export function useGuestNotes(guestId: string | null | undefined): Rec[] {
  return useLiveQuery(async () => (guestId ? (await db.guestNotes.where('guestId').equals(guestId).toArray()).filter((n) => !n.deletedAt).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) : []), [guestId], []) ?? [];
}

/** Local guest search by name, phone digits, e-mail or loyalty number — works offline. */
export async function searchGuests(term: string, limit = 20): Promise<Rec[]> {
  const t = term.trim().toLowerCase();
  if (!t) return (await db.guests.orderBy('lastVisitAt').reverse().filter((g) => !g.deletedAt && !g.mergedIntoId).limit(limit).toArray());
  const digits = t.replace(/\D/g, '');
  const phone = digits.length >= 6 ? normalizePhone(term) : null;
  return db.guests
    .filter((g) => {
      if (g.deletedAt || g.mergedIntoId) return false;
      const name = `${g.firstName ?? ''} ${g.lastName ?? ''} ${g.preferredName ?? ''}`.toLowerCase();
      return (
        name.includes(t) ||
        (digits.length >= 4 && String(g.phoneNormalized ?? g.phone ?? '').replace(/\D/g, '').includes(digits.slice(-9))) ||
        (phone !== null && g.phoneNormalized === phone) ||
        String(g.email ?? '').toLowerCase() === t ||
        String(g.loyaltyNumber ?? '').toLowerCase() === t
      );
    })
    .limit(limit)
    .toArray();
}

export function useGuestSearch(term: string, limit = 30): Rec[] | undefined {
  return useLiveQuery(() => searchGuests(term, limit), [term, limit]);
}

export function useWaitlist(branchId: string | null | undefined): Rec[] {
  return (
    useLiveQuery(
      async () => (branchId ? (await db.waitlist.where('branchId').equals(branchId).toArray()).filter((w) => ['waiting', 'notified'].includes(w.status) && !w.deletedAt).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))) : []),
      [branchId],
      [],
    ) ?? []
  );
}

export function useOutbox(statuses: string[] = ['pending', 'syncing', 'failed', 'conflict']) {
  return useLiveQuery(() => db.outbox.where('status').anyOf(statuses).reverse().sortBy('seq'), [statuses.join()], []) ?? [];
}

export function useKv<T>(key: string): T | undefined {
  return useLiveQuery(() => kvGet<T>(key), [key]);
}
