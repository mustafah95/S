import type { ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Permission } from '@sofia/shared';
import { useApp } from '../../app/context';
import { Empty, Tabs } from '../../ui/kit';
import { useOnline } from '../common';
import { BranchesTab } from './BranchSettings';
import { BrandingTab, GeneralTab, GuestsTab, IntegrationsTab, NotificationsTab } from './GeneralSettings';
import { AuditTab, BackupTab, DataTab, LogsTab, ServerTab, UpdatesTab } from './SystemSettings';
import { SecurityTab, UsersTab } from './UsersSettings';

const TABS: { key: string; perm?: Permission[]; Comp: () => ReactElement }[] = [
  { key: 'general', perm: ['settings.manage'], Comp: GeneralTab },
  { key: 'branding', perm: ['settings.manage'], Comp: BrandingTab },
  { key: 'branches', perm: ['settings.manage', 'branches.manage'], Comp: BranchesTab },
  { key: 'guests', perm: ['settings.manage'], Comp: GuestsTab },
  { key: 'notifications', perm: ['notifications.manage'], Comp: NotificationsTab },
  { key: 'integrations', perm: ['integrations.manage'], Comp: IntegrationsTab },
  { key: 'users', perm: ['users.read'], Comp: UsersTab },
  { key: 'security', Comp: SecurityTab },
  { key: 'backup', perm: ['system.backup'], Comp: BackupTab },
  { key: 'updates', perm: ['system.update', 'system.health'], Comp: UpdatesTab },
  { key: 'system', perm: ['system.health'], Comp: ServerTab },
  { key: 'logs', perm: ['system.logs'], Comp: LogsTab },
  { key: 'audit', perm: ['audit.read'], Comp: AuditTab },
  { key: 'data', perm: ['data.export'], Comp: DataTab },
];

export default function SettingsPage() {
  const { t } = useTranslation();
  const { tab } = useParams();
  const navigate = useNavigate();
  const online = useOnline();
  const { can } = useApp();
  const visible = TABS.filter((x) => !x.perm || x.perm.some((p) => can(p)));
  const current = visible.find((x) => x.key === tab) ?? visible[0]!;
  return (
    <div className="stack lg">
      <div className="page-head"><h1>{t('settings.title')}</h1></div>
      <Tabs value={current.key} onChange={(k) => navigate(`/settings/${k}`)} tabs={visible.map((x) => ({ key: x.key, label: t(`settings.${x.key}`) }))} />
      {online ? <current.Comp /> : <Empty>{t('common.requiresConnection')}</Empty>}
    </div>
  );
}
