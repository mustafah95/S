import { BidiPdf, brandLogo, ltr, type Align } from '../lib/pdf.js';

/** Arabic names of report datasets and columns (English names live with the dataset definitions). */
export const REPORT_AR: Record<string, { label: string; columns: Record<string, string> }> = {
  reservations: {
    label: 'الحجوزات',
    columns: {
      code: 'رقم الحجز', date: 'التاريخ', time: 'الوقت', hour: 'الساعة', weekday: 'اليوم', branch: 'الفرع', area: 'منطقة الجلوس',
      guest: 'الضيف', vipLevel: 'مستوى كبار الضيوف', partySize: 'عدد الأشخاص', status: 'الحالة', source: 'المصدر', occasion: 'المناسبة',
      deposit: 'العربون', origin: 'طريقة الإنشاء',
    },
  },
  guests: {
    label: 'الضيوف',
    columns: {
      name: 'الاسم', phone: 'الهاتف', email: 'البريد الإلكتروني', vipLevel: 'مستوى كبار الضيوف', tier: 'فئة الولاء', points: 'النقاط',
      visits: 'الزيارات', totalSpend: 'إجمالي الإنفاق', avgCheck: 'متوسط الفاتورة', noShows: 'عدم الحضور', firstVisit: 'أول زيارة',
      lastVisit: 'آخر زيارة', marketingConsent: 'موافقة تسويقية', language: 'اللغة', created: 'تاريخ الإنشاء',
    },
  },
  invoices: {
    label: 'فواتير نقطة البيع',
    columns: {
      invoice: 'الفاتورة', date: 'التاريخ', branch: 'الفرع', table: 'الطاولة', guest: 'الضيف', total: 'الإجمالي', discount: 'الخصم',
      tax: 'الضريبة', serviceCharge: 'رسوم الخدمة', paymentMethod: 'طريقة الدفع', status: 'الحالة', matched: 'طريقة المطابقة',
    },
  },
  feedback: {
    label: 'آراء الضيوف',
    columns: {
      date: 'التاريخ', branch: 'الفرع', guest: 'الضيف', overall: 'التقييم العام', food: 'الطعام', service: 'الخدمة', atmosphere: 'الأجواء',
      complaint: 'شكوى', comment: 'التعليق',
    },
  },
  loyalty: {
    label: 'حركات الولاء',
    columns: { date: 'التاريخ', guest: 'الضيف', type: 'النوع', points: 'النقاط', reason: 'السبب', branch: 'الفرع' },
  },
};

export const AGGREGATE_AR: Record<string, string> = { count: 'العدد', sum: 'مجموع', avg: 'متوسط', min: 'أدنى', max: 'أعلى' };

/** Arabic for stored codes (same wording as the staff app). */
const VALUE_AR: Record<string, string> = {
  pending: 'قيد الانتظار', confirmed: 'مؤكد', checked_in: 'تم الوصول', seated: 'جالس', dining: 'يتناول الطعام', completed: 'مكتمل',
  cancelled: 'ملغى', no_show: 'لم يحضر', rescheduled: 'أُعيدت جدولته', closed: 'مغلقة', open: 'مفتوحة', void: 'ملغاة', refunded: 'مستردة',
  phone: 'هاتف', walk_in: 'حضور مباشر', online: 'عبر الإنترنت', widget: 'موقع المطعم', whatsapp: 'واتساب', instagram: 'إنستغرام',
  facebook: 'فيسبوك', staff: 'الموظفون', event: 'مناسبة', other: 'أخرى',
  birthday: 'عيد ميلاد', anniversary: 'ذكرى زواج', engagement: 'خطوبة', wedding: 'زفاف', business_dinner: 'عشاء عمل', proposal: 'طلب زواج',
  graduation: 'تخرج', family_event: 'مناسبة عائلية',
  standard: 'عادي', silver: 'فضي', gold: 'ذهبي', platinum: 'بلاتيني', vip: 'كبار الشخصيات', vvip: 'كبار الشخصيات جداً',
  offline: 'دون اتصال', earn: 'كسب', redeem: 'استبدال', adjust: 'تعديل', expire: 'انتهاء', bonus: 'مكافأة',
  cash: 'نقداً', card: 'بطاقة', ar: 'العربية', en: 'English',
  Monday: 'الإثنين', Tuesday: 'الثلاثاء', Wednesday: 'الأربعاء', Thursday: 'الخميس', Friday: 'الجمعة', Saturday: 'السبت', Sunday: 'الأحد',
};

