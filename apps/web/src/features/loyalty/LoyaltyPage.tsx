import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LOYALTY_RULE_TYPES, REWARD_TYPES } from '@sofia/shared';
import { useApp } from '../../app/context';
import { errorMessage, get, post, put } from '../../lib/api';
import { dateTime, fullName, num } from '../../lib/format';
import { useGuestSearch } from '../../offline/hooks';
import { Icon } from '../../ui/icons';
import { Badge, Button, Card, Check, Empty, Field, Input, Select, Spinner, Tabs, useToast } from '../../ui/kit';
import { useOnline } from '../common';

interface Config {
  enabled: boolean;
  pointsExpiryMonths: number;
  tiers: { id?: string; name: string; nameAr: string | null; minPoints: number; multiplier: number; color: string | null }[];
  rules: { id?: string; type: string; name: string; isActive: boolean; config: Record<string, number> }[];
  rewards: { id?: string; name: string; nameAr: string | null; type: string; pointsCost: number; value: number; isActive: boolean }[];
}

function GuestLoyalty() {
  const { t } = useTranslation();
  const toast = useToast();
  const { can } = useApp();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [guestId, setGuestId] = useState<string | null>(null);
  const [adj, setAdj] = useState({ points: '', reason: '' });
  const results = useGuestSearch(q, 8) ?? [];
  const detail = useQuery({ queryKey: ['loyalty-guest', guestId], queryFn: () => get<{ guest: Record<string, any>; transactions: Record<string, any>[]; rewards: { id: string; name: string; pointsCost: number; redeemable: boolean }[] }>(`/api/v1/loyalty/guests/${guestId}`), enabled: !!guestId });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['loyalty-guest', guestId] });
  const g = detail.data?.guest;
  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,2fr)' }}>
      <Card title={t('loyalty.findGuest')}>
        <div className="search"><Icon name="search" /><input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('res.searchGuest')} /></div>
        {results.map((r) => (
          <div key={r.id} className="list-item" style={{ cursor: 'pointer' }} onClick={() => setGuestId(r.id)}>
            <span className="grow">{fullName(r)}</span><span className="num small">{num(r.loyaltyPoints)} {t('common.points')}</span>
          </div>
        ))}
      </Card>
      {g ? (
        <Card title={`${g.firstName} ${g.lastName ?? ''}`} actions={<Badge tone="gold">{g.tierName ?? '—'}</Badge>}>
          <div className="grid cols-3" style={{ marginBottom: 14 }}>
            <div className="stat"><span className="label">{t('loyalty.balance')}</span><span className="value">{num(g.loyaltyPoints)}</span></div>
            <div className="stat"><span className="label">{t('loyalty.lifetime')}</span><span className="value">{num(g.loyaltyLifetimePoints)}</span></div>
            <div className="stat"><span className="label">{t('guest.loyaltyNo')}</span><span className="value code" style={{ fontSize: 18 }}>{g.loyaltyNumber}</span></div>
          </div>
          {g.nextTierPoints && <div className="progress" title={`${g.loyaltyLifetimePoints} / ${g.nextTierPoints}`}><i style={{ width: `${Math.min(100, (g.loyaltyLifetimePoints / g.nextTierPoints) * 100)}%` }} /></div>}
          <h3 style={{ margin: '16px 0 8px' }}>{t('loyalty.rewards')}</h3>
          <div className="row tight">
            {detail.data!.rewards.map((rw) => (
              <Button key={rw.id} size="sm" disabled={!rw.redeemable || !can('loyalty.redeem')} onClick={async () => { try { await post('/api/v1/loyalty/redeem', { guestId, rewardId: rw.id }); toast(t('common.saved'), 'success'); refresh(); } catch (e) { toast(errorMessage(e, t), 'error'); } }}>
                {rw.name} · {num(rw.pointsCost)}
              </Button>
            ))}
          </div>
          {can('loyalty.adjust') && (
            <div className="row" style={{ marginTop: 14, alignItems: 'flex-end' }}>
              <Field label={t('loyalty.adjust')}><Input type="number" value={adj.points} onChange={(e) => setAdj({ ...adj, points: e.target.value })} style={{ width: 120 }} /></Field>
              <Field label={t('loyalty.reason')} className="grow"><Input value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} /></Field>
              <Button variant="primary" disabled={!adj.points || !adj.reason} onClick={async () => { try { await post('/api/v1/loyalty/adjust', { guestId, points: Number(adj.points), reason: adj.reason }); setAdj({ points: '', reason: '' }); refresh(); } catch (e) { toast(errorMessage(e, t), 'error'); } }}>{t('common.apply')}</Button>
            </div>
          )}
          <h3 style={{ margin: '16px 0 8px' }}>{t('loyalty.history')}</h3>
          <table className="data"><tbody>{detail.data!.transactions.map((x) => <tr key={x.id}><td className="small">{dateTime(x.createdAt)}</td><td><Badge tone={x.points > 0 ? 'green' : 'red'}>{x.type}</Badge></td><td>{x.reason}</td><td className="r num">{x.points > 0 ? '+' : ''}{x.points}</td><td className="r num muted">{x.balanceAfter}</td></tr>)}</tbody></table>
        </Card>
      ) : <Card><Empty>{t('loyalty.findGuest')}</Empty></Card>}
    </div>
  );
}

