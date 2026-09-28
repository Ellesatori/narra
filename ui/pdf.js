// Builds the timesheet PDF in the same layout as the Google Sheets template's PDF export:
// name + period header, a green "TIMESHEET DATA" table with two in/out rows per day,
// a TOTAL HOURS column, then overtime / regular hours and expected pay.
// Pure JS, no libraries: a one-page PDF using the built-in Helvetica fonts.

const PDF_PAGE = { w: 595.28, h: 841.89 }; // A4, points

// Glyph widths (per 1000 em) for ASCII 32..126 — Helvetica and Helvetica-Bold (Adobe AFM).
const PDF_WIDTHS = {
  F1: [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584],
  F2: [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584],
};

const PDF_COLORS = {
  ink: [0.2, 0.2, 0.2],
  muted: [0.33, 0.35, 0.38],
  faint: [0.8, 0.8, 0.8],
  green: [0.22, 0.46, 0.11],   // #38761d
  greenSoft: [0.85, 0.92, 0.83], // #d9ead3
  leave: [1, 0.95, 0.8],         // #fff2cc
  line: [0.55, 0.55, 0.55],
  white: [1, 1, 1],
};

/** Keep text printable ASCII (the built-in fonts' safe range). */
function pdfAscii(text) {
  return String(text)
    .replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '?');
}

function pdfTextWidth(text, font, size) {
  let w = 0;
  for (const ch of text) w += PDF_WIDTHS[font][ch.charCodeAt(0) - 32] || 556;
  return (w * size) / 1000;
}

