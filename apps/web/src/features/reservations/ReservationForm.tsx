import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { OCCASION_TYPES, RESERVATION_SOURCES, businessToUtc, combinedCapacity, durationForParty, utcToZoned, type ReservationSource } from '@sofia/shared';
import { useApp } from '../../app/context';
import { fullName } from '../../lib/format';
import type { Rec } from '../../offline/db';
import { useAreas, useCombos, useGuest, useGuestSearch, useReservationsAround, useTables } from '../../offline/hooks';
import { createGuest, createReservation, updateReservation } from '../../offline/repo';
import { Icon } from '../../ui/icons';
import { Badge, Button, Check, Count, Field, Input, Modal, Select, Textarea, VipBadge, useToast } from '../../ui/kit';
import { dayRange, localSlots, tableAvailability, useBranchContext, useOnline } from '../common';

interface Props {
  initial?: Rec;
  defaultDate: string;
  defaultTableIds?: string[];
  defaultGuestId?: string | null;
  onClose: () => void;
}

export function ReservationForm({ initial, defaultDate, defaultTableIds, defaultGuestId, onClose }: Props) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const online = useOnline();
  const { can } = useApp();
  const { branchId, tz, settings, hours } = useBranchContext();
  const [guestId, setGuestId] = useState<string | null>(initial?.guestId ?? defaultGuestId ?? null);
  const [guestQuery, setGuestQuery] = useState('');
  const [newGuest, setNewGuest] = useState<{ firstName: string; lastName: string; phone: string; email: string } | null>(null);
  const [date, setDate] = useState<string>(initial?.businessDate ?? defaultDate);
  const [partySize, setPartySize] = useState<number>(initial?.partySize ?? 2);
  const [time, setTime] = useState<string>(initial?.time ?? (initial ? utcToZoned(new Date(initial.startAt), tz).time : ''));
  const [tableIds, setTableIds] = useState<string[]>(initial?.tableIds ?? defaultTableIds ?? []);
  const [areaId, setAreaId] = useState<string>(initial?.areaId ?? '');
  const [occasion, setOccasion] = useState<string>(initial?.occasion ?? '');
  const [source, setSource] = useState<ReservationSource>((initial?.source as ReservationSource) ?? 'phone');
  const [notes, setNotes] = useState<string>(initial?.notes ?? '');
  const [specialRequest, setSpecialRequest] = useState<string>(initial?.specialRequest ?? '');
  const [deposit, setDeposit] = useState<string>(initial?.depositAmount ? String(initial.depositAmount) : '');
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const guest = useGuest(guestId);
  const results = useGuestSearch(guestQuery, 8);
  const tables = useTables(branchId);
  const combos = useCombos(branchId);
  const areas = useAreas(branchId);
  const reservations = useReservationsAround(branchId, dayRange(date));

  const slots = useMemo(
    () => localSlots({ date, partySize, hours, settings, tz, tables, combos, reservations, areaId: areaId || null, excludeId: initial?.id }),
    [date, partySize, hours, settings, tz, tables, combos, reservations, areaId, initial?.id],
  );
  const duration = durationForParty(settings, partySize);
  const start = time ? businessToUtc(date, time, tz) : null;
  const free = useMemo(() => (start ? tableAvailability(tables, reservations, start, duration, settings.bufferMinutes, initial?.id) : new Map<string, boolean>()), [start?.getTime(), tables, reservations, duration, settings.bufferMinutes, initial?.id]);
  const suggestion = slots.find((s) => s.time === time)?.tableIds ?? [];
  const chosen = tables.filter((tb) => tableIds.includes(tb.id));
  const cap = combinedCapacity(chosen as never);
  const conflict = tableIds.some((id) => free.get(id) === false);
  const outside = time !== '' && !slots.some((s) => s.time === time);

  async function submit() {
    if (!time) return toast(t('common.time') + ' — ' + t('common.required'), 'error');
    setBusy(true);
    try {
      let gid = guestId;
      if (!gid && newGuest?.firstName) {
        gid = (await createGuest({ firstName: newGuest.firstName, lastName: newGuest.lastName || null, phone: newGuest.phone || null, email: newGuest.email || null, source: 'reservation' })).id;
      }
      const finalTables = tableIds.length ? tableIds : suggestion;
      if (initial) {
        const patch: Record<string, unknown> = {};
        if (date !== initial.businessDate) patch.date = date;
        if (time !== initial.time) patch.time = time;
        if (partySize !== initial.partySize) patch.partySize = partySize;
        if (finalTables.join() !== (initial.tableIds as string[]).join()) patch.tableIds = finalTables;
        if ((gid ?? null) !== (initial.guestId ?? null)) patch.guestId = gid;
        if ((occasion || null) !== (initial.occasion ?? null)) patch.occasion = occasion || null;
        if (notes !== (initial.notes ?? '')) patch.notes = notes || null;
        if (specialRequest !== (initial.specialRequest ?? '')) patch.specialRequest = specialRequest || null;
        if (source !== initial.source) patch.source = source;
        if (override) patch.overrideHours = true;
        if (Object.keys(patch).length) await updateReservation(initial.id, patch);
      } else {
        await createReservation({
          branchId,
          guestId: gid,
          date,
          time,
          partySize,
          tableIds: finalTables,
          areaId: areaId || null,
          occasion: (occasion || null) as never,
          source,
          notes: notes || null,
          specialRequest: specialRequest || null,
          depositAmount: deposit ? Number(deposit) : null,
          autoAssignTable: !finalTables.length,
          overrideHours: override,
        });
      }
      toast(online ? t('res.created') : `${t('res.created')} — ${t('conn.localOnly')}`, online ? 'success' : 'warning');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title={initial ? `${t('res.edit')} · ${initial.code}` : t('res.new')}
      onClose={onClose}
      footer={
        <>
          {!online && <span className="local-note grow"><Icon name="wifiOff" />{t('conn.localOnly')}</span>}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" busy={busy} onClick={submit} disabled={!time || (!guestId && !newGuest?.firstName && !initial)}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack lg">
        <section className="stack">
          <h3>{t('res.guest')}</h3>
          {guest ? (
            <div className="row card" style={{ padding: 12 }}>
              <div className="avatar">{(guest.firstName ?? '?').charAt(0)}</div>
              <div className="grow">
                <div className="row tight">
                  <strong>{fullName(guest)}</strong>
                  <VipBadge level={guest.vipLevel} />
                </div>
                <div className="small muted">
                  {guest.phone ?? ''} · {guest.visitCount ?? 0} {t('res.visits')} {(guest.allergies as string[])?.length ? `· ⚠ ${(guest.allergies as string[]).join(', ')}` : ''}
                </div>
              </div>
              <Button size="sm" variant="ghost" icon="x" onClick={() => setGuestId(null)} />
            </div>
          ) : newGuest ? (
            <div className="form-grid">
              <Field label={t('guest.firstName')}><Input value={newGuest.firstName} onChange={(e) => setNewGuest({ ...newGuest, firstName: e.target.value })} autoFocus /></Field>
              <Field label={t('guest.lastName')}><Input value={newGuest.lastName} onChange={(e) => setNewGuest({ ...newGuest, lastName: e.target.value })} /></Field>
              <Field label={t('common.phone')}><Input type="tel" value={newGuest.phone} onChange={(e) => setNewGuest({ ...newGuest, phone: e.target.value })} /></Field>
              <Field label={t('common.email')}><Input type="email" value={newGuest.email} onChange={(e) => setNewGuest({ ...newGuest, email: e.target.value })} /></Field>
            </div>
          ) : (
            <div className="stack">
              <div className="search">
                <Icon name="search" />
                <input className="input" placeholder={t('res.searchGuest')} value={guestQuery} onChange={(e) => setGuestQuery(e.target.value)} autoFocus />
              </div>
              {guestQuery && (
                <div className="card" style={{ padding: 6 }}>
                  {(results ?? []).map((g) => (
                    <div key={g.id} className="list-item" style={{ cursor: 'pointer', padding: 8 }} onClick={() => setGuestId(g.id)}>
                      <div className="avatar">{(g.firstName ?? '?').charAt(0)}</div>
                      <span className="grow">{fullName(g)} <span className="muted small">{g.phone ?? ''}</span></span>
                      <VipBadge level={g.vipLevel} />
                    </div>
                  ))}
                  <Button variant="ghost" icon="plus" onClick={() => setNewGuest({ firstName: /\d/.test(guestQuery) ? '' : guestQuery, lastName: '', phone: /\d/.test(guestQuery) ? guestQuery : '', email: '' })}>
                    {t('res.newGuest')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </section>

        <section className="form-grid">
          <Field label={t('common.date')}><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label={t('res.partySize')}><Input type="number" min={1} max={500} value={partySize} onChange={(e) => setPartySize(Math.max(1, Number(e.target.value)))} /></Field>
          <Field label={t('common.area')}>
            <Select value={areaId} onChange={(e) => setAreaId(e.target.value)} options={[{ value: '', label: t('common.all') }, ...areas.map((a) => ({ value: a.id, label: i18n.language === 'ar' && a.nameAr ? a.nameAr : a.name }))]} />
          </Field>
          <Field label={t('res.source')}>
            <Select value={source} onChange={(e) => setSource(e.target.value as ReservationSource)} options={RESERVATION_SOURCES.map((s) => ({ value: s, label: t(`source.${s}`) }))} />
          </Field>
        </section>

        <section className="stack">
          <div className="row between">
            <h3>{t('common.time')}</h3>
            <span className="small muted">{t('res.duration')}: {duration} {t('common.minutes')}</span>
          </div>
          <div className="slot-grid">
            {slots.map((s) => (
              <button key={s.time} type="button" className={`slot ${time === s.time ? 'on' : ''}`} disabled={!s.available && time !== s.time && !initial} onClick={() => { setTime(s.time); setTableIds([]); }}>
                {s.time}
              </button>
            ))}
          </div>
          <div className="row">
            <Field label={t('common.time')}><Input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ width: 130 }} /></Field>
            {outside && <Badge tone="amber">{t('res.outsideHours')}</Badge>}
            {outside && can('reservations.override') && <Check label={t('res.override')} checked={override} onChange={setOverride} />}
          </div>
        </section>

        {time && (
          <section className="stack">
            <div className="row between">
              <h3>{t('res.chooseTable')}</h3>
              {suggestion.length > 0 && (
                <Button size="sm" variant="gold" onClick={() => setTableIds(suggestion)}>
                  {t('res.suggestion')}: {suggestion.map((id) => tables.find((tb) => tb.id === id)?.label).join(' + ')}
                </Button>
              )}
            </div>
            <div className="row tight" style={{ flexWrap: 'wrap' }}>
              {tables.filter((tb) => tb.isActive && (!areaId || tb.areaId === areaId)).map((tb) => {
                const on = tableIds.includes(tb.id);
                const isFree = free.get(tb.id) !== false;
                return (
                  <button key={tb.id} type="button" className={`btn sm ${on ? 'primary' : ''}`} style={!isFree && !on ? { opacity: 0.45, textDecoration: 'line-through' } : undefined} onClick={() => setTableIds(on ? tableIds.filter((x) => x !== tb.id) : [...tableIds, tb.id])}>
                    {tb.label} <span className="small">({tb.minCapacity}–{tb.maxCapacity})</span> {tb.isVip ? '★' : ''}
                  </button>
                );
              })}
            </div>
            {chosen.length > 0 && partySize > cap.max && <span className="badge amber">{t('res.capacityWarn')} <Count n={cap.max} /></span>}
            {conflict && <span className="badge red">{t('res.conflictWarn')}</span>}
          </section>
        )}

        <section className="form-grid">
          <Field label={t('res.occasion')}>
            <Select value={occasion} onChange={(e) => setOccasion(e.target.value)} options={[{ value: '', label: '—' }, ...OCCASION_TYPES.map((o) => ({ value: o, label: t(`occasion.${o}`) }))]} />
          </Field>
          {settings.deposit.enabled && <Field label={t('res.deposit')}><Input type="number" min={0} value={deposit} onChange={(e) => setDeposit(e.target.value)} /></Field>}
          <Field label={t('res.specialRequest')} className="grow"><Input value={specialRequest} onChange={(e) => setSpecialRequest(e.target.value)} /></Field>
        </section>
        <Field label={t('common.notes')}><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