function ProgramConfig() {
  const { t } = useTranslation();
  const toast = useToast();
  const { can } = useApp();
  const cfg = useQuery({ queryKey: ['loyalty-config'], queryFn: () => get<Config>('/api/v1/loyalty/config') });
  const [c, setC] = useState<Config | null>(null);
  useEffect(() => { if (cfg.data) setC(cfg.data); }, [cfg.data]);
  if (!c) return <Spinner />;
  const editable = can('loyalty.configure');
  const save = async () => {
    try {
      const clean = <T extends Record<string, unknown>>(rows: T[], keys: string[]) => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => keys.includes(k))));
      await put('/api/v1/loyalty/config', {
        enabled: c.enabled,
        pointsExpiryMonths: c.pointsExpiryMonths,
        tiers: clean(c.tiers, ['id', 'name', 'nameAr', 'minPoints', 'multiplier', 'color']).map((x) => ({ ...x, color: x.color || undefined, multiplier: Number(x.multiplier) })),
        rules: clean(c.rules, ['id', 'type', 'name', 'isActive', 'config']),
        rewards: clean(c.rewards, ['id', 'name', 'nameAr', 'type', 'pointsCost', 'value', 'isActive']).map((x) => ({ ...x, value: Number(x.value) })),
      });
      toast(t('common.saved'), 'success');
      void cfg.refetch();
    } catch (e) {
      toast(errorMessage(e, t), 'error');
    }
  };
  const upd = <K extends 'tiers' | 'rules' | 'rewards'>(k: K, i: number, patch: Partial<Config[K][number]>) => setC({ ...c, [k]: c[k].map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  return (
    <div className="stack">
      <Card title={t('loyalty.program')} actions={editable && <Button variant="primary" onClick={save}>{t('common.save')}</Button>}>
        <div className="row">
          <Check label={t('common.enabled')} checked={c.enabled} onChange={(v) => setC({ ...c, enabled: v })} disabled={!editable} />
          <Field label={t('loyalty.expiry')}><Input type="number" min={0} value={c.pointsExpiryMonths} onChange={(e) => setC({ ...c, pointsExpiryMonths: Number(e.target.value) })} disabled={!editable} style={{ width: 120 }} /></Field>
        </div>
      </Card>
      <Card title={t('loyalty.tiers')} actions={editable && <Button size="sm" icon="plus" onClick={() => setC({ ...c, tiers: [...c.tiers, { name: 'New tier', nameAr: '', minPoints: 0, multiplier: 1, color: '#C9A26B' }] })} />}>
        <table className="data"><thead><tr><th>{t('common.name')}</th><th>AR</th><th>{t('loyalty.minPoints')}</th><th>{t('loyalty.multiplier')}</th><th /></tr></thead><tbody>
          {c.tiers.map((x, i) => <tr key={x.id ?? i}><td><Input value={x.name} onChange={(e) => upd('tiers', i, { name: e.target.value })} /></td><td><Input dir="rtl" value={x.nameAr ?? ''} onChange={(e) => upd('tiers', i, { nameAr: e.target.value })} /></td><td><Input type="number" value={x.minPoints} onChange={(e) => upd('tiers', i, { minPoints: Number(e.target.value) })} /></td><td><Input type="number" step="0.05" value={x.multiplier} onChange={(e) => upd('tiers', i, { multiplier: Number(e.target.value) })} /></td><td><Button size="sm" variant="ghost" icon="trash" onClick={() => setC({ ...c, tiers: c.tiers.filter((_, j) => j !== i) })} /></td></tr>)}
        </tbody></table>
      </Card>
      <Card title={t('loyalty.rules')} actions={editable && <Button size="sm" icon="plus" onClick={() => setC({ ...c, rules: [...c.rules, { type: 'visit', name: 'New rule', isActive: true, config: { points: 10 } }] })} />}>
        <table className="data"><tbody>
          {c.rules.map((x, i) => (
            <tr key={x.id ?? i}>
              <td><Select value={x.type} onChange={(e) => upd('rules', i, { type: e.target.value })} options={LOYALTY_RULE_TYPES.map((r) => ({ value: r, label: r.replace(/_/g, ' ') }))} /></td>
              <td><Input value={x.name} onChange={(e) => upd('rules', i, { name: e.target.value })} /></td>
              <td><Input value={Object.entries(x.config).map(([k, v]) => `${k}=${v}`).join(', ')} onChange={(e) => upd('rules', i, { config: Object.fromEntries(e.target.value.split(',').map((p) => p.split('=').map((s) => s.trim())).filter((p) => p[0] && !Number.isNaN(Number(p[1]))).map(([k, v]) => [k, Number(v)])) })} /></td>
              <td><Check label="" checked={x.isActive} onChange={(v) => upd('rules', i, { isActive: v })} /></td>
              <td><Button size="sm" variant="ghost" icon="trash" onClick={() => setC({ ...c, rules: c.rules.filter((_, j) => j !== i) })} /></td>
            </tr>
          ))}
        </tbody></table>
        <p className="small muted">points_per_currency: currencyUnit, points · visit / birthday / referral: points · spend_threshold: threshold, points</p>
      </Card>
      <Card title={t('loyalty.rewards')} actions={editable && <Button size="sm" icon="plus" onClick={() => setC({ ...c, rewards: [...c.rewards, { name: 'New reward', nameAr: '', type: 'free_item', pointsCost: 500, value: 0, isActive: true }] })} />}>
        <table className="data"><tbody>
          {c.rewards.map((x, i) => (
            <tr key={x.id ?? i}>
              <td><Input value={x.name} onChange={(e) => upd('rewards', i, { name: e.target.value })} /></td>
              <td><Input dir="rtl" value={x.nameAr ?? ''} onChange={(e) => upd('rewards', i, { nameAr: e.target.value })} /></td>
              <td><Select value={x.type} onChange={(e) => upd('rewards', i, { type: e.target.value })} options={REWARD_TYPES.map((r) => ({ value: r, label: r.replace(/_/g, ' ') }))} /></td>
              <td><Input type="number" value={x.pointsCost} onChange={(e) => upd('rewards', i, { pointsCost: Number(e.target.value) })} /></td>
              <td><Input type="number" value={x.value} onChange={(e) => upd('rewards', i, { value: Number(e.target.value) })} /></td>
              <td><Check label="" checked={x.isActive} onChange={(v) => upd('rewards', i, { isActive: v })} /></td>
              <td><Button size="sm" variant="ghost" icon="trash" onClick={() => setC({ ...c, rewards: c.rewards.filter((_, j) => j !== i) })} /></td>
            </tr>
          ))}
        </tbody></table>
      </Card>
    </div>
  );
}

export default function LoyaltyPage() {
  const { t } = useTranslation();
  const online = useOnline();
  const [tab, setTab] = useState<'guests' | 'program'>('guests');
  if (!online) return <Empty>{t('common.requiresConnection')}</Empty>;
  return (
    <div className="stack lg">
      <div className="page-head"><h1>{t('loyalty.title')}</h1></div>
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'guests', label: t('loyalty.balance') }, { key: 'program', label: t('loyalty.program') }]} />
      {tab === 'guests' ? <GuestLoyalty /> : <ProgramConfig />}
    </div>
  );
}
