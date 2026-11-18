import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { pickTables } from '@sofia/shared';
import { useApp } from '../../app/context';
import { relative } from '../../lib/format';
import { useCombos, useReservationsAround, useTables, useWaitlist } from '../../offline/hooks';
import { addToWaitlist, seatWalkIn, waitlistAction } from '../../offline/repo';
import { Badge, Button, Card, Check, Empty, Field, Input, Modal, StatusBadge, useToast } from '../../ui/kit';
import { allocationsFrom, dayRange, useBranchContext, useOnline } from '../common';

export function WaitlistPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const online = useOnline();
  const { can } = useApp();
  const [params, setParams] = useSearchParams();
  const { branchId, today, settings } = useBranchContext();
  const waitlist = useWaitlist(branchId);
  const tables = useTables(branchId);
  const combos = useCombos(branchId);
  const reservations = useReservationsAround(branchId, dayRange(today));
  const [form, setForm] = useState<{ mode: 'walkin' | 'wait'; name: string; phone: string; party: number; quoted: number; vip: boolean; notes: string } | null>(params.get('walkin') ? { mode: 'walkin', name: '', phone: '', party: 2, quoted: 15, vip: false, notes: '' } : null);
  const [seatFor, setSeatFor] = useState<string | null>(null);
  const allocations = useMemo(() => allocationsFrom(reservations, settings.bufferMinutes), [reservations, settings.bufferMinutes]);
  const pick = (party: number) => {
    const now = Date.now();
    return pickTables(tables as never, combos as never, allocations, now, now + 2 * 3600_000, party, { now })?.tableIds ?? [];
  };
  const label = (ids: string[]) => ids.map((id) => tables.find((x) => x.id === id)?.label).join(' + ');
  const close = () => {
    setForm(null);
    if (params.get('walkin')) setParams({}, { replace: true });
  };

  async function submit() {
    if (!form) return;
    const free = pick(form.party);
    if (form.mode === 'walkin' && free.length) {
      await seatWalkIn({ branchId, partySize: form.party, tableIds: free, guestName: form.name || 'Walk-in', notes: form.notes || null });
      toast(`${t('wait.seated')} · ${label(free)}`, online ? 'success' : 'warning');
    } else {
      await addToWaitlist({ branchId, guestName: form.name || 'Walk-in', phone: form.phone || null, partySize: form.party, quotedWaitMinutes: form.quoted, isVip: form.vip, notes: form.notes || null });
      toast(form.mode === 'walkin' ? t('wait.noTable') : t('common.saved'), 'info');
    }
    close();
  }

  return (
    <div className="stack lg">
      <div className="page-head">
        <div>
          <h1>{t('wait.title')}</h1>
          <p>{waitlist.length} · {waitlist.reduce((s, w) => s + w.partySize, 0)} {t('common.guests')}</p>
        </div>
        {can('waitlist.manage') && (
          <div className="row">
            <Button variant="primary" icon="walk" onClick={() => setForm({ mode: 'walkin', name: '', phone: '', party: 2, quoted: 15, vip: false, notes: '' })}>{t('wait.walkIn')}</Button>
            <Button icon="plus" onClick={() => setForm({ mode: 'wait', name: '', phone: '', party: 2, quoted: 20, vip: false, notes: '' })}>{t('wait.add')}</Button>
          </div>
        )}
      </div>
      <Card flush>
        {waitlist.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>#</th><th>{t('common.name')}</th><th>{t('wait.party')}</th><th>{t('wait.waited')}</th><th>{t('wait.quoted')}</th><th>{t('common.status')}</th><th>{t('res.suggestion')}</th><th /></tr>
              </thead>
              <tbody>
                {[...waitlist].sort((a, b) => Number(b.isVip) - Number(a.isVip) || b.priority - a.priority).map((w, i) => {
                  const s = pick(w.partySize);
                  const waited = Math.round((Date.now() - new Date(w.createdAt).getTime()) / 60_000);
                  return (
                    <tr key={w.id}>
                      <td className="num">{i + 1}</td>
                      <td><strong>{w.guestName}</strong> {w.isVip && <Badge tone="vip">VIP</Badge>}<div className="small muted">{w.phone ?? ''} {w.notes ?? ''}</div></td>
                      <td className="num">{w.partySize}</td>
                      <td className="num" style={{ color: w.quotedWaitMinutes && waited > w.quotedWaitMinutes ? 'var(--s-danger)' : undefined }}>{waited} {t('common.minutes')}</td>
                      <td className="num">{w.quotedWaitMinutes ?? '—'} {t('common.minutes')}</td>
                      <td><StatusBadge status={w.status} /> {w._pending ? <span className="small muted">⟳</span> : null}</td>
                      <td>{s.length ? <Badge tone="green">{label(s)}</Badge> : <span className="muted">—</span>}</td>
                      <td>
                        {can('waitlist.manage') && (
                          <div className="row tight">
                            {w.status === 'waiting' && <Button size="sm" onClick={() => void waitlistAction(w.id, 'notify')}>{t('wait.notify')}</Button>}
                            <Button size="sm" variant="primary" disabled={!s.length} onClick={() => setSeatFor(w.id)}>{t('wait.seat')}</Button>
                            <Button size="sm" variant="ghost" icon="x" onClick={() => void waitlistAction(w.id, 'cancel')} aria-label={t('wait.remove')} />
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{t('wait.empty')}</Empty>
        )}
      </Card>
      {form && (
        <Modal title={form.mode === 'walkin' ? t('wait.walkIn') : t('wait.add')} onClose={close} footer={<><Button onClick={close}>{t('common.cancel')}</Button><Button variant="primary" onClick={submit}>{form.mode === 'walkin' && pick(form.party).length ? `${t('res.seatNow')} · ${label(pick(form.party))}` : t('wait.add')}</Button></>}>
          <div className="form-grid">
            <Field label={t('common.name')}><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
            <Field label={t('common.phone')}><Input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
            <Field label={t('wait.party')}><Input type="number" min={1} value={form.party} onChange={(e) => setForm({ ...form, party: Math.max(1, Number(e.target.value)) })} /></Field>
            <Field label={t('wait.quoted')}><Input type="number" min={0} value={form.quoted} onChange={(e) => setForm({ ...form, quoted: Number(e.target.value) })} /></Field>
            <Field label={t('common.notes')}><Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
          </div>
          <div style={{ marginTop: 12 }}><Check label="VIP" checked={form.vip} onChange={(v) => setForm({ ...form, vip: v })} /></div>
          {form.mode === 'walkin' && !pick(form.party).length && <p className="local-note" style={{ marginTop: 12 }}>{t('wait.noTable')}</p>}
        </Modal>
      )}
      {seatFor && (() => {
        const w = waitlist.find((x) => x.id === seatFor);
        if (!w) return null;
        const s = pick(w.partySize);
        return (
          <Modal title={`${t('wait.seat')} · ${w.guestName}`} onClose={() => setSeatFor(null)} footer={<><Button onClick={() => setSeatFor(null)}>{t('common.cancel')}</Button><Button variant="primary" onClick={async () => { await waitlistAction(w.id, 'seat', { tableIds: s }); setSeatFor(null); toast(t('wait.seated'), online ? 'success' : 'warning'); }}>{t('wait.seat')} · {label(s)}</Button></>}>
            <p>{w.partySize} {t('common.guests')} → {t('common.table')} <strong>{label(s)}</strong></p>
          </Modal>
        );
      })()}
    </div>
  );
}
