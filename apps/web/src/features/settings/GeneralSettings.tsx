import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useApp } from '../../app/context';
import { api, errorMessage, get, put } from '../../lib/api';
import { applyBranding } from '../../lib/theme';
import { Button, Card, Check, Field, Input, Select, Spinner, Textarea, useToast } from '../../ui/kit';

type Settings = Record<string, Record<string, any>>;

export function useSettingsData() {
  return useQuery({ queryKey: ['settings-all'], queryFn: () => get<Settings>('/api/v1/settings') });
}

function useSaver(key: string) {
  const { t } = useTranslation();
  const toast = useToast();
  const { reloadSettings } = useApp();
  return async (value: Record<string, unknown>, secrets?: Record<string, string>) => {
    try {
      await put(`/api/v1/settings/${key}`, { value, secrets: secrets && Object.fromEntries(Object.entries(secrets).filter(([, v]) => v)) });
      toast(t('common.saved'), 'success');
      await reloadSettings();
    } catch (e) {
      toast(errorMessage(e, t), 'error');
    }
  };
}

function Section({ title, onSave, children }: { title: string; onSave: () => void; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Card title={title} actions={<Button variant="primary" onClick={onSave}>{t('common.save')}</Button>}>
      <div className="stack">{children}</div>
    </Card>
  );
}

export function GeneralTab() {
  const { t } = useTranslation();
  const data = useSettingsData();
  const save = useSaver('general');
  const [v, setV] = useState<Record<string, any> | null>(null);
  useEffect(() => { if (data.data?.general) setV(data.data.general); }, [data.data]);
  if (!v) return <Spinner />;
  return (
    <Section title={t('settings.general')} onSave={() => void save(v)}>
      <div className="form-grid">
        <Field label={t('common.language')}><Select value={v.defaultLanguage} onChange={(e) => setV({ ...v, defaultLanguage: e.target.value })} options={[{ value: 'ar', label: 'العربية' }, { value: 'en', label: 'English' }]} /></Field>
        <Field label={t('settings.currency')}><Select value={v.primaryCurrency} onChange={(e) => setV({ ...v, primaryCurrency: e.target.value })} options={[{ value: 'IQD', label: 'IQD' }, { value: 'USD', label: 'USD' }]} /></Field>
        <Field label={t('settings.secondaryCurrency')}><Select value={v.secondaryCurrency ?? ''} onChange={(e) => setV({ ...v, secondaryCurrency: e.target.value || null })} options={[{ value: '', label: '—' }, { value: 'USD', label: 'USD' }, { value: 'IQD', label: 'IQD' }]} /></Field>
        <Field label={t('settings.rate')}><Input type="number" value={v.usdToIqdRate} onChange={(e) => setV({ ...v, usdToIqdRate: Number(e.target.value) })} /></Field>
        <Field label={t('settings.timezone')}><Input value={v.timezone} onChange={(e) => setV({ ...v, timezone: e.target.value })} /></Field>
        <Field label={t('settings.publicUrl')}><Input value={v.publicBaseUrl} placeholder="https://sofia.example.com" onChange={(e) => setV({ ...v, publicBaseUrl: e.target.value })} /></Field>
        <Field label={t('settings.offlineGrace')}><Input type="number" min={1} value={v.offlineGraceHours} onChange={(e) => setV({ ...v, offlineGraceHours: Number(e.target.value) })} /></Field>
        <Field label="Session idle (min)"><Input type="number" min={5} value={v.sessionIdleMinutes} onChange={(e) => setV({ ...v, sessionIdleMinutes: Number(e.target.value) })} /></Field>
      </div>
      <Check label="Require MFA for administrators" checked={v.enforceMfaForAdmins} onChange={(x) => setV({ ...v, enforceMfaForAdmins: x })} />
    </Section>
  );
}

