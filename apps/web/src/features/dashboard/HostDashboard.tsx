import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLiveQuery } from 'dexie-react-hooks';
import { VIP_RANK, effectiveTableStatus, type VipLevel } from '@sofia/shared';
import { dateLabel, timeIn } from '../../lib/format';
import { db, type Rec } from '../../offline/db';
import { useReservations, useTables, useWaitlist } from '../../offline/hooks';
import { reservationAction } from '../../offline/repo';
import { Icon } from '../../ui/icons';
import { Badge, Button, Card, Empty, Stat, StatusBadge, VipBadge, useToast } from '../../ui/kit';
import { useApp } from '../../app/context';
import { useBranchContext } from '../common';

export function HostDashboard() {
  const { t } = useTranslation();
  const { can } = useApp();
  const toast = useToast();
  const navigate = useNavigate();
  const { branchId, tz, settings, today } = useBranchContext();
  const reservations = useReservations(branchId, today);
  const tables = useTables(branchId);
  const waitlist = useWaitlist(branchId);
  const guestIds = useMemo(() => [...new Set(reservations.map((r) => r.guestId).filter(Boolean))] as string[], [reservations]);
  const guests = useLiveQuery(async () => new Map((await db.guests.bulkGet(guestIds)).filter(Boolean).map((g) => [g!.id, g!])), [guestIds.join()]) ?? new Map<string, Rec>();
  const now = Date.now();
  const live = reservations.filter((r) => r.status !== 'rescheduled');
  const active = live.filter((r) => !['cancelled', 'no_show'].includes(r.status));
  const tableStatus = tables.filter((tb) => tb.isActive).map((tb) => effectiveTableStatus(tb as never, active as never, new Date()).status);
  const vipOf = (r: Rec) => guests.get(r.guestId)?.vipLevel as VipLevel | undefined;
  const arrivals = active.filter((r) => ['pending', 'confirmed', 'checked_in'].includes(r.status) && new Date(r.startAt).getTime() < now + 3 * 3600_000);
  const late = active.filter((r) => ['pending', 'confirmed'].includes(r.status) && new Date(r.startAt).getTime() + settings.lateThresholdMinutes * 60_000 < now);
  const vips = active.filter((r) => VIP_RANK[vipOf(r) ?? 'standard'] >= VIP_RANK.gold);
  const occasions = active.filter((r) => r.occasion);
  const review = live.filter((r) => r.requiresReview || r._local || r._error);
  const labels = new Map(tables.map((tb) => [tb.id, tb.label]));

  const act = async (r: Rec, action: 'check_in' | 'seat') => {
    try {
      await reservationAction(r.id, action);
      toast(`${r.guestName ?? r.code} · ${t(action === 'seat' ? 'status.seated' : 'status.checked_in')}`, 'success');
    } catch (e) {
      toast(String((e as Error).message), 'error');
    }
  };

  const Row = ({ r }: { r: Rec }) => {
    const g = guests.get(r.guestId);
    return (
      <div className="list-item">
        <div className="num" style={{ width: 52, fontWeight: 600 }}>{timeIn(r.startAt, tz)}</div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row tight">
            <strong>{r.guestName ?? '—'}</strong>
            <VipBadge level={g?.vipLevel} />
            {r.occasion && <Badge tone="gold"><Icon name="cake" size={12} />{t(`occasion.${r.occasion}`)}</Badge>}
            {(g?.allergies as string[] | undefined)?.length ? <Badge tone="red">{t('res.allergies')}: {(g!.allergies as string[]).join(', ')}</Badge> : null}
          </div>
          <div className="small muted">
            {r.partySize} {t('common.guests')} · {(r.tableIds as string[]).map((id) => labels.get(id)).join('+') || '—'} {r.specialRequest ? `· ${r.specialRequest}` : ''}
          </div>
        </div>
        <StatusBadge status={r.status} />
        {can('checkin.manage') && r.status !== 'checked_in' && <Button size="sm" onClick={() => void act(r, 'check_in')}>{t('res.checkIn')}</Button>}
        {can('checkin.manage') && <Button size="sm" variant="primary" onClick={() => void act(r, 'seat')}>{t('res.seat')}</Button>}
      </div>
    );
  };

  return (
    <div className="stack lg">
      <div className="page-head">
        <div>
          <h1>{t('dash.title')}</h1>
          <p>{dateLabel(today, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        </div>
        <div className="row">
          {can('reservations.create') && <Button variant="primary" icon="plus" onClick={() => navigate('/reservations?new=1')}>{t('res.new')}</Button>}
          {can('reservations.create') && <Button icon="walk" onClick={() => navigate('/waitlist?walkin=1')}>{t('res.walkIn')}</Button>}
        </div>
      </div>

      <div className="grid cols-4">
        <Stat label={t('dash.reservations')} value={active.length} sub={`${live.filter((r) => r.status === 'completed').length} ${t('status.completed')}`} onClick={() => navigate('/reservations')} />
        <Stat label={t('dash.covers')} value={active.reduce((s, r) => s + r.partySize, 0)} />
        <Stat label={t('dash.seated')} value={active.filter((r) => ['seated', 'dining'].includes(r.status)).length} sub={`${tableStatus.filter((s) => s === 'available').length} ${t('dash.tablesAvailable')}`} onClick={() => navigate('/floor')} />
        <Stat label={t('dash.waitlist')} value={waitlist.length} sub={`${waitlist.reduce((s, w) => s + w.partySize, 0)} ${t('common.guests')}`} onClick={() => navigate('/waitlist')} />
      </div>

      <div className="grid cols-3">
        <Stat label={t('dash.tablesAvailable')} value={tableStatus.filter((s) => s === 'available').length} />
        <Stat label={t('dash.tablesOccupied')} value={tableStatus.filter((s) => s === 'occupied').length} />
        <Stat label={t('dash.tablesReserved')} value={tableStatus.filter((s) => s === 'reserved').length} />
      </div>

      <div className="grid cols-2">
        <Card title={t('dash.arrivals')} actions={<Link className="btn sm" to="/reservations">{t('common.view')}</Link>}>
          {arrivals.length ? arrivals.map((r) => <Row key={r.id} r={r} />) : <Empty>{t('dash.noArrivals')}</Empty>}
        </Card>
        <div className="stack">
          {late.length > 0 && (
            <Card title={<h3 style={{ color: 'var(--s-danger)' }}>{t('dash.late')} ({late.length})</h3>}>
              {late.map((r) => <Row key={r.id} r={r} />)}
            </Card>
          )}
          <Card title={`${t('dash.vip')} (${vips.length})`}>{vips.length ? vips.map((r) => <Row key={r.id} r={r} />) : <Empty />}</Card>
          <Card title={`${t('dash.occasions')} (${occasions.length})`}>{occasions.length ? occasions.map((r) => <Row key={r.id} r={r} />) : <Empty />}</Card>
          {review.length > 0 && (
            <Card title={`${t('dash.review')} (${review.length})`}>
              {review.map((r) => (
                <div key={r.id} className="list-item">
                  <Icon name="alert" style={{ color: 'var(--s-reserved)' }} />
                  <span className="grow">{r.code} · {r.guestName} · {timeIn(r.startAt, tz)}</span>
                  <span className="small muted">{r._error ?? (r._local ? t('res.unconfirmed') : r.reviewReason)}</span>
                </div>
              ))}
            </Card>
          )}
          <Card title={`${t('dash.noShows')} (${live.filter((r) => r.status === 'no_show').length})`}>
            {live.filter((r) => r.status === 'no_show').map((r) => <Row key={r.id} r={r} />)}
          </Card>
        </div>
      </div>
    </div>
  );
}
