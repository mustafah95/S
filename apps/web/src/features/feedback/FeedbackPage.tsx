import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { COMPLAINT_CATEGORIES, COMPLAINT_SEVERITIES, COMPLAINT_STATUSES } from '@sofia/shared';
import { useApp } from '../../app/context';
import { errorMessage, get, patch, post } from '../../lib/api';
import { dateTime, num } from '../../lib/format';
import { Badge, Button, Card, Count, Empty, Field, Input, Modal, Select, Stat, StatusBadge, Tabs, Textarea, useToast } from '../../ui/kit';
import { useOnline } from '../common';

interface Complaint { id: string; category: string; severity: string; status: string; description: string; resolution: string | null; compensation: string | null; createdAt: string; firstName: string | null; lastName: string | null; reservationCode: string | null; branchName: string; employeeName: string | null }

export default function FeedbackPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const online = useOnline();
  const qc = useQueryClient();
  const { can, branchId } = useApp();
  const [tab, setTab] = useState<'feedback' | 'complaints'>('feedback');
  const fb = useQuery({ queryKey: ['feedback'], queryFn: () => get<{ items: { id: string; overallRating: number; foodRating: number | null; serviceRating: number | null; atmosphereRating: number | null; comment: string | null; suggestion: string | null; submittedAt: string; firstName: string | null; reservationCode: string | null }[]; summary: Record<string, number> }>('/api/v1/feedback'), enabled: online });
  const complaints = useQuery({ queryKey: ['complaints'], queryFn: () => get<Complaint[]>('/api/v1/complaints'), enabled: online && can('complaints.read') });
  const [edit, setEdit] = useState<(Partial<Complaint> & { new?: boolean }) | null>(null);
  if (!online) return <Empty>{t('common.requiresConnection')}</Empty>;
  const s = fb.data?.summary;
  const stars = (n: number | null) => (n ? '★'.repeat(n) + '☆'.repeat(5 - n) : '—');
  return (
    <div className="stack lg">
      <div className="page-head">
        <h1>{t('fb.title')}</h1>
        {can('complaints.manage') && <Button variant="primary" icon="plus" onClick={() => setEdit({ new: true, category: 'service', severity: 'medium', description: '' })}>{t('fb.newComplaint')}</Button>}
      </div>
      {s && (
        <div className="grid cols-4">
          <Stat label={t('fb.overall')} value={s.overall ? `${num(s.overall, 2)} / 5` : '—'} sub={`${s.responses} (90d)`} />
          <Stat label={t('fb.food')} value={s.food ? num(s.food, 2) : '—'} />
          <Stat label={t('fb.service')} value={s.service ? num(s.service, 2) : '—'} />
          <Stat label={t('fb.atmosphere')} value={s.atmosphere ? num(s.atmosphere, 2) : '—'} />
        </div>
      )}
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'feedback', label: t('fb.feedback') }, { key: 'complaints', label: <>{t('fb.complaints')} <Count n={complaints.data?.filter((c) => ['open', 'in_progress'].includes(c.status)).length ?? 0} /></> }]} />
      {tab === 'feedback' ? (
        <Card flush>
          {fb.data?.items.length ? (
            <table className="data">
              <thead><tr><th>{t('common.date')}</th><th>{t('res.guest')}</th><th>{t('fb.overall')}</th><th>{t('fb.food')}</th><th>{t('fb.service')}</th><th>{t('fb.atmosphere')}</th><th>{t('booking.comment')}</th></tr></thead>
              <tbody>{fb.data.items.map((f) => <tr key={f.id}><td className="small">{dateTime(f.submittedAt)}</td><td>{f.firstName ?? '—'} <span className="code small muted">{f.reservationCode}</span></td><td style={{ color: 'var(--c-gold)' }}>{stars(f.overallRating)}</td><td>{f.foodRating ?? '—'}</td><td>{f.serviceRating ?? '—'}</td><td>{f.atmosphereRating ?? '—'}</td><td className="small">{f.comment}{f.suggestion ? <div className="muted">💡 {f.suggestion}</div> : null}</td></tr>)}</tbody>
            </table>
          ) : <Empty />}
        </Card>
      ) : (
        <Card flush>
          {complaints.data?.length ? (
            <table className="data">
              <thead><tr><th>{t('common.date')}</th><th>{t('res.guest')}</th><th>{t('fb.category')}</th><th>{t('fb.severity')}</th><th>{t('fb.description')}</th><th>{t('common.status')}</th></tr></thead>
              <tbody>{complaints.data.map((c) => <tr key={c.id} className="click" onClick={() => can('complaints.manage') && setEdit(c)}><td className="small">{dateTime(c.createdAt)}</td><td>{c.firstName ?? '—'} <span className="code small muted">{c.reservationCode}</span></td><td>{c.category}</td><td><Badge tone={c.severity === 'critical' || c.severity === 'high' ? 'red' : c.severity === 'medium' ? 'amber' : undefined}>{c.severity}</Badge></td><td className="small">{c.description}</td><td><StatusBadge status={c.status} /></td></tr>)}</tbody>
            </table>
          ) : <Empty />}
        </Card>
      )}
      {edit && (
        <Modal title={edit.new ? t('fb.newComplaint') : t('fb.complaints')} onClose={() => setEdit(null)} footer={<><Button onClick={() => setEdit(null)}>{t('common.cancel')}</Button><Button variant="primary" onClick={async () => {
          try {
            if (edit.new) await post('/api/v1/complaints', { branchId, category: edit.category, severity: edit.severity, description: edit.description, employeeName: edit.employeeName || null });
            else await patch(`/api/v1/complaints/${edit.id}`, { status: edit.status, resolution: edit.resolution || null, compensation: edit.compensation || null, severity: edit.severity, category: edit.category });
            setEdit(null);
            void qc.invalidateQueries({ queryKey: ['complaints'] });
          } catch (e) { toast(errorMessage(e, t), 'error'); }
        }}>{t('common.save')}</Button></>}>
          <div className="stack">
            <div className="form-grid">
              <Field label={t('fb.category')}><Select value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })} options={COMPLAINT_CATEGORIES.map((c) => ({ value: c, label: c.replace('_', ' ') }))} /></Field>
              <Field label={t('fb.severity')}><Select value={edit.severity} onChange={(e) => setEdit({ ...edit, severity: e.target.value })} options={COMPLAINT_SEVERITIES.map((c) => ({ value: c, label: c }))} /></Field>
              {!edit.new && <Field label={t('common.status')}><Select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })} options={COMPLAINT_STATUSES.map((c) => ({ value: c, label: t(`status.${c}`) }))} /></Field>}
              <Field label={t('fb.employee')}><Input value={edit.employeeName ?? ''} onChange={(e) => setEdit({ ...edit, employeeName: e.target.value })} /></Field>
            </div>
            <Field label={t('fb.description')}><Textarea value={edit.description ?? ''} disabled={!edit.new} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
            {!edit.new && <Field label={t('fb.resolution')}><Textarea value={edit.resolution ?? ''} onChange={(e) => setEdit({ ...edit, resolution: e.target.value })} /></Field>}
            {!edit.new && <Field label={t('fb.compensation')}><Input value={edit.compensation ?? ''} onChange={(e) => setEdit({ ...edit, compensation: e.target.value })} /></Field>}
          </div>
        </Modal>
      )}
    </div>
  );
}
