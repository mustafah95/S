import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useApp } from '../../app/context';
import { download, errorMessage, get, post } from '../../lib/api';
import { dateLabel, dateTime, fullName, initials, money, num } from '../../lib/format';
import { useGuest, useGuestNotes } from '../../offline/hooks';
import { addGuestNote } from '../../offline/repo';
import { syncEngine } from '../../offline/engine';
import { ColumnChart } from '../../ui/charts';
import { Icon } from '../../ui/icons';
import { Badge, Button, Card, Confirm, Empty, Stat, StatusBadge, Tabs, Textarea, VipBadge, useToast } from '../../ui/kit';
import { useOnline } from '../common';
import { GuestForm } from './GuestForm';

type Tab = 'overview' | 'history' | 'spending' | 'loyalty' | 'feedback';

interface Profile360 {
  guest: Record<string, unknown>;
  tier: { name: string; nameAr: string | null; color: string } | null;
  stats: Record<string, number | string | null> & { monthlySpending: { month: string; spend: number }[]; yearlySpending: { year: string; spend: number }[]; revenueByBranch: { name: string; spend: number }[] };
  favorites: { tables: { label: string; visits: number }[]; areas: { name: string; visits: number }[]; items: { name: string; quantity: number }[]; hours: { hour: number; visits: number }[]; weekdays: { weekday: number; visits: number }[]; branches: { name: string; visits: number }[] };
  reservations: Record<string, any>[];
  invoices: Record<string, any>[];
  loyalty: Record<string, any>[];
  feedback: Record<string, any>[];
  complaints: Record<string, any>[];
  marketing: Record<string, any>[];
  occasions: Record<string, any>[];
  notes: Record<string, any>[];
  push?: { devices: number; lastDeliveredAt: string | null };
}

