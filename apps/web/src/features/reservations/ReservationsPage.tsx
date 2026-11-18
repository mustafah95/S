import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLiveQuery } from 'dexie-react-hooks';
import { addDays, parseHHMM, periodsForDate } from '@sofia/shared';
import { useApp } from '../../app/context';
import { dateLabel, timeIn } from '../../lib/format';
import { db, type Rec } from '../../offline/db';
import { useReservations, useTables } from '../../offline/hooks';
import { Icon } from '../../ui/icons';
import { Badge, Button, Card, Empty, Input, Seg, StatusBadge, VipBadge } from '../../ui/kit';
import { useBranchContext } from '../common';
import { ReservationDetail } from './ReservationDetail';
import { ReservationForm } from './ReservationForm';

type Filter = 'all' | 'active' | 'seated' | 'done' | 'cancelled';
const FILTERS: Record<Filter, string[] | null> = {
  all: null,
  active: ['pending', 'confirmed', 'checked_in'],
  seated: ['seated', 'dining'],
  done: ['completed'],
  cancelled: ['cancelled', 'no_show', 'rescheduled'],
};

function DayTimeline({ reservations, tables, tz, hours, date, onOpen }: { reservations: Rec[]; tables: Rec[]; tz: string; hours: ReturnType<typeof useBranchContext>['hours']; date: string; onOpen: (id: string) => void }) {
  const periods = periodsForDate(date, hours);
  const startMin = periods.length ? Math.min(...periods.map((p) => parseHHMM(p.open))) : 12 * 60;
  const endMin = periods.length ? Math.max(...periods.map((p) => { const o = parseHHMM(p.open); let c = parseHHMM(p.close); if (c <= o) c += 1440; return c; })) : 24 * 60;
  const span = endMin - startMin;
  const toPct = (iso: string) => {
    const [h, m] = timeIn(iso, tz).split(':').map(Number) as [number, number];
    let mins = h * 60 + m;
    if (mins < startMin - 60) mins += 1440;
    return Math.max(0, Math.min(100, ((mins - startMin) / span) * 100));
  };
  const hoursMarks = Array.from({ length: Math.ceil(span / 60) + 1 }, (_, i) => startMin + i * 60);
  return (
    <div className="table-wrap">
      <div style={{ minWidth: 820 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', borderBottom: '1px solid var(--c-border)' }}>
          <div />
          <div style={{ position: 'relative', height: 26 }}>
            {hoursMarks.map((m) => (
              <span key={m} className="small muted num" style={{ position: 'absolute', insetInlineStart: `${((m - startMin) / span) * 100}%`, top: 4, transform: 'translateX(-50%)' }}>
                {String(Math.floor((m % 1440) / 60)).padStart(2, '0')}
              </span>
            ))}
          </div>
        </div>
        {tables.filter((tb) => tb.isActive).map((tb) => (
          <div key={tb.id} style={{ display: 'grid', gridTemplateColumns: '80px 1fr', borderBottom: '1px solid var(--c-border)', minHeight: 40 }}>
            <div style={{ padding: '10px 8px', fontWeight: 600 }}>{tb.label} <span className="small muted">{tb.maxCapacity}</span></div>
            <div style={{ position: 'relative' }}>
              {reservations.filter((r) => (r.tableIds as string[]).includes(tb.id) && !['cancelled', 'no_show', 'rescheduled'].includes(r.status)).map((r) => {
                const a = toPct(r.startAt);
                const b = toPct(r.endAt);
                return (
                  <button key={r.id} onClick={() => onOpen(r.id)} className={`badge ${['seated', 'dining'].includes(r.status) ? 'wine' : r.status === 'completed' ? 'green' : 'amber'}`} style={{ position: 'absolute', top: 6, height: 28, insetInlineStart: `${a}%`, width: `${Math.max(4, b - a)}%`, border: 0, cursor: 'pointer', justifyContent: 'flex-start', overflow: 'hidden', borderRadius: 6 }}>
                    {r.guestName ?? r.code} · {r.partySize}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ReservationsPage() {
  const { t } = useTranslation();
  const { can } = useApp();
  const [params, setParams] = useSearchParams();
  const { branchId, tz, today, hours } = useBranchContext();
  const date = params.get('date') ?? today;
  const [filter, setFilter] = useState<Filter>('all');
  const [view, setView] = useState<'list' | 'timeline'>('list');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Rec | null>(null);
  const creating = params.get('new') === '1';
  const openId = params.get('open');
  const all = useReservations(branchId, date);
  const tables = useTables(branchId);
  const guestIds = useMemo(() => [...new Set(all.map((r) => r.guestId).filter(Boolean))] as string[], [all]);
  const guests = useLiveQuery(async () => new Map((await db.guests.bulkGet(guestIds)).filter(Boolean).map((g) => [g!.id, g!])), [guestIds.join()]) ?? new Map<string, Rec>();
  const labels = new Map(tables.map((tb) => [tb.id, tb.label]));
  const rows = all.filter((r) => (!FILTERS[filter] || FILTERS[filter]!.includes(r.status)) && (!q || `${r.guestName} ${r.code} ${r.guestPhone ?? ''}`.toLowerCase().includes(q.toLowerCase())));
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v === null ? next.delete(k) : next.set(k, v);
    setParams(next, { replace: true });
  };

  return (
    <div className="stack lg">
      <div className="page-head">
        <div>
          <h1>{t('res.title')}</h1>
          <p>{dateLabel(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · {rows.filter((r) => !['cancelled', 'no_show'].includes(r.status)).reduce((s, r) => s + r.partySize, 0)} {t('common.guests')}</p>
        </div>
        <div className="row">
          <Button icon="chevronLeft" onClick={() => set({ date: addDays(date, -1) })} aria-label="previous day" />
          <Button onClick={() => set({ date: today })}>{t('common.today')}</Button>
          <Button icon="chevron" onClick={() => set({ date: addDays(date, 1) })} aria-label="next day" />
          <Input type="date" value={date} onChange={(e) => set({ date: e.target.value })} style={{ width: 160 }} />
          {can('reservations.create') && <Button variant="primary" icon="plus" onClick={() => set({ new: '1' })}>{t('res.new')}</Button>}
        </div>
      </div>
      <div className="row between">
        <Seg value={filter} onChange={setFilter} options={[
          { value: 'all', label: t('common.all') },
          { value: 'active', label: t('status.confirmed') },
          { value: 'seated', label: t('status.seated') },
          { value: 'done', label: t('status.completed') },
          { value: 'cancelled', label: t('status.cancelled') },
        ]} />
        <div className="row">
          <div className="search"><Icon name="search" /><input className="input" placeholder={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <Seg value={view} onChange={setView} options={[{ value: 'list', label: t('res.list') }, { value: 'timeline', label: t('res.timeline') }]} />
        </div>
      </div>
      <Card flush>
        {view === 'timeline' ? (
          <div style={{ padding: 12 }}><DayTimeline reservations={all} tables={tables} tz={tz} hours={hours} date={date} onOpen={(id) => set({ open: id })} /></div>
        ) : rows.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('common.time')}</th><th>{t('res.guest')}</th><th>{t('res.partySize')}</th><th>{t('common.table')}</th><th>{t('res.source')}</th><th>{t('common.status')}</th><th>{t('res.code')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const g = guests.get(r.guestId);
                  return (
                    <tr key={r.id} className="click" onClick={() => set({ open: r.id })}>
                      <td className="num"><strong>{timeIn(r.startAt, tz)}</strong></td>
                      <td>
                        <div className="row tight">
                          {r.guestName ?? '—'} <VipBadge level={g?.vipLevel} />
                          {r.occasion && <Icon name="cake" size={14} style={{ color: 'var(--c-gold)' }} />}
                          {(g?.allergies as string[])?.length > 0 && <Badge tone="red">⚠</Badge>}
                        </div>
                        {r.specialRequest && <div className="small muted">{r.specialRequest}</div>}
                      </td>
                      <td className="num">{r.partySize}</td>
                      <td>{(r.tableIds as string[]).map((id) => labels.get(id)).join(' + ') || <span className="muted">—</span>}</td>
                      <td className="small">{t(`source.${r.source}`)}</td>
                      <td>
                        <div className="row tight">
                          <StatusBadge status={r.status} />
                          {(r._local || r._pending) ? <span title={t('conn.localOnly')}><Icon name="wifiOff" size={14} style={{ color: 'var(--s-reserved)' }} /></span> : null}
                          {r.requiresReview && <Badge tone="amber">{t('res.requiresReview')}</Badge>}
                        </div>
                      </td>
                      <td className="code small">{r.code}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{t('res.noResults')}</Empty>
        )}
      </Card>
      {(creating || editing) && <ReservationForm initial={editing ?? undefined} defaultDate={date} defaultGuestId={params.get('guest')} onClose={() => { setEditing(null); set({ new: null, guest: null }); }} />}
      {openId && <ReservationDetail id={openId} onClose={() => set({ open: null })} onEdit={(r) => { set({ open: null }); setEditing(r); }} />}
    </div>
  );
}
