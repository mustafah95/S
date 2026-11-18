import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CHANNELS, SEGMENT_FIELDS, TEMPLATE_KEYS } from '@sofia/shared';
import { useApp } from '../../app/context';
import { errorMessage, get, post, put } from '../../lib/api';
import { dateTime, money, num, pct } from '../../lib/format';
import { Badge, Button, Card, Confirm, Empty, Field, Input, Modal, Select, StatusBadge, Tabs, Textarea, useToast } from '../../ui/kit';
import { useOnline } from '../common';

interface Segment { id: string; key: string; name: string; nameAr: string | null; description: string | null; isSystem: boolean; size: number; consentedSize: number }
interface Campaign { id: string; name: string; segmentKey: string; segmentName: string | null; channel: string; status: string; body: string; cost: number; sentAt: string | null; scheduledAt: string | null; stats: Record<string, number> }

function CampaignStats({ id }: { id: string }) {
  const { t } = useTranslation();
  const { settings } = useApp();
  const s = useQuery({ queryKey: ['campaign-stats', id], queryFn: () => get<{ delivery: Record<string, number>; attributedVisits: number; attributedRevenue: number; roi: number | null }>(`/api/v1/campaigns/${id}/stats`) });
  if (!s.data) return null;
  return (
    <span className="small muted">
      {Object.entries(s.data.delivery).map(([k, v]) => `${k}: ${v}`).join(' · ')} · {t('mkt.attributed')}: {money(s.data.attributedRevenue, settings.general.primaryCurrency)} · {t('mkt.roi')}: {s.data.roi === null ? '—' : pct(s.data.roi)}
    </span>
  );
}

