import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { APP_VERSION, type Permission } from '@sofia/shared';
import { get, post } from '../lib/api';
import { relative } from '../lib/format';
import { currentLang, setLanguage } from '../i18n';
import { syncEngine } from '../offline/engine';
import { useSyncState } from '../offline/state';
import { Icon, type IconName } from '../ui/icons';
import { Button, Drawer, Empty, useToast } from '../ui/kit';
import { useApp } from './context';
import { GlobalSearch } from './GlobalSearch';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  perm?: Permission;
}

export function StatusPill() {
  const { t } = useTranslation();
  const s = useSyncState();
  const navigate = useNavigate();
  const degraded = s.connection === 'online' && s.internet === false;
  const cls = degraded ? 'degraded' : s.connection;
  const label = degraded ? t('conn.internetDown') : t(`conn.${s.connection}`);
  return (
    <button className={`status-pill ${cls}`} onClick={() => navigate('/sync')} title={s.lastSync ? `${t('conn.lastSync')}: ${relative(s.lastSync)}` : undefined}>
      <span className="dot" />
      <span>{label}</span>
      {s.pending > 0 && <span className="num">· {t('conn.pending', { count: s.pending })}</span>}
    </button>
  );
}

function UpdatePrompt() {
  const { t } = useTranslation();
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      // Look for a new release every 30 minutes; old precaches are removed when the new worker activates.
      if (reg) setInterval(() => void reg.update(), 30 * 60_000);
    },
  });
  if (!needRefresh) return null;
  return (
    <div className="banner info" role="alert">
      <Icon name="download" />
      <span className="grow">{t('update.available')}</span>
      <Button size="sm" variant="gold" onClick={() => void updateServiceWorker(true)}>
        {t('update.now')}
      </Button>
      <Button size="sm" variant="ghost" style={{ color: 'inherit' }} onClick={() => setNeedRefresh(false)}>
        {t('update.later')}
      </Button>
    </div>
  );
}

