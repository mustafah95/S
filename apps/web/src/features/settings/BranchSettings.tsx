import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import QRCode from 'qrcode';
import type { OpeningPeriod, ReservationSettings, WeeklyHours } from '@sofia/shared';
import { useApp } from '../../app/context';
import { del, errorMessage, get, patch, post } from '../../lib/api';
import { syncEngine } from '../../offline/engine';
import { Button, Card, Check, Field, Input, Select, Spinner, Textarea, useToast } from '../../ui/kit';

interface Branch {
  id: string; code: string; name: string; nameAr: string | null; address: string | null; phone: string | null; timezone: string; currency: string;
  operatingHours: WeeklyHours; reservationSettings: ReservationSettings; isActive: boolean;
}

const DAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

export function HoursEditor({ value, onChange }: { value: WeeklyHours; onChange: (v: WeeklyHours) => void }) {
  const { t, i18n } = useTranslation();
  const days = i18n.language === 'ar' ? DAYS_AR : DAYS_EN;
  const set = (d: number, periods: OpeningPeriod[]) => onChange(value.map((p, i) => (i === d ? periods : p)));
  return (
    <div className="stack" style={{ gap: 8 }}>
      {value.map((periods, d) => (
        <div key={d} className="row" style={{ alignItems: 'center' }}>
          <strong style={{ width: 100 }}>{days[d]}</strong>
          {periods.length === 0 && <span className="muted small">{t('settings.closed')}</span>}
          {periods.map((p, i) => (
            <span key={i} className="row tight">
              <input className="input" type="time" value={p.open} style={{ width: 110 }} onChange={(e) => set(d, periods.map((x, j) => (j === i ? { ...x, open: e.target.value } : x)))} />–
              <input className="input" type="time" value={p.close} style={{ width: 110 }} onChange={(e) => set(d, periods.map((x, j) => (j === i ? { ...x, close: e.target.value } : x)))} />
              <Button size="sm" variant="ghost" icon="x" onClick={() => set(d, periods.filter((_, j) => j !== i))} />
            </span>
          ))}
          <Button size="sm" variant="ghost" icon="plus" onClick={() => set(d, [...periods, { open: '12:00', close: '00:00' }])}>{t('settings.addPeriod')}</Button>
          {d > 0 && <Button size="sm" variant="ghost" onClick={() => set(d, value[d - 1]!.map((p) => ({ ...p })))}>↑</Button>}
        </div>
      ))}
    </div>
  );
}

function BookingLink({ branch }: { branch: Branch }) {
  const { t } = useTranslation();
  const { settings } = useApp();
  const base = settings.general.publicBaseUrl || location.origin;
  const url = `${base}/book/${branch.code}`;
  const [qr, setQr] = useState('');
  useEffect(() => { void QRCode.toDataURL(url, { width: 360, margin: 1, color: { dark: '#3E0B12', light: '#FFFFFF' } }).then(setQr); }, [url]);
  const widget = `<script src="${base}/widget.js" data-branch="${branch.code}" data-lang="ar" async></script>`;
  return (
    <Card title={t('settings.bookingLink')}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        {qr && <a href={qr} download={`sofia-booking-${branch.code}.png`}><img src={qr} alt="QR" style={{ width: 160, borderRadius: 8, border: '1px solid var(--c-border)' }} /></a>}
        <div className="stack grow">
          <Field label="URL"><Input readOnly value={url} onFocus={(e) => e.target.select()} /></Field>
          <Field label={t('settings.widgetCode')}><Textarea readOnly value={widget} onFocus={(e) => e.target.select()} style={{ minHeight: 60, fontFamily: 'monospace', fontSize: 12 }} /></Field>
          <div className="row"><a className="btn sm" href={`/book/${branch.code}`} target="_blank" rel="noreferrer">{t('common.open')}</a></div>
        </div>
      </div>
    </Card>
  );
}

function Closures({ branchId }: { branchId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const list = useQuery({ queryKey: ['closures', branchId], queryFn: () => get<{ id: string; date: string; reason: string | null; periods: OpeningPeriod[] | null }[]>(`/api/v1/branches/${branchId}/closures`) });
  const [v, setV] = useState({ date: '', reason: '' });
  return (
    <Card title={t('settings.closures')}>
      {(list.data ?? []).map((c) => (
        <div key={c.id} className="list-item"><span className="grow">{c.date} · {c.reason ?? ''} {c.periods ? c.periods.map((p) => `${p.open}–${p.close}`).join(', ') : t('settings.closed')}</span><Button size="sm" variant="ghost" icon="trash" onClick={async () => { await del(`/api/v1/branches/${branchId}/closures/${c.id}`); void list.refetch(); }} /></div>
      ))}
      <div className="row" style={{ marginTop: 8 }}>
        <Input type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} style={{ width: 170 }} />
        <Input placeholder={t('res.reason')} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} style={{ width: 240 }} />
        <Button disabled={!v.date} onClick={async () => { try { await post(`/api/v1/branches/${branchId}/closures`, { date: v.date, reason: v.reason || null, periods: null }); setV({ date: '', reason: '' }); void list.refetch(); } catch (e) { toast(errorMessage(e, t), 'error'); } }}>{t('common.add')}</Button>
      </div>
    </Card>
  );
}

