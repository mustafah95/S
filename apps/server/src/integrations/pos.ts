import { parse } from 'csv-parse/sync';
import type { PosInvoiceInput } from '@sofia/shared';

/**
 * POS adapters. The core never depends on a specific POS: every adapter turns the vendor's data into the canonical
 * PosInvoiceInput shape (packages/shared posInvoiceSchema). Three integration styles cover most POS systems:
 *
 *  generic_rest  Sofia polls the POS / middleware REST endpoint for closed invoices since a cursor.
 *  webhook       The POS pushes closed invoices to /api/v1/pos/webhook/:connectionId, HMAC-SHA256 signed.
 *  csv_import    Staff upload the POS end-of-day export (no network integration needed).
 *
 * `fieldMap` maps canonical field names to dot-paths in the vendor payload, e.g. { "total": "amounts.grand_total" }.
 */

export interface PosConnectionConfig {
  baseUrl?: string;
  invoicesPath?: string;
  authHeader?: string;
  fieldMap?: Record<string, string>;
  currency?: 'IQD' | 'USD';
}

export interface PosSecrets {
  apiKey?: string;
  webhookSecret?: string;
}

export interface FetchResult {
  invoices: unknown[];
  nextCursor: string | null;
}

const CANONICAL = [
  'externalId',
  'invoiceNumber',
  'openedAt',
  'closedAt',
  'tableLabel',
  'reservationCode',
  'guestPhone',
  'loyaltyNumber',
  'covers',
  'subtotal',
  'discount',
  'tax',
  'serviceCharge',
  'total',
  'currency',
  'paymentMethod',
  'status',
  'items',
];

function pick(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/** Apply the field map, coerce numbers and dates. Output is validated with posInvoiceSchema by the caller. */
export function mapInvoice(raw: unknown, cfg: PosConnectionConfig): Partial<PosInvoiceInput> {
  const map = cfg.fieldMap ?? {};
  const out: Record<string, unknown> = {};
  for (const f of CANONICAL) {
    const v = pick(raw, map[f] ?? f);
    if (v !== undefined && v !== '') out[f] = v;
  }
  for (const n of ['subtotal', 'discount', 'tax', 'serviceCharge', 'total', 'covers']) if (out[n] !== undefined) out[n] = Number(out[n]);
  for (const d of ['openedAt', 'closedAt']) {
    if (out[d] !== undefined) {
      const date = new Date(String(out[d]));
      out[d] = Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }
  }
  if (out.externalId !== undefined) out.externalId = String(out.externalId);
  if (out.invoiceNumber !== undefined) out.invoiceNumber = String(out.invoiceNumber);
  if (out.tableLabel !== undefined) out.tableLabel = String(out.tableLabel);
  if (out.guestPhone !== undefined) out.guestPhone = String(out.guestPhone);
  if (!out.currency && cfg.currency) out.currency = cfg.currency;
  if (out.subtotal === undefined && out.total !== undefined) out.subtotal = out.total;
  if (Array.isArray(out.items)) {
    out.items = (out.items as Record<string, unknown>[]).map((it) => ({
      externalItemId: it.externalItemId ?? it.id ?? null,
      name: String(it.name ?? it.title ?? 'Item'),
      category: it.category ?? null,
      quantity: Number(it.quantity ?? it.qty ?? 1),
      unitPrice: Number(it.unitPrice ?? it.price ?? 0),
      discount: Number(it.discount ?? 0),
      total: Number(it.total ?? Number(it.quantity ?? 1) * Number(it.unitPrice ?? it.price ?? 0)),
    }));
  }
  return out as Partial<PosInvoiceInput>;
}

type FetchLike = typeof fetch;
let fetchImpl: FetchLike = (...a) => fetch(...a);
export function setPosFetch(f: FetchLike): void {
  fetchImpl = f;
}

/** generic_rest: GET {baseUrl}{invoicesPath}?since=<cursor>; accepts an array or { invoices, nextCursor }. */
export async function fetchRestInvoices(cfg: PosConnectionConfig, secrets: PosSecrets, cursor: string | null): Promise<FetchResult> {
  if (!cfg.baseUrl) throw new Error('POS base URL is not configured');
  const url = new URL(`${cfg.baseUrl.replace(/\/$/, '')}/${(cfg.invoicesPath ?? 'invoices').replace(/^\//, '')}`);
  if (cursor) url.searchParams.set('since', cursor);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (secrets.apiKey) {
    const h = cfg.authHeader || 'Authorization';
    headers[h] = h.toLowerCase() === 'authorization' ? `Bearer ${secrets.apiKey}` : secrets.apiKey;
  }
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`POS responded HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  const invoices = Array.isArray(body) ? body : ((body as { invoices?: unknown[] }).invoices ?? []);
  const next = Array.isArray(body) ? null : ((body as { nextCursor?: string | null }).nextCursor ?? null);
  const maxClosed = invoices
    .map((i) => mapInvoice(i, cfg).closedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  return { invoices, nextCursor: next ?? maxClosed ?? cursor };
}

/**
 * csv_import: header row with canonical column names (or mapped names). Items can be a JSON array or
 * "name|qty|unitPrice;name|qty|unitPrice".
 */
export function parseInvoiceCsv(text: string): Record<string, unknown>[] {
  const rows = parse(text.replace(/^﻿/, ''), { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    if (row.items) {
      const t = row.items.trim();
      out.items = t.startsWith('[')
        ? JSON.parse(t)
        : t.split(';').filter(Boolean).map((part) => {
            const [name, qty, price] = part.split('|');
            return { name, quantity: Number(qty ?? 1), unitPrice: Number(price ?? 0), total: Number(qty ?? 1) * Number(price ?? 0) };
          });
    }
    return out;
  });
}