/** Columns holding stored codes (translated); free text such as names is never translated. */
const CODED_COLUMNS = new Set(['status', 'source', 'occasion', 'vipLevel', 'origin', 'type', 'paymentMethod', 'language', 'weekday']);

export interface PdfColumn {
  key: string;
  label: string;
  numeric: boolean;
  type: string;
  /** Totals are only meaningful for counts and sums. */
  summable: boolean;
}

export interface ReportPdfInput {
  lang: 'ar' | 'en';
  title: string;
  restaurant: string;
  meta: string[];
  generatedAt: string;
  columns: PdfColumn[];
  rows: Record<string, unknown>[];
  truncated: boolean;
}

const C = { wine: '#6B1420', wineDark: '#3E0B12', cream: '#F3E6D0', paper: '#FBF7F1', gold: '#C9A26B', text: '#2B1A17', muted: '#7A6A63', line: '#E7DCCD' };

function cell(value: unknown, col: PdfColumn, lang: 'ar' | 'en'): string {
  if (value === null || value === undefined || value === '') return '—';
  if (col.type === 'boolean' || typeof value === 'boolean') return value ? (lang === 'ar' ? 'نعم' : 'Yes') : lang === 'ar' ? 'لا' : 'No';
  if (value instanceof Date) return col.type === 'date' ? value.toISOString().slice(0, 10) : value.toISOString().slice(0, 16).replace('T', ' ');
  if (col.numeric && !Number.isNaN(Number(value))) return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(value));
  const s = String(value);
  return lang === 'ar' && CODED_COLUMNS.has(col.key) && VALUE_AR[s] ? VALUE_AR[s]! : s;
}

