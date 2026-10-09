import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { Column } from './reports';

export interface ExportInput {
  title: string;
  subtitle: string;
  columns: Column[];
  rows: Record<string, unknown>[];
  totals: Record<string, number>;
  timezone: string;
}

const eur = new Intl.NumberFormat('de-AT', { style: 'currency', currency: 'EUR' });
const num = new Intl.NumberFormat('de-AT');

function display(c: Column, v: unknown, tz: string): string {
  if (v === null || v === undefined || v === '') return '';
  switch (c.type) {
    case 'money': return eur.format(Number(v));
    case 'number': return num.format(Number(v));
    case 'percent': return `${(Number(v) * 100).toFixed(2)} %`;
    case 'datetime': return new Date(v as string).toLocaleString('de-AT', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' });
    case 'date': return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
    default: return String(v);
  }
}

/** Raw (machine readable) value for CSV: ISO dates, dot decimals. */
function raw(c: Column, v: unknown): string {
  if (v === null || v === undefined) return '';
  if (c.type === 'datetime' || c.type === 'date') return v instanceof Date ? v.toISOString() : String(v);
  if (c.type === 'money') return Number(v).toFixed(2);
  if (c.type === 'percent') return Number(v).toFixed(4);
  return String(v);
}

export function toCsv(e: ExportInput): string {
  const esc = (s: string) => (/[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [e.columns.map((c) => esc(c.label)).join(',')];
  for (const row of e.rows) lines.push(e.columns.map((c) => esc(raw(c, row[c.key]))).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n'; // BOM so Excel opens UTF-8 correctly
}

export async function toXlsx(e: ExportInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'M1 Casino Cloud';
  const ws = wb.addWorksheet(e.title.slice(0, 31));
  ws.addRow([e.title]).font = { bold: true, size: 14 };
  ws.addRow([e.subtitle]).font = { color: { argb: 'FF666666' } };
  ws.addRow([]);
  const header = ws.addRow(e.columns.map((c) => c.label));
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.eachCell((cell) => (cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6D28D9' } }));
  for (const row of e.rows) {
    ws.addRow(
      e.columns.map((c) => {
        const v = row[c.key];
        if (v === null || v === undefined) return null;
        if (c.type === 'money' || c.type === 'number' || c.type === 'percent') return Number(v);
        if (c.type === 'datetime' || c.type === 'date') return new Date(v as string);
        return String(v);
      }),
    );
  }
  if (Object.keys(e.totals).length) {
    const t = ws.addRow(e.columns.map((c, i) => (i === 0 ? 'Total' : c.key in e.totals ? e.totals[c.key] : null)));
    t.font = { bold: true };
  }
  e.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = c.type === 'text' ? 22 : c.type === 'datetime' ? 18 : 14;
    if (c.type === 'money') col.numFmt = '#,##0.00 [$€-de-AT]';
    if (c.type === 'percent') col.numFmt = '0.00%';
    if (c.type === 'datetime') col.numFmt = 'dd.mm.yyyy hh:mm';
    if (c.type === 'date') col.numFmt = 'dd.mm.yyyy';
  });
  ws.views = [{ state: 'frozen', ySplit: 4 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function toPdf(e: ExportInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true, info: { Title: e.title, Creator: 'M1 Casino Cloud' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const weights = e.columns.map((c) => (c.type === 'text' ? 2 : c.type === 'datetime' ? 1.6 : 1.2));
    const sum = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (w / sum) * width);
    const right = (c: Column) => c.type === 'money' || c.type === 'number' || c.type === 'percent';
    const rowH = 16;

    const drawRow = (cells: string[], opts: { bold?: boolean; fill?: string; color?: string } = {}) => {
      if (doc.y + rowH > doc.page.height - doc.page.margins.bottom - 14) {
        doc.addPage();
        drawHeader();
      }
      const y = doc.y;
      if (opts.fill) doc.rect(left, y - 3, width, rowH).fill(opts.fill);
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(opts.color ?? '#111111');
      let x = left;
      cells.forEach((text, i) => {
        doc.text(text, x + 3, y, { width: widths[i] - 6, align: right(e.columns[i]) ? 'right' : 'left', lineBreak: false, ellipsis: true });
        x += widths[i];
      });
      doc.y = y + rowH;
    };
    const drawHeader = () => drawRow(e.columns.map((c) => c.label), { bold: true, fill: '#6d28d9', color: '#ffffff' });

    doc.font('Helvetica-Bold').fontSize(16).fillColor('#111111').text(e.title, left, doc.y);
    doc.font('Helvetica').fontSize(9).fillColor('#555555').text(e.subtitle);
    doc.moveDown(0.8);
    drawHeader();
    e.rows.forEach((row, i) => drawRow(e.columns.map((c) => display(c, row[c.key], e.timezone)), { fill: i % 2 ? '#f3f4f6' : undefined }));
    if (Object.keys(e.totals).length)
      drawRow(e.columns.map((c, i) => (i === 0 ? 'Total' : c.key in e.totals ? display(c, e.totals[c.key], e.timezone) : '')), { bold: true, fill: '#e5e7eb' });

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // footer sits inside the bottom margin
      doc.font('Helvetica').fontSize(7).fillColor('#888888')
        .text(`M1 Casino Cloud · generated ${new Date().toISOString()} · page ${i + 1}/${range.count}`, left, doc.page.height - 28, { width, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}
