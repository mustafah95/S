import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeDb } from '../src/db/pool.js';
import { ltr, visualRuns } from '../src/lib/pdf.js';
import { ApiClient, createStaff, setupRestaurant, startTestServer, tomorrow, type Restaurant } from './helpers.js';

let app: FastifyInstance;
let r: Restaurant;

beforeAll(async () => {
  app = await startTestServer();
  r = await setupRestaurant(app);
  const names = ['محمد علي', 'زينب حسن', 'Omar Khalid', 'نور الهدى', 'Sara (VIP)', 'حيدر عبد الله'];
  for (let i = 0; i < 60; i++) {
    const date = new Date(Date.parse(`${tomorrow()}T00:00:00Z`) + (i % 20) * 86400_000).toISOString().slice(0, 10);
    const res = await r.admin.post('/api/v1/reservations', { branchId: r.branchId, date, time: ['13:00', '15:30', '19:00'][i % 3], partySize: 2 + (i % 5), guest: { firstName: names[i % names.length] }, occasion: i % 7 === 0 ? 'birthday' : null });
    expect(res.status).toBe(201);
  }
});
afterAll(async () => {
  await app.close();
  await closeDb();
});

async function exportPdf(client: ApiClient, body: Record<string, unknown>) {
  await client.get('/api/v1/sync/ping');
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/reports/export',
    payload: { format: 'pdf', ...body },
    headers: { cookie: [...client.jar].map(([k, v]) => `${k}=${v}`).join('; '), 'x-csrf-token': client.jar.get('sofia_csrf') ?? '' },
  });
  return { status: res.statusCode, headers: res.headers, pdf: res.rawPayload };
}

const pages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

describe('bidirectional text for PDF', () => {
  it('orders Arabic, numbers and Latin runs visually (Unicode Bidirectional Algorithm)', () => {
    expect(visualRuns('الطاولة 12 · 4 أشخاص', true).map((x) => x.text)).toEqual([' أشخاص', '4', ' · ', '12', 'الطاولة ']);
    expect(visualRuns('عيد ميلاد (خاص) Main Hall', true)).toEqual([
      { text: 'Main Hall', rtl: false },
      { text: 'عيد ميلاد )خاص( ', rtl: true }, // brackets mirrored for right-to-left display
    ]);
    expect(visualRuns('Table 12 الطاولة', false).map((x) => x.text)).toEqual(['Table 12 ', 'الطاولة']);
    expect(visualRuns('Main Hall', true)).toEqual([{ text: 'Main Hall', rtl: false }]);
    // Without an isolate a date after Arabic letters is split (as in browsers); ltr() keeps it intact.
    expect(visualRuns('أُنشئ في 2026-11-18', true).map((x) => x.text)).toEqual(['18', '-', '11', '-', '2026', 'أُنشئ في ']);
    expect(visualRuns(`أُنشئ في ${ltr('2026-11-18 14:02')}`, true).map((x) => x.text)).toEqual(['2026-11-18 14:02', 'أُنشئ في ']);
  });
});

describe('PDF report export', () => {
  it('exports an Arabic report over several pages with the Arabic font embedded', async () => {
    const res = await exportPdf(r.admin, { dataset: 'reservations', columns: ['code', 'date', 'time', 'guest', 'partySize', 'status', 'occasion', 'area'], language: 'ar', sort: { column: 'date', dir: 'asc' } });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(String(res.headers['content-disposition'])).toMatch(/attachment; filename="sofia-reservations-\d{4}-\d{2}-\d{2}\.pdf"/);
    expect(res.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pages(res.pdf)).toBeGreaterThanOrEqual(2); // 60 rows + header repeat on the next page
    expect(res.pdf.toString('latin1')).toContain('IBMPlexSansArabic');
    if (process.env.SOFIA_PDF_OUT) writeFileSync(join(process.env.SOFIA_PDF_OUT, 'report-ar.pdf'), res.pdf);
  });

  it('exports grouped English reports with totals and a custom title', async () => {
    const res = await exportPdf(r.admin, { dataset: 'reservations', columns: ['status'], groupBy: ['status', 'occasion'], aggregates: [{ column: 'partySize', fn: 'sum' }, { column: 'partySize', fn: 'avg' }], language: 'en', title: 'Covers by status', from: tomorrow() });
    expect(res.status).toBe(200);
    expect(pages(res.pdf)).toBe(1);
    if (process.env.SOFIA_PDF_OUT) writeFileSync(join(process.env.SOFIA_PDF_OUT, 'report-en-grouped.pdf'), res.pdf);
    const grouped = await exportPdf(r.admin, { dataset: 'reservations', columns: ['status'], groupBy: ['occasion'], aggregates: [{ column: 'partySize', fn: 'sum' }], language: 'ar' });
    expect(grouped.status).toBe(200);
    if (process.env.SOFIA_PDF_OUT) writeFileSync(join(process.env.SOFIA_PDF_OUT, 'report-ar-grouped.pdf'), grouped.pdf);
  });

  it('produces a valid document for an empty result and respects the export permission', async () => {
    const empty = await exportPdf(r.admin, { dataset: 'feedback', columns: ['date', 'overall', 'comment'], language: 'ar' });
    expect(empty.status).toBe(200);
    expect(pages(empty.pdf)).toBe(1);
    const host = await createStaff(app, r.admin, 'host', [r.branchId]);
    expect((await exportPdf(host.client, { dataset: 'reservations', columns: ['code'] })).status).toBe(403);
  });
});
