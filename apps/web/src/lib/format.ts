import { formatMoney, utcToZoned } from '@sofia/shared';
import { currentLang } from '../i18n';

export function locale(): string {
  return currentLang() === 'ar' ? 'ar-IQ-u-nu-latn' : 'en-GB';
}

export function money(amount: number | null | undefined, currency = 'IQD'): string {
  return formatMoney(amount ?? 0, currency, currentLang());
}

export function num(n: number | null | undefined, digits = 0): string {
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: digits }).format(n ?? 0);
}

export function pct(n: number | null | undefined): string {
  return `${num(n, 1)}%`;
}

export function dateLabel(date: string | null | undefined, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }): string {
  if (!date) return '—';
  const [y, m, d] = date.slice(0, 10).split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(locale(), { ...opts, timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function dateTime(value: string | Date | null | undefined, tz?: string): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(value));
}

export function timeIn(value: string | Date, tz: string): string {
  return utcToZoned(new Date(value), tz).time;
}

export function relative(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const diff = (new Date(value).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

export function initials(first?: string | null, last?: string | null): string {
  return `${(first ?? '').trim().charAt(0)}${(last ?? '').trim().charAt(0)}`.toUpperCase() || '·';
}

export function fullName(g: Record<string, unknown> | null | undefined): string {
  return [g?.firstName, g?.lastName].filter(Boolean).map(String).join(' ');
}
