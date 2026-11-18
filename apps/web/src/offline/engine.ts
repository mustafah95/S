import {
  DEFAULT_RESERVATION_SETTINGS,
  SYNC_PROTOCOL_VERSION,
  durationForParty,
  type ReservationSettings,
  type SyncOpResult,
  type SyncPullResponse,
} from '@sofia/shared';
import { ApiError, NetworkError, api, deviceId } from '../lib/api';
import { PULL_TABLE, db, kvGet, kvSet, tableFor, type OutboxOp, type Rec } from './db';
import { rebase, type RebaseContext } from './ops';
import { getSyncState, setSyncState } from './state';

/**
 * Sofia Sync Engine (client side).
 *
 *  - Connectivity: distinguishes "device offline" (navigator.onLine), "server unavailable" (probe fails) and
 *    "internet unavailable" (server reachable on the LAN but reports no internet).
 *  - Push: pending outbox operations are sent in local order (≤100 per request). Results update the local copy
 *    with the server's authoritative record. Network errors keep operations queued — nothing is ever dropped.
 *  - Pull: gap-free change feed from a cursor; records with pending local edits are rebased, not overwritten.
 *  - Real time: SSE hints trigger immediate pulls; a periodic probe/pull covers missed events.
 */

const PUSH_BATCH = 100;
const PROBE_ONLINE_MS = 15_000;
const PROBE_DOWN_MS = 5_000;

type Listener = (event: string, data: unknown) => void;

class SyncEngine {
  private started = false;
  private authenticated = false;
  private flushing: Promise<void> | null = null;
  private pulling: Promise<void> | null = null;
  private probeTimer: number | undefined;
  private es: EventSource | null = null;
  private listeners = new Set<Listener>();
  private pullSoon: number | undefined;
  private backoffMs = 2_000;

