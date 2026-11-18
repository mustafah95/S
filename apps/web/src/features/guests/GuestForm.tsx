import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LANGUAGES, VIP_LEVELS, normalizePhone, type GuestCreateInput } from '@sofia/shared';
import { useApp } from '../../app/context';
import { get } from '../../lib/api';
import { db, type Rec } from '../../offline/db';
import { createGuest, updateGuest } from '../../offline/repo';
import { Badge, Button, Check, Field, Input, Modal, Select, Textarea, useToast } from '../../ui/kit';
import { useOnline } from '../common';

const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

export function GuestForm({ guest, onClose }: { guest?: Rec; onClose: (id?: string) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const online = useOnline();
  const navigate = useNavigate();
  const { can, settings } = useApp();
  const [v, setV] = useState({
    firstName: guest?.firstName ?? '',
    lastName: guest?.lastName ?? '',
    preferredName: guest?.preferredName ?? '',
    phone: guest?.phone ?? '',
    whatsapp: guest?.whatsapp ?? '',
    email: guest?.email ?? '',
    birthday: guest?.birthday ?? '',
    anniversary: guest?.anniversary ?? '',
    address: guest?.address ?? '',
    company: guest?.company ?? '',
    preferredLanguage: guest?.preferredLanguage ?? '',
    vipLevel: guest?.vipLevel ?? 'standard',
    tags: ((guest?.tags as string[]) ?? []).join(', '),
    allergies: ((guest?.allergies as string[]) ?? []).join(', '),
    dietary: ((guest?.dietary as string[]) ?? []).join(', '),
    seating: ((guest?.preferences as Record<string, string>)?.seating as string) ?? '',
    drinks: ((guest?.preferences as Record<string, string>)?.drinks as string) ?? '',
    notes: guest?.notes ?? '',
    marketingConsent: !!guest?.marketingConsent,
    whatsappOk: !!(guest?.consentChannels as Record<string, boolean>)?.whatsapp,
    smsOk: !!(guest?.consentChannels as Record<string, boolean>)?.sms,
    emailOk: !!(guest?.consentChannels as Record<string, boolean>)?.email,
  });
  const [dups, setDups] = useState<{ id: string; firstName: string; lastName: string | null; phone: string | null; reasons: string[] }[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (guest || (!v.phone && !v.email && v.firstName.length < 3)) return setDups([]);
    const timer = setTimeout(async () => {
      if (online) {
        try {
          const qs = new URLSearchParams({ ...(v.phone ? { phone: v.phone } : {}), ...(v.email ? { email: v.email } : {}), ...(v.firstName ? { firstName: v.firstName } : {}), ...(v.lastName ? { lastName: v.lastName } : {}) });
          return setDups(await get(`/api/v1/guests/duplicates?${qs}`));
        } catch {
          /* fall through to local check */
        }
      }
      const phone = normalizePhone(v.phone, settings.guests.defaultCountry);
      const local = await db.guests.filter((g) => !g.deletedAt && ((!!phone && g.phoneNormalized === phone) || (!!v.email && String(g.email ?? '').toLowerCase() === v.email.toLowerCase()))).limit(5).toArray();
      setDups(local.map((g) => ({ id: g.id, firstName: g.firstName, lastName: g.lastName, phone: g.phone, reasons: ['phone'] })));
    }, 400);
    return () => clearTimeout(timer);
  }, [v.phone, v.email, v.firstName, v.lastName, guest, online, settings.guests.defaultCountry]);

  async function save() {
    setBusy(true);
    try {
      const input: GuestCreateInput = {
        firstName: v.firstName.trim(),
        lastName: v.lastName || null,
        preferredName: v.preferredName || null,
        phone: v.phone || null,
        whatsapp: v.whatsapp || null,
        email: v.email || null,
        birthday: v.birthday || null,
        anniversary: v.anniversary || null,
        address: v.address || null,
        company: v.company || null,
        preferredLanguage: (v.preferredLanguage || null) as never,
        tags: csv(v.tags),
        allergies: csv(v.allergies),
        dietary: csv(v.dietary),
        preferences: Object.fromEntries(Object.entries({ seating: v.seating, drinks: v.drinks }).filter(([, x]) => x)),
        notes: v.notes || null,
        marketingConsent: v.marketingConsent,
        consentChannels: { whatsapp: v.whatsappOk, sms: v.smsOk, email: v.emailOk, push: false },
      };
      if (can('guests.vip') || !guest) input.vipLevel = (can('guests.vip') ? v.vipLevel : 'standard') as never;
      if (guest) {
        const changed = Object.fromEntries(Object.entries(input).filter(([k, val]) => JSON.stringify(val ?? null) !== JSON.stringify(guest[k] ?? (Array.isArray(val) ? [] : null))));
        if (Object.keys(changed).length) await updateGuest(guest.id, changed);
        onClose(guest.id);
      } else {
        const g = await createGuest(input);
        onClose(g.id);
      }
      toast(t('common.saved'), online ? 'success' : 'warning');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const f = (k: keyof typeof v) => ({ value: v[k] as string, onChange: (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value }) });
  return (
    <Modal wide title={guest ? `${t('common.edit')} · ${guest.firstName}` : t('guest.new')} onClose={() => onClose()} footer={<><Button onClick={() => onClose()}>{t('common.cancel')}</Button><Button variant="primary" busy={busy} disabled={!v.firstName.trim()} onClick={save}>{t('common.save')}</Button></>}>
      <div className="stack lg">
        {dups.length > 0 && (
          <div className="local-note" style={{ display: 'block' }}>
            <strong>{t('guest.duplicates')}</strong>
            {dups.map((d) => (
              <div key={d.id} className="row" style={{ marginTop: 6 }}>
                <span className="grow">{d.firstName} {d.lastName ?? ''} · {d.phone ?? ''} {d.reasons.map((r) => <Badge key={r}>{r}</Badge>)}</span>
                <Button size="sm" onClick={() => { onClose(); navigate(`/guests/${d.id}`); }}>{t('common.open')}</Button>
              </div>
            ))}
          </div>
        )}
        <div className="form-grid">
          <Field label={`${t('guest.firstName')} *`}><Input {...f('firstName')} autoFocus /></Field>
          <Field label={t('guest.lastName')}><Input {...f('lastName')} /></Field>
          <Field label={t('guest.preferredName')}><Input {...f('preferredName')} /></Field>
          <Field label={t('common.phone')}><Input type="tel" {...f('phone')} /></Field>
          <Field label={t('guest.whatsapp')}><Input type="tel" {...f('whatsapp')} /></Field>
          <Field label={t('common.email')}><Input type="email" {...f('email')} /></Field>
          <Field label={t('guest.birthday')}><Input type="date" {...f('birthday')} /></Field>
          <Field label={t('guest.anniversary')}><Input type="date" {...f('anniversary')} /></Field>
          <Field label={t('guest.language')}><Select {...f('preferredLanguage')} options={[{ value: '', label: '—' }, ...LANGUAGES.map((l) => ({ value: l, label: l === 'ar' ? 'العربية' : 'English' }))]} /></Field>
          <Field label={t('guest.vipLevel')}><Select {...f('vipLevel')} disabled={!can('guests.vip')} options={VIP_LEVELS.map((l) => ({ value: l, label: t(`vip.${l}`) }))} /></Field>
          <Field label={t('guest.company')}><Input {...f('company')} /></Field>
          <Field label={t('guest.address')}><Input {...f('address')} /></Field>
        </div>
        <div className="form-grid">
          <Field label={t('guest.tags')} hint={settings.guests.tags.join(', ')}><Input {...f('tags')} /></Field>
          <Field label={t('guest.allergies')}><Input {...f('allergies')} /></Field>
          <Field label={t('guest.dietary')}><Input {...f('dietary')} /></Field>
          <Field label={`${t('guest.preferences')} · seating`}><Input {...f('seating')} /></Field>
          <Field label={`${t('guest.preferences')} · drinks`}><Input {...f('drinks')} /></Field>
        </div>
        <Field label={t('common.notes')}><Textarea {...f('notes')} /></Field>
        <div className="row">
          <Check label={t('guest.consent')} checked={v.marketingConsent} onChange={(x) => setV({ ...v, marketingConsent: x })} />
          {v.marketingConsent && (
            <>
              <Check label="WhatsApp" checked={v.whatsappOk} onChange={(x) => setV({ ...v, whatsappOk: x })} />
              <Check label="SMS" checked={v.smsOk} onChange={(x) => setV({ ...v, smsOk: x })} />
              <Check label="E-mail" checked={v.emailOk} onChange={(x) => setV({ ...v, emailOk: x })} />
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
