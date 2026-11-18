import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { OCCASION_TYPES, addDays } from '@sofia/shared';
import { ApiError, errorMessage, get, post } from '../lib/api';
import { applyBranding } from '../lib/theme';
import { currentLang, setLanguage } from '../i18n';
import { dateLabel, money } from '../lib/format';
import { Button, Check, Field, Input, Select, Textarea } from '../ui/kit';
import { Icon } from '../ui/icons';
import { PushOptIn } from './PushOptIn';

interface Branding { restaurantName: string; restaurantNameAr: string; logoUrl: string | null; colors: Record<string, string>; contact: Record<string, string> }
interface PublicBranch { id: string; code: string; name: string; nameAr: string | null; address: string | null; phone: string | null; today: string; maxDate: string; maxPartySize: number; cancellationPolicy: { en: string; ar: string }; deposit: { minPartySize: number; amountPerGuest: number; currency: string } | null; areas: { id: string; name: string; nameAr: string | null }[] }
interface Confirmation { code: string; status: string; guestName: string; branch: { name: string; nameAr: string | null; address: string | null; phone: string | null }; date: string; time: string; partySize: number; area: string | null; occasion: string | null; deposit: { amount: number; currency: string; status: string; instructions: { en: string; ar: string } } | null; policy: { en: string; ar: string }; cancellable: boolean; manageUrl: string; qr: string; token: string }

const embed = new URLSearchParams(location.search).get('embed') === '1';

function useAutoHeight() {
  useEffect(() => {
    if (!embed) return;
    const send = () => parent.postMessage({ type: 'sofia:height', height: document.documentElement.scrollHeight }, '*');
    const ro = new ResizeObserver(send);
    ro.observe(document.body);
    send();
    return () => ro.disconnect();
  }, []);
}

function Shell({ branding, children }: { branding: Branding | null; children: ReactNode }) {
  const name = currentLang() === 'ar' && branding?.restaurantNameAr ? branding.restaurantNameAr : branding?.restaurantName;
  return (
    <div style={{ minHeight: '100%', background: embed ? 'transparent' : 'linear-gradient(170deg, var(--c-primary-dark), #1d0508 60%)', padding: embed ? 0 : '28px 14px' }}>
      <div style={{ maxWidth: 620, margin: '0 auto' }}>
        {!embed && <img src={branding?.logoUrl ?? '/brand/sofia-logo-cream.png'} alt={name ?? ''} style={{ display: 'block', width: 'min(300px, 70%)', margin: '0 auto 18px' }} />}
        <div className="card" style={{ padding: 22, borderRadius: 20 }}>
          <div className="row between" style={{ marginBottom: 6 }}>
            <span />
            <Button size="sm" variant="ghost" icon="globe" onClick={() => setLanguage(currentLang() === 'ar' ? 'en' : 'ar')}>{currentLang() === 'ar' ? 'English' : 'العربية'}</Button>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

function ConfirmationView({ c, onChange }: { c: Confirmation; onChange: (c: Confirmation) => void }) {
  const { t } = useTranslation();
  const ar = currentLang() === 'ar';
  const [busy, setBusy] = useState(false);
  const cancelled = c.status === 'cancelled';
  return (
    <div className="stack" style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 40, color: cancelled ? 'var(--s-danger)' : 'var(--s-available)' }}>{cancelled ? '✕' : '✓'}</div>
      <h2>{cancelled ? t('booking.cancelled') : c.status === 'pending' ? t('booking.pendingDeposit') : t('booking.confirmed')}</h2>
      <div className="small muted">{t('booking.number')}</div>
      <div className="code" style={{ fontSize: 26, fontWeight: 700, letterSpacing: 2 }}>{c.code}</div>
      <img src={c.qr} alt="QR" style={{ width: 170, margin: '0 auto' }} />
      <dl className="kv" style={{ textAlign: 'start', margin: '0 auto' }}>
        <dt>{t('booking.branch')}</dt><dd>{ar && c.branch.nameAr ? c.branch.nameAr : c.branch.name}{c.branch.address ? ` · ${c.branch.address}` : ''}</dd>
        <dt>{t('booking.date')}</dt><dd>{dateLabel(c.date, { weekday: 'long', day: 'numeric', month: 'long' })}</dd>
        <dt>{t('booking.time')}</dt><dd className="num">{c.time}</dd>
        <dt>{t('booking.guests')}</dt><dd>{c.partySize}</dd>
        {c.area && (<><dt>{t('booking.area')}</dt><dd>{c.area}</dd></>)}
        {c.deposit && (<><dt>{t('booking.deposit')}</dt><dd>{money(c.deposit.amount, c.deposit.currency)} · {ar ? c.deposit.instructions.ar : c.deposit.instructions.en}</dd></>)}
      </dl>
      <div className="small muted" style={{ textAlign: 'start' }}><strong>{t('booking.policy')}:</strong> {ar ? c.policy.ar : c.policy.en}</div>
      {!cancelled && <PushOptIn code={c.code} token={c.token} manageUrl={c.manageUrl} />}
      {!cancelled && (
        <div className="row" style={{ justifyContent: 'center' }}>
          <a className="btn" href={`/api/v1/public/reservations/${c.code}/calendar.ics?t=${c.token}`}><Icon name="calendar" />{t('booking.addCalendar')}</a>
          {c.branch.phone && <a className="btn" href={`tel:${c.branch.phone}`}><Icon name="phone" /><bdi className="ltr">{c.branch.phone}</bdi></a>}
          {c.cancellable && (
            <Button variant="danger" busy={busy} onClick={async () => { if (!confirm(t('booking.cancelConfirm'))) return; setBusy(true); try { onChange(await post<Confirmation>(`/api/v1/public/reservations/${c.code}/cancel`, { t: c.token })); } finally { setBusy(false); } }}>{t('booking.cancel')}</Button>
          )}
        </div>
      )}
    </div>
  );
}

