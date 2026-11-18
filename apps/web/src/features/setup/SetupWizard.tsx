import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_WEEKLY_HOURS, type SetupInput, type WeeklyHours } from '@sofia/shared';
import { errorMessage, post } from '../../lib/api';
import { currentLang, setLanguage } from '../../i18n';
import { Button, Check, Field, Input, Select, useToast } from '../../ui/kit';
import { HoursEditor } from '../settings/BranchSettings';

interface Props {
  onDone: () => void;
}

/** First-run wizard (§85): restaurant → … → public booking URL, protected by the installer's setup token. */
export default function SetupWizard({ onDone }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [restaurant, setRestaurant] = useState({ name: "Sofia's Resto-Lounge", nameAr: 'صوفيا ريستو-لاونج', phone: '', email: '', logoDataUrl: null as string | null });
  const [branch, setBranch] = useState({ code: 'MAIN', name: 'Main Branch', nameAr: 'الفرع الرئيسي', address: '', phone: '', timezone: 'Asia/Baghdad' });
  const [loc, setLoc] = useState({ currency: 'IQD', secondaryCurrency: 'USD', language: currentLang() });
  const [hours, setHours] = useState<WeeklyHours>(DEFAULT_WEEKLY_HOURS.map(() => [{ open: '12:00', close: '01:00' }]));
  const [areas, setAreas] = useState([
    { key: 'hall', name: 'Main Hall', nameAr: 'الصالة الرئيسية', kind: 'indoor' },
    { key: 'lounge', name: 'Lounge', nameAr: 'اللاونج', kind: 'lounge' },
    { key: 'terrace', name: 'Terrace', nameAr: 'التراس', kind: 'terrace' },
    { key: 'vip', name: 'VIP Room', nameAr: 'غرفة كبار الشخصيات', kind: 'vip' },
  ]);
  const [tableGen, setTableGen] = useState<Record<string, { count: number; capacity: number; prefix: string }>>({ hall: { count: 10, capacity: 4, prefix: 'T' }, lounge: { count: 6, capacity: 4, prefix: 'L' }, terrace: { count: 6, capacity: 4, prefix: 'P' }, vip: { count: 2, capacity: 8, prefix: 'V' } });
  const [admin, setAdmin] = useState({ username: 'admin', displayName: '', email: '', password: '', confirm: '' });
  const [res, setRes] = useState({ slotIntervalMinutes: 30, defaultDurationMinutes: 120, bufferMinutes: 15, maxAdvanceDays: 60, onlineBookingEnabled: true, depositEnabled: false });
  const [pos, setPos] = useState({ provider: 'none', baseUrl: '' });
  const [backup, setBackup] = useState({ enabled: true, timeOfDay: '04:00', retentionDays: 30, externalDirectory: '' });
  const [publicBaseUrl, setPublicBaseUrl] = useState(location.origin);

  const steps = [t('setup.restaurant'), t('setup.branch'), t('setup.localization'), t('setup.hours'), t('setup.areas'), t('setup.tables'), t('setup.admin'), t('setup.reservations'), t('setup.pos'), t('setup.backup'), t('setup.finish')];

  async function finish() {
    if (admin.password !== admin.confirm) return toast(t('setup.mismatch'), 'error');
    setBusy(true);
    const tables = areas.flatMap((a) => {
      const g = tableGen[a.key] ?? { count: 0, capacity: 4, prefix: 'T' };
      return Array.from({ length: g.count }, (_, i) => ({ areaKey: a.key, label: `${g.prefix}${i + 1}`, capacity: g.capacity, minCapacity: 1, maxCapacity: g.capacity, shape: (g.capacity > 6 ? 'sofa' : g.capacity > 4 ? 'rectangle' : 'square') as 'square', isVip: a.kind === 'vip' }));
    });
    const body: SetupInput = {
      setupToken: token,
      restaurant,
      branch,
      currency: loc.currency as 'IQD',
      secondaryCurrency: (loc.secondaryCurrency || null) as 'USD' | null,
      language: loc.language,
      operatingHours: hours,
      areas: areas as SetupInput['areas'],
      tables,
      admin: { username: admin.username, displayName: admin.displayName || admin.username, email: admin.email || null, password: admin.password },
      reservation: res,
      pos: pos as SetupInput['pos'],
      backup,
      publicBaseUrl,
    };
    try {
      const r = await post<{ publicBookingUrl: string }>('/api/v1/setup/complete', body);
      setDone(r.publicBookingUrl);
    } catch (e) {
      toast(errorMessage(e, t), 'error');
    } finally {
      setBusy(false);
    }
  }

  const readLogo = (file: File) => {
    const fr = new FileReader();
    fr.onload = () => setRestaurant({ ...restaurant, logoDataUrl: String(fr.result) });
    fr.readAsDataURL(file);
  };

  if (done) {
    return (
      <div className="auth">
        <div className="panel stack" style={{ width: 'min(560px, 100%)', textAlign: 'center' }}>
          <img className="brand" src="/brand/sofia-logo-burgundy.png" alt="" />
          <h2>{t('setup.done')}</h2>
          <p>{t('settings.bookingLink')}: <a href={done} className="code">{done}</a></p>
          <Button variant="primary" onClick={onDone}>{t('common.next')}</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth" style={{ alignItems: 'start', paddingTop: 40 }}>
      <div className="panel stack" style={{ width: 'min(820px, 100%)' }}>
        <div className="row between">
          <img src="/brand/sofia-logo-burgundy.png" alt="" style={{ height: 64 }} />
          <Button variant="ghost" size="sm" onClick={() => setLanguage(currentLang() === 'ar' ? 'en' : 'ar')}>{currentLang() === 'ar' ? 'English' : 'العربية'}</Button>
        </div>
        <div>
          <h1>{t('setup.welcome')}</h1>
          <p className="muted">{t('setup.intro')}</p>
        </div>
        <div className="progress"><i style={{ width: `${((step + 1) / steps.length) * 100}%` }} /></div>
        <div className="small muted">{t('setup.step', { n: step + 1, total: steps.length })} · <strong>{steps[step]}</strong></div>

        {step === 0 && (
          <div className="form-grid">
            <Field label={t('setup.token')}><Input value={token} onChange={(e) => setToken(e.target.value)} autoFocus /></Field>
            <Field label={t('settings.restaurantName')}><Input value={restaurant.name} onChange={(e) => setRestaurant({ ...restaurant, name: e.target.value })} /></Field>
            <Field label={`${t('settings.restaurantName')} (AR)`}><Input dir="rtl" value={restaurant.nameAr} onChange={(e) => setRestaurant({ ...restaurant, nameAr: e.target.value })} /></Field>
            <Field label={t('common.phone')}><Input value={restaurant.phone} onChange={(e) => setRestaurant({ ...restaurant, phone: e.target.value })} /></Field>
            <Field label={t('common.email')}><Input value={restaurant.email} onChange={(e) => setRestaurant({ ...restaurant, email: e.target.value })} /></Field>
            <Field label={t('settings.logo')} hint="The official Sofia's logo is used by default"><input type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && readLogo(e.target.files[0])} /></Field>
          </div>
        )}
        {step === 1 && (
          <div className="form-grid">
            <Field label="Code"><Input value={branch.code} onChange={(e) => setBranch({ ...branch, code: e.target.value.toUpperCase() })} /></Field>
            <Field label={t('common.name')}><Input value={branch.name} onChange={(e) => setBranch({ ...branch, name: e.target.value })} /></Field>
            <Field label={`${t('common.name')} (AR)`}><Input dir="rtl" value={branch.nameAr} onChange={(e) => setBranch({ ...branch, nameAr: e.target.value })} /></Field>
            <Field label={t('guest.address')}><Input value={branch.address} onChange={(e) => setBranch({ ...branch, address: e.target.value })} /></Field>
            <Field label={t('common.phone')}><Input value={branch.phone} onChange={(e) => setBranch({ ...branch, phone: e.target.value })} /></Field>
            <Field label={t('settings.timezone')}><Input value={branch.timezone} onChange={(e) => setBranch({ ...branch, timezone: e.target.value })} /></Field>
          </div>
        )}
        {step === 2 && (
          <div className="form-grid">
            <Field label={t('settings.currency')}><Select value={loc.currency} onChange={(e) => setLoc({ ...loc, currency: e.target.value })} options={[{ value: 'IQD', label: 'IQD — Iraqi dinar' }, { value: 'USD', label: 'USD' }]} /></Field>
            <Field label={t('settings.secondaryCurrency')}><Select value={loc.secondaryCurrency} onChange={(e) => setLoc({ ...loc, secondaryCurrency: e.target.value })} options={[{ value: '', label: '—' }, { value: 'USD', label: 'USD' }, { value: 'IQD', label: 'IQD' }]} /></Field>
            <Field label={t('common.language')}><Select value={loc.language} onChange={(e) => setLoc({ ...loc, language: e.target.value as 'ar' })} options={[{ value: 'ar', label: 'العربية' }, { value: 'en', label: 'English' }]} /></Field>
          </div>
        )}
        {step === 3 && <HoursEditor value={hours} onChange={setHours} />}
        {step === 4 && (
          <div className="stack">
            {areas.map((a, i) => (
              <div key={a.key} className="row">
                <Input value={a.name} onChange={(e) => setAreas(areas.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <Input dir="rtl" value={a.nameAr} onChange={(e) => setAreas(areas.map((x, j) => (j === i ? { ...x, nameAr: e.target.value } : x)))} />
                <Select value={a.kind} onChange={(e) => setAreas(areas.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))} options={['indoor', 'outdoor', 'vip', 'terrace', 'private_room', 'lounge', 'bar'].map((k) => ({ value: k, label: t(`areaKind.${k}`) }))} />
                <Button variant="ghost" icon="x" onClick={() => setAreas(areas.filter((_, j) => j !== i))} />
              </div>
            ))}
            <Button icon="plus" onClick={() => { const key = `area${Date.now()}`; setAreas([...areas, { key, name: 'New area', nameAr: '', kind: 'indoor' }]); setTableGen({ ...tableGen, [key]: { count: 4, capacity: 4, prefix: 'A' } }); }}>{t('setup.addArea')}</Button>
          </div>
        )}
        {step === 5 && (
          <div className="stack">
            {areas.map((a) => {
              const g = tableGen[a.key] ?? { count: 4, capacity: 4, prefix: 'A' };
              return (
                <div key={a.key} className="row">
                  <strong style={{ width: 160 }}>{a.name}</strong>
                  <Field label={t('setup.count')}><Input type="number" min={0} value={g.count} onChange={(e) => setTableGen({ ...tableGen, [a.key]: { ...g, count: Number(e.target.value) } })} style={{ width: 90 }} /></Field>
                  <Field label={t('floor.capacity')}><Input type="number" min={1} value={g.capacity} onChange={(e) => setTableGen({ ...tableGen, [a.key]: { ...g, capacity: Number(e.target.value) } })} style={{ width: 90 }} /></Field>
                  <Field label={t('setup.prefix')}><Input value={g.prefix} onChange={(e) => setTableGen({ ...tableGen, [a.key]: { ...g, prefix: e.target.value } })} style={{ width: 80 }} /></Field>
                </div>
              );
            })}
          </div>
        )}
        {step === 6 && (
          <div className="form-grid">
            <Field label={t('auth.username')}><Input value={admin.username} onChange={(e) => setAdmin({ ...admin, username: e.target.value })} /></Field>
            <Field label={t('common.name')}><Input value={admin.displayName} onChange={(e) => setAdmin({ ...admin, displayName: e.target.value })} /></Field>
            <Field label={t('common.email')}><Input value={admin.email} onChange={(e) => setAdmin({ ...admin, email: e.target.value })} /></Field>
            <Field label={t('auth.password')} hint="≥ 10"><Input type="password" autoComplete="new-password" value={admin.password} onChange={(e) => setAdmin({ ...admin, password: e.target.value })} /></Field>
            <Field label={t('setup.confirmPassword')} error={admin.confirm && admin.confirm !== admin.password ? t('setup.mismatch') : undefined}><Input type="password" autoComplete="new-password" value={admin.confirm} onChange={(e) => setAdmin({ ...admin, confirm: e.target.value })} /></Field>
          </div>
        )}
        {step === 7 && (
          <div className="stack">
            <div className="form-grid">
              <Field label={t('settings.slot')}><Input type="number" value={res.slotIntervalMinutes} onChange={(e) => setRes({ ...res, slotIntervalMinutes: Number(e.target.value) })} /></Field>
              <Field label={t('settings.defaultDuration')}><Input type="number" value={res.defaultDurationMinutes} onChange={(e) => setRes({ ...res, defaultDurationMinutes: Number(e.target.value) })} /></Field>
              <Field label={t('settings.buffer')}><Input type="number" value={res.bufferMinutes} onChange={(e) => setRes({ ...res, bufferMinutes: Number(e.target.value) })} /></Field>
              <Field label={t('settings.advance')}><Input type="number" value={res.maxAdvanceDays} onChange={(e) => setRes({ ...res, maxAdvanceDays: Number(e.target.value) })} /></Field>
            </div>
            <Check label={t('settings.onlineBooking')} checked={res.onlineBookingEnabled} onChange={(v) => setRes({ ...res, onlineBookingEnabled: v })} />
            <Check label={t('settings.depositRule')} checked={res.depositEnabled} onChange={(v) => setRes({ ...res, depositEnabled: v })} />
          </div>
        )}
        {step === 8 && (
          <div className="form-grid">
            <Field label={t('setup.pos')}><Select value={pos.provider} onChange={(e) => setPos({ ...pos, provider: e.target.value })} options={[{ value: 'none', label: t('setup.posNone') }, { value: 'webhook', label: 'Webhook (POS pushes invoices)' }, { value: 'generic_rest', label: 'REST API (Sofia polls)' }, { value: 'csv_import', label: 'CSV import' }]} /></Field>
            {pos.provider === 'generic_rest' && <Field label="Base URL"><Input value={pos.baseUrl} onChange={(e) => setPos({ ...pos, baseUrl: e.target.value })} /></Field>}
          </div>
        )}
        {step === 9 && (
          <div className="form-grid">
            <Field label={t('common.time')}><Input type="time" value={backup.timeOfDay} onChange={(e) => setBackup({ ...backup, timeOfDay: e.target.value })} /></Field>
            <Field label={t('settings.retention')}><Input type="number" value={backup.retentionDays} onChange={(e) => setBackup({ ...backup, retentionDays: Number(e.target.value) })} /></Field>
            <Field label={t('settings.externalDir')}><Input value={backup.externalDirectory} onChange={(e) => setBackup({ ...backup, externalDirectory: e.target.value })} placeholder="D:\\SofiaBackups" /></Field>
            <Check label={t('common.enabled')} checked={backup.enabled} onChange={(v) => setBackup({ ...backup, enabled: v })} />
          </div>
        )}
        {step === 10 && (
          <div className="stack">
            <Field label={t('settings.publicUrl')} hint="https://sofia.example.com"><Input value={publicBaseUrl} onChange={(e) => setPublicBaseUrl(e.target.value)} /></Field>
            <p className="small muted">{t('settings.bookingLink')}: <span className="code">{publicBaseUrl}/book/{branch.code}</span></p>
          </div>
        )}

        <div className="row between">
          <Button disabled={step === 0} onClick={() => setStep(step - 1)}>{t('common.back')}</Button>
          {step < steps.length - 1 ? (
            <Button variant="primary" disabled={step === 0 && !token} onClick={() => setStep(step + 1)}>{t('common.next')}</Button>
          ) : (
            <Button variant="primary" busy={busy} disabled={!admin.password || admin.password !== admin.confirm} onClick={finish}>{t('common.create')}</Button>
          )}
        </div>
      </div>
    </div>
  );
}
