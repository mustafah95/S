import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, NetworkError, post } from '../lib/api';
import { setLanguage, currentLang } from '../i18n';
import { rememberSession, unlockOffline, type Profile } from '../offline/session';
import { useSyncState } from '../offline/state';
import { Button, Field, Input } from '../ui/kit';
import type { ClientSettings } from './context';

interface Props {
  settings: ClientSettings;
  offline: boolean;
  pendingChanges: number;
  onSignedIn: (profile: Profile, offlineSession: boolean) => void;
}

/** Sign-in screen. When the server is unreachable it verifies the password locally (offline unlock). */
export function Login({ settings, offline, pendingChanges, onSignedIn }: Props) {
  const { t } = useTranslation();
  const sync = useSyncState();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [offlineMode, setOfflineMode] = useState(offline);

  async function tryOffline() {
    const r = await unlockOffline(username, password, settings.general.offlineGraceHours);
    if (r.ok) return onSignedIn(r.profile, true);
    setError(r.reason === 'expired' ? t('auth.offlineExpired') : r.reason === 'invalid' ? t('auth.invalid') : t('auth.offlineNoCache'));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (offlineMode) return await tryOffline();
      if (challenge) {
        const r = await post<{ user: Profile }>('/api/v1/auth/mfa/verify', { challenge, code });
        await rememberSession(r.user, username, password);
        return onSignedIn(r.user, false);
      }
      const r = await post<{ mfaRequired: boolean; challenge?: string; user?: Profile }>('/api/v1/auth/login', { username, password, deviceId: localStorage.getItem('sofia.deviceId') ?? undefined });
      if (r.mfaRequired) {
        setChallenge(r.challenge!);
        return;
      }
      await rememberSession(r.user!, username, password);
      onSignedIn(r.user!, false);
    } catch (err) {
      if (err instanceof NetworkError) {
        setOfflineMode(true);
        await tryOffline();
      } else if (err instanceof ApiError) {
        setError(err.code === 'account_locked' ? t('auth.locked') : err.code === 'invalid_credentials' ? t('auth.invalid') : err.message);
      } else setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  const bg = settings.branding.loginBackgroundUrl;
  return (
    <div className="auth" style={bg ? { backgroundImage: `linear-gradient(rgb(30 5 8 / 55%), rgb(30 5 8 / 75%)), url(${bg})` } : undefined}>
      <form className="panel stack" onSubmit={submit}>
        <img className="brand" src={settings.branding.logoUrl ?? '/brand/sofia-logo-burgundy.png'} alt={settings.branding.restaurantName} />
        {offlineMode && (
          <div className="local-note">
            <strong>{t('auth.offlineUnlock')}</strong>
          </div>
        )}
        {offlineMode && <p className="muted small" style={{ margin: 0 }}>{t('auth.offlineHint')}</p>}
        {pendingChanges > 0 && <p className="small" style={{ margin: 0, color: 'var(--s-reserved)' }}>{t('auth.pendingWarn')}</p>}
        {!challenge ? (
          <>
            <Field label={t('auth.username')}>
              <Input autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
            </Field>
            <Field label={t('auth.password')}>
              <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
          </>
        ) : (
          <Field label={t('auth.mfaCode')}>
            <Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
          </Field>
        )}
        {error && <div className="err small" style={{ color: 'var(--s-danger)' }}>{error}</div>}
        <Button type="submit" variant="primary" busy={busy}>
          {offlineMode ? t('auth.unlock') : challenge ? t('auth.verify') : t('auth.signIn')}
        </Button>
        {offlineMode && sync.connection !== 'offline' && (
          <Button variant="ghost" size="sm" onClick={() => setOfflineMode(false)}>
            {t('auth.signIn')} ({t('conn.online')})
          </Button>
        )}
        <div className="lang">
          <Button variant="ghost" size="sm" icon="globe" onClick={() => setLanguage(currentLang() === 'ar' ? 'en' : 'ar')}>
            {currentLang() === 'ar' ? 'English' : 'العربية'}
          </Button>
        </div>
      </form>
    </div>
  );
}