function BookingFlow({ branchCode }: { branchCode: string | null }) {
  const { t } = useTranslation();
  const ar = currentLang() === 'ar';
  const [branches, setBranches] = useState<PublicBranch[]>([]);
  const [branchId, setBranchId] = useState('');
  const [date, setDate] = useState('');
  const [party, setParty] = useState(2);
  const [areaId, setAreaId] = useState('');
  const [slots, setSlots] = useState<{ time: string; available: boolean }[] | null>(null);
  const [time, setTime] = useState('');
  const [d, setD] = useState({ firstName: '', lastName: '', phone: '', email: '', occasion: '', specialRequest: '', marketingConsent: false, website: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Confirmation | null>(null);
  const branch = branches.find((b) => b.id === branchId);

  useEffect(() => {
    void get<PublicBranch[]>('/api/v1/public/branches').then((bs) => {
      setBranches(bs);
      const b = bs.find((x) => x.code.toLowerCase() === branchCode?.toLowerCase()) ?? bs[0];
      if (b) {
        setBranchId(b.id);
        setDate(b.today);
      }
    });
  }, [branchCode]);
  useEffect(() => {
    if (!branch || !date) return;
    setSlots(null);
    setTime('');
    void get<{ slots: { time: string; available: boolean }[] }>(`/api/v1/public/availability?branch=${branch.code}&date=${date}&partySize=${party}${areaId ? `&areaId=${areaId}` : ''}`)
      .then((r) => setSlots(r.slots))
      .catch((e) => { setSlots([]); setError(errorMessage(e)); });
  }, [branch, date, party, areaId]);
  const dates = useMemo(() => (branch ? Array.from({ length: 14 }, (_, i) => addDays(branch.today, i)).filter((x) => x <= branch.maxDate) : []), [branch]);

  if (result) return <ConfirmationView c={result} onChange={setResult} />;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<Confirmation>('/api/v1/public/reservations', { branchId, date, time, partySize: party, areaId: areaId || null, firstName: d.firstName, lastName: d.lastName || undefined, phone: d.phone, email: d.email || '', occasion: d.occasion || null, specialRequest: d.specialRequest || undefined, marketingConsent: d.marketingConsent, language: currentLang(), source: embed ? 'widget' : 'online', website: d.website });
      history.replaceState(null, '', `/r/${r.code}?t=${r.token}`);
      setResult(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack lg">
      <h1 style={{ textAlign: 'center' }}>{t('booking.title')}</h1>
      {branches.length > 1 && <Field label={t('booking.branch')}><Select value={branchId} onChange={(e) => setBranchId(e.target.value)} options={branches.map((b) => ({ value: b.id, label: ar && b.nameAr ? b.nameAr : b.name }))} /></Field>}
      <div>
        <div className="small muted" style={{ marginBottom: 6 }}>{t('booking.date')}</div>
        <div className="row tight" style={{ overflowX: 'auto', flexWrap: 'nowrap', paddingBottom: 4 }}>
          {dates.map((x) => <button key={x} type="button" className={`slot ${x === date ? 'on' : ''}`} style={{ minWidth: 74, padding: '8px 6px' }} onClick={() => setDate(x)}>{dateLabel(x, { weekday: 'short', day: 'numeric' })}</button>)}
          <input className="input" type="date" min={branch?.today} max={branch?.maxDate} value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 150, flex: 'none' }} />
        </div>
      </div>
      <div className="form-grid">
        <Field label={t('booking.guests')}>
          <Select value={String(party)} onChange={(e) => setParty(Number(e.target.value))} options={Array.from({ length: branch?.maxPartySize ?? 10 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))} />
        </Field>
        {branch && branch.areas.length > 1 && <Field label={t('booking.area')}><Select value={areaId} onChange={(e) => setAreaId(e.target.value)} options={[{ value: '', label: t('booking.any') }, ...branch.areas.map((a) => ({ value: a.id, label: ar && a.nameAr ? a.nameAr : a.name }))]} /></Field>}
      </div>
      <div className="small muted">{t('booking.bigParty')}{branch?.phone ? <>: <bdi className="ltr">{branch.phone}</bdi></> : ''}</div>
      <div>
        <div className="small muted" style={{ marginBottom: 6 }}>{t('booking.time')}</div>
        {slots === null ? <span className="spinner" /> : slots.some((s) => s.available) ? (
          <div className="slot-grid">{slots.map((s) => <button key={s.time} type="button" className={`slot ${time === s.time ? 'on' : ''}`} disabled={!s.available} onClick={() => setTime(s.time)}>{s.time}</button>)}</div>
        ) : <div className="local-note">{t('booking.noSlots')}</div>}
      </div>
      {time && (
        <div className="stack">
          <h3>{t('booking.details')}</h3>
          <div className="form-grid">
            <Field label={t('booking.firstName')}><Input value={d.firstName} onChange={(e) => setD({ ...d, firstName: e.target.value })} autoComplete="given-name" /></Field>
            <Field label={t('booking.lastName')}><Input value={d.lastName} onChange={(e) => setD({ ...d, lastName: e.target.value })} autoComplete="family-name" /></Field>
            <Field label={t('booking.phone')}><Input type="tel" value={d.phone} onChange={(e) => setD({ ...d, phone: e.target.value })} autoComplete="tel" placeholder="07XX XXX XXXX" /></Field>
            <Field label={t('booking.email')}><Input type="email" value={d.email} onChange={(e) => setD({ ...d, email: e.target.value })} autoComplete="email" /></Field>
            <Field label={t('booking.occasion')}><Select value={d.occasion} onChange={(e) => setD({ ...d, occasion: e.target.value })} options={[{ value: '', label: '—' }, ...OCCASION_TYPES.map((o) => ({ value: o, label: t(`occasion.${o}`) }))]} /></Field>
          </div>
          <Field label={t('booking.request')}><Textarea value={d.specialRequest} onChange={(e) => setD({ ...d, specialRequest: e.target.value })} /></Field>
          <input tabIndex={-1} autoComplete="off" aria-hidden="true" style={{ position: 'absolute', left: -9999 }} value={d.website} onChange={(e) => setD({ ...d, website: e.target.value })} name="website" />
          <Check label={t('booking.consent')} checked={d.marketingConsent} onChange={(v) => setD({ ...d, marketingConsent: v })} />
          {branch?.deposit && party >= branch.deposit.minPartySize && <div className="local-note">{t('booking.deposit')}: {money(branch.deposit.amountPerGuest * party, branch.deposit.currency)}</div>}
          <div className="small muted"><strong>{t('booking.policy')}:</strong> {branch ? (ar ? branch.cancellationPolicy.ar : branch.cancellationPolicy.en) : ''}</div>
          {error && <div className="badge red" style={{ whiteSpace: 'normal' }}>{error}</div>}
          <Button variant="primary" busy={busy} disabled={!d.firstName || d.phone.replace(/\D/g, '').length < 6} onClick={submit}>{t('booking.book')} · {dateLabel(date, { day: 'numeric', month: 'short' })} {time} · {party}</Button>
        </div>
      )}
    </div>
  );
}

