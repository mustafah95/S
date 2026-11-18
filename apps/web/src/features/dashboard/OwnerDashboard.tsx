import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { addDays } from '@sofia/shared';
import { useApp } from '../../app/context';
import { get } from '../../lib/api';
import { dateLabel, money, num, pct } from '../../lib/format';
import { BarList, ColumnChart, LineChart } from '../../ui/charts';
import { Badge, Card, Empty, Seg, Spinner, Stat } from '../../ui/kit';
import { useBranchContext, useOnline } from '../common';

type Range = '7' | '30' | 'month';

interface Owner {
  reservations: number; covers: number; walkIns: number; revenue: number; invoices: number; averageCheck: number; revenuePerCover: number;
  occupancyRate: number; noShowRate: number; cancellationRate: number; vipRevenue: number; newCustomers: number; returningCustomers: number;
  retentionRate: number; tableUtilization: number; marketing: { campaigns: number; cost: number; attributedRevenue: number; roi: number | null };
  series: { date: string; reservations: number; covers: number; revenue: number }[];
}

export default function OwnerDashboard() {
  const { t } = useTranslation();
  const online = useOnline();
  const { settings, profile } = useApp();
  const { today } = useBranchContext();
  const [range, setRange] = useState<Range>('30');
  const [scope, setScope] = useState<string>('all');
  const from = range === 'month' ? `${today.slice(0, 8)}01` : addDays(today, -Number(range) + 1);
  const qs = `from=${from}&to=${today}${scope !== 'all' ? `&branchId=${scope}` : ''}`;
  const cur = settings.general.primaryCurrency;
  const owner = useQuery({ queryKey: ['owner', qs], queryFn: () => get<Owner>(`/api/v1/analytics/owner?${qs}`), enabled: online });
  const resA = useQuery({ queryKey: ['res-analytics', qs], queryFn: () => get<{ perHour: { hour: number; reservations: number }[]; partySizes: { partySize: number; reservations: number }[]; sources: { source: string; reservations: number }[] }>(`/api/v1/analytics/reservations?${qs}`), enabled: online });
  const guestsA = useQuery({ queryKey: ['guest-analytics', qs], queryFn: () => get<{ counts: Record<string, number>; topGuests: { id: string; firstName: string; lastName: string | null; vipLevel: string; visitCount: number; totalSpend: number }[] }>(`/api/v1/analytics/guests?${qs}`), enabled: online });
  const tablesA = useQuery({ queryKey: ['table-analytics', qs], queryFn: () => get<{ id: string; label: string; area: string; seatings: number; turnoverPerDay: number; utilization: number; revenue: number; revenuePerSeat: number }[]>(`/api/v1/analytics/tables?${qs}`), enabled: online });

  if (!online) return <Empty>{t('common.requiresConnection')}</Empty>;
  const o = owner.data;
  return (
    <div className="stack lg">
      <div className="page-head">
        <div>
          <h1>{t('dash.owner')}</h1>
          <p>{dateLabel(from)} – {dateLabel(today)}</p>
        </div>
        <div className="row">
          {profile.branches.length > 1 && (
            <select className="input" style={{ width: 'auto' }} value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="all">{t('common.all')}</option>
              {profile.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          )}
          <Seg value={range} onChange={setRange} options={[{ value: '7', label: t('dash.last7') }, { value: '30', label: t('dash.last30') }, { value: 'month', label: t('dash.thisMonth') }]} />
        </div>
      </div>
      {!o ? <Spinner /> : (
        <>
          <div className="grid cols-4">
            <Stat label={t('dash.revenue')} value={money(o.revenue, cur)} sub={`${num(o.invoices)} invoices`} />
            <Stat label={t('dash.avgCheck')} value={money(o.averageCheck, cur)} sub={`${t('dash.revenuePerCover')}: ${money(o.revenuePerCover, cur)}`} />
            <Stat label={t('dash.reservations')} value={num(o.reservations)} sub={`${num(o.covers)} ${t('dash.covers')} · ${num(o.walkIns)} ${t('dash.walkIns')}`} />
            <Stat label={t('dash.occupancy')} value={pct(o.occupancyRate)} sub={`${t('dash.utilization')}: ${pct(o.tableUtilization)}`} />
          </div>
          <div className="grid cols-4">
            <Stat label={t('dash.noShowRate')} value={pct(o.noShowRate)} />
            <Stat label={t('dash.cancellationRate')} value={pct(o.cancellationRate)} />
            <Stat label={t('dash.vipRevenue')} value={money(o.vipRevenue, cur)} sub={o.revenue ? pct((o.vipRevenue / o.revenue) * 100) : undefined} />
            <Stat label={t('dash.marketingRoi')} value={o.marketing.roi === null ? '—' : pct(o.marketing.roi)} sub={`${money(o.marketing.attributedRevenue, cur)} / ${money(o.marketing.cost, cur)}`} />
          </div>
          <div className="grid cols-3">
            <Stat label={t('dash.newGuests')} value={num(o.newCustomers)} />
            <Stat label={t('dash.returning')} value={num(o.returningCustomers)} />
            <Stat label={t('dash.retention')} value={pct(o.retentionRate)} />
          </div>
          <div className="grid cols-2">
            <Card title={`${t('dash.revenue')} · ${t('dash.trend')}`}>
              <ColumnChart data={o.series.map((d) => ({ label: String(d.date).slice(8, 10), title: dateLabel(String(d.date)), value: d.revenue }))} format={(v) => money(v, cur)} tableCaption={t('common.details')} />
            </Card>
            <Card title={`${t('dash.covers')} · ${t('dash.trend')}`}>
              <LineChart data={o.series.map((d) => ({ label: String(d.date).slice(8, 10), title: dateLabel(String(d.date)), value: d.covers }))} format={(v) => num(v)} tableCaption={t('common.details')} />
            </Card>
          </div>
        </>
      )}
      {resA.data && (
        <div className="grid cols-3">
          <Card title={t('dash.byHour')}><ColumnChart height={180} data={resA.data.perHour.map((h) => ({ label: String(h.hour).padStart(2, '0'), value: h.reservations }))} tableCaption={t('common.details')} /></Card>
          <Card title={t('dash.partySizes')}><ColumnChart height={180} data={resA.data.partySizes.map((p) => ({ label: String(p.partySize), value: p.reservations }))} tableCaption={t('common.details')} /></Card>
          <Card title={t('dash.sources')}><BarList data={resA.data.sources.map((s) => ({ label: s.source, title: t(`source.${s.source}`), value: s.reservations }))} /></Card>
        </div>
      )}
      <div className="grid cols-2">
        {guestsA.data && (
          <Card title={t('dash.topGuests')} flush>
            <table className="data">
              <tbody>
                {guestsA.data.topGuests.slice(0, 10).map((g) => (
                  <tr key={g.id}><td>{g.firstName} {g.lastName ?? ''} {g.vipLevel !== 'standard' && <Badge tone="vip">{t(`vip.${g.vipLevel}`)}</Badge>}</td><td className="r num">{g.visitCount}</td><td className="r num">{money(g.totalSpend, cur)}</td></tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
        {tablesA.data && (
          <Card title={t('dash.tablePerf')} flush>
            <table className="data">
              <thead><tr><th>{t('common.table')}</th><th className="r">{t('dash.seatings')}</th><th className="r">{t('dash.turnover')}</th><th className="r">{t('dash.utilization')}</th><th className="r">{t('dash.revenue')}</th><th className="r">{t('dash.revenuePerSeat')}</th></tr></thead>
              <tbody>
                {tablesA.data.map((tb) => (
                  <tr key={tb.id}><td>{tb.label} <span className="small muted">{tb.area}</span></td><td className="r num">{tb.seatings}</td><td className="r num">{tb.turnoverPerDay}</td><td className="r num">{pct(tb.utilization)}</td><td className="r num">{money(tb.revenue, cur)}</td><td className="r num">{money(tb.revenuePerSeat, cur)}</td></tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </div>
  );
}