function Inbox({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data = [] } = useQuery({ queryKey: ['inbox'], queryFn: () => get<{ id: string; title: string; body: string | null; severity: string; createdAt: string; read: boolean; type: string }[]>('/api/v1/inbox') });
  return (
    <Drawer title={t('nav.notifications')} onClose={onClose}>
      <div className="row between" style={{ marginBottom: 8 }}>
        <span className="muted small">{data.filter((n) => !n.read).length} new</span>
        <Button size="sm" variant="ghost" onClick={async () => { await post('/api/v1/inbox/read-all'); void qc.invalidateQueries({ queryKey: ['inbox'] }); }}>
          ✓ {t('common.all')}
        </Button>
      </div>
      {!data.length && <Empty />}
      {data.map((n) => (
        <div key={n.id} className="list-item" style={{ opacity: n.read ? 0.6 : 1 }} onClick={async () => { await post(`/api/v1/inbox/${n.id}/read`); void qc.invalidateQueries({ queryKey: ['inbox'] }); }}>
          <Icon name={n.severity === 'critical' ? 'alert' : n.type === 'vip_arrival' ? 'crown' : 'bell'} style={{ color: n.severity === 'critical' ? 'var(--s-danger)' : 'var(--c-gold)' }} />
          <div className="grow">
            <div style={{ fontWeight: n.read ? 400 : 600 }}>{n.title}</div>
            {n.body && <div className="small muted">{n.body}</div>}
            <div className="small muted">{relative(n.createdAt)}</div>
          </div>
        </div>
      ))}
    </Drawer>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { profile, can, branchId, setBranchId, settings, signOut } = useApp();
  const sync = useSyncState();
  const toast = useToast();
  const qc = useQueryClient();
  const [navOpen, setNavOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const online = sync.connection === 'online' || sync.connection === 'syncing';
  const { data: inbox = [] } = useQuery({ queryKey: ['inbox'], queryFn: () => get<{ read: boolean }[]>('/api/v1/inbox'), enabled: online, refetchInterval: 120_000 });
  const unread = inbox.filter((n) => !n.read).length;

  useEffect(
    () =>
      syncEngine.on((event, data) => {
        if (event === 'notification') {
          const n = data as { title: string; severity: string };
          toast(n.title, n.severity === 'critical' ? 'error' : n.severity === 'warning' ? 'warning' : 'info');
          void qc.invalidateQueries({ queryKey: ['inbox'] });
        }
      }),
    [toast, qc],
  );

  const sections: { title: string; items: NavItem[] }[] = [
    {
      title: t('nav.operations'),
      items: [
        { to: '/', label: t('nav.dashboard'), icon: 'dashboard', perm: 'analytics.host' },
        { to: '/reservations', label: t('nav.reservations'), icon: 'calendar', perm: 'reservations.read' },
        { to: '/floor', label: t('nav.floor'), icon: 'floor', perm: 'tables.read' },
        { to: '/waitlist', label: t('nav.waitlist'), icon: 'clock', perm: 'waitlist.read' },
      ],
    },
    {
      title: t('nav.crm'),
      items: [
        { to: '/guests', label: t('nav.guests'), icon: 'users', perm: 'guests.read' },
        { to: '/loyalty', label: t('nav.loyalty'), icon: 'gift', perm: 'loyalty.read' },
        { to: '/marketing', label: t('nav.marketing'), icon: 'megaphone', perm: 'marketing.read' },
        { to: '/feedback', label: t('nav.feedback'), icon: 'star', perm: 'feedback.read' },
      ],
    },
    {
      title: t('nav.business'),
      items: [
        { to: '/owner', label: t('nav.owner'), icon: 'chart', perm: 'analytics.owner' },
        { to: '/pos', label: t('nav.pos'), icon: 'receipt', perm: 'pos.read' },
        { to: '/reports', label: t('nav.reports'), icon: 'report', perm: 'reports.read' },
      ],
    },
    {
      title: t('nav.system'),
      items: [
        { to: '/sync', label: t('nav.sync'), icon: 'sync' },
        { to: '/settings', label: t('nav.settings'), icon: 'settings' },
      ],
    },
  ];

  return (
    <div className={`shell ${navOpen ? 'nav-open' : ''}`}>
      <nav className="sidebar" onClick={() => setNavOpen(false)}>
        <img className="logo" src={settings.branding.logoUrl ?? '/brand/sofia-logo-cream.png'} alt={settings.branding.restaurantName} style={settings.branding.logoUrl ? { borderRadius: 8 } : undefined} />
        {sections.map((s) => {
          const items = s.items.filter((i) => !i.perm || can(i.perm));
          if (!items.length) return null;
          return (
            <div key={s.title}>
              <div className="nav-section">{s.title}</div>
              {items.map((i) => (
                <NavLink key={i.to} to={i.to} end={i.to === '/'} className={({ isActive }) => `nav ${isActive ? 'active' : ''}`}>
                  <Icon name={i.icon} />
                  {i.label}
                </NavLink>
              ))}
            </div>
          );
        })}
        <div className="foot">
          <div>{profile.displayName}</div>
          <div>{t(`roles.${profile.role}`, { defaultValue: profile.role.replace(/_/g, ' ') })}</div>
          <div style={{ marginTop: 6 }}>v{APP_VERSION}</div>
        </div>
      </nav>
      {navOpen && <div className="overlay" style={{ zIndex: 40 }} onClick={() => setNavOpen(false)} />}
      <div className="main">
        <UpdatePrompt />
        {sync.maintenance && <div className="banner warn"><Icon name="alert" />{t('conn.maintenance')}</div>}
        {(sync.connection === 'offline' || sync.connection === 'server_unavailable') && (
          <div className="banner danger">
            <Icon name="wifiOff" />
            <strong>{t('conn.offline')}</strong>
            <span>{sync.pending > 0 ? t('conn.pending', { count: sync.pending }) : t('conn.localOnly')}</span>
          </div>
        )}
        <header className="topbar">
          <Button className="menu-btn" variant="ghost" icon="menu" onClick={() => setNavOpen(true)} aria-label="menu" />
          {profile.branches.length > 1 ? (
            <select className="input" style={{ width: 'auto', minWidth: 140 }} value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              {profile.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {currentLang() === 'ar' && b.nameAr ? b.nameAr : b.name}
                </option>
              ))}
            </select>
          ) : (
            <strong className="nowrap" style={{ fontFamily: 'var(--font-display)', fontSize: 18 }}>
              {(() => {
                const b = profile.branches[0];
                return b ? (currentLang() === 'ar' && b.nameAr ? b.nameAr : b.name) : settings.branding.restaurantName;
              })()}
            </strong>
          )}
          <GlobalSearch />
          <div className="grow" />
          <StatusPill />
          <Button variant="ghost" icon="bell" onClick={() => setInboxOpen(true)} aria-label="notifications" disabled={!online}>
            {unread > 0 && <span className="badge red">{unread}</span>}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setLanguage(currentLang() === 'ar' ? 'en' : 'ar')}>
            {currentLang() === 'ar' ? 'EN' : 'ع'}
          </Button>
          <Button variant="ghost" icon="logout" onClick={signOut} aria-label={t('nav.logout')} title={t('nav.logout')} />
        </header>
        <main className="content">{children}</main>
      </div>
      {inboxOpen && <Inbox onClose={() => setInboxOpen(false)} />}
    </div>
  );
}