function ManageView({ code, token }: { code: string; token: string }) {
  const [c, setC] = useState<Confirmation | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { void get<Confirmation>(`/api/v1/public/reservations/${code}?t=${encodeURIComponent(token)}`).then(setC).catch((e) => setErr(errorMessage(e))); }, [code, token]);
  if (err) return <div className="badge red">{err}</div>;
  return c ? <ConfirmationView c={c} onChange={setC} /> : <span className="spinner" />;
}

function FeedbackView({ token }: { token: string }) {
  const { t } = useTranslation();
  const [ctx, setCtx] = useState<{ guestName: string; branchName: string; submitted: boolean } | null>(null);
  const [v, setV] = useState({ overallRating: 0, foodRating: 0, serviceRating: 0, atmosphereRating: 0, comment: '', suggestion: '' });
  const [done, setDone] = useState(false);
  useEffect(() => { void get<{ guestName: string; branchName: string; submitted: boolean }>(`/api/v1/public/feedback/${token}`).then((x) => { setCtx(x); setDone(x.submitted); }); }, [token]);
  const Stars = ({ k, label }: { k: 'overallRating' | 'foodRating' | 'serviceRating' | 'atmosphereRating'; label: string }) => (
    <div className="row between"><span>{label}</span><span>{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" aria-label={`${n}`} onClick={() => setV({ ...v, [k]: n })} style={{ border: 0, background: 'none', fontSize: 28, cursor: 'pointer', color: n <= v[k] ? 'var(--c-gold)' : 'var(--c-border-strong)' }}>★</button>)}</span></div>
  );
  if (done) return <h2 style={{ textAlign: 'center' }}>{t('booking.thanks')}</h2>;
  if (!ctx) return <span className="spinner" />;
  return (
    <div className="stack">
      <h2>{t('booking.feedbackTitle')}</h2>
      <p className="muted">{ctx.guestName} · {ctx.branchName}</p>
      <Stars k="overallRating" label={t('fb.overall')} />
      <Stars k="foodRating" label={t('fb.food')} />
      <Stars k="serviceRating" label={t('fb.service')} />
      <Stars k="atmosphereRating" label={t('fb.atmosphere')} />
      <Field label={t('booking.comment')}><Textarea value={v.comment} onChange={(e) => setV({ ...v, comment: e.target.value })} /></Field>
      <Field label={t('booking.suggestion')}><Input value={v.suggestion} onChange={(e) => setV({ ...v, suggestion: e.target.value })} /></Field>
      <Button variant="primary" disabled={!v.overallRating} onClick={async () => { await post(`/api/v1/public/feedback/${token}`, { overallRating: v.overallRating, foodRating: v.foodRating || null, serviceRating: v.serviceRating || null, atmosphereRating: v.atmosphereRating || null, comment: v.comment || null, suggestion: v.suggestion || null }); setDone(true); }}>{t('booking.submit')}</Button>
    </div>
  );
}

function OptOutView({ token }: { token: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<'busy' | 'ok' | 'err'>('busy');
  useEffect(() => { void post('/api/v1/public/opt-out', { t: token }).then(() => setState('ok')).catch(() => setState('err')); }, [token]);
  return <h2 style={{ textAlign: 'center' }}>{state === 'ok' ? t('booking.optOut') : state === 'err' ? '✕' : '…'}</h2>;
}

export function BookingApp() {
  const [branding, setBranding] = useState<Branding | null>(null);
  useAutoHeight();
  useEffect(() => {
    const lang = new URLSearchParams(location.search).get('lang');
    if (lang === 'ar' || lang === 'en') setLanguage(lang);
    void get<Branding>('/api/v1/public/branding').then((b) => { setBranding(b); applyBranding(b as never); document.title = `${b.restaurantName}`; });
  }, []);
  const path = location.pathname.split('/').filter(Boolean);
  const q = new URLSearchParams(location.search);
  let view: ReactNode;
  if (path[0] === 'r' && path[1]) view = <ManageView code={path[1]} token={q.get('t') ?? ''} />;
  else if (path[0] === 'feedback' && path[1]) view = <FeedbackView token={path[1]} />;
  else if (path[0] === 'book' && path[1] === 'opt-out') view = <OptOutView token={q.get('t') ?? ''} />;
  else view = <BookingFlow branchCode={path[1] ?? q.get('branch')} />;
  return <Shell branding={branding}>{view}</Shell>;
}
