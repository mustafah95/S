import { config } from '../../config.js';

/**
 * Internet reachability as seen by the server (distinct from "server reachable" as seen by devices, §73):
 * when the restaurant's internet is down the local network keeps working and devices show
 * "ONLINE · Internet unavailable".
 */
let state: { online: boolean | null; checkedAt: string | null } = { online: null, checkedAt: null };
let timer: NodeJS.Timeout | undefined;

export function internetStatus() {
  return state;
}

export async function checkInternet(): Promise<boolean> {
  try {
    const res = await fetch(config.internetCheckUrl, { method: 'GET', signal: AbortSignal.timeout(5000) });
    state = { online: res.status < 500, checkedAt: new Date().toISOString() };
  } catch {
    state = { online: false, checkedAt: new Date().toISOString() };
  }
  return state.online === true;
}

export function startInternetMonitor(intervalMs = 60_000): void {
  if (timer || config.isTest) return;
  void checkInternet();
  timer = setInterval(() => void checkInternet(), intervalMs);
  timer.unref();
}

export function stopInternetMonitor(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
