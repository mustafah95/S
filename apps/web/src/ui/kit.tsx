import { createContext, useCallback, useContext, useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from './icons';

export function Button({ variant, size, icon, busy, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'gold' | 'ghost' | 'danger' | 'danger solid'; size?: 'sm'; icon?: IconName; busy?: boolean }) {
  return (
    <button type="button" className={['btn', variant, size, !children && icon ? 'icon' : '', className].filter(Boolean).join(' ')} disabled={busy || rest.disabled} {...rest}>
      {busy ? <span className="spinner" /> : icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children, className }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={['field', className].filter(Boolean).join(' ')}>
      {label && <span>{label}</span>}
      {children}
      {hint && <small className="hint">{hint}</small>}
      {error && <small className="err">{error}</small>}
    </label>
  );
}

export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input className="input" {...p} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea className="input" {...p} />;
export function Select({ options, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: ReactNode }[] }) {
  return (
    <select className="input" {...rest}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label as string}
        </option>
      ))}
    </select>
  );
}

export function Check({ label, checked, onChange, disabled }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Card({ title, actions, children, className, flush }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={['card', flush ? 'flush' : '', className].filter(Boolean).join(' ')}>
      {(title || actions) && (
        <div className="card-head">
          {typeof title === 'string' ? <h3>{title}</h3> : title}
          {actions && <div className="row tight">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, onClick }: { label: ReactNode; value: ReactNode; sub?: ReactNode; onClick?: () => void }) {
  return (
    <div className="card stat" onClick={onClick} style={onClick ? { cursor: 'pointer' } : undefined}>
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      {sub && <span className="sub">{sub}</span>}
    </div>
  );
}

export function Badge({ tone, children }: { tone?: 'green' | 'amber' | 'red' | 'wine' | 'blue' | 'gold' | 'vip'; children: ReactNode }) {
  return <span className={['badge', tone].filter(Boolean).join(' ')}>{children}</span>;
}

const STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'wine' | 'blue' | 'gold' | undefined> = {
  pending: 'amber',
  confirmed: 'blue',
  checked_in: 'gold',
  seated: 'wine',
  dining: 'wine',
  completed: 'green',
  cancelled: undefined,
  no_show: 'red',
  rescheduled: undefined,
  waiting: 'amber',
  notified: 'blue',
  available: 'green',
  reserved: 'amber',
  occupied: 'wine',
  cleaning: 'blue',
  open: 'red',
  in_progress: 'amber',
  resolved: 'green',
};

export function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  return <Badge tone={STATUS_TONE[status]}>{t(`status.${status}`, { defaultValue: status })}</Badge>;
}

export function VipBadge({ level }: { level?: string | null }) {
  const { t } = useTranslation();
  if (!level || level === 'standard') return null;
  return (
    <Badge tone={['vip', 'vvip', 'platinum', 'gold'].includes(level) ? 'vip' : 'gold'}>
      <Icon name="crown" size={12} />
      {t(`vip.${level}`)}
    </Badge>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={['modal', wide ? 'wide' : ''].join(' ')} role="dialog" aria-modal="true">
        <header>
          <h3>{title}</h3>
          <Button variant="ghost" icon="x" onClick={onClose} aria-label="close" />
        </header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

export function Drawer({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  return (
    <>
      <div className="overlay" style={{ background: 'rgb(30 8 11 / 25%)' }} onMouseDown={onClose} />
      <aside className="drawer">
        <header>
          <h3>{title}</h3>
          <Button variant="ghost" icon="x" onClick={onClose} />
        </header>
        <div className="body">{children}</div>
      </aside>
    </>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" className={t.key === value ? 'on' : ''} onClick={() => onChange(t.key)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Seg<T extends string>({ options, value, onChange }: { options: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="empty">
      <div className="ornament">❦</div>
      {children ?? t('common.noData')}
    </div>
  );
}

export function Spinner() {
  return (
    <div className="row" style={{ justifyContent: 'center', padding: 24 }}>
      <span className="spinner" />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------------------------------------
type ToastKind = 'info' | 'success' | 'error' | 'warning';
interface ToastItem {
  id: number;
  kind: ToastKind;
  text: ReactNode;
}
const ToastCtx = createContext<(text: ReactNode, kind?: ToastKind) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((text: ReactNode, kind: ToastKind = 'info') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.slice(-3), { id, kind, text }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), kind === 'error' ? 8000 : 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((i) => (
          <div key={i.id} className={`toast ${i.kind}`}>
            <span className="grow">{i.text}</span>
            <button className="btn ghost sm" style={{ color: 'inherit', minHeight: 0 }} onClick={() => setItems((x) => x.filter((y) => y.id !== i.id))}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

export function Confirm({ text, onConfirm, onClose, danger, confirmLabel }: { text: ReactNode; onConfirm: () => void | Promise<void>; onClose: () => void; danger?: boolean; confirmLabel?: string }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={t('common.confirm')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant={danger ? 'danger solid' : 'primary'}
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel ?? t('common.confirm')}
          </Button>
        </>
      }
    >
      <p style={{ margin: 0 }}>{text}</p>
    </Modal>
  );
}
