import { existsSync } from 'node:fs';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import bidiFactory from 'bidi-js';
import { config } from '../config.js';

/**
 * Server-side PDF for reports, in Arabic (right-to-left) or English.
 *
 * PDFKit shapes Arabic letters (via fontkit) but lays a line out left-to-right, which scrambles the word order of
 * Arabic and of mixed Arabic/number/Latin text. Every string is therefore split into bidirectional runs with the
 * Unicode Bidirectional Algorithm (bidi-js), the runs are put into visual order (rule L2), brackets are mirrored in
 * right-to-left runs (L4), and each run is drawn separately at its own position. fontkit then shapes each Arabic
 * run and orders its glyphs right-to-left.
 */

const bidi = bidiFactory();
/**
 * Without explicit features PDFKit shapes text word by word (a cache optimisation), which reverses each Arabic word
 * separately and moves the spaces to the wrong side. An explicit (empty) feature list makes it shape the whole run;
 * fontkit still applies the script's default features (init/medi/fina/liga/kern …).
 */
const WHOLE_RUN = { features: [] as PDFKit.Mixins.OpenTypeFeatures[] };
const RTL_LETTERS = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
/** Invisible bidi controls (marks, embeddings, isolates): they steer the algorithm but are never drawn. */
const BIDI_CONTROLS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Keeps a left-to-right value (date, time, code, amount) intact inside Arabic text. Without the isolate, digits
 * after Arabic letters become "Arabic numbers" and 2026-11-18 is displayed as 18-11-2026 (as in browsers).
 */
export function ltr(value: string): string {
  return `\u2066${value}\u2069`;
}

export interface VisualRun {
  text: string;
  rtl: boolean;
}

/** Splits text into runs of one direction, in visual (left-to-right on the page) order. */
export function visualRuns(text: string, baseRtl: boolean): VisualRun[] {
  if (!text) return [];
  const embedding = bidi.getEmbeddingLevels(text, baseRtl ? 'rtl' : 'ltr');
  const levels = embedding.levels;
  const mirrored: Map<number, string> = bidi.getMirroredCharactersMap(text, levels);
  const runs: { start: number; end: number; level: number }[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || levels[i] !== levels[start]) {
      runs.push({ start, end: i, level: levels[start]! });
      start = i;
    }
  }
  const max = Math.max(...runs.map((r) => r.level));
  const min = Math.min(...runs.map((r) => r.level));
  const lowestOdd = min % 2 === 1 ? min : min + 1;
  let order = runs;
  for (let level = max; level >= lowestOdd; level--) {
    const next: typeof runs = [];
    for (let i = 0; i < order.length; ) {
      if (order[i]!.level >= level) {
        let j = i;
        while (j < order.length && order[j]!.level >= level) j++;
        next.push(...order.slice(i, j).reverse());
        i = j;
      } else next.push(order[i++]!);
    }
    order = next;
  }
  return order
    .map((r) => {
      let s = '';
      for (let i = r.start; i < r.end; i++) s += mirrored.get(i) ?? text[i];
      return { text: s.replace(BIDI_CONTROLS, ''), rtl: r.level % 2 === 1 };
    })
    .filter((r) => r.text.length > 0);
}

export type Align = 'start' | 'end' | 'center';

export class BidiPdf {
  readonly doc: PDFKit.PDFDocument;
  readonly rtl: boolean;

  constructor(opts: { rtl: boolean; landscape: boolean; title: string; author: string }) {
    this.rtl = opts.rtl;
    this.doc = new PDFDocument({
      size: 'A4',
      layout: opts.landscape ? 'landscape' : 'portrait',
      margins: { top: 36, bottom: 40, left: 36, right: 36 },
      bufferPages: true,
      info: { Title: opts.title, Author: opts.author, Creator: "Sofia's Resto-Lounge", Producer: "Sofia's Resto-Lounge" },
      lang: opts.rtl ? 'ar' : 'en',
    } as PDFKit.PDFDocumentOptions);
    const fonts = assetPath('fonts');
    this.doc.registerFont('regular', join(fonts, 'IBMPlexSansArabic-Regular.ttf'));
    this.doc.registerFont('bold', join(fonts, 'IBMPlexSansArabic-Bold.ttf'));
    this.doc.font('regular');
  }

  get left(): number {
    return this.doc.page.margins.left;
  }
  get right(): number {
    return this.doc.page.width - this.doc.page.margins.right;
  }
  get bottom(): number {
    return this.doc.page.height - this.doc.page.margins.bottom;
  }

  width(text: string, font: 'regular' | 'bold', size: number): number {
    this.doc.font(font).fontSize(size);
    return this.doc.widthOfString(text.replace(BIDI_CONTROLS, ''), WHOLE_RUN);
  }

  /** Longest prefix of `text` (plus an ellipsis) that fits into `max` points. */
  fit(text: string, font: 'regular' | 'bold', size: number, max: number): string {
    if (this.width(text, font, size) <= max) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.width(`${text.slice(0, mid).trimEnd()}…`, font, size) <= max) lo = mid;
      else hi = mid - 1;
    }
    return lo ? `${text.slice(0, lo).trimEnd()}…` : '';
  }

  /**
   * Draws one line of text inside [x, x + w]. `start` is the right edge in Arabic documents and the left edge in
   * English ones; the text's own direction is resolved per run.
   */
  text(raw: string, x: number, y: number, w: number, o: { font?: 'regular' | 'bold'; size?: number; color?: string; align?: Align } = {}): void {
    const font = o.font ?? 'regular';
    const size = o.size ?? 9;
    const text = this.fit(raw.replace(/\s+/g, ' ').trim(), font, size, w);
    if (!text) return;
    const runs = visualRuns(text, this.rtl);
    const widths = runs.map((r) => this.width(r.text, font, size));
    const total = widths.reduce((a, b) => a + b, 0);
    const align = o.align ?? 'start';
    const atRight = (align === 'start' && this.rtl) || (align === 'end' && !this.rtl);
    let cx = align === 'center' ? x + (w - total) / 2 : atRight ? x + w - total : x;
    this.doc.font(font).fontSize(size).fillColor(o.color ?? '#2B1A17');
    runs.forEach((r, i) => {
      // fontkit reverses Arabic runs itself; a right-to-left run without Arabic letters (e.g. brackets) is reversed here.
      const glyphs = r.rtl && !RTL_LETTERS.test(r.text) ? [...r.text].reverse().join('') : r.text;
      this.doc.text(glyphs, cx, y, { lineBreak: false, ...WHOLE_RUN });
      cx += widths[i]!;
    });
  }

  async toBuffer(): Promise<Buffer> {
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
      this.doc.on('data', (c: Buffer) => chunks.push(c));
      this.doc.on('end', () => resolve(Buffer.concat(chunks)));
      this.doc.on('error', reject);
      this.doc.end();
    });
  }
}

export function assetPath(...parts: string[]): string {
  return join(config.assetsDir, ...parts);
}

export function brandLogo(): string | null {
  const p = assetPath('brand', 'sofia-logo-burgundy.png');
  return existsSync(p) ? p : null;
}
