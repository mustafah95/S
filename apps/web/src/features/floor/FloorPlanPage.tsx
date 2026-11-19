import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { TABLE_SHAPES, effectiveTableStatus, pickTables, type TableShape } from '@sofia/shared';
import { useApp } from '../../app/context';
import { del, errorMessage, patch, post, put } from '../../lib/api';
import { relative, timeIn } from '../../lib/format';
import type { Rec } from '../../offline/db';
import { syncEngine } from '../../offline/engine';
import { useAreas, useCombos, useReservationsAround, useTables, useWaitlist } from '../../offline/hooks';
import { seatWalkIn, setTableStatus, waitlistAction } from '../../offline/repo';
import { Icon } from '../../ui/icons';
import { Badge, Button, Card, Check, Empty, Field, Input, Modal, Select, Seg, StatusBadge, useToast } from '../../ui/kit';
import { ReservationForm } from '../reservations/ReservationForm';
import { allocationsFrom, dayRange, useBranchContext, useOnline } from '../common';

type Pos = { posX: number; posY: number; width: number; height: number; rotation: number };

function chairs(t: Rec & Pos): { x: number; y: number }[] {
  const n = Math.min(Number(t.maxCapacity) || 2, 16);
  const cx = t.width / 2;
  const cy = t.height / 2;
  if (t.shape === 'round') {
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      return { x: cx + Math.cos(a) * (t.width / 2 + 9), y: cy + Math.sin(a) * (t.height / 2 + 9) };
    });
  }
  const perSide = Math.ceil(n / 2);
  return Array.from({ length: n }, (_, i) => {
    const side = i < perSide ? -1 : 1;
    const k = i < perSide ? i : i - perSide;
    const count = i < perSide ? perSide : n - perSide;
    return { x: ((k + 1) * t.width) / (count + 1), y: side < 0 ? -9 : t.height + 9 };
  });
}

