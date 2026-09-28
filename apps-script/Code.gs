/**
 * Narra ↔ Google Sheets timesheet bridge.
 *
 * Paste this into Extensions → Apps Script of YOUR timesheet, deploy it as a web app
 * (Execute as: Me · Who has access: Anyone), and give Narra the web app URL plus the key
 * from the "🌼 Narra → Desktop app key…" menu.
 *
 * It adapts to the sheet instead of assuming fixed cells:
 *  - finds the header row by its labels ("Time In", "Time Out", "Total", "Day"/"Date"),
 *  - finds the tab and rows for a date by reading the date column,
 *  - works out how many in/out rows each day has.
 * A half-month tab still holding an older period (tabs named like "1-15" / "16-30") is
 * backed up to a hidden tab and reset with the new dates before writing.
 *
 * Times are exchanged with Narra as epoch milliseconds and written as Eastern wall-clock
 * times, as the timesheet template asks.
 */

const TZ = 'America/New_York';
const HOLIDAY = 'HOLIDAY';
const LEAVE = 'LEAVE';
const CREDIT_HOURS = 8;
const HEADER_SCAN_ROWS = 15;

// ---- Sheet menu ----

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🌼 Narra')
    .addItem('Desktop app key…', 'showApiKey')
    .addToUi();
}

function showApiKey() {
  SpreadsheetApp.getUi().alert('Narra app key', apiKey_(), SpreadsheetApp.getUi().ButtonSet.OK);
}

function apiKey_() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('API_KEY');
  if (!key) {
    key = Utilities.getUuid();
    props.setProperty('API_KEY', key);
  }
  return key;
}

// ---- JSON API (deployed as a web app) ----

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (_) {
    return json_({ ok: false, error: 'Bad request' });
  }
  const key = PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (!key || body.key !== key) return json_({ ok: false, error: 'Invalid key' });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    switch (body.action) {
      case 'sync':
        return json_({ ok: true, data: sync_(body.holidays || []) });
      case 'setDays':
        return json_({ ok: true, data: setDays_(body.days || {}) });
      default:
        return json_({ ok: false, error: 'Unknown action: ' + body.action + '. Update the script in your sheet.' });
    }
  } catch (err) {
    return json_({ ok: false, error: err.message });
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function book_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('This script must be created from inside the timesheet (Extensions → Apps Script).');
  return ss;
}