  /** Called by the app once a session exists (online login or offline unlock). */
  start(authenticated: boolean): void {
    this.authenticated = authenticated;
    if (!this.started) {
      this.started = true;
      window.addEventListener('online', () => void this.probe());
      window.addEventListener('offline', () => setSyncState({ connection: 'offline' }));
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void this.probe();
      });
    }
    void this.refreshCounts();
    void this.probe();
  }

  setAuthenticated(v: boolean): void {
    this.authenticated = v;
    if (!v) this.closeStream();
    else void this.probe();
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(event: string, data: unknown) {
    for (const l of this.listeners) l(event, data);
  }

  private schedule(ms: number) {
    window.clearTimeout(this.probeTimer);
    this.probeTimer = window.setTimeout(() => void this.probe(), ms);
  }

  /** Connectivity probe. On reconnection: push first (local changes win the race), then pull. */
  async probe(): Promise<void> {
    if (!navigator.onLine) {
      setSyncState({ connection: 'offline' });
      this.closeStream();
      return this.schedule(PROBE_DOWN_MS);
    }
    const was = getSyncState().connection;
    try {
      const ping = await api<{ ok: boolean; internet: { online: boolean | null }; maintenance: boolean; version: string; authenticated: boolean }>(
        'GET',
        '/api/v1/sync/ping',
        undefined,
        { timeoutMs: 4000, noRefresh: true },
      );
      setSyncState({
        connection: getSyncState().connection === 'syncing' ? 'syncing' : 'online',
        internet: ping.internet?.online ?? null,
        maintenance: ping.maintenance,
        serverVersion: ping.version,
      });
      if (this.authenticated) {
        if (was !== 'online' && was !== 'syncing') this.emit('reconnected', null);
        await this.syncNow();
        this.openStream();
      }
      this.schedule(PROBE_ONLINE_MS);
    } catch {
      setSyncState({ connection: navigator.onLine ? 'server_unavailable' : 'offline' });
      this.closeStream();
      this.schedule(PROBE_DOWN_MS);
    }
  }

  /** Push then pull. Safe to call often (single-flight). */
  async syncNow(): Promise<void> {
    if (!this.authenticated) return;
    await this.flush();
    await this.pull();
  }

  /** Called after every local write: try to push immediately when the server is reachable. */
  kick(): void {
    void this.refreshCounts();
    const c = getSyncState().connection;
    if (this.authenticated && (c === 'online' || c === 'syncing')) void this.flush().then(() => this.refreshCounts());
  }

  async refreshCounts(): Promise<void> {
    const [pending, failed, conflicts, synced] = await Promise.all([
      db.outbox.where('status').anyOf('pending', 'syncing').count(),
      db.outbox.where('status').equals('failed').count(),
      db.outbox.where('status').anyOf('conflict', 'requires_review').count(),
      kvGet<number>('syncedCount'),
    ]);
    setSyncState({ pending, failed, conflicts, synced: synced ?? 0, lastSync: (await kvGet<string>('lastSync')) ?? null });
  }

  private async rebaseContext(): Promise<RebaseContext> {
    const branches = await db.branches.toArray();
    const map = new Map(branches.map((b) => [b.id, b]));
    return {
      tzFor: (id) => map.get(id)?.timezone ?? 'Asia/Baghdad',
      durationFor: (id, party) => durationForParty({ ...DEFAULT_RESERVATION_SETTINGS, ...((map.get(id)?.reservationSettings ?? {}) as Partial<ReservationSettings>) }, party),
    };
  }

  flush(): Promise<void> {
    this.flushing ??= this.doFlush().finally(() => (this.flushing = null));
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    for (let round = 0; round < 50; round++) {
      const batch = await db.outbox.where('[status+seq]').between(['pending', 0], ['pending', Infinity]).limit(PUSH_BATCH).toArray();
      if (!batch.length) break;
      setSyncState({ connection: 'syncing' });
      await db.outbox.bulkUpdate(batch.map((op) => ({ key: op.seq!, changes: { status: 'syncing' as const, attempts: op.attempts + 1 } })));
      let results: SyncOpResult[];
      try {
        const res = await api<{ results: SyncOpResult[] }>('POST', '/api/v1/sync/push', {
          deviceId: deviceId(),
          protocol: SYNC_PROTOCOL_VERSION,
          ops: batch.map(({ seq: _s, status: _st, attempts: _a, lastError: _l, syncedAt: _sa, conflictId: _c, label: _lb, ...op }) => op),
        });
        results = res.results;
        this.backoffMs = 2_000;
      } catch (err) {
        await db.outbox.bulkUpdate(batch.map((op) => ({ key: op.seq!, changes: { status: 'pending' as const, lastError: (err as Error).message } })));
        if (err instanceof NetworkError) setSyncState({ connection: navigator.onLine ? 'server_unavailable' : 'offline' });
        else if (err instanceof ApiError && err.code === 'maintenance') setSyncState({ connection: 'online', maintenance: true });
        else setSyncState({ connection: 'online', lastError: (err as Error).message });
        this.backoffMs = Math.min(this.backoffMs * 2, 300_000);
        this.schedule(this.backoffMs);
        return;
      }
      await this.applyResults(batch, results);
      setSyncState({ connection: 'online', lastError: null });
      if (results.some((r) => r.status === 'retry')) {
        this.schedule(this.backoffMs);
        break;
      }
    }
    await this.refreshCounts();
  }

  private async applyResults(batch: OutboxOp[], results: SyncOpResult[]): Promise<void> {
    const ctx = await this.rebaseContext();
    const byOp = new Map(results.map((r) => [r.opId, r]));
    let synced = (await kvGet<number>('syncedCount')) ?? 0;
    await db.transaction('rw', [db.outbox, db.guests, db.guestNotes, db.reservations, db.waitlist, db.diningTables, db.kv], async () => {
      for (const op of batch) {
        const r = byOp.get(op.opId);
        if (!r || r.status === 'retry') {
          await db.outbox.update(op.seq!, { status: 'pending', lastError: r?.error?.message ?? null });
          continue;
        }
        if (r.status === 'rejected') {
          await db.outbox.update(op.seq!, { status: 'failed', lastError: r.error?.message ?? 'Rejected by server' });
          const t = tableFor(op.entityType);
          const local = await t.get(op.entityId);
          if (local) await t.put({ ...local, _error: r.error?.message ?? 'Rejected', _pending: Math.max(0, (local._pending ?? 1) - 1) });
          continue;
        }
        const status = r.status === 'conflict' || r.status === 'requires_review' ? 'conflict' : 'synced';
        await db.outbox.update(op.seq!, { status, syncedAt: new Date().toISOString(), conflictId: r.conflictId ?? null, lastError: r.message ?? null });
        synced++;
        if (r.entity) await this.putServerRecord(tableFor(op.entityType).name, r.entity as Rec, ctx);
      }
      await kvSet('syncedCount', synced);
      await kvSet('lastSync', new Date().toISOString());
    });
    await this.pruneOutbox();
  }

  /** Write a server record locally, re-applying any operations still waiting to be pushed. */
  private async putServerRecord(tableName: string, row: Rec, ctx: RebaseContext): Promise<void> {
    const table = db.table<Rec, string>(tableName);
    if (row.deletedAt) {
      await table.delete(row.id);
      return;
    }
    const pending = await db.outbox.where('entityId').equals(row.id).filter((o) => o.status === 'pending' || o.status === 'syncing').sortBy('seq');
    await table.put(rebase(row, pending, ctx));
  }

  pull(): Promise<void> {
    this.pulling ??= this.doPull().finally(() => (this.pulling = null));
    return this.pulling;
  }

  private async doPull(): Promise<void> {
    let cursor = (await kvGet<string>('cursor')) ?? '0';
    const knownEpoch = await kvGet<string>('epoch');
    for (let page = 0; page < 500; page++) {
      let res: SyncPullResponse;
      try {
        res = await api<SyncPullResponse>('GET', `/api/v1/sync/pull?cursor=${encodeURIComponent(cursor)}&deviceId=${deviceId()}`);
      } catch (err) {
        if (err instanceof NetworkError) setSyncState({ connection: navigator.onLine ? 'server_unavailable' : 'offline' });
        return;
      }
      if (knownEpoch !== undefined && res.epoch !== knownEpoch) {
        // The server database was restored from a backup: rebuild the local copy, keep unsent operations.
        await this.resetLocalData();
        await kvSet('epoch', res.epoch);
        cursor = '0';
        return this.doPull();
      }
      if (knownEpoch === undefined) await kvSet('epoch', res.epoch);
      const ctx = await this.rebaseContext();
      await db.transaction('rw', [db.outbox, db.guests, db.guestNotes, db.reservations, db.waitlist, db.diningTables, db.areas, db.branches, db.combos, db.kv], async () => {
        for (const [entity, rows] of Object.entries(res.changes)) {
          const tableName = PULL_TABLE[entity];
          if (!tableName || !rows) continue;
          for (const row of rows) await this.putServerRecord(tableName as string, row as Rec, ctx);
        }
        await kvSet('cursor', res.cursor);
        await kvSet('lastSync', res.serverTime);
      });
      cursor = res.cursor;
      const count = Object.values(res.changes).reduce((s, r) => s + (r?.length ?? 0), 0);
      if (count) this.emit('pulled', res.changes);
      if (!res.hasMore) break;
    }
    await this.pruneReservations();
    await this.refreshCounts();
  }

  /** Remove local data that was synced (keeps the outbox and records still created only on this device). */
  async resetLocalData(): Promise<void> {
    await db.transaction('rw', [db.guests, db.guestNotes, db.reservations, db.waitlist, db.diningTables, db.areas, db.branches, db.combos, db.kv], async () => {
      for (const t of [db.guests, db.guestNotes, db.reservations, db.waitlist, db.diningTables, db.areas, db.branches, db.combos]) {
        await t.filter((r) => !r._local && !r._pending).delete();
      }
      await db.kv.delete('cursor');
    });
  }

  private async pruneOutbox(): Promise<void> {
    const done = await db.outbox.where('status').equals('synced').primaryKeys();
    if (done.length > 1000) await db.outbox.bulkDelete(done.slice(0, done.length - 1000));
  }

  private async pruneReservations(): Promise<void> {
    const cutoff = new Date(Date.now() - 35 * 86400_000).toISOString().slice(0, 10);
    await db.reservations.where('businessDate').below(cutoff).filter((r) => !r._pending && !r._local).delete();
  }

  private openStream(): void {
    if (this.es || typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/v1/events');
    this.es = es;
    const schedulePull = () => {
      window.clearTimeout(this.pullSoon);
      this.pullSoon = window.setTimeout(() => void this.pull(), 300);
    };
    es.addEventListener('changes', schedulePull);
    es.addEventListener('notification', (e) => this.emit('notification', JSON.parse((e as MessageEvent).data)));
    es.addEventListener('table_freed', (e) => this.emit('table_freed', JSON.parse((e as MessageEvent).data)));
    es.addEventListener('maintenance', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { enabled: boolean };
      setSyncState({ maintenance: d.enabled });
      if (!d.enabled) void this.syncNow();
    });
    es.onerror = () => {
      this.closeStream();
      void this.probe();
    };
  }

  private closeStream(): void {
    this.es?.close();
    this.es = null;
  }

  /** Retry failed operations (after the user fixed the cause) or discard them. */
  async retryFailed(seq?: number): Promise<void> {
    const ops = seq ? [await db.outbox.get(seq)] : await db.outbox.where('status').equals('failed').toArray();
    for (const op of ops) if (op) await db.outbox.update(op.seq!, { status: 'pending', lastError: null });
    this.kick();
  }

  async discard(seq: number): Promise<void> {
    const op = await db.outbox.get(seq);
    if (!op) return;
    await db.outbox.delete(seq);
    const t = tableFor(op.entityType);
    const rec = await t.get(op.entityId);
    if (op.entityType === 'waitlist' && op.action === 'seat' && typeof op.payload.reservationId === 'string') {
      const local = await db.reservations.get(op.payload.reservationId);
      if (local?._local) await db.reservations.delete(local.id);
    }
    if (rec?._local && op.op === 'create') await t.delete(op.entityId);
    else if (rec) {
      const pending = await db.outbox.where('entityId').equals(op.entityId).filter((o) => o.status === 'pending').sortBy('seq');
      if (rec._server) await t.put(rebase(rec._server as Rec, pending, await this.rebaseContext()));
    }
    await this.refreshCounts();
  }
}

export const syncEngine = new SyncEngine();
