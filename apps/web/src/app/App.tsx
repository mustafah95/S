import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { NetworkError, get, onAuthLost, post } from '../lib/api';
import { applyBranding } from '../lib/theme';
import { db } from '../offline/db';
import { syncEngine } from '../offline/engine';
import { forgetSession, touchOnline, type Profile } from '../offline/session';
import { Spinner } from '../ui/kit';
import { AppProvider, DEFAULT_SETTINGS, loadSettings, type ClientSettings } from './context';
import { Layout } from './Layout';
import { Login } from './Login';
import { HostDashboard } from '../features/dashboard/HostDashboard';
import { ReservationsPage } from '../features/reservations/ReservationsPage';
import { FloorPlanPage } from '../features/floor/FloorPlanPage';
import { WaitlistPage } from '../features/waitlist/WaitlistPage';
import { GuestsPage } from '../features/guests/GuestsPage';
import { GuestProfilePage } from '../features/guests/GuestProfilePage';
import { SyncPage } from '../features/sync/SyncPage';

const OwnerDashboard = lazy(() => import('../features/dashboard/OwnerDashboard'));
const LoyaltyPage = lazy(() => import('../features/loyalty/LoyaltyPage'));
const MarketingPage = lazy(() => import('../features/marketing/MarketingPage'));
const FeedbackPage = lazy(() => import('../features/feedback/FeedbackPage'));
const PosPage = lazy(() => import('../features/reports/PosPage'));
const ReportsPage = lazy(() => import('../features/reports/ReportsPage'));
const SettingsPage = lazy(() => import('../features/settings/SettingsPage'));
const SetupWizard = lazy(() => import('../features/setup/SetupWizard'));

type Phase =
  | { kind: 'loading' }
  | { kind: 'setup' }
  | { kind: 'login'; offline: boolean }
  | { kind: 'ready'; profile: Profile; offlineSession: boolean };

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [settings, setSettings] = useState<ClientSettings>(DEFAULT_SETTINGS);
  const [pending, setPending] = useState(0);

  const boot = useCallback(async () => {
    const s = await loadSettings();
    setSettings(s);
    applyBranding(s.branding);
    setPending(await db.outbox.where('status').anyOf('pending', 'failed').count());
    try {
      const branding = await get<{ setupCompleted: boolean }>('/api/v1/public/branding', { timeoutMs: 6000 });
      if (!branding.setupCompleted) return setPhase({ kind: 'setup' });
    } catch {
      /* server unreachable — handled below */
    }
    try {
      const me = await get<Profile>('/api/v1/auth/me', { timeoutMs: 6000 });
      await touchOnline(me);
      setPhase({ kind: 'ready', profile: me, offlineSession: false });
    } catch (err) {
      setPhase({ kind: 'login', offline: err instanceof NetworkError });
    }
  }, []);

  useEffect(() => {
    void boot();
    onAuthLost(() => {
      syncEngine.setAuthenticated(false);
      setPhase((p) => (p.kind === 'ready' && !p.offlineSession ? { kind: 'login', offline: false } : p));
    });
  }, [boot]);

  useEffect(() => {
    if (phase.kind === 'ready') syncEngine.start(true);
  }, [phase]);

  const signOut = useCallback(async () => {
    await post('/api/v1/auth/logout').catch(() => undefined);
    syncEngine.setAuthenticated(false);
    await forgetSession();
    setPending(await db.outbox.where('status').anyOf('pending', 'failed').count());
    setPhase({ kind: 'login', offline: false });
  }, []);

  if (phase.kind === 'loading') return <Spinner />;
  if (phase.kind === 'setup')
    return (
      <Suspense fallback={<Spinner />}>
        <SetupWizard onDone={() => void boot()} />
      </Suspense>
    );
  if (phase.kind === 'login')
    return (
      <Login
        settings={settings}
        offline={phase.offline}
        pendingChanges={pending}
        onSignedIn={async (profile, offlineSession) => {
          if (!offlineSession) setSettings(await loadSettings());
          setPhase({ kind: 'ready', profile, offlineSession });
        }}
      />
    );

  return (
    <AppProvider profile={phase.profile} offlineSession={phase.offlineSession} initialSettings={settings} onSignOut={signOut}>
      <Layout>
        <Suspense fallback={<Spinner />}>
          <Routes>
            <Route path="/" element={<HostDashboard />} />
            <Route path="/owner" element={<OwnerDashboard />} />
            <Route path="/reservations" element={<ReservationsPage />} />
            <Route path="/floor" element={<FloorPlanPage />} />
            <Route path="/waitlist" element={<WaitlistPage />} />
            <Route path="/guests" element={<GuestsPage />} />
            <Route path="/guests/:id" element={<GuestProfilePage />} />
            <Route path="/loyalty" element={<LoyaltyPage />} />
            <Route path="/marketing" element={<MarketingPage />} />
            <Route path="/feedback" element={<FeedbackPage />} />
            <Route path="/pos" element={<PosPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/sync" element={<SyncPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/settings/:tab" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </Layout>
    </AppProvider>
  );
}
