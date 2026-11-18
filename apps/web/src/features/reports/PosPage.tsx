import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { POS_PROVIDERS } from '@sofia/shared';
import { useApp } from '../../app/context';
import { api, errorMessage, get, patch, post } from '../../lib/api';
import { dateTime, money } from '../../lib/format';
import { Badge, Button, Card, Check, Empty, Field, Input, Modal, Select, Tabs, useToast } from '../../ui/kit';
import { useOnline } from '../common';

interface Connection { id: string; name: string; provider: string; isActive: boolean; branchId: string; config: Record<string, unknown>; lastSyncAt: string | null; lastError: string | null; apiKeySet: boolean; webhookSecretSet: boolean; webhookPath: string; pollIntervalMinutes: number }

export default function PosPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const online = useOnline();
  const qc = useQueryClient();
  const { can, branchId, settings } = useApp();
  const [tab, setTab] = useState<'invoices' | 'connections'>('invoices');
  const [unmatched, setUnmatched] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importFor, setImportFor] = useState<string | null>(null);
  const [form, setForm] = useState<{ id?: string; name: string; provider: string; baseUrl: string; invoicesPath: string; apiKey: string; webhookSecret: string; isActive: boolean; pollIntervalMinutes: number } | null>(null);
  const invoices = useQuery({ queryKey: ['invoices', unmatched], queryFn: () => get<{ items: { id: string; invoiceNumber: string | null; externalId: string; closedAt: string; tableLabel: string | null; total: number; currency: string; status: string; matchMethod: string; firstName: string | null; lastName: string | null; branchName: string }[]; total: number }>(`/api/v1/pos/invoices?pageSize=200${unmatched ? '&unmatched=true' : ''}`), enabled: online });
  const conns = useQuery({ queryKey: ['pos-conns'], queryFn: () => get<Connection[]>('/api/v1/pos/connections'), enabled: online });
  if (!online) return <Empty>{t('common.requiresConnection')}</Empty>;

  async function upload(file: File) {
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await api<{ inserted: number; updated: number; matched: number; errors: unknown[] }>('POST', `/api/v1/pos/connections/${importFor}/import`, fd, { timeoutMs: 120_000 });
      toast(`+${r.inserted} · ↻${r.updated} · ✓${r.matched}${r.errors.length ? ` · ✗${r.errors.length}` : ''}`, r.errors.length ? 'warning' : 'success');
      void qc.invalidateQueries({ queryKey: ['invoices'] });
    } catch (e) {
      toast(errorMessage(e, t), 'error');
    }
  }

  return (
    <div className="stack lg">
      <div className="page-head">
        <div><h1>{t('pos.title')}</h1><p>{invoices.data?.total ?? 0} {t('pos.invoices')}</p></div>
        {can('pos.manage') && <Button variant="primary" icon="plus" onClick={() => setForm({ name: 'POS', provider: 'webhook', baseUrl: '', invoicesPath: 'invoices', apiKey: '', webhookSecret: '', isActive: true, pollIntervalMinutes: 5 })}>{t('pos.connections')}</Button>}
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'invoices', label: t('pos.invoices') }, { key: 'connections', label: t('pos.connections') }]} />
      {tab === 'invoices' ? (
        <Card flush title={<div style={{ padding: '12px 18px 0' }}><Check label={t('pos.unmatched')} checked={unmatched} onChange={setUnmatched} /></div>}>
          {invoices.data?.items.length ? (
            <table className="data">
              <thead><tr><th>{t('common.date')}</th><th>#</th><th>{t('common.table')}</th><th>{t('res.guest')}</th><th>{t('pos.matchedBy')}</th><th className="r">{t('common.total')}</th></tr></thead>
              <tbody>{invoices.data.items.map((i) => <tr key={i.id}><td className="small">{dateTime(i.closedAt)}</td><td className="code">{i.invoiceNumber ?? i.externalId}</td><td>{i.tableLabel ?? '—'}</td><td>{i.firstName ? `${i.firstName} ${i.lastName ?? ''}` : <span className="muted">—</span>}</td><td><Badge tone={i.matchMethod === 'none' ? undefined : 'green'}>{i.matchMethod}</Badge></td><td className="r num">{money(i.total, i.currency)}</td></tr>)}</tbody>
            </table>
          ) : <Empty />}
        </Card>
      ) : (
        <div className="grid cols-2">
          {(conns.data ?? []).map((c) => (
            <Card key={c.id} title={c.name} actions={<Badge tone={c.isActive ? 'green' : undefined}>{c.provider}</Badge>}>
              <dl className="kv">
                <dt>{t('sync.lastSync')}</dt><dd>{c.lastSyncAt ? dateTime(c.lastSyncAt) : '—'}</dd>
                {c.lastError && (<><dt>⚠</dt><dd className="small" style={{ color: 'var(--s-danger)' }}>{c.lastError}</dd></>)}
                {c.provider === 'webhook' && (<><dt>{t('pos.webhookUrl')}</dt><dd className="code small">{location.origin}{c.webhookPath}</dd></>)}
                {c.provider === 'generic_rest' && (<><dt>URL</dt><dd className="code small">{String(c.config.baseUrl ?? '')}</dd></>)}
              </dl>
              {can('pos.manage') && (
                <div className="row tight" style={{ marginTop: 12 }}>
                  <Button size="sm" onClick={async () => { const r = await post<{ ok: boolean; message: string }>(`/api/v1/pos/connections/${c.id}/test`); toast(r.message, r.ok ? 'success' : 'error'); }}>{t('pos.test')}</Button>
                  {c.provider === 'generic_rest' && <Button size="sm" onClick={async () => { try { const r = await post<{ inserted: number; matched: number }>(`/api/v1/pos/connections/${c.id}/sync`); toast(`+${r.inserted} ✓${r.matched}`, 'success'); void qc.invalidateQueries({ queryKey: ['invoices'] }); } catch (e) { toast(errorMessage(e, t), 'error'); } }}>{t('pos.syncNow')}</Button>}
                  <Button size="sm" icon="upload" onClick={() => { setImportFor(c.id); fileRef.current?.click(); }}>{t('pos.importCsv')}</Button>
                  <Button size="sm" icon="edit" onClick={() => setForm({ id: c.id, name: c.name, provider: c.provider, baseUrl: String(c.config.baseUrl ?? ''), invoicesPath: String(c.config.invoicesPath ?? 'invoices'), apiKey: '', webhookSecret: '', isActive: c.isActive, pollIntervalMinutes: c.pollIntervalMinutes })} />
                </div>
              )}
            </Card>
          ))}
          {!conns.data?.length && <Empty />}
        </div>
      )}
      <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
      {form && (
        <Modal title={t('pos.connections')} onClose={() => setForm(null)} footer={<><Button onClick={() => setForm(null)}>{t('common.cancel')}</Button><Button variant="primary" onClick={async () => {
          const body = { name: form.name, provider: form.provider, isActive: form.isActive, pollIntervalMinutes: form.pollIntervalMinutes, config: { baseUrl: form.baseUrl || undefined, invoicesPath: form.invoicesPath || undefined, apiKey: form.apiKey || undefined, webhookSecret: form.webhookSecret || undefined, currency: settings.general.primaryCurrency } };
          try {
            if (form.id) await patch(`/api/v1/pos/connections/${form.id}`, body);
            else await post('/api/v1/pos/connections', { ...body, branchId });
            setForm(null);
            void qc.invalidateQueries({ queryKey: ['pos-conns'] });
          } catch (e) { toast(errorMessage(e, t), 'error'); }
        }}>{t('common.save')}</Button></>}>
          <div className="form-grid">
            <Field label={t('common.name')}><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Provider"><Select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} options={POS_PROVIDERS.map((p) => ({ value: p, label: p }))} /></Field>
            {form.provider === 'generic_rest' && <Field label="Base URL"><Input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://pos.local/api" /></Field>}
            {form.provider === 'generic_rest' && <Field label="Invoices path"><Input value={form.invoicesPath} onChange={(e) => setForm({ ...form, invoicesPath: e.target.value })} /></Field>}
            {form.provider === 'generic_rest' && <Field label="API key" hint={t('settings.secretSet')}><Input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /></Field>}
            {form.provider === 'webhook' && <Field label="Webhook secret (HMAC-SHA256)" hint={t('settings.secretSet')}><Input type="password" value={form.webhookSecret} onChange={(e) => setForm({ ...form, webhookSecret: e.target.value })} /></Field>}
            {form.provider === 'generic_rest' && <Field label="Poll (min)"><Input type="number" min={1} value={form.pollIntervalMinutes} onChange={(e) => setForm({ ...form, pollIntervalMinutes: Number(e.target.value) })} /></Field>}
          </div>
          <div style={{ marginTop: 12 }}><Check label={t('settings.active')} checked={form.isActive} onChange={(v) => setForm({ ...form, isActive: v })} /></div>
        </Modal>
      )}
    </div>
  );
}
