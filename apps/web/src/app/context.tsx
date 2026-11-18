import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_BRANDING, DEFAULT_GENERAL_SETTINGS, DEFAULT_GUEST_SETTINGS, type Branding, type GeneralSettings, type GuestSettings, type Permission } from '@sofia/shared';
import { get } from '../lib/api';
import { applyBranding } from '../lib/theme';
import { kvGet, kvSet } from '../offline/db';
import { setRepoUser } from '../offline/repo';
import type { Profile } from '../offline/session';

export interface ClientSettings {
  branding: Branding & { logoUrl?: string | null; loginBackgroundUrl?: string | null };
  general: GeneralSettings;
  guests: GuestSettings;
}

interface AppCtx {
  profile: Profile;
  offlineSession: boolean;
  branchId: string;
  setBranchId: (id: string) => void;
  settings: ClientSettings;
  reloadSettings: () => Promise<void>;
  can: (p: Permission) => boolean;
  signOut: () => void;
}

const Ctx = createContext<AppCtx | null>(null);

export const DEFAULT_SETTINGS: ClientSettings = { branding: DEFAULT_BRANDING, general: DEFAULT_GENERAL_SETTINGS, guests: DEFAULT_GUEST_SETTINGS };

/** Settings cached in IndexedDB so branding and rules are available offline. */
export async function loadSettings(): Promise<ClientSettings> {
  try {
    const s = await get<Record<string, unknown>>('/api/v1/settings');
    const branding = await get<ClientSettings['branding']>('/api/v1/public/branding');
    const merged: ClientSettings = {
      branding: { ...DEFAULT_BRANDING, ...(branding ?? {}) },
      general: { ...DEFAULT_GENERAL_SETTINGS, ...((s.general as object) ?? {}) },
      guests: { ...DEFAULT_GUEST_SETTINGS, ...((s.guests as object) ?? {}) },
    };
    await kvSet('settings', merged);
    return merged;
  } catch {
    return (await kvGet<ClientSettings>('settings')) ?? DEFAULT_SETTINGS;
  }
}

export function AppProvider({ profile, offlineSession, initialSettings, onSignOut, children }: { profile: Profile; offlineSession: boolean; initialSettings: ClientSettings; onSignOut: () => void; children: ReactNode }) {
  const [settings, setSettings] = useState(initialSettings);
  const [branchId, setBranch] = useState<string>(() => {
    try {
      const saved = localStorage.getItem('sofia.branch');
      if (saved && profile.branches.some((b) => b.id === saved)) return saved;
    } catch {
      /* ignore */
    }
    return profile.branches[0]?.id ?? '';
  });
  useEffect(() => setRepoUser(profile.id), [profile.id]);
  useEffect(() => applyBranding(settings.branding), [settings.branding]);
  const setBranchId = useCallback((id: string) => {
    setBranch(id);
    try {
      localStorage.setItem('sofia.branch', id);
    } catch {
      /* ignore */
    }
  }, []);
  const reloadSettings = useCallback(async () => setSettings(await loadSettings()), []);
  const perms = useMemo(() => new Set(profile.permissions), [profile.permissions]);
  const value = useMemo<AppCtx>(
    () => ({ profile, offlineSession, branchId, setBranchId, settings, reloadSettings, can: (p) => perms.has(p), signOut: onSignOut }),
    [profile, offlineSession, branchId, setBranchId, settings, reloadSettings, perms, onSignOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp outside AppProvider');
  return c;
}
