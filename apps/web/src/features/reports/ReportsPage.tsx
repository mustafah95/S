import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays } from '@sofia/shared';
import { useApp } from '../../app/context';
import { del, download, errorMessage, get, post } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { currentLang } from '../../i18n';
import { Button, Card, Check, Empty, Field, Input, Select, useToast } from '../../ui/kit';
import { useBranchContext, useOnline } from '../common';

interface Dataset { key: string; label: string; labelAr?: string; columns: { key: string; label: string; labelAr?: string; type: string }[] }
interface Result { headers: { key: string; label: string; labelAr?: string }[]; rows: Record<string, unknown>[]; dataset: string; datasetAr?: string }

/** Column and dataset names in the interface language (the server provides English and Arabic). */
const localise = <T extends { label: string; labelAr?: string }>(x: T): T => (currentLang() === 'ar' && x.labelAr ? { ...x, label: x.labelAr } : x);

const fmt = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'number' ? v.toLocaleString() : typeof v === 'boolean' ? (v ? '✓' : '') : String(v).replace(/T.*Z$/, ''));

export default function ReportsPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const online = useOnline();
  const qc = useQueryClient();
  const { can, settings } = useApp();
  const { today } = useBranchContext();
  const datasets = useQuery({
    queryKey: ['datasets', currentLang()],
    queryFn: async () => (await get<Dataset[]>('/api/v1/reports/datasets')).map((d) => ({ ...localise(d), columns: d.columns.map(localise) })),
    enabled: online,
  });
  const saved = useQuery({ queryKey: ['saved-reports'], queryFn: () => get<{ id: string; name: string; definition: Record<string, unknown> }[]>('/api/v1/reports/saved'), enabled: online });
  const [def, setDef] = useState({ dataset: 'reservations', columns: [] as string[], groupBy: '' as string, agg: '' as string, from: addDays(today, -30), to: today, filterCol: '', filterVal: '' });
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const ds = datasets.data?.find((d) => d.key === def.dataset);
  useEffect(() => {
    if (ds && !def.columns.length) setDef((d) => ({ ...d, columns: ds.columns.slice(0, 6).map((c) => c.key) }));
  }, [ds, def.columns.length]);
  if (!online) return <Empty>{t('common.requiresConnection')}</Empty>;

  const body = () => ({
    dataset: def.dataset,
    columns: def.columns.length ? def.columns : [ds?.columns[0]?.key ?? 'code'],
    groupBy: def.groupBy ? [def.groupBy] : [],
    aggregates: def.groupBy && def.agg ? [{ column: def.agg, fn: 'sum' }] : [],
    filters: def.filterCol && def.filterVal ? [{ column: def.filterCol, op: 'contains', value: def.filterVal }] : [],
    sort: def.groupBy ? { column: 'count', dir: 'desc' } : undefined,
    from: def.from,
    to: def.to,
    limit: 5000,
  });
  const run = async () => {
    setBusy(true);
    try {
      const r = await post<Result>('/api/v1/reports/run', body());
      setResult({ ...r, dataset: currentLang() === 'ar' && r.datasetAr ? r.datasetAr : r.dataset, headers: r.headers.map(localise) });
    } catch (e) {
      toast(errorMessage(e, t), 'error');
    } finally {
      setBusy(false);
    }
  };
  const numeric = ds?.columns.filter((c) => c.type === 'number') ?? [];

  return (
    <div className="stack lg">
      <div className="page-head no-print">
        <h1>{t('reports.title')}</h1>
        {saved.data && saved.data.length > 0 && (
          <Select value="" onChange={(e) => { const s = saved.data!.find((x) => x.id === e.target.value); if (s) { const d = s.definition as { dataset: string; columns: string[]; groupBy?: string[]; from?: string; to?: string }; setDef({ ...def, dataset: d.dataset, columns: d.columns, groupBy: d.groupBy?.[0] ?? '', from: d.from ?? def.from, to: d.to ?? def.to }); } }} options={[{ value: '', label: t('reports.saved') }, ...saved.data.map((s) => ({ value: s.id, label: s.name }))]} />
        )}
      </div>
      <Card className="no-print">
        <div className="stack">
          <div className="form-grid">
            <Field label={t('reports.dataset')}><Select value={def.dataset} onChange={(e) => { setDef({ ...def, dataset: e.target.value, columns: [], groupBy: '', agg: '', filterCol: '' }); setResult(null); }} options={(datasets.data ?? []).map((d) => ({ value: d.key, label: d.label }))} /></Field>
            <Field label={t('common.from')}><Input type="date" value={def.from} onChange={(e) => setDef({ ...def, from: e.target.value })} /></Field>
            <Field label={t('common.to')}><Input type="date" value={def.to} onChange={(e) => setDef({ ...def, to: e.target.value })} /></Field>
            <Field label={t('reports.groupBy')}><Select value={def.groupBy} onChange={(e) => setDef({ ...def, groupBy: e.target.value })} options={[{ value: '', label: '—' }, ...(ds?.columns ?? []).filter((c) => c.type !== 'number').map((c) => ({ value: c.key, label: c.label }))]} /></Field>
            {def.groupBy && numeric.length > 0 && <Field label="Σ"><Select value={def.agg} onChange={(e) => setDef({ ...def, agg: e.target.value })} options={[{ value: '', label: '—' }, ...numeric.map((c) => ({ value: c.key, label: c.label }))]} /></Field>}
            <Field label={t('reports.filters')}><Select value={def.filterCol} onChange={(e) => setDef({ ...def, filterCol: e.target.value })} options={[{ value: '', label: '—' }, ...(ds?.columns ?? []).map((c) => ({ value: c.key, label: c.label }))]} /></Field>
            {def.filterCol && <Field label="≈"><Input value={def.filterVal} onChange={(e) => setDef({ ...def, filterVal: e.target.value })} /></Field>}
          </div>
          {!def.groupBy && (
            <div>
              <div className="small muted" style={{ marginBottom: 6 }}>{t('reports.columns')}</div>
              <div className="row">
                {(ds?.columns ?? []).map((c) => <Check key={c.key} label={c.label} checked={def.columns.includes(c.key)} onChange={(v) => setDef({ ...def, columns: v ? [...def.columns, c.key] : def.columns.filter((x) => x !== c.key) })} />)}
              </div>
            </div>
          )}
          <div className="row">
            <Button variant="primary" busy={busy} onClick={run}>{t('reports.run')}</Button>
            {result && can('reports.export') && (
              <>
                <Button icon="download" onClick={() => void download('POST', '/api/v1/reports/export', { ...body(), format: 'xlsx' })}>Excel</Button>
                <Button icon="download" onClick={() => void download('POST', '/api/v1/reports/export', { ...body(), format: 'csv' })}>CSV</Button>
                <Button icon="download" onClick={() => void download('POST', '/api/v1/reports/export', { ...body(), format: 'pdf', language: currentLang() })}>PDF</Button>
                <Button icon="print" variant="ghost" onClick={() => window.print()} aria-label={t('common.print')} />
              </>
            )}
            {result && <Button variant="ghost" onClick={async () => { const name = prompt(t('reports.saveAs')); if (name) { await post('/api/v1/reports/saved', { name, definition: body() }); void qc.invalidateQueries({ queryKey: ['saved-reports'] }); } }}>{t('reports.saveAs')}</Button>}
          </div>
        </div>
      </Card>
      {result && (
        <Card flush>
          <div className="print-only" style={{ padding: 18 }}>
            <img src="/brand/sofia-logo-burgundy.png" alt="" style={{ height: 56 }} />
            <h2>{settings.branding.restaurantName} — {result.dataset}</h2>
            <p className="small">{def.from} → {def.to} · {dateTime(new Date())}</p>
          </div>
          <div className="row between no-print" style={{ padding: '12px 18px 0' }}><strong>{result.dataset}</strong><span className="muted small">{result.rows.length} {t('reports.rows')}</span></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr>{result.headers.map((h) => <th key={h.key}>{h.label}</th>)}</tr></thead>
              <tbody>{result.rows.map((r, i) => <tr key={i}>{result.headers.map((h) => <td key={h.key} className={typeof r[h.key] === 'number' ? 'r num' : ''}>{fmt(r[h.key])}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </Card>
      )}
      {saved.data && saved.data.length > 0 && (
        <Card title={t('reports.saved')} className="no-print">
          {saved.data.map((s) => <div key={s.id} className="list-item"><span className="grow">{s.name}</span><Button size="sm" variant="ghost" icon="trash" onClick={async () => { await del(`/api/v1/reports/saved/${s.id}`); void qc.invalidateQueries({ queryKey: ['saved-reports'] }); }} /></div>)}
        </Card>
      )}
    </div>
  );
}
