import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage, get, post } from '../lib/api';
import { currentLang } from '../i18n';
import { Button, Check } from '../ui/kit';
import { Icon } from '../ui/icons';

/**
 * "Notify me" on the reservation confirmation page: subscribes this browser to Web Push for the reservation
 * (reminders, changes, table ready, feedback) and, only if the guest ticks it, to offers.
 * Uses a dedicated service worker with scope /r/ so the staff app's service worker is never touched.
 */

const SCOPE = '/r/';
const inFrame = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
})();
const supported = typeof window !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);

function keyBytes(base64url: string): Uint8Array {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function activeRegistration(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register('/guest-sw.js', { scope: SCOPE });
  if (reg.active) return reg;
  const worker = reg.installing ?? reg.waiting;
  await new Promise<void>((resolve) => {
    if (!worker) return resolve();
    worker.addEventListener('statechange', () => worker.state === 'activated' && resolve());
  });
  return reg;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration(SCOPE);
  return (await reg?.pushManager.getSubscription()) ?? null;
}

type State = 'loading' | 'off' | 'on' | 'denied' | 'busy';

export function PushOptIn({ code, token, manageUrl }: { code: string; token: string; manageUrl: string }) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<{ enabled: boolean; publicKey: string | null } | null>(null);
  const [state, setState] = useState<State>('loading');
  const [offers, setOffers] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void get<{ enabled: boolean; publicKey: string | null }>('/api/v1/public/push/config').then(setConfig).catch(() => setConfig({ enabled: false, publicKey: null }));
    if (!supported) return setState('off');
    if (Notification.permission === 'denied') return setState('denied');
    void currentSubscription()
      .then((s) => setState(s ? 'on' : 'off'))
      .catch(() => setState('off'));
  }, []);

  if (!config?.enabled) return null;

  const box = (children: React.ReactNode) => (
    <div className="panel" style={{ textAlign: 'start', padding: 14, borderRadius: 14, background: 'var(--c-surface-2, rgba(201,162,107,0.08))' }}>
      <div className="row tight" style={{ marginBottom: 6 }}>
        <Icon name="bell" />
        <strong>{t('booking.pushTitle')}</strong>
      </div>
      {children}
    </div>
  );

  if (inFrame) {
    // Browsers do not let embedded pages ask for notification permission: continue on the full page.
    return box(
      <a className="btn" href={manageUrl} target="_blank" rel="noopener">
        {t('booking.pushEnable')}
      </a>,
    );
  }
  if (!supported) return box(<p className="small muted">{isIos ? t('booking.pushIos') : t('booking.pushUnsupported')}</p>);
  if (state === 'denied') return box(<p className="small muted">{t('booking.pushDenied')}</p>);

  async function enable() {
    setError('');
    setState('busy');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return setState(permission === 'denied' ? 'denied' : 'off');
      const reg = await activeRegistration();
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(config!.publicKey!) as BufferSource }));
      await post('/api/v1/public/push/subscribe', { code, t: token, subscription: sub.toJSON(), offers, language: currentLang() });
      setState('on');
    } catch (err) {
      setError(errorMessage(err));
      setState('off');
    }
  }

  async function disable() {
    setState('busy');
    try {
      const sub = await currentSubscription();
      if (sub) {
        await post('/api/v1/public/push/unsubscribe', { endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setState('off');
    } catch (err) {
      setError(errorMessage(err));
      setState('on');
    }
  }

  return box(
    state === 'on' ? (
      <div className="row between">
        <span className="small">{t('booking.pushOn')}</span>
        <Button size="sm" variant="ghost" onClick={disable}>{t('booking.pushOff')}</Button>
      </div>
    ) : (
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>{t('booking.pushText')}</p>
        <Check checked={offers} onChange={setOffers} label={t('booking.pushOffers')} />
        <div>
          <Button variant="primary" busy={state === 'busy' || state === 'loading'} onClick={enable}>{t('booking.pushEnable')}</Button>
        </div>
        {error && <p className="small" style={{ color: 'var(--s-danger)' }}>{error}</p>}
      </div>
    ),
  );
}
