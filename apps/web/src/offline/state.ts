import { useSyncExternalStore } from 'react';
import type { ConnectionState } from '@sofia/shared';

export interface SyncState {
  connection: ConnectionState;
  /** Internet as seen by the server (null = unknown). */
  internet: boolean | null;
  maintenance: boolean;
  pending: number;
  failed: number;
  conflicts: number;
  synced: number;
  lastSync: string | null;
  lastError: string | null;
  serverVersion: string | null;
}

let state: SyncState = {
  connection: typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'server_unavailable',
  internet: null,
  maintenance: false,
  pending: 0,
  failed: 0,
  conflicts: 0,
  synced: 0,
  lastSync: null,
  lastError: null,
  serverVersion: null,
};
const listeners = new Set<() => void>();

export function getSyncState(): SyncState {
  return state;
}

export function setSyncState(patch: Partial<SyncState>): void {
  const next = { ...state, ...patch };
  if (Object.keys(patch).every((k) => (state as never)[k] === (next as never)[k])) return;
  state = next;
  for (const l of listeners) l();
}

export function subscribeSync(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useSyncState(): SyncState {
  return useSyncExternalStore(subscribeSync, getSyncState, getSyncState);
}