/** Roll the current tab forward if needed, credit holidays, and return every day. */
function sync_(holidays) {
  const ss = book_();
  const notes = [];
  const note = ensureDate_(ss, Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'));
  if (note) notes.push(note);
  applyHolidays_(ss, holidays);
  SpreadsheetApp.flush();
  const tabs = tabs_(ss).filter(t => !t.sheet.isSheetHidden());
  const days = {};
  const covered = [];
  tabs.forEach(tab => {
    Object.keys(tab.dates).forEach(date => {
      covered.push(date);
      const day = readDay_(tab, tab.dates[date], date);
      if (day) days[date] = day;
    });
  });
  const first = tabs[0];
  return {
    notes,
    days,
    covered,
    sheetUrl: ss.getUrl(),
    sheetName: ss.getName(),
    ownerName: first ? ownerName_(first) : '',
    monthlyRate: first ? monthlyRate_(first) : null,
  };
}

/** days: { 'yyyy-MM-dd': { sessions: [{start, end}], kind, hours } } */
function setDays_(days) {
  const ss = book_();
  const written = [];
  Object.keys(days).sort().forEach(date => {
    ensureDate_(ss, date);
    const hit = find_(ss, date);
    if (!hit) throw new Error('No row for ' + date + ' in the timesheet.');
    writeDay_(ss, hit.tab, hit.block, date, days[date] || {});
    written.push(date);
  });
  SpreadsheetApp.flush();
  return { written };
}

// ---- Layout discovery ----

/**
 * A tab that looks like a timesheet:
 * { sheet, headerRow, firstRow, rowsPerDay, col: { date, in, out, total },
 *   dates: { 'yyyy-MM-dd': { row, rows } } }
 */
function layout_(sheet) {
  const lastCol = Math.min(sheet.getLastColumn(), 26);
  const lastRow = sheet.getLastRow();
  if (lastCol < 3 || lastRow < 3) return null;
  const head = sheet.getRange(1, 1, Math.min(HEADER_SCAN_ROWS, lastRow), lastCol).getDisplayValues();
  for (let r = 0; r < head.length; r++) {
    const cells = head[r].map(v => String(v).trim().toLowerCase());
    const find = re => cells.findIndex(v => re.test(v)) + 1;
    const col = { in: find(/^time\s*in$/), out: find(/^time\s*out$/), total: find(/total/), date: find(/day|date/) };
    if (!col.in || !col.out) continue;
    if (!col.date) col.date = Math.max(1, col.in - 1);
    if (!col.total) col.total = col.out + 1;
    const headerRow = r + 1;
    const values = sheet.getRange(headerRow + 1, col.date, Math.max(1, lastRow - headerRow), 1).getValues();
    const tz = sheet.getParent().getSpreadsheetTimeZone();
    const starts = [];
    values.forEach((v, i) => {
      if (v[0] instanceof Date) starts.push({ row: headerRow + 1 + i, key: Utilities.formatDate(v[0], tz, 'yyyy-MM-dd') });
    });
    const gaps = starts.slice(1).map((s, i) => s.row - starts[i].row);
    const rowsPerDay = gaps.length ? Math.min.apply(null, gaps) : 2;
    const dates = {};
    starts.forEach((s, i) => {
      dates[s.key] = { row: s.row, rows: i + 1 < starts.length ? Math.min(starts[i + 1].row - s.row, rowsPerDay) : rowsPerDay };
    });
    return { sheet, headerRow, firstRow: headerRow + 1, rowsPerDay, col, dates };
  }
  return null;
}

function tabs_(ss) {
  return ss.getSheets().map(layout_).filter(Boolean);
}

function find_(ss, date) {
  for (const tab of tabs_(ss)) {
    if (tab.sheet.isSheetHidden()) continue;
    if (tab.dates[date]) return { tab, block: tab.dates[date] };
  }
  return null;
}

/** Name at the top of the timesheet: the first text cell above the header that isn't a label or date. */
function ownerName_(tab) {
  if (tab.headerRow < 2) return '';
  const rows = tab.sheet.getRange(1, 1, tab.headerRow - 1, Math.min(tab.sheet.getLastColumn(), 8)).getDisplayValues();
  for (const row of rows) {
    for (const v of row) {
      const t = String(v).trim();
      if (t && !/:$/.test(t) && !/timesheet|period|data/i.test(t) && !/\d{1,2}\/\d{1,2}/.test(t)) return t;
    }
  }
  return '';
}

/** Monthly rate: the number left of the "EXPECTED PAY" figure (one row up), if the sheet has one. */
function monthlyRate_(tab) {
  const s = tab.sheet;
  const range = s.getRange(1, 1, s.getLastRow(), Math.min(s.getLastColumn(), 26));
  const vals = range.getValues();
  const text = range.getDisplayValues();
  for (let r = 1; r < text.length; r++) {
    for (let c = 0; c < text[r].length; c++) {
      if (!/expected pay/i.test(text[r][c])) continue;
      for (let cc = c - 1; cc >= 0; cc--) {
        const v = vals[r - 1][cc];
        if (typeof v === 'number' && v > 0) return v;
      }
    }
  }
  return null;
}

// ---- Reading and writing days ----

function readDay_(tab, block, date) {
  const s = tab.sheet;
  const ins = s.getRange(block.row, tab.col.in, block.rows, 1).getValues().map(r => r[0]);
  const outs = s.getRange(block.row, tab.col.out, block.rows, 1).getValues().map(r => r[0]);
  const total = s.getRange(block.row, tab.col.total).getValue();
  const label = String(ins[0]).trim().toUpperCase();
  if (label === HOLIDAY || label === LEAVE) {
    return { sessions: [], kind: label.toLowerCase(), hours: typeof total === 'number' ? total : CREDIT_HOURS };
  }
  const sessions = [];
  for (let i = 0; i < block.rows; i++) {
    if (!(ins[i] instanceof Date)) continue;
    const start = wallClockMs_(date, ins[i], s);
    let end = outs[i] instanceof Date ? wallClockMs_(date, outs[i], s) : null;
    if (end !== null && end <= start) end += 24 * 3600 * 1000; // past midnight
    sessions.push({ start, end });
  }
  // Send the sheet's own total too, so Narra shows exactly what the sheet shows.
  if (sessions.length) {
    const closed = sessions.every(x => x.end !== null);
    return closed && typeof total === 'number' ? { sessions, hours: total } : { sessions };
  }
  if (typeof total === 'number' && total > 0) return { sessions: [], hours: total };
  return null;
}

function writeDay_(ss, tab, block, date, day) {
  const s = tab.sheet;
  const sessions = (day.sessions || []).slice().sort((a, b) => a.start - b.start);
  if (sessions.length > block.rows) {
    throw new Error('Your sheet has ' + block.rows + ' time rows per day; ' + date + ' has ' + sessions.length + ' sessions.');
  }
  const weekend = [0, 6].includes(new Date(date + 'T00:00:00Z').getUTCDay());
  const blank = weekend ? '--' : '';
  const credit = day.kind === 'leave' || day.kind === 'holiday';
  const rows = [];
  for (let i = 0; i < block.rows; i++) {
    const x = sessions[i];
    if (credit) rows.push([i === 0 ? day.kind.toUpperCase() : '', '']);
    else rows.push(x ? [timeSerial_(x.start), x.end ? timeSerial_(x.end) : ''] : [blank, blank]);
  }
  s.getRange(block.row, tab.col.in, block.rows, 1).setValues(rows.map(r => [r[0]]));
  s.getRange(block.row, tab.col.out, block.rows, 1).setValues(rows.map(r => [r[1]]));
  const totalCell = s.getRange(block.row, tab.col.total);
  if (credit) {
    totalCell.setValue(day.hours != null ? day.hours : CREDIT_HOURS);
  } else if (!sessions.length && day.hours != null) {
    totalCell.setValue(day.hours);
  } else if (!totalCell.getFormula()) {
    const formula = totalFormula_(ss);
    if (formula) totalCell.setFormulaR1C1(formula);
  }
}

/** The per-day TOTAL formula, borrowed from any day that still has it (R1C1, so it moves). */
function totalFormula_(ss) {
  for (const tab of tabs_(ss)) {
    for (const date of Object.keys(tab.dates)) {
      const f = tab.sheet.getRange(tab.dates[date].row, tab.col.total).getFormulaR1C1();
      if (f) return f;
    }
  }
  return '';
}

// ---- Holidays ----

/** Credit each weekday holiday that hasn't been used; un-credit days that are no longer holidays. */
function applyHolidays_(ss, holidays) {
  if (!holidays.length) return;
  const dates = new Set(holidays.map(h => h.date));
  tabs_(ss).forEach(tab => {
    if (tab.sheet.isSheetHidden()) return;
    Object.keys(tab.dates).forEach(date => {
      const block = tab.dates[date];
      const weekend = [0, 6].includes(new Date(date + 'T00:00:00Z').getUTCDay());
      const day = readDay_(tab, block, date);
      const marked = !!day && day.kind === 'holiday';
      const used = !!day && !marked;
      if (dates.has(date) && !weekend && !marked && !used) {
        writeDay_(ss, tab, block, date, { kind: 'holiday', hours: CREDIT_HOURS });
      } else if (marked && !dates.has(date)) {
        writeDay_(ss, tab, block, date, { sessions: [] });
      }
    });
  });
}

// ---- Rolling half-month tabs forward ----

function lastDayOfMonth_(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Make sure some visible tab has a row for `date`. If not, find the half-month tab for it
 * by name ("1-15", "16-28/29/30/31"), back its old period up to a hidden tab and reset it.
 */
function ensureDate_(ss, date) {
  if (find_(ss, date)) return '';
  const [y, m, d] = date.split('-').map(Number);
  const last = lastDayOfMonth_(y, m);
  const names = d <= 15 ? ['1-15'] : ['16-' + last, '16-31', '16-30', '16-29', '16-28'];
  let tab = null;
  for (const name of names) {
    const sheet = ss.getSheetByName(name);
    const layout = sheet && layout_(sheet);
    const slots = layout ? Object.keys(layout.dates).length : 0;
    if (slots >= (d <= 15 ? 15 : last - 15)) { tab = layout; break; }
  }
  if (!tab) throw new Error('No tab in the sheet has room for ' + date + '. Add that period\'s dates to a tab.');

  const start = d <= 15 ? 1 : 16;
  const end = d <= 15 ? 15 : last;
  const oldKeys = Object.keys(tab.dates).sort();
  if (oldKeys[0] >= date) throw new Error('Tab ' + tab.sheet.getName() + ' already holds a newer period.');

  const backup = tab.sheet.getName() + ' (' + Utilities.formatDate(new Date(oldKeys[0] + 'T12:00:00Z'), 'UTC', 'MMM yyyy') + ')';
  if (!ss.getSheetByName(backup)) tab.sheet.copyTo(ss).setName(backup).hideSheet();

  const formula = totalFormula_(ss);
  const per = tab.rowsPerDay;
  for (let i = 0; i < oldKeys.length; i++) {
    const day = start + i;
    const row = tab.firstRow + i * per;
    const inMonth = day <= end;
    const utc = Date.UTC(y, m - 1, day);
    const fill = inMonth && [0, 6].includes(new Date(utc).getUTCDay()) ? '--' : '';
    tab.sheet.getRange(row, tab.col.date).setValue(inMonth ? dateSerial_(utc) : '');
    const blanks = [];
    for (let r = 0; r < per; r++) blanks.push([fill]);
    tab.sheet.getRange(row, tab.col.in, per, 1).setValues(blanks);
    tab.sheet.getRange(row, tab.col.out, per, 1).setValues(blanks);
    if (formula) tab.sheet.getRange(row, tab.col.total).setFormulaR1C1(formula);
  }
  SpreadsheetApp.flush();
  return 'Started ' + m + '/' + start + '–' + m + '/' + end + ' in tab ' + tab.sheet.getName() +
    ' (old entries saved to hidden tab "' + backup + '")';
}

// ---- Cell helpers ----

/** Sheets time-of-day serial for instant ms, as an Eastern wall-clock time. */
function timeSerial_(ms) {
  const [h, m] = Utilities.formatDate(new Date(ms), TZ, 'H:m').split(':').map(Number);
  return (h * 60 + m) / 1440;
}

/** Epoch ms of a time-of-day cell on date, read as Eastern wall-clock time. */
function wallClockMs_(date, timeValue, sheet) {
  const hm = Utilities.formatDate(timeValue, sheet.getParent().getSpreadsheetTimeZone(), 'HH:mm');
  return Utilities.parseDate(date + ' ' + hm, TZ, 'yyyy-MM-dd HH:mm').getTime();
}

/** Sheets date serial (days since 1899-12-30) for a UTC-midnight timestamp. */
function dateSerial_(utc) {
  return (utc - Date.UTC(1899, 11, 30)) / 86400000;
}