export default function MarketingPage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const online = useOnline();
  const qc = useQueryClient();
  const { can } = useApp();
  const [tab, setTab] = useState<'campaigns' | 'segments' | 'templates' | 'outbox'>('campaigns');
  const segments = useQuery({ queryKey: ['segments'], queryFn: () => get<Segment[]>('/api/v1/segments'), enabled: online });
  const campaigns = useQuery({ queryKey: ['campaigns'], queryFn: () => get<Campaign[]>('/api/v1/campaigns'), enabled: online });
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => get<{ id: string; key: string; channel: string; language: string; subject: string | null; body: string; providerTemplateName: string | null; isActive: boolean }[]>('/api/v1/notification-templates'), enabled: online && tab === 'templates' });
  const outbox = useQuery({ queryKey: ['outbox'], queryFn: () => get<{ id: string; channel: string; recipient: string; templateKey: string; status: string; lastError: string | null; createdAt: string; firstName: string | null }[]>('/api/v1/notifications/outbox'), enabled: online && tab === 'outbox' });
  const [newCampaign, setNewCampaign] = useState<{ name: string; segmentKey: string; channel: string; body: string; cost: number; language: string } | null>(null);
  const [newSegment, setNewSegment] = useState<{ name: string; match: 'all' | 'any'; rules: { field: string; op: string; value: string }[] } | null>(null);
  const [sending, setSending] = useState<Campaign | null>(null);
  const [preview, setPreview] = useState<Segment | null>(null);
  const previewQ = useQuery({ queryKey: ['segment-preview', preview?.id], queryFn: () => get<{ id: string; firstName: string; lastName: string | null; vipLevel: string; visitCount: number; totalSpend: number; marketingConsent: boolean }[]>(`/api/v1/segments/${preview!.id}/preview`), enabled: !!preview });
  const [tpl, setTpl] = useState<{ key: string; channel: string; language: string; subject: string; body: string; providerTemplateName: string } | null>(null);
  if (!online) return <Empty>{t('common.requiresConnection')}</Empty>;
  const segName = (s: Segment) => (i18n.language === 'ar' && s.nameAr ? s.nameAr : s.name);

  return (
    <div className="stack lg">
      <div className="page-head">
        <h1>{t('mkt.title')}</h1>
        <div className="row">
          {can('marketing.manage') && <Button icon="plus" onClick={() => setNewSegment({ name: '', match: 'all', rules: [{ field: 'visit_count', op: 'gte', value: '3' }] })}>{t('mkt.newSegment')}</Button>}
          {can('marketing.manage') && <Button variant="primary" icon="plus" onClick={() => setNewCampaign({ name: '', segmentKey: 'vip', channel: 'whatsapp', body: '', cost: 0, language: 'guest' })}>{t('mkt.newCampaign')}</Button>}
        </div>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'campaigns', label: t('mkt.campaigns') }, { key: 'segments', label: t('mkt.segments') }, { key: 'templates', label: t('mkt.templates') }, { key: 'outbox', label: t('mkt.outbox') }]} />
      {tab === 'segments' && (
        <div className="grid cols-3">
          {(segments.data ?? []).map((s) => (
            <Card key={s.id} title={segName(s)} actions={<Button size="sm" variant="ghost" onClick={() => setPreview(s)}>{t('mkt.preview')}</Button>}>
              <div className="stat"><span className="value">{num(s.size)}</span><span className="sub">{num(s.consentedSize)} {t('mkt.consented')}</span></div>
              {s.description && <p className="small muted" style={{ marginBottom: 0 }}>{s.description}</p>}
            </Card>
          ))}
        </div>
      )}
      {tab === 'campaigns' && (
        <Card flush>
          {campaigns.data?.length ? (
            <table className="data">
              <thead><tr><th>{t('common.name')}</th><th>{t('mkt.audience')}</th><th>{t('mkt.channel')}</th><th>{t('common.status')}</th><th>{t('mkt.sent')}</th><th /></tr></thead>
              <tbody>
                {campaigns.data.map((c) => (
                  <tr key={c.id}>
                    <td><strong>{c.name}</strong><div className="small muted">{c.body.slice(0, 80)}</div>{c.status === 'sent' && <CampaignStats id={c.id} />}</td>
                    <td>{c.segmentName ?? c.segmentKey}</td>
                    <td><Badge>{c.channel}</Badge></td>
                    <td><StatusBadge status={c.status} /></td>
                    <td className="small">{c.sentAt ? dateTime(c.sentAt) : c.scheduledAt ? `⏱ ${dateTime(c.scheduledAt)}` : '—'}</td>
                    <td>{['draft', 'scheduled'].includes(c.status) && can('marketing.send') && <Button size="sm" variant="primary" onClick={() => setSending(c)}>{t('mkt.sendNow')}</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty />}
        </Card>
      )}
      {tab === 'templates' && (
        <Card flush>
          <table className="data">
            <tbody>
              {(templates.data ?? []).map((x) => (
                <tr key={x.id} className="click" onClick={() => can('notifications.manage') && setTpl({ key: x.key, channel: x.channel, language: x.language, subject: x.subject ?? '', body: x.body, providerTemplateName: x.providerTemplateName ?? '' })}>
                  <td className="code small">{x.key}</td><td><Badge>{x.channel}</Badge></td><td>{x.language}</td><td className="small" dir={x.language === 'ar' ? 'rtl' : 'ltr'}>{x.body.slice(0, 120)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {tab === 'outbox' && (
        <Card flush>
          <table className="data">
            <tbody>
              {(outbox.data ?? []).map((m) => (
                <tr key={m.id}><td className="small">{dateTime(m.createdAt)}</td><td>{m.firstName}</td><td className="code small">{m.recipient}</td><td><Badge>{m.channel}</Badge></td><td className="code small">{m.templateKey}</td><td><Badge tone={m.status === 'sent' ? 'green' : m.status === 'failed' ? 'red' : 'amber'}>{m.status}</Badge></td><td className="small muted">{m.lastError}</td></tr>
              ))}
            </tbody>
          </table>
          {!outbox.data?.length && <Empty />}
        </Card>
      )}

      {newCampaign && (
        <Modal title={t('mkt.newCampaign')} onClose={() => setNewCampaign(null)} footer={<><Button onClick={() => setNewCampaign(null)}>{t('common.cancel')}</Button><Button variant="primary" disabled={!newCampaign.name || !newCampaign.body} onClick={async () => { try { await post('/api/v1/campaigns', newCampaign); setNewCampaign(null); void qc.invalidateQueries({ queryKey: ['campaigns'] }); } catch (e) { toast(errorMessage(e, t), 'error'); } }}>{t('common.save')}</Button></>}>
          <div className="stack">
            <Field label={t('common.name')}><Input value={newCampaign.name} onChange={(e) => setNewCampaign({ ...newCampaign, name: e.target.value })} /></Field>
            <div className="form-grid">
              <Field label={t('mkt.audience')}><Select value={newCampaign.segmentKey} onChange={(e) => setNewCampaign({ ...newCampaign, segmentKey: e.target.value })} options={(segments.data ?? []).map((s) => ({ value: s.key, label: `${segName(s)} (${s.consentedSize})` }))} /></Field>
              <Field label={t('mkt.channel')}><Select value={newCampaign.channel} onChange={(e) => setNewCampaign({ ...newCampaign, channel: e.target.value })} options={CHANNELS.filter((c) => c !== 'push').map((c) => ({ value: c, label: c }))} /></Field>
              <Field label={t('common.language')}><Select value={newCampaign.language} onChange={(e) => setNewCampaign({ ...newCampaign, language: e.target.value })} options={[{ value: 'guest', label: '—' }, { value: 'ar', label: 'العربية' }, { value: 'en', label: 'English' }]} /></Field>
              <Field label={t('mkt.cost')}><Input type="number" min={0} value={newCampaign.cost} onChange={(e) => setNewCampaign({ ...newCampaign, cost: Number(e.target.value) })} /></Field>
            </div>
            <Field label={t('mkt.message')} hint="{{guest_name}} {{restaurant}} {{opt_out_url}}"><Textarea value={newCampaign.body} onChange={(e) => setNewCampaign({ ...newCampaign, body: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
      {newSegment && (
        <Modal title={t('mkt.newSegment')} onClose={() => setNewSegment(null)} footer={<><Button onClick={() => setNewSegment(null)}>{t('common.cancel')}</Button><Button variant="primary" onClick={async () => { try { await post('/api/v1/segments', { name: newSegment.name, match: newSegment.match, rules: newSegment.rules.map((r) => ({ ...r, value: r.op === 'in' ? r.value.split(',').map((v) => v.trim()) : Number.isNaN(Number(r.value)) ? r.value : Number(r.value) })) }); setNewSegment(null); void qc.invalidateQueries({ queryKey: ['segments'] }); } catch (e) { toast(errorMessage(e, t), 'error'); } }}>{t('common.save')}</Button></>}>
          <div className="stack">
            <div className="form-grid">
              <Field label={t('common.name')}><Input value={newSegment.name} onChange={(e) => setNewSegment({ ...newSegment, name: e.target.value })} /></Field>
              <Field label={t('mkt.match')}><Select value={newSegment.match} onChange={(e) => setNewSegment({ ...newSegment, match: e.target.value as 'all' | 'any' })} options={[{ value: 'all', label: t('mkt.matchAll') }, { value: 'any', label: t('mkt.matchAny') }]} /></Field>
            </div>
            {newSegment.rules.map((r, i) => (
              <div key={i} className="row">
                <Select value={r.field} onChange={(e) => setNewSegment({ ...newSegment, rules: newSegment.rules.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)) })} options={SEGMENT_FIELDS.map((f) => ({ value: f, label: f.replace(/_/g, ' ') }))} />
                <Select value={r.op} onChange={(e) => setNewSegment({ ...newSegment, rules: newSegment.rules.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)) })} options={['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains'].map((o) => ({ value: o, label: o }))} />
                <Input value={r.value} onChange={(e) => setNewSegment({ ...newSegment, rules: newSegment.rules.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
                <Button size="sm" variant="ghost" icon="trash" onClick={() => setNewSegment({ ...newSegment, rules: newSegment.rules.filter((_, j) => j !== i) })} />
              </div>
            ))}
            <Button size="sm" icon="plus" onClick={() => setNewSegment({ ...newSegment, rules: [...newSegment.rules, { field: 'total_spend', op: 'gte', value: '0' }] })}>{t('mkt.rules')}</Button>
          </div>
        </Modal>
      )}
      {sending && <Confirm text={t('mkt.confirmSend')} onClose={() => setSending(null)} onConfirm={async () => { try { const r = await post<{ queued: number; skipped: number }>(`/api/v1/campaigns/${sending.id}/send`); toast(`✓ ${r.queued} · ✗ ${r.skipped}`, 'success'); void qc.invalidateQueries({ queryKey: ['campaigns'] }); } catch (e) { toast(errorMessage(e, t), 'error'); } }} />}
      {preview && (
        <Modal wide title={segName(preview)} onClose={() => setPreview(null)}>
          <table className="data"><tbody>{(previewQ.data ?? []).map((g) => <tr key={g.id}><td>{g.firstName} {g.lastName ?? ''}</td><td>{t(`vip.${g.vipLevel}`)}</td><td className="r num">{g.visitCount}</td><td className="r num">{num(g.totalSpend)}</td><td>{g.marketingConsent ? '✓' : '✗'}</td></tr>)}</tbody></table>
        </Modal>
      )}
      {tpl && (
        <Modal title={`${tpl.key} · ${tpl.channel} · ${tpl.language}`} onClose={() => setTpl(null)} footer={<><Button onClick={() => setTpl(null)}>{t('common.cancel')}</Button><Button variant="primary" onClick={async () => { try { await put('/api/v1/notification-templates', { ...tpl, subject: tpl.subject || null, providerTemplateName: tpl.providerTemplateName || null, isActive: true }); setTpl(null); void qc.invalidateQueries({ queryKey: ['templates'] }); } catch (e) { toast(errorMessage(e, t), 'error'); } }}>{t('common.save')}</Button></>}>
          <div className="stack">
            <Field label="Key"><Select value={tpl.key} onChange={(e) => setTpl({ ...tpl, key: e.target.value })} options={TEMPLATE_KEYS.map((k) => ({ value: k, label: k }))} /></Field>
            {tpl.channel === 'email' && <Field label="Subject"><Input value={tpl.subject} onChange={(e) => setTpl({ ...tpl, subject: e.target.value })} /></Field>}
            {tpl.channel === 'whatsapp' && <Field label="WhatsApp approved template name" hint="Required for messages outside the 24-hour customer-care window"><Input value={tpl.providerTemplateName} onChange={(e) => setTpl({ ...tpl, providerTemplateName: e.target.value })} /></Field>}
            <Field label={t('mkt.message')}><Textarea dir={tpl.language === 'ar' ? 'rtl' : 'ltr'} value={tpl.body} onChange={(e) => setTpl({ ...tpl, body: e.target.value })} style={{ minHeight: 140 }} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
