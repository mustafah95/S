import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { RESERVATION_TRANSITIONS, type ReservationAction, type ReservationStatus } from '@sofia/shared';
import { useApp } from '../../app/context';
import { get } from '../../lib/api';
import { dateLabel, dateTime, fullName, money, timeIn } from '../../lib/format';
import type { Rec } from '../../offline/db';
import { useGuest, useReservation, useTables } from '../../offline/hooks';
import { reservationAction } from '../../offline/repo';
import { Icon } from '../../ui/icons';
import { Badge, Button, Drawer, Field, Input, Modal, StatusBadge, VipBadge, useToast } from '../../ui/kit';
import { useBranchContext, useOnline } from '../common';

const ACTIONS: { action: ReservationAction; target: ReservationStatus; label: string; variant?: 'primary' | 'danger' }[] = [
  { action: 'confirm', target: 'confirmed', label: 'res.confirm' },
  { action: 'check_in', target: 'checked_in', label: 'res.checkIn' },
  { action: 'seat', target: 'seated', label: 'res.seat', variant: 'primary' },
  { action: 'start_dining', target: 'dining', label: 'res.startDining' },
  { action: 'complete', target: 'completed', label: 'res.complete', variant: 'primary' },
  { action: 'no_show', target: 'no_show', label: 'res.noShow', variant: 'danger' },
  { action: 'cancel', target: 'cancelled', label: 'res.cancelRes', variant: 'danger' },
];

export function ReservationDetail({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (r: Rec) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const online = useOnline();
  const { can } = useApp();
  const { branchId, tz } = useBranchContext();
  const r = useReservation(id);
  const guest = useGuest(r?.guestId);
  const tables = useTables(branchId);
  const [reasonFor, setReasonFor] = useState<ReservationAction | null>(null);
  const [reason, setReason] = useState('');
  const events = useQuery({ queryKey: ['res-events', id, r?.version], queryFn: () => get<{ id: string; type: string; toStatus: string | null; at: string; userName: string | null; data: Record<string, unknown> }[]>(`/api/v1/reservations/${id}/events`), enabled: online && !!r && !r._local });

  if (!r) return null;
  const labels = (r.tableIds as string[]).map((tid) => tables.find((tb) => tb.id === tid)?.label ?? '?').join(' + ');
  const allowed = RESERVATION_TRANSITIONS[r.status as ReservationStatus] ?? [];

  const run = async (action: ReservationAction, extra: { reason?: string } = {}) => {
    try {
      await reservationAction(r.id, action, extra);
      toast(`${r.code}: ${t(`status.${ACTIONS.find((a) => a.action === action)?.target}`)}`, online ? 'success' : 'warning');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <Drawer title={<span className="code">{r.code}</span>} onClose={onClose}>
      <div className="stack lg">
        {(r._local || r._pending) && <div className="local-note"><Icon name="wifiOff" />{t('conn.localOnly')}</div>}
        {r._error && <div className="badge red">{r._error}</div>}
        {r.requiresReview && <div className="local-note"><Icon name="alert" />{t('res.requiresReview')}: {r.reviewReason}</div>}
        <div className="row between">
          <div>
            <h2>{guest ? <Link to={`/guests/${guest.id}`}>{fullName(guest)}</Link> : r.guestName ?? '—'}</h2>
            <div className="row tight" style={{ marginTop: 4 }}>
              <VipBadge level={guest?.vipLevel} />
              {r.occasion && <Badge tone="gold"><Icon name="cake" size={12} />{t(`occasion.${r.occasion}`)}</Badge>}
            </div>
          </div>
          <StatusBadge status={r.status} />
        </div>
        <dl className="kv">
          <dt>{t('common.date')}</dt>
          <dd>{dateLabel(r.businessDate, { weekday: 'long', day: 'numeric', month: 'long' })}</dd>
          <dt>{t('common.time')}</dt>
          <dd className="num">{timeIn(r.startAt, tz)} – {timeIn(r.endAt, tz)}</dd>
          <dt>{t('res.partySize')}</dt>
          <dd>{r.partySize}</dd>
          <dt>{t('common.table')}</dt>
          <dd>{labels || '—'}</dd>
          <dt>{t('res.source')}</dt>
          <dd>{t(`source.${r.source}`)}</dd>
          {guest?.phone && (<><dt>{t('common.phone')}</dt><dd><a href={`tel:${guest.phone}`}>{guest.phone}</a></dd></>)}
          {(guest?.allergies as string[])?.length > 0 && (<><dt>{t('res.allergies')}</dt><dd><Badge tone="red">{(guest!.allergies as string[]).join(', ')}</Badge></dd></>)}
          {r.specialRequest && (<><dt>{t('res.specialRequest')}</dt><dd>{r.specialRequest}</dd></>)}
          {r.notes && (<><dt>{t('common.notes')}</dt><dd>{r.notes}</dd></>)}
          {r.depositAmount ? (<><dt>{t('res.deposit')}</dt><dd>{money(r.depositAmount, r.depositCurrency ?? 'IQD')} · {r.paymentStatus}</dd></>) : null}
        </dl>

        <div className="row">
          {ACTIONS.filter((a) => allowed.includes(a.target)).filter((a) => can(a.action === 'cancel' ? 'reservations.cancel' : a.action === 'confirm' ? 'reservations.update' : 'checkin.manage')).map((a) => (
            <Button key={a.action} variant={a.variant} onClick={() => (a.action === 'cancel' ? setReasonFor('cancel') : void run(a.action))}>
              {t(a.label)}
            </Button>
          ))}
          {can('reservations.update') && ['pending', 'confirmed', 'checked_in', 'seated', 'dining'].includes(r.status) && (
            <Button icon="edit" onClick={() => onEdit(r)}>{t('common.edit')}</Button>
          )}
        </div>

        {online && events.data && (
          <section>
            <h3 style={{ marginBottom: 10 }}>{t('res.timeline')}</h3>
            <ul className="timeline">
              {events.data.map((e) => (
                <li key={e.id}>
                  <strong>{e.toStatus ? t(`status.${e.toStatus}`, { defaultValue: e.type }) : e.type}</strong>
                  <div className="small muted">{dateTime(e.at, tz)} · {e.userName ?? 'system'}{e.data?.reason ? ` · ${e.data.reason}` : ''}</div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {reasonFor && (
        <Modal
          title={t('res.cancelRes')}
          onClose={() => setReasonFor(null)}
          footer={
            <>
              <Button onClick={() => setReasonFor(null)}>{t('common.close')}</Button>
              <Button variant="danger solid" onClick={async () => { await run('cancel', { reason }); setReasonFor(null); }}>{t('res.cancelRes')}</Button>
            </>
          }
        >
          <Field label={t('res.reason')}><Input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
        </Modal>
      )}
    </Drawer>
  );
}
