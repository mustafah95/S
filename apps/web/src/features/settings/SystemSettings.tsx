import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { APP_VERSION } from '@sofia/shared';
import { useApp } from '../../app/context';
import { download, errorMessage, get, post, put } from '../../lib/api';
import { dateTime, num, relative } from '../../lib/format';
import { Icon } from '../../ui/icons';
import { Badge, Button, Card, Check, Empty, Field, Input, Modal, Select, Spinner, Stat, useToast } from '../../ui/kit';
import { useSettingsData } from './GeneralSettings';

const bytes = (n: number | null | undefined) => (n == null ? '—' : n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
const tone = (s: string) => (s === 'ok' || s === 'running' ? 'green' : s === 'warn' || s === 'disabled' || s === 'not_configured' ? 'amber' : 'red') as 'green' | 'amber' | 'red';

/** Sofia Server Manager (web): services, health, addresses, storage, internet, logs. */
export function ServerTab() {
  const { t } = useTranslation();
  const toast = useToast();
  const { can } = useApp();
  const status = useQuery({ queryKey: ['system-status'], queryFn: () => get<{ version: string; health: { status: string; checks: Record<string, Record<string, any>> }; server: { hostname: string; platform: string; node: string; ipAddresses: string[]; localUrls: string[]; publicUrl: string | null; services: { name: string; status: string }[]; current: { version: string; previous?: string } | null } }>('/api/v1/system/status'), refetchInterval: 15_000 });
  if (!status.data) return <Spinner />;
  const { health, server } = status.data;
  const c = health.checks;
  return (
    <div className="stack">
      <div className="grid cols-3">
        {server.services.map((s) => (
          <div key={s.name} className="card row between"><strong>{s.name}</strong><Badge tone={tone(s.status)}>● {t(`settings.${s.status}`, { defaultValue: s.status })}</Badge></div>
        ))}
      </div>
      <div className="grid cols-4">
        <Stat label={t('settings.health')} value={<Badge tone={tone(health.status)}>{health.status.toUpperCase()}</Badge>} sub={`v${status.data.version} · ${server.platform}`} />
        <Stat label="PostgreSQL" value={`${c.database?.latencyMs ?? '—'} ms`} sub={`${c.database?.postgres ?? ''}`} />
        <Stat label={t('settings.storage')} value={bytes(c.storage?.backupDirFreeBytes)} sub="free (backup disk)" />
        <Stat label={t('settings.internet')} value={<Badge tone={c.internet?.online === false ? 'red' : 'green'}>{c.internet?.online === false ? '✗' : '✓'}</Badge>} sub={relative(c.internet?.checkedAt)} />
      </div>
      <div className="grid cols-2">
        <Card title={t('settings.addresses')}>
          <dl className="kv">
            <dt>Host</dt><dd>{server.hostname}</dd>
            <dt>LAN</dt><dd>{server.localUrls.map((u) => <div key={u} className="code">{u}</div>)}</dd>
            <dt>{t('settings.publicUrl')}</dt><dd className="code">{server.publicUrl ?? '—'}</dd>
            <dt>Node.js</dt><dd>{server.node}</dd>
          </dl>
        </Card>
        <Card title={t('settings.health')}>
          {Object.entries(c).map(([k, v]) => (
            <div key={k} className="list-item"><Badge tone={tone(v.status)}>{v.status}</Badge><strong className="grow">{k}</strong><span className="small muted">{Object.entries(v).filter(([kk]) => kk !== 'status').slice(0, 3).map(([kk, vv]) => `${kk}: ${typeof vv === 'object' ? JSON.stringify(vv).slice(0, 40) : vv}`).join(' · ')}</span></div>
          ))}
        </Card>
      </div>
      {can('system.update') && <div className="row"><Button icon="rotate" onClick={async () => { await post('/api/v1/system/restart'); toast(t('settings.restart'), 'info'); }}>{t('settings.restart')}</Button></div>}
    </div>
  );
}

export function BackupTab() {
  const { t } = useTranslation();
  const toast = useToast();
  const { can } = useApp();
  const qc = useQueryClient();
  const data = useSettingsData();
  const backups = useQuery({ queryKey: ['backups'], queryFn: () => get<{ id: string; fileName: string; sizeBytes: number | null; kind: string; status: string; verifyStatus: string | null; startedAt: string; finishedAt: string | null; error: string | null; externalCopyPath: string | null; sha256: string | null }[]>('/api/v1/backups') });
  const [s, setS] = useState<Record<string, any> | null>(null);
  const [busy, setBusy] = useState(false);
  const [restore, setRestore] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  useEffect(() => { if (data.data?.backup) setS(data.data.backup); }, [data.data]);
  return (
    <div className="stack">
      {s && (
        <Card title={t('settings.schedule')} actions={<Button variant="primary" onClick={async () => { try { await put('/api/v1/settings/backup', { value: s }); toast(t('common.saved'), 'success'); } catch (e) { toast(errorMessage(e, t), 'error'); } }}>{t('common.save')}</Button>}>
          <div className="form-grid">
            <Field label={t('settings.frequency')}><Select value={s.frequency} onChange={(e) => setS({ ...s, frequency: e.target.value })} options={[{ value: 'daily', label: 'Daily' }, { value: 'every_12_hours', label: '12 h' }, { value: 'every_6_hours', label: '6 h' }, { value: 'weekly', label: 'Weekly' }]} /></Field>
            <Field label={t('common.time')}><Input type="time" value={s.timeOfDay} onChange={(e) => setS({ ...s, timeOfDay: e.target.value })} /></Field>
            <Field label={t('settings.retention')}><Input type="number" min={1} value={s.retentionDays} onChange={(e) => setS({ ...s, retentionDays: Number(e.target.value) })} /></Field>
            <Field label={t('settings.keepMin')}><Input type="number" min={1} value={s.keepMinimum} onChange={(e) => setS({ ...s, keepMinimum: Number(e.target.value) })} /></Field>
            <Field label={t('settings.externalDir')} hint="USB / NAS / OneDrive folder"><Input value={s.externalDirectory} onChange={(e) => setS({ ...s, externalDirectory: e.target.value })} /></Field>
            <Field label={t('settings.verify')}><Select value={s.verifyMode} onChange={(e) => setS({ ...s, verifyMode: e.target.value })} options={[{ value: 'list', label: 'Archive check' }, { value: 'full', label: 'Full test restore' }]} /></Field>
          </div>
          <div style={{ marginTop: 10 }}><Check label={t('common.enabled')} checked={s.enabled} onChange={(x) => setS({ ...s, enabled: x })} /></div>
        </Card>
      )}
      <Card title={t('settings.backup')} actions={<Button variant="primary" icon="database" busy={busy} onClick={async () => { setBusy(true); try { await post('/api/v1/backups'); toast(t('common.saved'), 'success'); void qc.invalidateQueries({ queryKey: ['backups'] }); } catch (e) { toast(errorMessage(e, t), 'error'); } finally { setBusy(false); } }}>{t('settings.backupNow')}</Button>} flush>
        {backups.data?.length ? (
          <table className="data">
            <thead><tr><th>{t('common.date')}</th><th>Type</th><th>Size</th><th>{t('settings.verify')}</th><th>{t('common.status')}</th><th /></tr></thead>
            <tbody>
              {backups.data.map((b) => (
                <tr key={b.id}>
                  <td className="small">{dateTime(b.startedAt)}<div className="code small muted">{b.fileName}</div></td>
                  <td><Badge>{b.kind}</Badge></td>
                  <td className="num">{bytes(b.sizeBytes)}</td>
                  <td>{b.verifyStatus && <Badge tone={b.verifyStatus === 'passed' ? 'green' : 'red'}>{b.verifyStatus}</Badge>} {b.externalCopyPath && <Badge tone="blue">copy</Badge>}</td>
                  <td><Badge tone={b.status === 'completed' ? 'green' : b.status === 'failed' ? 'red' : 'amber'}>{b.status}</Badge>{b.error && <div className="small" style={{ color: 'var(--s-danger)' }}>{b.error.slice(0, 120)}</div>}</td>
                  <td>
                    {b.status === 'completed' && (
                      <div className="row tight">
                        <Button size="sm" icon="download" onClick={() => void download('GET', `/api/v1/backups/${b.id}/download`, undefined, b.fileName)} />
                        {can('system.restore') && <Button size="sm" variant="danger" onClick={() => { setRestore(b.id); setConfirmText(''); }}>{t('settings.restore')}</Button>}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty />}
      </Card>
      {restore && (
        <Modal title={t('settings.restore')} onClose={() => setRestore(null)} footer={<><Button onClick={() => setRestore(null)}>{t('common.cancel')}</Button><Button variant="danger solid" disabled={confirmText !== 'RESTORE'} busy={busy} onClick={async () => { setBusy(true); try { await post(`/api/v1/backups/${restore}/restore`, { confirm: 'RESTORE' }); toast(t('common.saved'), 'success'); setRestore(null); void qc.invalidateQueries(); } catch (e) { toast(errorMessage(e, t), 'error'); } finally { setBusy(false); } }}>{t('settings.restore')}</Button></>}>
          <div className="stack"><p>{t('settings.restoreConfirm')}</p><Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="RESTORE" /></div>
        </Modal>
      )}
    </div>
  );
}

interface UpdateStatus {
  currentVersion: string; latestVersion: string | null; updateAvailable: boolean; releaseNotes: { en: string; ar: string } | null; releasedAt: string | null; lastCheckAt: string | null;
  downloaded: { version: string } | null; feedConfigured: boolean; lastError: string | null; previousVersion: string | null;
  migrations: { current: number; latest: number; pending: { version: number; name: string }[]; applied: { version: number; name: string; appliedAt: string; appVersion: string | null }[] };
  lastBackup: { fileName: string; finishedAt: string } | null;
  activeJob: { id: string; toVersion: string; status: string; steps: { step: string; status: string; at: string; message?: string }[] } | null;
}

/** Settings → System → Updates (§21, §70). */
export function UpdatesTab() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { can } = useApp();
  const qc = useQueryClient();
  const st = useQuery({ queryKey: ['update-status'], queryFn: () => get<UpdateStatus>('/api/v1/updates/status'), refetchInterval: (q) => (q.state.data?.activeJob ? 3000 : 30_000) });
  const history = useQuery({ queryKey: ['update-history'], queryFn: () => get<{ id: string; fromVersion: string; toVersion: string; status: string; startedAt: string; finishedAt: string | null; error: string | null; isRollback: boolean; initiatedByName: string | null }[]>('/api/v1/updates/history') });
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (name: string, url: string) => {
    setBusy(name);
    try {
      await post(url);
      void qc.invalidateQueries({ queryKey: ['update-status'] });
      void qc.invalidateQueries({ queryKey: ['update-history'] });
    } catch (e) {
      toast(errorMessage(e, t), 'error');
    } finally {
      setBusy(null);
    }
  };
  const s = st.data;
  if (!s) return <Spinner />;
  const allowed = can('system.update');
  return (
    <div className="stack">
      <div className="grid cols-3">
        <Stat label={t('settings.current')} value={s.currentVersion} sub={`UI ${APP_VERSION}`} />
        <Stat label={t('settings.latest')} value={s.latestVersion ?? '—'} sub={s.lastCheckAt ? `${t('settings.check')}: ${relative(s.lastCheckAt)}` : undefined} />
        <Stat label={t('common.status')} value={<Badge tone={s.updateAvailable ? 'gold' : 'green'}>{s.updateAvailable ? t('settings.newUpdate') : t('settings.upToDate')}</Badge>} sub={s.lastBackup ? `${t('settings.lastBackup')}: ${relative(s.lastBackup.finishedAt)}` : undefined} />
      </div>
      {!s.feedConfigured && <div className="local-note"><Icon name="alert" />{t('settings.feedMissing')}</div>}
      {s.lastError && <div className="badge red">{s.lastError}</div>}
      <Card>
        <div className="row">
          <Button icon="search" disabled={!allowed || !s.feedConfigured} busy={busy === 'check'} onClick={() => act('check', '/api/v1/updates/check')}>{t('settings.check')}</Button>
          <Button icon="download" disabled={!allowed || !s.updateAvailable} busy={busy === 'download'} onClick={() => act('download', '/api/v1/updates/download')}>{t('settings.downloadUpdate')}</Button>
          <Button variant="primary" icon="upload" disabled={!allowed || !s.updateAvailable || !!s.activeJob} busy={busy === 'install'} onClick={() => act('install', '/api/v1/updates/install')}>{t('settings.install')}</Button>
          <Button icon="rotate" disabled={!allowed} onClick={() => act('restart', '/api/v1/system/restart')}>{t('settings.restart')}</Button>
          <Button variant="danger" disabled={!allowed || !s.previousVersion || !!s.activeJob} onClick={() => act('rollback', '/api/v1/updates/rollback')}>{t('settings.rollback')}{s.previousVersion ? ` → ${s.previousVersion}` : ''}</Button>
        </div>
        {s.downloaded && <p className="small muted" style={{ marginBottom: 0 }}>✓ {s.downloaded.version} downloaded & verified</p>}
      </Card>
      {s.activeJob && (
        <Card title={`→ ${s.activeJob.toVersion}`}>
          <ul className="timeline">{s.activeJob.steps.filter((x) => x.status !== 'running' || x === s.activeJob!.steps.at(-1)).map((x, i) => <li key={i}><strong>{x.step}</strong> <Badge tone={x.status === 'done' ? 'green' : x.status === 'failed' ? 'red' : 'amber'}>{x.status}</Badge><div className="small muted">{dateTime(x.at)} {x.message ?? ''}</div></li>)}</ul>
        </Card>
      )}
      {s.releaseNotes && <Card title={t('settings.releaseNotes')}><p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{i18n.language === 'ar' ? s.releaseNotes.ar : s.releaseNotes.en}</p></Card>}
      <div className="grid cols-2">
        <Card title={t('settings.migrations')}>
          <p className="small">Schema {s.migrations.current} / {s.migrations.latest} {s.migrations.pending.length ? <Badge tone="amber">{s.migrations.pending.length} pending</Badge> : <Badge tone="green">✓</Badge>}</p>
          {s.migrations.applied.map((m) => <div key={m.version} className="list-item small"><span className="code">{String(m.version).padStart(3, '0')}_{m.name}</span><span className="grow" /><span className="muted">{m.appVersion} · {dateTime(m.appliedAt)}</span></div>)}
        </Card>
        <Card title={t('settings.history')}>
          {(history.data ?? []).map((h) => <div key={h.id} className="list-item small"><Badge tone={h.status === 'completed' ? 'green' : h.status === 'rolled_back' ? 'amber' : h.status === 'failed' ? 'red' : 'blue'}>{h.status}</Badge><span className="grow">{h.fromVersion} → {h.toVersion} {h.isRollback ? '(rollback)' : ''}</span><span className="muted">{dateTime(h.startedAt)}</span></div>)}
          {!history.data?.length && <span className="muted small">—</span>}
        </Card>
      </div>
    </div>
  );
}

export function LogsTab() {
  const { t } = useTranslation();
  const [category, setCategory] = useState('');
  const [level, setLevel] = useState('');
  const logs = useQuery({ queryKey: ['logs', category, level], queryFn: () => get<{ id: number; at: string; level: string; category: string; message: string; data: unknown; processRole: string }[]>(`/api/v1/system/logs?limit=300${category ? `&category=${category}` : ''}${level ? `&level=${level}` : ''}`) });
  return (
    <Card flush title={<div className="row" style={{ padding: '12px 18px 0' }}>
      <Select value={category} onChange={(e) => setCategory(e.target.value)} options={[{ value: '', label: t('common.all') }, ...['app', 'security', 'sync', 'update', 'backup', 'integration', 'worker', 'error'].map((c) => ({ value: c, label: c }))]} />
      <Select value={level} onChange={(e) => setLevel(e.target.value)} options={[{ value: '', label: t('common.all') }, ...['info', 'warn', 'error'].map((c) => ({ value: c, label: c }))]} />
    </div>}>
      <table className="data"><tbody>{(logs.data ?? []).map((l) => <tr key={l.id}><td className="small nowrap">{dateTime(l.at)}</td><td><Badge tone={l.level === 'error' ? 'red' : l.level === 'warn' ? 'amber' : undefined}>{l.level}</Badge></td><td><Badge>{l.category}</Badge></td><td className="small">{l.message}{l.data ? <div className="code muted" style={{ fontSize: 11 }}>{JSON.stringify(l.data).slice(0, 200)}</div> : null}</td><td className="small muted">{l.processRole}</td></tr>)}</tbody></table>
    </Card>
  );
}

export function AuditTab() {
  const { t } = useTranslation();
  const [entityType, setEntityType] = useState('');
  const audit = useQuery({ queryKey: ['audit', entityType], queryFn: () => get<{ items: { id: number; at: string; action: string; entityType: string; entityId: string | null; userName: string | null; offlineUserName: string | null; deviceId: string | null; ip: string | null; oldValues: Record<string, unknown> | null; newValues: Record<string, unknown> | null }[] }>(`/api/v1/audit?pageSize=300${entityType ? `&entityType=${entityType}` : ''}`) });
  return (
    <Card flush title={<div style={{ padding: '12px 18px 0' }}><Select value={entityType} onChange={(e) => setEntityType(e.target.value)} options={[{ value: '', label: t('common.all') }, ...['reservation', 'guest', 'table', 'user', 'settings', 'backup', 'system', 'waitlist'].map((c) => ({ value: c, label: c }))]} /></div>}>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>{t('common.date')}</th><th>User</th><th>Action</th><th>Entity</th><th>Old → New</th><th>Device / IP</th></tr></thead>
          <tbody>
            {(audit.data?.items ?? []).map((a) => (
              <tr key={a.id}>
                <td className="small nowrap">{dateTime(a.at)}</td>
                <td className="small">{a.userName ?? 'system'}{a.offlineUserName && a.offlineUserName !== a.userName ? <div className="muted">offline: {a.offlineUserName}</div> : null}</td>
                <td><span className="code small">{a.action}</span></td>
                <td className="small">{a.entityType} <span className="code muted">{a.entityId?.slice(0, 8)}</span></td>
                <td className="small" style={{ maxWidth: 420 }}>{a.newValues ? Object.keys(a.newValues).slice(0, 6).map((k) => <div key={k}><strong>{k}</strong>: <span className="muted">{JSON.stringify(a.oldValues?.[k] ?? null)?.slice(0, 40)}</span> → {JSON.stringify(a.newValues![k])?.slice(0, 40)}</div>) : null}</td>
                <td className="code small muted">{a.deviceId?.slice(0, 8)} {a.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function DataTab() {
  const { t } = useTranslation();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Card title={t('settings.data')}>
      <p>{t('settings.exportHint')}</p>
      <Button variant="primary" icon="download" busy={busy} onClick={async () => { setBusy(true); try { await download('GET', '/api/v1/export/full', undefined, 'sofia-export.zip'); } catch (e) { toast(errorMessage(e, t), 'error'); } finally { setBusy(false); } }}>{t('settings.exportAll')}</Button>
      <p className="small muted" style={{ marginBottom: 0 }}>API: <span className="code">/api/v1/openapi.json</span> · <a href="/api/v1/docs" target="_blank" rel="noreferrer">/api/v1/docs</a> · {num(1)} PostgreSQL backup per day (Settings → {t('settings.backup')})</p>
    </Card>
  );
}