export function GuestProfilePage() {
  const { id } = useParams();
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const online = useOnline();
  const { can, branchId, settings } = useApp();
  const guest = useGuest(id);
  const notes = useGuestNotes(id);
  const [tab, setTab] = useState<Tab>('overview');
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState<'anonymize' | null>(null);
  const cur = settings.general.primaryCurrency;
  const profile = useQuery({ queryKey: ['guest-profile', id, guest?.version], queryFn: () => get<Profile360>(`/api/v1/guests/${id}/profile`), enabled: online && !!guest && !guest._local });
  const dups = useQuery({ queryKey: ['guest-dups', id], queryFn: () => get<{ id: string; firstName: string; lastName: string | null; phone: string | null; reasons: string[] }[]>(`/api/v1/guests/duplicates?${new URLSearchParams({ excludeId: id!, ...(guest?.phone ? { phone: guest.phone } : {}), ...(guest?.email ? { email: guest.email } : {}) })}`), enabled: online && !!guest && can('guests.merge') });

  if (!guest) return <Empty />;
  const p = profile.data;
  const stats = p?.stats ?? { visitCount: guest.visitCount, totalSpend: guest.totalSpend, avgCheck: guest.avgCheck, noShowCount: guest.noShowCount, firstVisitAt: guest.firstVisitAt, lastVisitAt: guest.lastVisitAt };
  const weekdays = t('common.today') && ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <div className="stack lg">
      <div className="page-head">
        <div className="row">
          <div className="avatar lg">{initials(guest.firstName, guest.lastName)}</div>
          <div>
            <h1>{fullName(guest)}</h1>
            <div className="row tight" style={{ marginTop: 4 }}>
              <VipBadge level={guest.vipLevel} />
              {p?.tier && <Badge tone="gold">{p.tier.name}</Badge>}
              {guest.loyaltyNumber && <span className="chip code">{t('guest.loyaltyNo')} {guest.loyaltyNumber}</span>}
              {((guest.tags as string[]) ?? []).map((x) => <span key={x} className="chip">{x}</span>)}
              {guest._local && <Badge tone="amber"><Icon name="wifiOff" size={12} />{t('res.unconfirmed')}</Badge>}
            </div>
          </div>
        </div>
        <div className="row">
          {guest.phone && <a className="btn" href={`tel:${guest.phone}`}><Icon name="phone" />{guest.phone}</a>}
          {can('guests.update') && <Button icon="edit" onClick={() => setEditing(true)}>{t('common.edit')}</Button>}
          {can('reservations.create') && <Button variant="primary" icon="calendar" onClick={() => navigate(`/reservations?new=1&guest=${guest.id}`)}>{t('res.new')}</Button>}
        </div>
      </div>

      {!online && <div className="local-note"><Icon name="wifiOff" />{t('guest.offlineProfile')}</div>}
      {(guest.allergies as string[])?.length > 0 && <div className="banner danger" style={{ borderRadius: 10 }}><Icon name="alert" /><strong>{t('guest.allergies')}:</strong> {(guest.allergies as string[]).join(', ')}</div>}
      {dups.data && dups.data.length > 0 && (
        <Card title={t('guest.duplicates')}>
          {dups.data.map((d) => (
            <div key={d.id} className="list-item">
              <span className="grow">{d.firstName} {d.lastName ?? ''} · {d.phone ?? ''} {d.reasons.map((r) => <Badge key={r}>{r}</Badge>)}</span>
              <Button size="sm" onClick={async () => { try { await post(`/api/v1/guests/${guest.id}/merge`, { sourceIds: [d.id] }); toast(t('common.saved'), 'success'); void syncEngine.pull(); void dups.refetch(); } catch (e) { toast(errorMessage(e, t), 'error'); } }}>{t('guest.merge')}</Button>
            </div>
          ))}
        </Card>
      )}

      <div className="grid cols-4">
        <Stat label={t('guest.visits')} value={num(Number(stats.visitCount ?? 0))} sub={`${t('guest.firstVisit')}: ${stats.firstVisitAt ? dateLabel(String(stats.firstVisitAt)) : '—'}`} />
        <Stat label={t('guest.ltv')} value={money(Number(stats.totalSpend ?? 0), cur)} sub={`${t('guest.avgCheck')}: ${money(Number(stats.avgCheck ?? 0), cur)}`} />
        <Stat label={t('guest.lastVisit')} value={stats.lastVisitAt ? dateLabel(String(stats.lastVisitAt)) : '—'} sub={p ? `${t('guest.perVisit')}: ${money(Number(p.stats.revenuePerVisit ?? 0), cur)}` : undefined} />
        <Stat label={t('loyalty.balance')} value={`${num(Number(guest.loyaltyPoints ?? 0))}`} sub={`${t('guest.noShows')}: ${stats.noShowCount ?? 0} · ${t('guest.cancellations')}: ${p?.stats.cancellationCount ?? guest.cancellationCount ?? 0}`} />
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'overview', label: t('common.details') },
        { key: 'history', label: t('guest.history') },
        { key: 'spending', label: t('guest.spending') },
        { key: 'loyalty', label: t('nav.loyalty') },
        { key: 'feedback', label: `${t('guest.feedback')} & ${t('guest.complaints')}` },
      ]} />

      {tab === 'overview' && (
        <div className="grid cols-2">
          <Card title={t('common.details')}>
            <dl className="kv">
              <dt>{t('common.phone')}</dt><dd>{guest.phone ?? '—'}</dd>
              <dt>{t('guest.whatsapp')}</dt><dd>{guest.whatsapp ?? '—'}</dd>
              <dt>{t('common.email')}</dt><dd>{guest.email ?? '—'}</dd>
              <dt>{t('guest.birthday')}</dt><dd>{guest.birthday ? dateLabel(guest.birthday, { day: 'numeric', month: 'long' }) : '—'}</dd>
              <dt>{t('guest.anniversary')}</dt><dd>{guest.anniversary ? dateLabel(guest.anniversary, { day: 'numeric', month: 'long' }) : '—'}</dd>
              <dt>{t('guest.language')}</dt><dd>{guest.preferredLanguage === 'ar' ? 'العربية' : guest.preferredLanguage === 'en' ? 'English' : '—'}</dd>
              <dt>{t('guest.company')}</dt><dd>{guest.company ?? '—'}</dd>
              <dt>{t('guest.dietary')}</dt><dd>{((guest.dietary as string[]) ?? []).join(', ') || '—'}</dd>
              <dt>{t('guest.preferences')}</dt><dd>{Object.entries((guest.preferences as Record<string, string>) ?? {}).map(([k, v]) => `${k}: ${v}`).join(' · ') || '—'}</dd>
              <dt>{t('guest.consent')}</dt><dd>{guest.marketingConsent ? <Badge tone="green">✓ {Object.entries((guest.consentChannels as Record<string, boolean>) ?? {}).filter(([, v]) => v).map(([k]) => k).join(', ')}</Badge> : <Badge>✗</Badge>}</dd>
              <dt>{t('guest.pushDevices')}</dt><dd>{p?.push?.devices ? <Badge tone="green">{p.push.devices}</Badge> : '—'}</dd>
            </dl>
            {guest.notes && <><div className="divider" /><p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{guest.notes}</p></>}
          </Card>
          <div className="stack">
            <Card title={t('common.notes')}>
              {can('guests.update') && (
                <div className="stack" style={{ marginBottom: 12 }}>
                  <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('guest.addNote')} style={{ minHeight: 60 }} />
                  <Button size="sm" variant="primary" disabled={!note.trim()} onClick={async () => { await addGuestNote(guest.id, note.trim(), branchId); setNote(''); }}>{t('guest.addNote')}</Button>
                </div>
              )}
              {notes.map((n) => (
                <div key={n.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                  <Icon name={n.kind === 'offline_merge' ? 'sync' : 'edit'} style={{ color: 'var(--c-gold)' }} />
                  <div className="grow">
                    <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
                    <div className="small muted">{dateTime(n.createdAt)} {n._local ? '· ⟳' : ''}</div>
                  </div>
                </div>
              ))}
              {!notes.length && <span className="muted small">—</span>}
            </Card>
            {p && (
              <Card title={t('guest.favorites')}>
                <dl className="kv">
                  <dt>{t('guest.favTables')}</dt><dd>{p.favorites.tables.map((x) => `${x.label} (${x.visits})`).join(', ') || '—'}</dd>
                  <dt>{t('guest.favAreas')}</dt><dd>{p.favorites.areas.map((x) => `${x.name} (${x.visits})`).join(', ') || '—'}</dd>
                  <dt>{t('guest.favItems')}</dt><dd>{p.favorites.items.map((x) => `${x.name} ×${num(x.quantity)}`).join(', ') || '—'}</dd>
                  <dt>{t('guest.favTimes')}</dt><dd>{p.favorites.hours.map((x) => `${String(x.hour).padStart(2, '0')}:00`).join(', ') || '—'} {p.favorites.weekdays.length ? `· ${p.favorites.weekdays.map((w) => weekdays[w.weekday]).join(', ')}` : ''}</dd>
                  <dt>{t('guest.favBranches')}</dt><dd>{p.favorites.branches.map((x) => x.name).join(', ') || '—'}</dd>
                </dl>
              </Card>
            )}
            {p && p.occasions.length > 0 && <Card title={t('guest.occasions')}>{p.occasions.map((o) => <div key={o.id} className="list-item"><Icon name="cake" /><span className="grow">{t(`occasion.${o.type}`)}</span>{dateLabel(o.date, { day: 'numeric', month: 'long' })}</div>)}</Card>}
          </div>
        </div>
      )}

      {tab === 'history' && (
        <Card flush>
          {p?.reservations.length ? (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>{t('common.date')}</th><th>{t('common.branch')}</th><th>{t('res.partySize')}</th><th>{t('common.table')}</th><th>{t('res.occasion')}</th><th>{t('common.status')}</th><th className="r">{t('common.total')}</th></tr></thead>
                <tbody>
                  {p.reservations.map((r) => (
                    <tr key={r.id}>
                      <td>{dateLabel(r.businessDate)} <span className="code small muted">{r.code}</span></td>
                      <td>{r.branchName}</td>
                      <td className="num">{r.partySize}</td>
                      <td>{r.tableLabels ?? '—'}</td>
                      <td>{r.occasion ? t(`occasion.${r.occasion}`) : ''}</td>
                      <td><StatusBadge status={r.status} /></td>
                      <td className="r num">{r.spend ? money(r.spend, cur) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty>{online ? undefined : t('common.requiresConnection')}</Empty>}
        </Card>
      )}

      {tab === 'spending' && (
        <div className="stack">
          {p ? (
            <>
              <div className="grid cols-3">
                <Stat label={t('guest.highestCheck')} value={money(Number(p.stats.maxCheck ?? 0), cur)} />
                <Stat label={t('guest.yearly')} value={p.stats.yearlySpending.map((y) => `${y.year}: ${money(y.spend, cur)}`).join(' · ') || '—'} />
                <Stat label={t('common.branch')} value={p.stats.revenueByBranch.map((b) => b.name).join(', ') || '—'} />
              </div>
              <Card title={t('guest.monthly')}>
                {p.stats.monthlySpending.length ? <ColumnChart data={p.stats.monthlySpending.map((m) => ({ label: m.month.slice(2), title: m.month, value: m.spend }))} format={(v) => money(v, cur)} tableCaption={t('common.details')} /> : <Empty />}
              </Card>
              <Card title={t('guest.invoices')} flush>
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>{t('common.date')}</th><th>#</th><th>{t('common.branch')}</th><th>{t('common.table')}</th><th>Items</th><th className="r">{t('common.total')}</th></tr></thead>
                    <tbody>
                      {p.invoices.map((i) => (
                        <tr key={i.id}><td>{dateTime(i.closedAt)}</td><td className="code">{i.invoiceNumber}</td><td>{i.branchName}</td><td>{i.tableLabel}</td><td className="small">{(i.items ?? []).map((x: { name: string; quantity: number }) => `${x.name} ×${x.quantity}`).join(', ')}</td><td className="r num">{money(i.total, i.currency)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!p.invoices.length && <Empty />}
              </Card>
            </>
          ) : <Empty>{t('common.requiresConnection')}</Empty>}
        </div>
      )}

      {tab === 'loyalty' && (
        <Card flush>
          {p?.loyalty.length ? (
            <table className="data"><tbody>{p.loyalty.map((l) => <tr key={l.id}><td>{dateTime(l.createdAt)}</td><td><Badge tone={l.points > 0 ? 'green' : 'red'}>{l.type}</Badge></td><td>{l.reason}</td><td className="r num">{l.points > 0 ? '+' : ''}{l.points}</td><td className="r num muted">{l.balanceAfter}</td></tr>)}</tbody></table>
          ) : <Empty />}
        </Card>
      )}

      {tab === 'feedback' && (
        <div className="grid cols-2">
          <Card title={t('guest.feedback')}>{p?.feedback.length ? p.feedback.map((f) => <div key={f.id} className="list-item"><Badge tone={f.overallRating >= 4 ? 'green' : f.overallRating >= 3 ? 'amber' : 'red'}>{'★'.repeat(f.overallRating)}</Badge><span className="grow">{f.comment}</span><span className="small muted">{dateLabel(String(f.submittedAt).slice(0, 10))}</span></div>) : <Empty />}</Card>
          <Card title={t('guest.complaints')}>{p?.complaints.length ? p.complaints.map((c) => <div key={c.id} className="list-item"><StatusBadge status={c.status} /><span className="grow">{c.description}</span><Badge>{c.severity}</Badge></div>) : <Empty />}</Card>
          <Card title={t('guest.marketingHistory')}>{p?.marketing.length ? p.marketing.map((m) => <div key={`${m.id}${m.createdAt}`} className="list-item"><span className="grow">{m.name}</span><Badge>{m.channel}</Badge><Badge tone={m.status === 'sent' ? 'green' : undefined}>{m.status}</Badge></div>) : <Empty />}</Card>
        </div>
      )}

      {online && (can('guests.export') || can('guests.delete')) && (
        <div className="row no-print">
          {can('guests.export') && <Button icon="download" onClick={() => void download('GET', `/api/v1/guests/${guest.id}/export`, undefined, `guest-${guest.id}.json`)}>{t('guest.exportData')}</Button>}
          {can('guests.delete') && <Button variant="danger" onClick={() => setConfirm('anonymize')}>{t('guest.anonymize')}</Button>}
        </div>
      )}
      {editing && <GuestForm guest={guest} onClose={() => setEditing(false)} />}
      {confirm === 'anonymize' && <Confirm danger text={t('guest.anonymizeConfirm')} onClose={() => setConfirm(null)} onConfirm={async () => { await post(`/api/v1/guests/${guest.id}/anonymize`); await syncEngine.pull(); toast(t('common.saved'), 'success'); }} />}
    </div>
  );
}