export function BrandingTab() {
  const { t } = useTranslation();
  const toast = useToast();
  const data = useSettingsData();
  const save = useSaver('branding');
  const [v, setV] = useState<Record<string, any> | null>(null);
  useEffect(() => { if (data.data?.branding) setV(data.data.branding); }, [data.data]);
  if (!v) return <Spinner />;
  const upload = async (field: string, file: File) => {
    const fd = new FormData();
    fd.append('purpose', field);
    fd.append('file', file);
    try {
      const r = await api<{ id: string }>('POST', '/api/v1/files', fd);
      setV({ ...v, [field]: r.id });
    } catch (e) {
      toast(errorMessage(e, t), 'error');
    }
  };
  const colors = v.colors as Record<string, string>;
  const setColor = (k: string, c: string) => {
    const next = { ...v, colors: { ...colors, [k]: c } };
    setV(next);
    applyBranding(next as never);
  };
  const fileField = (field: string, label: string) => (
    <Field label={label}>
      <div className="row">
        {v[field] ? <img src={`/api/v1/files/${v[field]}`} alt="" style={{ height: 48, borderRadius: 6, background: 'var(--c-primary-dark)' }} /> : <img src="/brand/sofia-logo-cream.png" alt="" style={{ height: 48, padding: 4, borderRadius: 6, background: 'var(--c-primary-dark)' }} />}
        <input type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && void upload(field, e.target.files[0])} />
        {v[field] && <Button size="sm" variant="ghost" onClick={() => setV({ ...v, [field]: null })}>{t('common.reset')}</Button>}
      </div>
    </Field>
  );
  return (
    <Section title={t('settings.branding')} onSave={() => void save(v)}>
      <div className="form-grid">
        <Field label={t('settings.restaurantName')}><Input value={v.restaurantName} onChange={(e) => setV({ ...v, restaurantName: e.target.value })} /></Field>
        <Field label={`${t('settings.restaurantName')} (AR)`}><Input dir="rtl" value={v.restaurantNameAr} onChange={(e) => setV({ ...v, restaurantNameAr: e.target.value })} /></Field>
        <Field label="Tagline"><Input value={v.tagline} onChange={(e) => setV({ ...v, tagline: e.target.value })} /></Field>
      </div>
      {fileField('logoFileId', t('settings.logo'))}
      {fileField('loginBackgroundFileId', t('settings.loginBg'))}
      {fileField('faviconFileId', t('settings.favicon'))}
      <h3>{t('settings.colors')}</h3>
      <div className="row">
        {Object.entries(colors).map(([k, c]) => (
          <label key={k} className="field" style={{ alignItems: 'center' }}>
            <span>{k}</span>
            <input type="color" value={c} onChange={(e) => setColor(k, e.target.value)} style={{ width: 52, height: 36, border: 0, background: 'none' }} />
          </label>
        ))}
      </div>
      <h3>{t('settings.contact')}</h3>
      <div className="form-grid">
        {Object.keys(v.contact).map((k) => <Field key={k} label={k}><Input value={v.contact[k]} onChange={(e) => setV({ ...v, contact: { ...v.contact, [k]: e.target.value } })} /></Field>)}
      </div>
    </Section>
  );
}