function pdfEscape(text) {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Tiny drawing API over a PDF content stream. y is measured from the TOP of the page. */
function pdfCanvas() {
  const ops = [];
  const Y = y => (PDF_PAGE.h - y).toFixed(2);
  const rgb = c => c.map(v => v.toFixed(3)).join(' ');
  return {
    ops,
    rect(x, y, w, h, fill) {
      ops.push(`${rgb(fill)} rg ${x.toFixed(2)} ${Y(y + h)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
    },
    line(x1, y1, x2, y2, color = PDF_COLORS.line, width = 0.5) {
      ops.push(`${rgb(color)} RG ${width} w ${x1.toFixed(2)} ${Y(y1)} m ${x2.toFixed(2)} ${Y(y2)} l S`);
    },
    /** align: 'left' | 'center' | 'right' within [x, x + w]; y is the text baseline. */
    text(str, x, y, { size = 8, bold = false, color = PDF_COLORS.ink, align = 'left', w = 0 } = {}) {
      const s = pdfAscii(str);
      const font = bold ? 'F2' : 'F1';
      const tw = pdfTextWidth(s, font, size);
      const tx = align === 'center' ? x + (w - tw) / 2 : align === 'right' ? x + w - tw : x;
      ops.push(`BT /${font} ${size} Tf ${rgb(color)} rg ${tx.toFixed(2)} ${Y(y)} Td (${pdfEscape(s)}) Tj ET`);
    },
  };
}

/** Serialize a one-page PDF around a content stream. Output is pure ASCII. */
function pdfDocument(content) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE.w} ${PDF_PAGE.h}] ` +
      '/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

/**
 * sheet: { name, periodText, days: [{ label, weekend, type, hours, sessions: [{start,end}] }],
 *          total, overtime, regular, rate, pay }
 */
function timesheetPdf(sheet) {
  const c = pdfCanvas();
  const C = PDF_COLORS;
  // Column edges (points), measured from the template's export.
  const X = { left: 117, day: 216, in: 331, out: 426, right: 524 };
  const rowH = 14.2;

  // Header: name and period.
  c.text(sheet.name || '', X.left + 3, 80, { size: 14, bold: true, color: [0, 0, 0] });
  c.text('PERIOD:', 360, 80, { size: 8.5, bold: true, color: C.muted, w: 60, align: 'right' });
  c.text(sheet.periodText, 426, 80, { size: 8.5, color: [0, 0, 0], w: X.right - 426, align: 'center' });
  for (let x = 426; x < X.right; x += 2.2) c.line(x, 85, x + 1.1, 85, C.muted, 0.5);

  // Title band and column headers.
  let y = 107;
  c.rect(X.left, y, X.right - X.left, 18, C.greenSoft);
  c.text('TIMESHEET DATA', X.left, y + 12.5, { size: 10, bold: true, color: [0.27, 0.27, 0.27], w: X.right - X.left, align: 'center' });
  y += 18;
  c.rect(X.left, y, X.right - X.left, 24, C.green);
  c.text('Day, Date', X.left, y + 15, { size: 8, bold: true, color: C.white, w: X.day - X.left - 3, align: 'right' });
  c.text('Time In', X.day, y + 15, { size: 8, bold: true, color: C.white, w: X.in - X.day, align: 'center' });
  c.text('Time Out', X.in, y + 15, { size: 8, bold: true, color: C.white, w: X.out - X.in, align: 'center' });
  c.text('TOTAL HOURS', X.out, y + 15, { size: 8, bold: true, color: C.white, w: X.right - X.out, align: 'center' });
  c.line(X.in, y, X.in, y + 24, C.white, 0.5);
  c.line(X.day, y, X.day, y + 24, C.white, 0.5);
  y += 24;
  const tableTop = y;

  for (const d of sheet.days) {
    const rows = Math.max(2, d.sessions.length);
    const h = rows * rowH;
    c.rect(X.out, y, X.right - X.out, h, C.greenSoft);
    c.text(d.label, X.left, y + 10, { size: 8, bold: true, color: [0.25, 0.25, 0.25], w: X.day - X.left - 3, align: 'right' });
    if (d.type === 'leave' || d.type === 'holiday') {
      c.rect(X.day, y, X.out - X.day, h, C.leave);
      c.text(d.type.toUpperCase(), X.day, y + h / 2 + 3, { size: 8, color: [0.3, 0.3, 0.3], w: X.out - X.day, align: 'center' });
    } else {
      for (let r = 0; r < rows; r++) {
        const s = d.sessions[r];
        const ry = y + r * rowH + 10;
        const blank = d.weekend && !s ? '--' : '';
        c.text(s ? clock(s.start) : blank, X.day, ry, { size: 8, color: C.muted, w: X.in - X.day, align: 'center' });
        c.text(s && s.end ? clock(s.end) : blank, X.in, ry, { size: 8, color: C.muted, w: X.out - X.in, align: 'center' });
        if (r < rows - 1) c.line(X.day, y + (r + 1) * rowH, X.out, y + (r + 1) * rowH, C.line, 0.4);
      }
      c.line(X.in, y, X.in, y + h, C.line, 0.4);
    }
    c.text(hours(d.hours), X.out, y + h / 2 + 3, { size: 8.5, bold: true, color: [0.25, 0.25, 0.25], w: X.right - X.out, align: 'center' });
    y += h;
    c.line(X.left, y, X.right, y, C.line, 0.5);
  }
  // Table frame: left edge, day divider, thick total-column divider.
  c.line(X.left, tableTop, X.left, y, C.line, 0.5);
  c.line(X.day, tableTop, X.day, y, C.line, 0.5);
  c.line(X.right, tableTop, X.right, y, C.line, 0.5);
  c.line(X.out, tableTop - 24, X.out, y + 28, [0.5, 0.5, 0.5], 2);

  // Grand total.
  c.rect(X.out, y, X.right - X.out, 28, C.green);
  c.text(hours(sheet.total), X.out, y + 17.5, { size: 9, bold: true, color: C.white, w: X.right - X.out, align: 'center' });
  y += 28;

  // Overtime | regular hours.
  y += 30;
  c.text(hours(sheet.overtime), 331, y + 14, { size: 12, bold: true, color: [0.27, 0.29, 0.31], w: 95, align: 'center' });
  c.text(hours(sheet.regular), X.out, y + 14, { size: 12, bold: true, color: [0.27, 0.29, 0.31], w: X.right - X.out, align: 'center' });
  c.line(331, y + 21, 421, y + 21, C.green, 1.5);
  c.line(X.out, y + 21, X.right, y + 21, C.green, 1.5);
  c.line(X.out - 1, y - 2, X.out - 1, y + 38, [0.5, 0.5, 0.5], 2);
  c.text('OVERTIME', 331, y + 32, { size: 7.5, bold: true, color: C.muted, w: 90, align: 'center' });
  c.text('REGULAR HRS', X.out, y + 32, { size: 7.5, bold: true, color: C.muted, w: X.right - X.out, align: 'center' });

  // Expected pay (the monthly rate sits faintly to the left, as in the template).
  y += 60;
  if (sheet.rate) c.text(money(sheet.rate), 331, y + 22, { size: 8.5, color: C.faint, w: 90, align: 'center' });
  c.text(sheet.pay != null ? money(sheet.pay) : '-', X.out, y + 14, { size: 12, bold: true, color: [0.27, 0.29, 0.31], w: X.right - X.out, align: 'center' });
  c.line(X.out, y + 21, X.right, y + 21, C.green, 1.5);
  c.text('EXPECTED PAY', X.out, y + 32, { size: 7.5, bold: true, color: C.muted, w: X.right - X.out, align: 'center' });

  return pdfDocument(c.ops.join('\n'));
}

/** The PDF for a period built by buildPeriod(). */
function periodPdf(view, period) {
  const rate = view.monthly_rate || null;
  const p = payFor(period, period.total, rate);
  return timesheetPdf({
    name: view.name,
    periodText: period.periodText,
    days: period.days,
    total: period.total,
    overtime: p.overtime,
    regular: p.regular,
    rate,
    pay: p.pay,
  });
}