export function BranchesTab() {
  const { t } = useTranslation();
  const toast = useToast();
  const { can, branchId } = useApp();
  const branches = useQuery({ queryKey: ['branches-admin'], queryFn: () => get<Branch[]>('/api/v1/branches') });
  const [selected, setSelected] = useState(branchId);
  const [b, setB] = useState<Branch | null>(null);
  useEffect(() => { const found = branches.data?.find((x) => x.id === selected) ?? branches.data?.[0]; if (found) setB(structuredClone(found)); }, [branches.data, selected]);
  if (!b) return <Spinner />;
  const rs = b.reservationSettings;
  const setRs = (patchRs: Partial<ReservationSettings>) => setB({ ...b, reservationSettings: { ...rs, ...patchRs } });
  const save = async () => {
    try {
      await patch(`/api/v1/branches/${b.id}`, { name: b.name, nameAr: b.nameAr, address: b.address, phone: b.phone, timezone: b.timezone, currency: b.currency, operatingHours: b.operatingHours, reservationSettings: rs });
      toast(t('common.saved'), 'success');
      void branches.refetch();
      void syncEngine.pull();
    } catch (e) {
      toast(errorMessage(e, t), 'error');
    }
  };
  const num = (k: keyof ReservationSettings, label: string) => <Field label={label}><Input type="number" value={rs[k] as number} onChange={(e) => setRs({ [k]: Number(e.target.value) } as Partial<ReservationSettings>)} /></Field>;
  return (
    <div className="stack">
      <div className="row">
        <Select value={b.id} onChange={(e) => setSelected(e.target.value)} options={(branches.data ?? []).map((x) => ({ value: x.id, label: `${x.code} · ${x.name}` }))} />
        {can('branches.manage') && <Button icon="plus" onClick={async () => { const code = prompt('Branch code (e.g. ERBIL)'); if (!code) return; try { const nb = await post<Branch>('/api/v1/branches', { code, name: code, operatingHours: b.operatingHours }); setSelected(nb.id); void branches.refetch(); void syncEngine.pull(); } catch (e) { toast(errorMessage(e, t), 'error'); } }}>{t('common.add')}</Button>}
        <div className="grow" />
        <Button variant="primary" onClick={save}>{t('common.save')}</Button>
      </div>
      <Card title={`${b.code} · ${b.name}`}>
        <div className="form-grid">
          <Field label={t('common.name')}><Input value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} /></Field>
          <Field label={`${t('common.name')} (AR)`}><Input dir="rtl" value={b.nameAr ?? ''} onChange={(e) => setB({ ...b, nameAr: e.target.value })} /></Field>
          <Field label={t('guest.address')}><Input value={b.address ?? ''} onChange={(e) => setB({ ...b, address: e.target.value })} /></Field>
          <Field label={t('common.phone')}><Input value={b.phone ?? ''} onChange={(e) => setB({ ...b, phone: e.target.value })} /></Field>
          <Field label={t('settings.timezone')}><Input value={b.timezone} onChange={(e) => setB({ ...b, timezone: e.target.value })} /></Field>
        </div>
      </Card>
      <Card title={t('settings.hours')}><HoursEditor value={b.operatingHours} onChange={(v) => setB({ ...b, operatingHours: v })} /></Card>
      <Card title={t('settings.reservations')}>
        <div className="form-grid">
          {num('slotIntervalMinutes', t('settings.slot'))}
          {num('defaultDurationMinutes', t('settings.defaultDuration'))}
          {num('bufferMinutes', t('settings.buffer'))}
          {num('maxAdvanceDays', t('settings.advance'))}
          {num('minNoticeMinutes', t('settings.notice'))}
          {num('maxOnlinePartySize', t('settings.maxOnline'))}
          {num('cancellationCutoffHours', t('settings.cancelCutoff'))}
          {num('noShowGraceMinutes', t('settings.noShowGrace'))}
          {num('reminderHoursBefore', t('settings.reminder'))}
          {num('lastSeatingBeforeCloseMinutes', 'Last seating before close (min)')}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <Check label={t('settings.onlineBooking')} checked={rs.onlineBookingEnabled} onChange={(x) => setRs({ onlineBookingEnabled: x })} />
          <Check label={t('settings.autoConfirm')} checked={rs.autoConfirmOnline} onChange={(x) => setRs({ autoConfirmOnline: x })} />
          <Check label="Hold VIP tables for VIP guests" checked={rs.holdVipTablesForVip} onChange={(x) => setRs({ holdVipTablesForVip: x })} />
          <Check label="Mark table for cleaning after service" checked={rs.markCleaningAfterComplete} onChange={(x) => setRs({ markCleaningAfterComplete: x })} />
        </div>
        <h3 style={{ margin: '16px 0 8px' }}>{t('settings.depositRule')}</h3>
        <div className="row">
          <Check label={t('common.enabled')} checked={rs.deposit.enabled} onChange={(x) => setRs({ deposit: { ...rs.deposit, enabled: x } })} />
          <Field label={t('settings.depositFrom')}><Input type="number" value={rs.deposit.minPartySize} onChange={(e) => setRs({ deposit: { ...rs.deposit, minPartySize: Number(e.target.value) } })} /></Field>
          <Field label={t('settings.depositPerGuest')}><Input type="number" value={rs.deposit.amountPerGuest} onChange={(e) => setRs({ deposit: { ...rs.deposit, amountPerGuest: Number(e.target.value) } })} /></Field>
        </div>
        <div className="form-grid" style={{ marginTop: 12 }}>
          <Field label={`${t('settings.policy')} (EN)`}><Textarea value={rs.cancellationPolicy.en} onChange={(e) => setRs({ cancellationPolicy: { ...rs.cancellationPolicy, en: e.target.value } })} /></Field>
          <Field label={`${t('settings.policy')} (AR)`}><Textarea dir="rtl" value={rs.cancellationPolicy.ar} onChange={(e) => setRs({ cancellationPolicy: { ...rs.cancellationPolicy, ar: e.target.value } })} /></Field>
        </div>
      </Card>
      <Closures branchId={b.id} />
      <BookingLink branch={b} />
    </div>
  );
}
