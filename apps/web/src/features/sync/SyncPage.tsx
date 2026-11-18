import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApp } from '../../app/context';
import { deviceId, errorMessage, get, post } from '../../lib/api';
import { dateTime, relative } from '../../lib/format';
import { syncEngine } from '../../offline/engine';
import { useOutbox } from '../../offline/hooks';
import { useSyncState } from '../../offline/state';
import { Icon } from '../../ui/icons';
import { Badge, Button, Card, Confirm, Empty, Modal, Stat, useToast } from '../../ui/kit';
import { useOnline } from '../common';

interface ServerConflict {
  id: string;
  kind: string;
  status: string;
  summary: string;
  entityType: string;
  entityId: string;
  createdAt: string;
  userName: string | null;
  fieldConflicts: { field: string; base: unknown; client: unknown; server: unknown }[] | null;
  serverSnapshot: Record<string, unknown> | null;
}

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function SyncPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const online = useOnline();
  const qc = useQueryClient();
  const { can } = useApp();
  const s = useSyncState();
  const ops = useOutbox(['pending', 'syncing', 'failed', 'conflict']);
  const [resolving, setResolving] = useState<ServerConflict | null>(null);
  const [rebuild, setRebuild] = useState(false);
  const canReview = can('sync.review') || can('guests.merge');
  const conflicts = useQuery({ queryKey: ['conflicts'], queryFn: () => get<ServerConflict[]>('/api/v1/sync/conflicts'), enabled: online && canReview });
  const status = useQuery({ queryKey: ['sync-status'], queryFn: () => get<{ devices: { id: string; userName: string | null; lastSyncAt: string | null; lastSeenAt: string; clientVersion: string | null; opsTotal: number; userAgent: string | null }[]; openConflicts: number }>(`/api/v1/sync/status?deviceId=${deviceId()}`), enabled: online, refetchInterval: 30_000 });

  const resolve = async (c: ServerConflict, resolution: 'keep_server' | 'take_client' | 'dismiss') => {
    try {
      await post(`/api/v1/sync/conflicts/${c.id}/resolve`, { resolution });
      setResolving(null);
      void qc.invalidateQueries({ queryKey: ['conflicts'] });
      void syncEngine.pull();
      toast(t('common.saved'), 'success');
    } catch (e) {
      toast(errorMessage(e, t), 'error');
    }
  };

  return (
    <div className="stack lg">
      <div className="page-head">
        <div>
          <h1>{t('sync.title')}</h1>
          <p>Device <span className="code">{deviceId().slice(0, 8)}</span></p>
        </div>
        <div className="row">
          <Button icon="sync" variant="primary" disabled={!online} onClick={() => void syncEngine.syncNow()}>{t('sync.syncNow')}</Button>
          <Button onClick={() => setRebuild(true)} disabled={!online}>{t('sync.rebuild')}</Button>
        </div>
      </div>
      <div className="grid cols-4">
        <Stat label={t('sync.server')} value={<span style={{ fontSize: 20 }}>{t(`conn.${s.connection}`)}</span>} sub={s.internet === false ? t('conn.internetDown') : s.serverVersion ? `v${s.serverVersion}` : undefined} />
        <Stat label={t('sync.lastSync')} value={<span style={{ fontSize: 20 }}>{s.lastSync ? new Date(s.lastSync).toLocaleTimeString() : '—'}</span>} sub={relative(s.lastSync)} />
        <Stat label={t('sync.pending')} value={s.pending} sub={`${t('sync.synced')}: ${s.synced.toLocaleString()}`} />
        <Stat label={`${t('sync.failed')} / ${t('sync.conflicts')}`} value={`${s.failed} / ${s.conflicts}`} sub={status.data ? `${t('sync.review')}: ${status.data.openConflicts}` : undefined} />
      </div>

      <Card title={t('sync.queue')} flush>
        {ops.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>#</th><th>{t('common.details')}</th><th>{t('common.time')}</th><th>{t('common.status')}</th><th>{t('common.notes')}</th><th /></tr></thead>
              <tbody>
                {ops.map((o) => (
                  <tr key={o.seq}>
                    <td className="num">{o.seq}</td>
                    <td>{o.label ?? `${o.entityType} ${o.op}`}<div className="small muted code">{o.entityType}/{o.op}{o.action ? `:${o.action}` : ''}</div></td>
                    <td className="small">{dateTime(o.clientTs)}</td>
                    <td><Badge tone={o.status === 'failed' ? 'red' : o.status === 'conflict' ? 'amber' : o.status === 'syncing' ? 'blue' : undefined}>{t(`sync.${o.status === 'conflict' ? 'conflicts' : o.status}`, { defaultValue: o.status })}</Badge></td>
                    <td className="small" style={{ maxWidth: 320 }}>{o.lastError ?? ''}</td>
                    <td>
                      {o.status === 'failed' && (
                        <div className="row tight">
                          <Button size="sm" onClick={() => void syncEngine.retryFailed(o.seq)}>{t('common.retry')}</Button>
                          <Button size="sm" variant="danger" onClick={() => void syncEngine.discard(o.seq!)}>{t('common.discard')}</Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty><Icon name="check" /> {t('sync.noQueue')}</Empty>
        )}
      </Card>

      {canReview && (
        <Card title={t('sync.review')} flush>
          {!online ? <Empty>{t('common.requiresConnection')}</Empty> : conflicts.data?.length ? (
            <div className="table-wrap">
              <table className="data">
                <tbody>
                  {conflicts.data.map((c) => (
                    <tr key={c.id} className="click" onClick={() => setResolving(c)}>
                      <td><Badge tone="amber">{c.kind.replace(/_/g, ' ')}</Badge></td>
                      <td>{c.summary}</td>
                      <td className="small muted">{c.userName ?? ''} · {relative(c.createdAt)}</td>
                      <td><Button size="sm">{t('sync.resolve')}</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty><Icon name="check" /> 0</Empty>}
        </Card>
      )}

      {status.data && status.data.devices.length > 0 && (
        <Card title={t('sync.devices')} flush>
          <table className="data">
            <tbody>
              {status.data.devices.map((d) => (
                <tr key={d.id}><td className="code">{d.id.slice(0, 8)}</td><td>{d.userName}</td><td className="small muted">{(d.userAgent ?? '').slice(0, 60)}</td><td className="small">{relative(d.lastSyncAt ?? d.lastSeenAt)}</td><td className="r num">{d.opsTotal}</td><td>{d.clientVersion}</td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {resolving && (
        <Modal wide title={resolving.summary} onClose={() => setResolving(null)} footer={
          <>
            <Button onClick={() => void resolve(resolving, 'dismiss')}>{t('sync.dismiss')}</Button>
            {resolving.fieldConflicts?.length || resolving.kind === 'reservation_overlap' ? <Button onClick={() => void resolve(resolving, 'take_client')}>{t('sync.takeDevice')}</Button> : null}
            <Button variant="primary" onClick={() => void resolve(resolving, 'keep_server')}>{t('sync.keepServer')}</Button>
          </>
        }>
          {resolving.fieldConflicts?.length ? (
            <table className="data">
              <thead><tr><th>{t('sync.field')}</th><th>{t('sync.serverValue')}</th><th>{t('sync.deviceValue')}</th></tr></thead>
              <tbody>{resolving.fieldConflicts.map((f) => <tr key={f.field}><td><strong>{f.field}</strong></td><td>{show(f.server)}</td><td>{show(f.client)}</td></tr>)}</tbody>
            </table>
          ) : (
            <p style={{ margin: 0 }}>{resolving.kind === 'reservation_overlap' ? t('res.overlap') : resolving.summary}</p>
          )}
        </Modal>
      )}
      {rebuild && <Confirm text={t('sync.rebuild') + '?'} onClose={() => setRebuild(false)} onConfirm={async () => { await syncEngine.resetLocalData(); await syncEngine.pull(); }} />}
    </div>
  );
}
