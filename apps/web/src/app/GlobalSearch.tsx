import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { get } from '../lib/api';
import { db, type Rec } from '../offline/db';
import { searchGuests } from '../offline/hooks';
import { useSyncState } from '../offline/state';
import { Icon } from '../ui/icons';
import { VipBadge } from '../ui/kit';
import { dateLabel, fullName } from '../lib/format';

interface Results {
  guests: Rec[];
  reservations: Rec[];
  tables: Rec[];
  invoices: Rec[];
}

/** Global search (§61): server search when online, IndexedDB search when offline. */
export function GlobalSearch() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const sync = useSyncState();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [res, setRes] = useState<Results | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (q.trim().length < 2) return setRes(null);
    timer.current = window.setTimeout(async () => {
      const online = sync.connection === 'online' || sync.connection === 'syncing';
      if (online) {
        try {
          return setRes(await get<Results>(`/api/v1/search?q=${encodeURIComponent(q.trim())}`));
        } catch {
          /* fall back to local search */
        }
      }
      const term = q.trim().toLowerCase();
      const [guests, reservations, tables] = await Promise.all([
        searchGuests(q, 8),
        db.reservations.filter((r) => String(r.code).toLowerCase().includes(term) || String(r.guestName ?? '').toLowerCase().includes(term)).limit(8).toArray(),
        db.diningTables.filter((tb) => String(tb.label).toLowerCase().includes(term)).limit(5).toArray(),
      ]);
      setRes({ guests, reservations, tables, invoices: [] });
    }, 250);
  }, [q, sync.connection]);

  const go = (path: string) => {
    setOpen(false);
    setQ('');
    navigate(path);
  };

  return (
    <div className="search" style={{ position: 'relative', width: 'min(380px, 40vw)' }}>
      <Icon name="search" />
      <input className="input" placeholder={t('nav.searchAll')} value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 200)} />
      {open && res && (
        <div className="card" style={{ position: 'absolute', top: 44, insetInline: 0, zIndex: 60, maxHeight: 420, overflowY: 'auto', padding: 8, boxShadow: 'var(--shadow-lg)' }}>
          {res.guests.map((g) => (
            <div key={g.id} className="list-item" style={{ cursor: 'pointer', padding: 8 }} onMouseDown={() => go(`/guests/${g.id}`)}>
              <Icon name="users" />
              <span className="grow">{fullName(g)} <span className="muted small">{g.phone ?? g.email ?? ''}</span></span>
              <VipBadge level={g.vipLevel} />
            </div>
          ))}
          {res.reservations.map((r) => (
            <div key={r.id} className="list-item" style={{ cursor: 'pointer', padding: 8 }} onMouseDown={() => go(`/reservations?date=${r.businessDate}&open=${r.id}`)}>
              <Icon name="calendar" />
              <span className="grow"><span className="code">{r.code}</span> {r.guestName} <span className="muted small">{dateLabel(r.businessDate)}</span></span>
            </div>
          ))}
          {res.tables.map((tb) => (
            <div key={tb.id} className="list-item" style={{ cursor: 'pointer', padding: 8 }} onMouseDown={() => go(`/floor?table=${tb.id}`)}>
              <Icon name="floor" />
              <span className="grow">{t('common.table')} {tb.label}</span>
            </div>
          ))}
          {res.invoices.map((i) => (
            <div key={i.id} className="list-item" style={{ cursor: 'pointer', padding: 8 }} onMouseDown={() => go(`/pos?invoice=${i.id}`)}>
              <Icon name="receipt" />
              <span className="grow">{i.invoiceNumber ?? i.externalId}</span>
            </div>
          ))}
          {!res.guests.length && !res.reservations.length && !res.tables.length && !res.invoices.length && <div className="muted small" style={{ padding: 8 }}>{t('common.noData')}</div>}
        </div>
      )}
    </div>
  );
}
