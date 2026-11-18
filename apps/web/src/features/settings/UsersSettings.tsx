import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { ROLE_KEYS } from '@sofia/shared';
import { useApp } from '../../app/context';
import { del, errorMessage, get, patch, post, put } from '../../lib/api';
import { dateTime, relative } from '../../lib/format';
import { Badge, Button, Card, Check, Field, Input, Modal, Select, useToast } from '../../ui/kit';

interface User { id: string; username: string; displayName: string; email: string | null; roleKey: string; isActive: boolean; branchIds: string[]; lastLoginAt: string | null; mfaEnabled: boolean; preferredLanguage: string }

export function UsersTab() {
  const { t } = useTranslation();
  const toast = useToast();
  const { profile, can } = useApp();
  const users = useQuery({ queryKey: ['users'], queryFn: () => get<User[]>('/api/v1/users') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => get<{ roles: { id: string; key: string; nameEn: string; nameAr: string; permissions: string[]; allBranches: boolean }[]; allPermissions: string[] }>('/api/v1/roles') });
  const [form, setForm] = useState<{ id?: string; username: string; displayName: string; email: string; password: string; roleKey: string; branchIds: string[]; isActive: boolean; preferredLanguage: string } | null>(null);
  const [roleEdit, setRoleEdit] = useState<{ id: string; key: string; permissions: string[] } | null>(null);
  const save = async () => {
    if (!form) return;
    try {
      if (form.id) await patch(`/api/v1/users/${form.id}`, { displayName: form.displayName, email: form.email || null, roleKey: form.roleKey, branchIds: form.branchIds, isActive: form.isActive, preferredLanguage: form.preferredLanguage });
      else await post('/api/v1/users', { ...form, email: form.email || null });
      setForm(null);
      void users.refetch();
    } catch (e) {
      toast(errorMessage(e, t), 'error');
    }
  };
  return (
    <div className="stack">
      <Card title={t('settings.users')} actions={can('users.manage') && <Button variant="primary" icon="plus" onClick={() => setForm({ username: '', displayName: '', email: '', password: '', roleKey: 'host', branchIds: profile.branches.slice(0, 1).map((b) => b.id), isActive: true, preferredLanguage: 'ar' })}>{t('settings.newUser')}</Button>} flush>
        <table className="data">
          <thead><tr><th>{t('common.name')}</th><th>{t('auth.username')}</th><th>{t('settings.role')}</th><th>{t('settings.branchesAccess')}</th><th>MFA</th><th>Last login</th><th>{t('common.status')}</th></tr></thead>
          <tbody>
            {(users.data ?? []).map((u) => (
              <tr key={u.id} className="click" onClick={() => can('users.manage') && setForm({ id: u.id, username: u.username, displayName: u.displayName, email: u.email ?? '', password: '', roleKey: u.roleKey, branchIds: u.branchIds, isActive: u.isActive, preferredLanguage: u.preferredLanguage })}>
                <td><strong>{u.displayName}</strong></td><td className="code">{u.username}</td><td>{t(`roles.${u.roleKey}`)}</td>
                <td className="small">{u.branchIds.map((id) => profile.branches.find((b) => b.id === id)?.code ?? '…').join(', ')}</td>
                <td>{u.mfaEnabled ? <Badge tone="green">✓</Badge> : ''}</td><td className="small">{relative(u.lastLoginAt)}</td>
                <td><Badge tone={u.isActive ? 'green' : undefined}>{u.isActive ? t('settings.active') : t('common.disabled')}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title={t('settings.permissions')} flush>
        <table className="data">
          <tbody>
            {(roles.data?.roles ?? []).map((r) => (
              <tr key={r.id} className="click" onClick={() => ['super_admin', 'owner'].includes(profile.role) && r.key !== 'super_admin' && setRoleEdit({ id: r.id, key: r.key, permissions: r.permissions })}>
                <td><strong>{t(`roles.${r.key}`)}</strong> {r.allBranches && <Badge tone="gold">All branches</Badge>}</td>
                <td className="small muted">{r.permissions.length} / {roles.data!.allPermissions.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {form && (
        <Modal title={form.id ? form.displayName : t('settings.newUser')} onClose={() => setForm(null)} footer={<>
          {form.id && <Button onClick={async () => { const pw = prompt(t('settings.newPassword')); if (pw) { try { await post(`/api/v1/users/${form.id}/reset-password`, { password: pw }); toast(t('common.saved'), 'success'); } catch (e) { toast(errorMessage(e, t), 'error'); } } }}>{t('settings.resetPassword')}</Button>}
          <Button onClick={() => setForm(null)}>{t('common.cancel')}</Button><Button variant="primary" onClick={save}>{t('common.save')}</Button></>}>
          <div className="form-grid">
            <Field label={t('auth.username')}><Input value={form.username} disabled={!!form.id} onChange={(e) => setForm({ ...form, username: e.target.value })} /></Field>
            <Field label={t('common.name')}><Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></Field>
            <Field label={t('common.email')}><Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
            {!form.id && <Field label={t('auth.password')} hint="≥ 10"><Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>}
            <Field label={t('settings.role')}><Select value={form.roleKey} onChange={(e) => setForm({ ...form, roleKey: e.target.value })} options={ROLE_KEYS.map((k) => ({ value: k, label: t(`roles.${k}`) }))} /></Field>
            <Field label={t('common.language')}><Select value={form.preferredLanguage} onChange={(e) => setForm({ ...form, preferredLanguage: e.target.value })} options={[{ value: 'ar', label: 'العربية' }, { value: 'en', label: 'English' }]} /></Field>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            {profile.branches.map((b) => <Check key={b.id} label={b.name} checked={form.branchIds.includes(b.id)} onChange={(v) => setForm({ ...form, branchIds: v ? [...form.branchIds, b.id] : form.branchIds.filter((x) => x !== b.id) })} />)}
            <Check label={t('settings.active')} checked={form.isActive} onChange={(v) => setForm({ ...form, isActive: v })} />
          </div>
        </Modal>
      )}
      {roleEdit && roles.data && (
        <Modal wide title={t(`roles.${roleEdit.key}`)} onClose={() => setRoleEdit(null)} footer={<><Button onClick={() => setRoleEdit(null)}>{t('common.cancel')}</Button><Button variant="primary" onClick={async () => { try { await put(`/api/v1/roles/${roleEdit.id}/permissions`, { permissions: roleEdit.permissions }); setRoleEdit(null); void roles.refetch(); } catch (e) { toast(errorMessage(e, t), 'error'); } }}>{t('common.save')}</Button></>}>
          <div className="grid cols-3" style={{ gap: 6 }}>
            {roles.data.allPermissions.map((p) => <Check key={p} label={<span className="code small">{p}</span>} checked={roleEdit.permissions.includes(p)} onChange={(v) => setRoleEdit({ ...roleEdit, permissions: v ? [...roleEdit.permissions, p] : roleEdit.permissions.filter((x) => x !== p) })} />)}
          </div>
        </Modal>
      )}
    </div>
  );
}

export function SecurityTab() {
  const { t } = useTranslation();
  const toast = useToast();
  const { profile } = useApp();
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => get<{ id: string; userAgent: string | null; ip: string | null; createdAt: string; lastUsedAt: string }[]>('/api/v1/auth/sessions') });
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [mfa, setMfa] = useState<{ secret: string; qr: string; code: string; recovery?: string[] } | null>(null);
  return (
    <div className="grid cols-2">
      <Card title={t('settings.changePassword')}>
        <div className="stack">
          <Field label={t('settings.currentPassword')}><Input type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></Field>
          <Field label={t('settings.newPassword')} hint="≥ 10"><Input type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></Field>
          <Button variant="primary" onClick={async () => { try { await post('/api/v1/auth/password', pw); setPw({ currentPassword: '', newPassword: '' }); toast(t('common.saved'), 'success'); } catch (e) { toast(errorMessage(e, t), 'error'); } }}>{t('common.save')}</Button>
        </div>
      </Card>
      <Card title={t('settings.mfa')}>
        {profile.mfaEnabled ? (
          <Button variant="danger" onClick={async () => { const p = prompt(t('auth.password')); if (p) { try { await post('/api/v1/auth/mfa/disable', { password: p }); toast(t('common.saved'), 'success'); } catch (e) { toast(errorMessage(e, t), 'error'); } } }}>{t('settings.disableMfa')}</Button>
        ) : mfa ? (
          mfa.recovery ? (
            <div className="stack"><strong>{t('settings.recoveryCodes')}</strong><pre className="code card">{mfa.recovery.join('\n')}</pre></div>
          ) : (
            <div className="stack">
              <p className="small">{t('settings.scanQr')}</p>
              <img src={mfa.qr} alt="QR" style={{ width: 200 }} />
              <span className="code small">{mfa.secret}</span>
              <Input inputMode="numeric" value={mfa.code} onChange={(e) => setMfa({ ...mfa, code: e.target.value })} />
              <Button variant="primary" onClick={async () => { try { const r = await post<{ recoveryCodes: string[] }>('/api/v1/auth/mfa/enable', { code: mfa.code }); setMfa({ ...mfa, recovery: r.recoveryCodes }); } catch (e) { toast(errorMessage(e, t), 'error'); } }}>{t('auth.verify')}</Button>
            </div>
          )
        ) : (
          <Button variant="primary" icon="shield" onClick={async () => { const r = await post<{ secret: string; otpauthUrl: string }>('/api/v1/auth/mfa/setup'); setMfa({ secret: r.secret, qr: await QRCode.toDataURL(r.otpauthUrl, { width: 220 }), code: '' }); }}>{t('settings.enableMfa')}</Button>
        )}
      </Card>
      <Card title={t('settings.sessions')} flush>
        <table className="data"><tbody>{(sessions.data ?? []).map((s) => <tr key={s.id}><td className="small">{(s.userAgent ?? '').slice(0, 70)}</td><td className="code small">{s.ip}</td><td className="small">{dateTime(s.createdAt)}</td><td><Button size="sm" variant="ghost" icon="x" onClick={async () => { await del(`/api/v1/auth/sessions/${s.id}`); void sessions.refetch(); }} /></td></tr>)}</tbody></table>
      </Card>
    </div>
  );
}