export function GuestsTab() {
  const { t } = useTranslation();
  const data = useSettingsData();
  const save = useSaver('guests');
  const [v, setV] = useState<Record<string, any> | null>(null);
  useEffect(() => { if (data.data?.guests) setV(data.data.guests); }, [data.data]);
  if (!v) return <Spinner />;
  const m = v.duplicateMatching;
  return (
    <Section title={t('settings.guests')} onSave={() => void save(v)}>
      <h3>{t('settings.duplicateRules')}</h3>
      <div className="row">
        <Check label={t('common.phone')} checked={m.phone} onChange={(x) => setV({ ...v, duplicateMatching: { ...m, phone: x } })} />
        <Check label={t('common.email')} checked={m.email} onChange={(x) => setV({ ...v, duplicateMatching: { ...m, email: x } })} />
        <Check label={t('common.name')} checked={m.name} onChange={(x) => setV({ ...v, duplicateMatching: { ...m, name: x } })} />
        <Field label="Name similarity (0.3–1)"><Input type="number" step="0.05" min={0.3} max={1} value={m.nameSimilarity} onChange={(e) => setV({ ...v, duplicateMatching: { ...m, nameSimilarity: Number(e.target.value) } })} /></Field>
      </div>
      <div className="form-grid">
        <Field label={t('settings.highSpender')}><Input type="number" value={v.highSpenderThreshold} onChange={(e) => setV({ ...v, highSpenderThreshold: Number(e.target.value) })} /></Field>
        <Field label="Frequent (visits / 90d)"><Input type="number" value={v.frequentVisitsIn90Days} onChange={(e) => setV({ ...v, frequentVisitsIn90Days: Number(e.target.value) })} /></Field>
        <Field label="Default country"><Input value={v.defaultCountry} maxLength={2} onChange={(e) => setV({ ...v, defaultCountry: e.target.value.toUpperCase() })} /></Field>
        <Field label={t('settings.retentionMonths')}><Input type="number" min={0} value={v.dataRetentionMonths} onChange={(e) => setV({ ...v, dataRetentionMonths: Number(e.target.value) })} /></Field>
      </div>
      <Field label={t('guest.tags')}><Textarea value={(v.tags as string[]).join(', ')} onChange={(e) => setV({ ...v, tags: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /></Field>
    </Section>
  );
}

export function NotificationsTab() {
  const { t } = useTranslation();
  const data = useSettingsData();
  const save = useSaver('notifications');
  const [v, setV] = useState<Record<string, any> | null>(null);
  useEffect(() => { if (data.data?.notifications) setV(data.data.notifications); }, [data.data]);
  if (!v) return <Spinner />;
  return (
    <Section title={t('settings.notifications')} onSave={() => void save(v)}>
      <h3>{t('settings.channels')}</h3>
      <div className="row">
        {Object.keys(v.channelsEnabled).map((c) => <Check key={c} label={c} checked={v.channelsEnabled[c]} onChange={(x) => setV({ ...v, channelsEnabled: { ...v.channelsEnabled, [c]: x } })} />)}
      </div>
      <Field label="Transactional channel"><Select value={v.preferredTransactionalChannel} onChange={(e) => setV({ ...v, preferredTransactionalChannel: e.target.value })} options={['whatsapp', 'sms', 'email', 'push'].map((c) => ({ value: c, label: c }))} /></Field>
      <p className="small muted">{t('settings.pushHint')}</p>
      <div className="row">
        {['sendConfirmation', 'sendReminder', 'sendFeedbackRequest', 'sendBirthday', 'vipArrivalAlert'].map((k) => <Check key={k} label={k.replace(/([A-Z])/g, ' $1').toLowerCase()} checked={v[k]} onChange={(x) => setV({ ...v, [k]: x })} />)}
      </div>
    </Section>
  );
}

export function IntegrationsTab() {
  const { t } = useTranslation();
  const data = useSettingsData();
  const wa = useSaver('integrations.whatsapp');
  const em = useSaver('integrations.email');
  const sms = useSaver('integrations.sms');
  const [w, setW] = useState<Record<string, any> | null>(null);
  const [e, setE] = useState<Record<string, any> | null>(null);
  const [s, setS] = useState<Record<string, any> | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  useEffect(() => {
    if (data.data) {
      setW(data.data['integrations.whatsapp'] ?? null);
      setE(data.data['integrations.email'] ?? null);
      setS(data.data['integrations.sms'] ?? null);
    }
  }, [data.data]);
  if (!w || !e || !s) return <Spinner />;
  const sec = (k: string, label: string, isSet: boolean) => (
    <Field label={label} hint={isSet ? t('settings.secretSet') : undefined}><Input type="password" autoComplete="new-password" value={secrets[k] ?? ''} onChange={(ev) => setSecrets({ ...secrets, [k]: ev.target.value })} /></Field>
  );
  return (
    <div className="stack">
      <Section title={t('settings.whatsapp')} onSave={() => void wa(w, { accessToken: secrets.waToken ?? '', appSecret: secrets.waSecret ?? '', verifyToken: secrets.waVerify ?? '' })}>
        <Check label={t('common.enabled')} checked={w.enabled} onChange={(x) => setW({ ...w, enabled: x })} />
        <div className="form-grid">
          <Field label="Phone number ID"><Input value={w.phoneNumberId} onChange={(ev) => setW({ ...w, phoneNumberId: ev.target.value })} /></Field>
          <Field label="Business account ID"><Input value={w.businessAccountId} onChange={(ev) => setW({ ...w, businessAccountId: ev.target.value })} /></Field>
          <Field label="Graph API version"><Input value={w.apiVersion} onChange={(ev) => setW({ ...w, apiVersion: ev.target.value })} /></Field>
          {sec('waToken', 'Access token', w.secretsSet)}
          {sec('waSecret', 'App secret (webhook signature)', w.secretsSet)}
          {sec('waVerify', 'Webhook verify token', w.secretsSet)}
        </div>
        <p className="small muted">Webhook: <span className="code">{location.origin}/api/v1/webhooks/whatsapp</span></p>
      </Section>
      <Section title={t('settings.smtp')} onSave={() => void em(e, { password: secrets.smtp ?? '' })}>
        <Check label={t('common.enabled')} checked={e.enabled} onChange={(x) => setE({ ...e, enabled: x })} />
        <div className="form-grid">
          <Field label="Host"><Input value={e.host} onChange={(ev) => setE({ ...e, host: ev.target.value })} /></Field>
          <Field label="Port"><Input type="number" value={e.port} onChange={(ev) => setE({ ...e, port: Number(ev.target.value) })} /></Field>
          <Field label="Username"><Input value={e.username} onChange={(ev) => setE({ ...e, username: ev.target.value })} /></Field>
          {sec('smtp', 'Password', e.secretsSet)}
          <Field label="From address"><Input value={e.fromAddress} onChange={(ev) => setE({ ...e, fromAddress: ev.target.value })} /></Field>
          <Field label="From name"><Input value={e.fromName} onChange={(ev) => setE({ ...e, fromName: ev.target.value })} /></Field>
        </div>
        <Check label="TLS (port 465)" checked={e.secure} onChange={(x) => setE({ ...e, secure: x })} />
      </Section>
      <Section title={t('settings.sms')} onSave={() => void sms(s, { authToken: secrets.smsToken ?? '', apiKey: secrets.smsKey ?? '' })}>
        <Check label={t('common.enabled')} checked={s.enabled} onChange={(x) => setS({ ...s, enabled: x })} />
        <div className="form-grid">
          <Field label="Provider"><Select value={s.provider} onChange={(ev) => setS({ ...s, provider: ev.target.value })} options={[{ value: 'generic_http', label: 'HTTP gateway' }, { value: 'twilio', label: 'Twilio' }]} /></Field>
          {s.provider === 'twilio' ? (
            <>
              <Field label="Account SID"><Input value={s.accountSid} onChange={(ev) => setS({ ...s, accountSid: ev.target.value })} /></Field>
              <Field label="From number"><Input value={s.fromNumber} onChange={(ev) => setS({ ...s, fromNumber: ev.target.value })} /></Field>
              {sec('smsToken', 'Auth token', s.secretsSet)}
            </>
          ) : (
            <>
              <Field label="Gateway URL"><Input value={s.url} onChange={(ev) => setS({ ...s, url: ev.target.value })} /></Field>
              <Field label="Method"><Select value={s.method} onChange={(ev) => setS({ ...s, method: ev.target.value })} options={[{ value: 'POST', label: 'POST' }, { value: 'GET', label: 'GET' }]} /></Field>
              <Field label="'to' parameter"><Input value={s.toParam} onChange={(ev) => setS({ ...s, toParam: ev.target.value })} /></Field>
              <Field label="'text' parameter"><Input value={s.textParam} onChange={(ev) => setS({ ...s, textParam: ev.target.value })} /></Field>
              {sec('smsKey', 'API key', s.secretsSet)}
            </>
          )}
        </div>
      </Section>
    </div>
  );
}
