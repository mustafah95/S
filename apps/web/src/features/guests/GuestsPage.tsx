import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useApp } from '../../app/context';
import { dateLabel, fullName, money } from '../../lib/format';
import { useGuestSearch } from '../../offline/hooks';
import { Icon } from '../../ui/icons';
import { Button, Card, Empty, VipBadge } from '../../ui/kit';
import { GuestForm } from './GuestForm';

export function GuestsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { can, settings } = useApp();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const guests = useGuestSearch(q, 200) ?? [];
  return (
    <div className="stack lg">
      <div className="page-head">
        <div>
          <h1>{t('guest.title')}</h1>
          <p>{guests.length}{guests.length >= 200 ? '+' : ''}</p>
        </div>
        <div className="row">
          <div className="search" style={{ width: 320 }}>
            <Icon name="search" />
            <input className="input" placeholder={t('res.searchGuest')} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {can('guests.create') && <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>{t('guest.new')}</Button>}
        </div>
      </div>
      <Card flush>
        {guests.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>{t('common.name')}</th><th>{t('common.phone')}</th><th>{t('guest.vipLevel')}</th><th className="r">{t('guest.visits')}</th><th className="r">{t('guest.totalSpend')}</th><th>{t('guest.lastVisit')}</th><th>{t('guest.tags')}</th></tr>
              </thead>
              <tbody>
                {guests.map((g) => (
                  <tr key={g.id} className="click" onClick={() => navigate(`/guests/${g.id}`)}>
                    <td>
                      <div className="row tight">
                        <div className="avatar" style={{ width: 30, height: 30, fontSize: 12 }}>{(g.firstName ?? '?').charAt(0)}</div>
                        <strong>{fullName(g)}</strong>
                        {g._local && <Icon name="wifiOff" size={14} style={{ color: 'var(--s-reserved)' }} />}
                        {(g.allergies as string[])?.length > 0 && <span title={(g.allergies as string[]).join(', ')}>⚠</span>}
                      </div>
                    </td>
                    <td className="num">{g.phone ?? ''}</td>
                    <td><VipBadge level={g.vipLevel} /></td>
                    <td className="r num">{g.visitCount ?? 0}</td>
                    <td className="r num">{money(g.totalSpend, settings.general.primaryCurrency)}</td>
                    <td className="small">{g.lastVisitAt ? dateLabel(String(g.lastVisitAt)) : '—'}</td>
                    <td>{((g.tags as string[]) ?? []).slice(0, 3).map((x) => <span key={x} className="chip" style={{ marginInlineEnd: 4 }}>{x}</span>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty />
        )}
      </Card>
      {creating && <GuestForm onClose={(id) => { setCreating(false); if (id) navigate(`/guests/${id}`); }} />}
    </div>
  );
}