export async function renderReportPdf(input: ReportPdfInput): Promise<Buffer> {
  const rtl = input.lang === 'ar';
  const cells = input.rows.map((r) => input.columns.map((c) => cell(r[c.key], c, input.lang)));
  const totals = input.columns.some((c) => c.summable)
    ? input.columns.map((c, i) => (c.summable ? cell(input.rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0), c, input.lang) : i === 0 ? (rtl ? 'الإجمالي' : 'Total') : ''))
    : null;

  // Column widths from the content (header + up to 300 rows), fitted to the page.
  const FONT = 8.5;
  const PAD = 5;
  const probe = new BidiPdf({ rtl, landscape: false, title: input.title, author: input.restaurant });
  const natural = input.columns.map((c, i) => {
    let w = probe.width(c.label, 'bold', FONT);
    for (const row of cells.slice(0, 300)) w = Math.max(w, probe.width(row[i]!, 'regular', FONT));
    return Math.min(Math.max(w + PAD * 2, 38), 200);
  });
  const naturalTotal = natural.reduce((a, b) => a + b, 0);
  const landscape = naturalTotal > 523 || input.columns.length > 7;
  const pdf = new BidiPdf({ rtl, landscape, title: input.title, author: input.restaurant });
  const { doc } = pdf;
  const avail = pdf.right - pdf.left;
  const widths = natural.map((w) => (w / naturalTotal) * avail);
  // Physical x of each column: Arabic tables start at the right edge.
  const xs: number[] = [];
  let acc = 0;
  for (const w of widths) {
    xs.push(rtl ? pdf.right - acc - w : pdf.left + acc);
    acc += w;
  }
  // Numbers line up at the end of the cell; short numbers under a long header (counts, party sizes) are centred.
  const centred = input.columns.map((c, i) => c.numeric && natural[i]! - PAD * 2 > 2 * Math.max(0, ...cells.slice(0, 300).map((row) => probe.width(row[i]!, 'regular', FONT))));
  const alignOf = (c: PdfColumn): Align => (c.numeric ? (centred[input.columns.indexOf(c)] ? 'center' : 'end') : 'start');

  // ---- header (first page) -------------------------------------------------------------------------------------
  const logo = brandLogo();
  const top = doc.page.margins.top;
  if (logo) doc.image(logo, rtl ? pdf.left : pdf.right - 110, top - 6, { fit: [110, 54] });
  const textX = rtl ? pdf.left + 120 : pdf.left;
  const textW = avail - 120;
  pdf.text(input.title, textX, top, textW, { font: 'bold', size: 17, color: C.wineDark });
  pdf.text(input.restaurant, textX, top + 24, textW, { size: 10, color: C.wine });
  let y = top + 40;
  for (const line of input.meta) {
    pdf.text(line, textX, y, textW, { size: 8.5, color: C.muted });
    y += 12;
  }
  y = Math.max(y, top + 58) + 6;
  doc.moveTo(pdf.left, y).lineTo(pdf.right, y).lineWidth(1.2).strokeColor(C.gold).stroke();
  y += 10;

  const ROW = 16;
  const headerRow = () => {
    doc.rect(pdf.left, y, avail, ROW + 2).fill(C.wine);
    input.columns.forEach((c, i) => pdf.text(c.label, xs[i]! + PAD, y + 4, widths[i]! - PAD * 2, { font: 'bold', size: FONT, color: C.cream, align: alignOf(c) }));
    y += ROW + 2;
  };
  headerRow();

  const drawRow = (values: string[], i: number, bold = false) => {
    if (y + ROW > pdf.bottom - 14) {
      doc.addPage();
      y = doc.page.margins.top;
      headerRow();
    }
    if (bold) doc.rect(pdf.left, y, avail, ROW).fill(C.cream);
    else if (i % 2 === 1) doc.rect(pdf.left, y, avail, ROW).fill(C.paper);
    values.forEach((v, ci) => pdf.text(v, xs[ci]! + PAD, y + 4, widths[ci]! - PAD * 2, { font: bold ? 'bold' : 'regular', size: FONT, color: C.text, align: alignOf(input.columns[ci]!) }));
    doc.moveTo(pdf.left, y + ROW).lineTo(pdf.right, y + ROW).lineWidth(0.4).strokeColor(C.line).stroke();
    y += ROW;
  };
  if (!cells.length) {
    pdf.text(rtl ? 'لا توجد بيانات لهذه المعايير.' : 'No data for these criteria.', pdf.left, y + 10, avail, { size: 10, color: C.muted, align: 'center' });
  }
  cells.forEach((row, i) => drawRow(row, i));
  if (totals && cells.length) drawRow(totals, 0, true);
  if (input.truncated) {
    y += 8;
    pdf.text(rtl ? 'تم الوصول إلى الحد الأقصى لعدد الصفوف — ضيّق نطاق التقرير لعرض الباقي.' : 'Row limit reached — narrow the report to see the remaining rows.', pdf.left, y, avail, { size: 8, color: C.wine });
  }

  // ---- footer on every page --------------------------------------------------------------------------------------
  const range = doc.bufferedPageRange();
  for (let p = range.start; p < range.start + range.count; p++) {
    doc.switchToPage(p);
    const fy = doc.page.height - doc.page.margins.bottom + 14;
    // Writing into the bottom margin must not trigger PDFKit's automatic page break.
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.moveTo(pdf.left, fy - 4).lineTo(pdf.right, fy - 4).lineWidth(0.5).strokeColor(C.line).stroke();
    const page = rtl ? `صفحة ${p + 1} من ${range.count}` : `Page ${p + 1} of ${range.count}`;
    pdf.text(`${input.restaurant} · ${ltr(input.generatedAt)}`, rtl ? pdf.right - avail * 0.7 : pdf.left, fy, avail * 0.7, { size: 7.5, color: C.muted, align: 'start' });
    pdf.text(page, pdf.left, fy, avail, { size: 7.5, color: C.muted, align: 'end' });
    doc.page.margins.bottom = bottomMargin;
  }
  return pdf.toBuffer();
}