export function FloorPlanPage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const online = useOnline();
  const { can } = useApp();
  const [params] = useSearchParams();
  const { branchId, tz, today, settings } = useBranchContext();
  const areas = useAreas(branchId);
  const tables = useTables(branchId);
  const combos = useCombos(branchId);
  const reservations = useReservationsAround(branchId, dayRange(today));
  const waitlist = useWaitlist(branchId);
  const [areaId, setAreaId] = useState<string>('');
  const [selected, setSelected] = useState<string | null>(params.get('table'));
  const [edit, setEdit] = useState(false);
  const [layout, setLayout] = useState<Record<string, Pos>>({});
  const [dirty, setDirty] = useState(false);
  const [walkIn, setWalkIn] = useState<{ party: number; name: string } | null>(null);
  const [newRes, setNewRes] = useState(false);
  const [tableForm, setTableForm] = useState<Rec | 'new' | null>(null);
  const [areaForm, setAreaForm] = useState(false);
  const [now, setNow] = useState(Date.now());
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);

  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(i);
  }, []);
  useEffect(() => {
    if (!areaId && areas[0]) setAreaId(params.get('table') ? (tables.find((x) => x.id === params.get('table'))?.areaId ?? areas[0].id) : areas[0].id);
  }, [areas, areaId, params, tables]);
  useEffect(() => {
    if (!edit) setLayout(Object.fromEntries(tables.map((x) => [x.id, { posX: x.posX, posY: x.posY, width: x.width, height: x.height, rotation: x.rotation }])));
  }, [tables, edit]);

  const area = areas.find((a) => a.id === areaId);
  const plan = (area?.floorPlan as { width: number; height: number; elements: { id: string; kind: string; x: number; y: number; width: number; height: number; label?: string }[] }) ?? { width: 1200, height: 800, elements: [] };
  const active = reservations.filter((r) => !['cancelled', 'no_show', 'rescheduled', 'completed'].includes(r.status));
  const status = useMemo(() => new Map(tables.map((x) => [x.id, effectiveTableStatus(x as never, active as never, new Date(now))])), [tables, active, now]);
  const areaTables = tables.filter((x) => x.areaId === areaId && (x.isActive || edit));
  const sel = tables.find((x) => x.id === selected);
  const selStatus = sel ? status.get(sel.id) : undefined;
  const fitting = sel ? waitlist.filter((w) => w.partySize >= sel.minCapacity && w.partySize <= sel.maxCapacity && ['waiting', 'notified'].includes(w.status)) : [];

  const toSvg = (e: RPointerEvent) => {
    const pt = svgRef.current!.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    return pt.matrixTransform(svgRef.current!.getScreenCTM()!.inverse());
  };
  const onDown = (e: RPointerEvent, id: string) => {
    setSelected(id);
    if (!edit) return;
    const p = toSvg(e);
    const pos = layout[id]!;
    drag.current = { id, dx: p.x - pos.posX, dy: p.y - pos.posY };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: RPointerEvent) => {
    if (!drag.current) return;
    const p = toSvg(e);
    const snap = (v: number) => Math.round(v / 10) * 10;
    const { id, dx, dy } = drag.current;
    setLayout((l) => ({ ...l, [id]: { ...l[id]!, posX: Math.max(0, snap(p.x - dx)), posY: Math.max(0, snap(p.y - dy)) } }));
    setDirty(true);
  };
  const onUp = () => (drag.current = null);

  const saveLayout = async () => {
    try {
      await put('/api/v1/tables/layout', { tables: areaTables.map((x) => ({ id: x.id, ...layout[x.id]!, areaId })) });
      setDirty(false);
      setEdit(false);
      toast(t('common.saved'), 'success');
      void syncEngine.pull();
    } catch (e) {
      toast(errorMessage(e, t), 'error');
    }
  };

  const doStatus = async (s: 'available' | 'cleaning' | 'blocked' | 'maintenance') => {
    if (!sel) return;
    await setTableStatus(sel.id, s);
    toast(`${t('common.table')} ${sel.label}: ${t(`status.${s}`)}`, online ? 'success' : 'warning');
  };

  const suggestWaitlistTable = (w: Rec) => {
    const allocations = allocationsFrom(reservations, settings.bufferMinutes);
    const start = Date.now();
    return pickTables(tables as never, combos as never, allocations, start, start + 2 * 3600_000, w.partySize, { now: start })?.tableIds ?? [];
  };

  return (
    <div className="stack lg">
      <div className="page-head">
        <div>
          <h1>{t('floor.title')}</h1>
          <div className="legend" style={{ marginTop: 8 }}>
            {(['available', 'reserved', 'occupied', 'cleaning', 'blocked'] as const).map((s) => (
              <span key={s}><i style={{ background: `var(--s-${s}-bg)`, borderColor: `var(--s-${s})` }} />{t(`status.${s}`)}</span>
            ))}
          </div>
        </div>
        <div className="row">
          {areas.length > 0 && <Seg value={areaId} onChange={setAreaId} options={areas.map((a) => ({ value: a.id, label: i18n.language === 'ar' && a.nameAr ? a.nameAr : a.name }))} />}
          {can('tables.manage') && !edit && <Button icon="edit" disabled={!online} title={online ? '' : t('floor.editOffline')} onClick={() => setEdit(true)}>{t('floor.editMode')}</Button>}
          {edit && (
            <>
              <Button icon="plus" onClick={() => setTableForm('new')}>{t('floor.addTable')}</Button>
              <Button icon="plus" onClick={() => setAreaForm(true)}>{t('floor.newArea')}</Button>
              <Button onClick={() => { setEdit(false); setDirty(false); }}>{t('common.cancel')}</Button>
              <Button variant="primary" disabled={!dirty} onClick={saveLayout}>{t('floor.saveLayout')}</Button>
            </>
          )}
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) 320px', alignItems: 'start' }}>
        <div className="floor-wrap">
          {!area ? (
            <Empty />
          ) : (
            <svg ref={svgRef} viewBox={`0 0 ${plan.width} ${plan.height}`} width="100%" style={{ minWidth: 640, aspectRatio: `${plan.width} / ${plan.height}` }} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
              {plan.elements.map((el) => (
                <g key={el.id}>
                  <rect x={el.x} y={el.y} width={el.width} height={el.height} rx={6} fill={el.kind === 'bar' ? '#efe2cf' : el.kind === 'wall' ? '#cbbcae' : '#f4ede3'} stroke="#d9c9b6" />
                  {el.label && <text x={el.x + el.width / 2} y={el.y + el.height / 2 + 5} textAnchor="middle" fontSize={14} fill="#7a6a64">{el.label}</text>}
                </g>
              ))}
              {areaTables.map((x) => {
                const pos = layout[x.id] ?? (x as unknown as Pos);
                const st = status.get(x.id)!;
                const tb = { ...x, ...pos } as Rec & Pos;
                const info = st.current ? `${(st.current as Rec).guestName ?? ''}`.slice(0, 14) : st.next ? timeIn((st.next as Rec).startAt, tz) : '';
                return (
                  <g key={x.id} className={`floor-table ${st.status} ${selected === x.id ? 'selected' : ''}`} transform={`translate(${pos.posX} ${pos.posY}) rotate(${pos.rotation} ${pos.width / 2} ${pos.height / 2})`} onPointerDown={(e) => onDown(e, x.id)} style={{ cursor: edit ? 'grab' : 'pointer', opacity: x.isActive ? 1 : 0.4 }}>
                    {chairs(tb).map((c, i) => <circle key={i} className="chair" cx={c.x} cy={c.y} r={6} />)}
                    {x.shape === 'round' ? <ellipse className="shape" cx={pos.width / 2} cy={pos.height / 2} rx={pos.width / 2} ry={pos.height / 2} /> : <rect className="shape" width={pos.width} height={pos.height} rx={x.shape === 'booth' || x.shape === 'sofa' ? 18 : 8} />}
                    <text x={pos.width / 2} y={pos.height / 2 - (info ? 2 : -5)} textAnchor="middle" fontSize={16} fontWeight={700} fill="#2a1416" transform={`rotate(${-pos.rotation} ${pos.width / 2} ${pos.height / 2})`}>
                      {x.label}{x.isVip ? ' ★' : ''}
                    </text>
                    {info && <text x={pos.width / 2} y={pos.height / 2 + 15} textAnchor="middle" fontSize={11} fill="#5a4a46" transform={`rotate(${-pos.rotation} ${pos.width / 2} ${pos.height / 2})`}>{info}</text>}
                  </g>
                );
              })}
            </svg>
          )}
        </div>

        <div className="stack">
          {sel && selStatus ? (
            <Card title={<div className="row"><h2>{t('common.table')} {sel.label}</h2><StatusBadge status={selStatus.status} /></div>}>
              <div className="stack">
                <div className="small muted">{t('floor.capacity')}: {sel.minCapacity}–{sel.maxCapacity} · {t(`shape.${sel.shape}`)} {sel.isVip ? '· ★ VIP' : ''}</div>
                {selStatus.current && (
                  <div className="card" style={{ padding: 10 }}>
                    <div className="small muted">{t('floor.current')}</div>
                    <strong>{(selStatus.current as Rec).guestName}</strong> · {(selStatus.current as Rec).partySize} · {t('floor.since')} {timeIn((selStatus.current as Rec).seatedAt ?? (selStatus.current as Rec).startAt, tz)}
                  </div>
                )}
                {selStatus.next && (
                  <div className="card" style={{ padding: 10 }}>
                    <div className="small muted">{t('floor.next')}</div>
                    <strong>{(selStatus.next as Rec).guestName}</strong> · {(selStatus.next as Rec).partySize} · {timeIn((selStatus.next as Rec).startAt, tz)} ({relative((selStatus.next as Rec).startAt)})
                  </div>
                )}
                {!edit && can('tables.status') && (
                  <div className="row tight">
                    <Button size="sm" onClick={() => void doStatus('available')}>{t('floor.markAvailable')}</Button>
                    <Button size="sm" onClick={() => void doStatus('cleaning')}>{t('floor.markCleaning')}</Button>
                    <Button size="sm" variant="danger" onClick={() => void doStatus('blocked')}>{t('floor.markBlocked')}</Button>
                  </div>
                )}
                {!edit && can('reservations.create') && selStatus.status !== 'occupied' && (
                  <div className="row tight">
                    <Button size="sm" variant="primary" icon="walk" onClick={() => setWalkIn({ party: Math.min(2, sel.maxCapacity), name: '' })}>{t('floor.seatWalkIn')}</Button>
                    <Button size="sm" icon="calendar" onClick={() => setNewRes(true)}>{t('res.new')}</Button>
                  </div>
                )}
                {edit && (
                  <div className="row tight">
                    <Button size="sm" icon="rotate" onClick={() => { setLayout((l) => ({ ...l, [sel.id]: { ...l[sel.id]!, rotation: ((l[sel.id]!.rotation + 15) % 360) } })); setDirty(true); }}>{t('floor.rotate')}</Button>
                    <Button size="sm" icon="edit" onClick={() => setTableForm(sel)}>{t('common.edit')}</Button>
                    <Button size="sm" variant="danger" icon="trash" onClick={async () => { try { await del(`/api/v1/tables/${sel.id}`); setSelected(null); void syncEngine.pull(); } catch (e) { toast(errorMessage(e, t), 'error'); } }} />
                  </div>
                )}
                {!edit && fitting.length > 0 && (
                  <div>
                    <div className="small muted" style={{ marginBottom: 6 }}>{t('floor.suggestions')}</div>
                    {fitting.map((w) => (
                      <div key={w.id} className="list-item">
                        <span className="grow">{w.guestName} · {w.partySize} {w.isVip ? '★' : ''} <span className="small muted">{relative(w.createdAt)}</span></span>
                        <Button size="sm" variant="primary" onClick={async () => { await waitlistAction(w.id, 'seat', { tableIds: [sel.id] }); toast(t('wait.seated'), 'success'); }}>{t('wait.seat')}</Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          ) : (
            <Card><p className="muted" style={{ margin: 0 }}>{t('floor.title')}: {areaTables.length} {t('common.tables')}</p></Card>
          )}
          <Card title={t('floor.combine')}>
            {combos.length ? combos.map((c) => <div key={c.id} className="list-item"><span className="grow">{c.name}</span><Badge>{c.minCapacity}–{c.maxCapacity}</Badge></div>) : <span className="muted small">—</span>}
          </Card>
          {waitlist.length > 0 && (
            <Card title={t('dash.waitlist')} count={waitlist.length}>
              {waitlist.slice(0, 6).map((w) => {
                const suggestion = suggestWaitlistTable(w);
                return (
                  <div key={w.id} className="list-item">
                    <span className="grow">{w.guestName} · {w.partySize}</span>
                    {suggestion.length > 0 && <Button size="sm" onClick={async () => { await waitlistAction(w.id, 'seat', { tableIds: suggestion }); toast(t('wait.seated'), 'success'); }}>{suggestion.map((id) => tables.find((x) => x.id === id)?.label).join('+')}</Button>}
                  </div>
                );
              })}
            </Card>
          )}
        </div>
      </div>

      {walkIn && sel && (
        <Modal title={`${t('res.walkIn')} · ${t('common.table')} ${sel.label}`} onClose={() => setWalkIn(null)} footer={<><Button onClick={() => setWalkIn(null)}>{t('common.cancel')}</Button><Button variant="primary" onClick={async () => { await seatWalkIn({ branchId, partySize: walkIn.party, tableIds: [sel.id], guestName: walkIn.name }); setWalkIn(null); toast(t('wait.seated'), online ? 'success' : 'warning'); }}>{t('res.seatNow')}</Button></>}>
          <div className="form-grid">
            <Field label={t('res.partySize')}><Input type="number" min={1} value={walkIn.party} onChange={(e) => setWalkIn({ ...walkIn, party: Number(e.target.value) })} /></Field>
            <Field label={t('common.name')}><Input value={walkIn.name} onChange={(e) => setWalkIn({ ...walkIn, name: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
      {newRes && sel && <ReservationForm defaultDate={today} defaultTableIds={[sel.id]} onClose={() => setNewRes(false)} />}
      {tableForm && <TableForm table={tableForm === 'new' ? null : tableForm} branchId={branchId} areaId={areaId} onClose={() => setTableForm(null)} />}
      {areaForm && <AreaForm branchId={branchId} onClose={() => setAreaForm(false)} />}
    </div>
  );
}

function TableForm({ table, branchId, areaId, onClose }: { table: Rec | null; branchId: string; areaId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [v, setV] = useState({ label: table?.label ?? '', capacity: table?.capacity ?? 4, minCapacity: table?.minCapacity ?? 1, maxCapacity: table?.maxCapacity ?? 4, shape: (table?.shape ?? 'square') as TableShape, isVip: !!table?.isVip, isActive: table?.isActive ?? true, bookableOnline: table?.bookableOnline ?? true });
  const save = async () => {
    try {
      if (table) await patch(`/api/v1/tables/${table.id}`, v);
      else await post('/api/v1/tables', { ...v, branchId, areaId, posX: 80, posY: 80, width: v.shape === 'rectangle' ? 140 : 90, height: 90 });
      void syncEngine.pull();
      onClose();
    } catch (e) {
      toast(errorMessage(e, t), 'error');
    }
  };
  return (
    <Modal title={table ? `${t('common.table')} ${table.label}` : t('floor.addTable')} onClose={onClose} footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" onClick={save}>{t('common.save')}</Button></>}>
      <div className="form-grid">
        <Field label={t('floor.label')}><Input value={v.label} onChange={(e) => setV({ ...v, label: e.target.value })} /></Field>
        <Field label={t('floor.capacity')}><Input type="number" min={1} value={v.capacity} onChange={(e) => setV({ ...v, capacity: Number(e.target.value), maxCapacity: Math.max(v.maxCapacity, Number(e.target.value)) })} /></Field>
        <Field label={t('floor.minCap')}><Input type="number" min={1} value={v.minCapacity} onChange={(e) => setV({ ...v, minCapacity: Number(e.target.value) })} /></Field>
        <Field label={t('floor.maxCap')}><Input type="number" min={1} value={v.maxCapacity} onChange={(e) => setV({ ...v, maxCapacity: Number(e.target.value) })} /></Field>
        <Field label={t('floor.shape')}><Select value={v.shape} onChange={(e) => setV({ ...v, shape: e.target.value as TableShape })} options={TABLE_SHAPES.map((s) => ({ value: s, label: t(`shape.${s}`) }))} /></Field>
      </div>
      <div className="row" style={{ marginTop: 14 }}>
        <Check label={t('floor.vipTable')} checked={v.isVip} onChange={(x) => setV({ ...v, isVip: x })} />
        <Check label={t('settings.active')} checked={v.isActive} onChange={(x) => setV({ ...v, isActive: x })} />
        <Check label={t('settings.onlineBooking')} checked={v.bookableOnline} onChange={(x) => setV({ ...v, bookableOnline: x })} />
      </div>
    </Modal>
  );
}

function AreaForm({ branchId, onClose }: { branchId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [v, setV] = useState({ name: '', nameAr: '', kind: 'indoor' });
  return (
    <Modal title={t('floor.newArea')} onClose={onClose} footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" onClick={async () => { try { await post('/api/v1/areas', { ...v, branchId }); void syncEngine.pull(); onClose(); } catch (e) { toast(errorMessage(e, t), 'error'); } }}>{t('common.save')}</Button></>}>
      <div className="form-grid">
        <Field label={t('common.name')}><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <Field label={`${t('common.name')} (AR)`}><Input value={v.nameAr} onChange={(e) => setV({ ...v, nameAr: e.target.value })} dir="rtl" /></Field>
        <Field label={t('common.area')}><Select value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })} options={['indoor', 'outdoor', 'vip', 'terrace', 'private_room', 'lounge', 'bar'].map((k) => ({ value: k, label: t(`areaKind.${k}`) }))} /></Field>
      </div>
    </Modal>
  );
}
