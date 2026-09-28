/**
 * Narra API for "Biweekly Timesheet (Monthly)".
 *
 * The Narra desktop app POSTs JSON here ({ key, action, ... }); the sheet also
 * gets a "🌼 Narra" menu with the same Time In / Time Out actions.
 *
 * Layout: tabs 1-15 / 16-28 / 16-30 / 16-31, days start at row 5, 2 rows per day
 * (before / after lunch). Times are Eastern, as the template asks. A tab that still
 * holds an older period is backed up to a hidden tab and reset for the new one.
 */

const SHEET_ID = '14sMZgxOqTE2QahXwPJ31bG45JuFf5v6qKJLrIKhUy0c';
const TZ = 'America/New_York';
const FIRST_ROW = 5;
const COL = { DATE: 2, IN: 3, OUT: 4, TOTAL: 6 };
const HOLIDAY = 'HOLIDAY';
const HOLIDAY_HOURS = 8;
const TAB_NAME = /^(\d+)-(\d+)\b/;

// ---- Sheet menu ----

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🌼 Narra')
    .addItem('Time In', 'menuTimeIn')
    .addItem('Time Out', 'menuTimeOut')
    .addSeparator()
    .addItem('Desktop app key…', 'showApiKey')
    .addToUi();
}

function menuTimeIn() { menuPunch_('in'); }
function menuTimeOut() { menuPunch_('out'); }

function menuPunch_(kind) {
  try {
    const result = punch_(kind, new Date());
    const ss = SpreadsheetApp.getActive();
    ss.getSheetByName(result.tab).activate();
    ss.toast(result.message, '🌼 Narra', 6);
  } catch (e) {
    SpreadsheetApp.getUi().alert(e.message);
  }
}

function showApiKey() {
  SpreadsheetApp.getUi().alert('Desktop app key', apiKey_(), SpreadsheetApp.getUi().ButtonSet.OK);
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
      case 'punch': {
        const at = body.at ? new Date(body.at) : new Date();
        const result = punch_(body.kind, at);
        return json_({ ok: true, data: { message: result.message, status: status_(new Date()) } });
      }
      default:
        return json_({ ok: false, error: 'Unknown action: ' + body.action });
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

/** Roll today's tab forward if needed, mark holidays, and return everything the app shows. */
function sync_(holidays) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const now = new Date();
  const notes = [];
  const ctx = ctx_(now);
  const sheet = tabFor_(ss, ctx);
  const note = ensurePeriod_(ss, sheet, ctx);
  if (note) notes.push(note);
  applyHolidays_(ss, holidays);
  SpreadsheetApp.flush();
  return { notes, status: status_(now), timesheets: timesheets_(ss) };
}

// ---- Punching ----

function punch_(kind, at) {
  if (isNaN(at.getTime())) throw new Error('Bad timestamp');
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const ctx = ctx_(at);
  const sheet = tabFor_(ss, ctx);
  const note = ensurePeriod_(ss, sheet, ctx);
  const row = rowFor_(sheet, ctx);

  // Working on a holiday: drop the holiday credit and log real times instead.
  if (isHoliday_(sheet.getRange(row, COL.IN).getValue())) clearHoliday_(ss, sheet, row);

  const slots = readSlots_(sheet, row);
  const open = slots.find(s => !blank_(s.in) && blank_(s.out));
  const time = timeSerial_(at);
  const label = Utilities.formatDate(at, TZ, 'h:mm a');

  if (kind === 'in') {
    if (open) throw new Error('Already timed in since ' + open.inText + '. Time out first.');
    const free = slots.find(s => blank_(s.in));
    if (!free) throw new Error('Both time slots for ' + ctx.label + ' are used. Edit the sheet directly.');
    sheet.getRange(free.row, COL.IN, 1, 2).setValues([[time, blank_(free.out) ? '' : free.out]]);
  } else if (kind === 'out') {
    if (!open) throw new Error('No open Time In for ' + ctx.label + '.');
    sheet.getRange(open.row, COL.OUT).setValue(time);
  } else {
    throw new Error('Unknown punch: ' + kind);
  }
  SpreadsheetApp.flush();

  const message = (kind === 'in' ? 'Timed in at ' : 'Timed out at ') + label + ' ET' + (note ? '. ' + note : '');
  return { tab: sheet.getName(), message };
}

function status_(now) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const ctx = ctx_(now);
  const sheet = tabFor_(ss, ctx);
  const row = rowFor_(sheet, ctx);
  const current = sameDay_(sheet.getRange(row, COL.DATE).getValue(), ctx, ss);
  const slots = current ? readSlots_(sheet, row) : [];
  const open = slots.find(s => !blank_(s.in) && blank_(s.out));
  const holiday = slots.length > 0 && isHoliday_(slots[0].in);
  return {
    date: ctx.key,
    label: ctx.label,
    tab: sheet.getName(),
    holiday,
    open: !!open,
    sinceMs: open ? wallClockMs_(ctx, open.in, ss) : null,
    slots: holiday ? [] : slots
      .filter(s => !blank_(s.in))
      .map(s => ({ in: s.inText, out: blank_(s.out) ? '' : s.outText })),
    hours: current ? Number(sheet.getRange(row, COL.TOTAL).getValue()) || 0 : 0,
  };
}

// ---- Timesheets (all tabs, including hidden backups) ----

function timesheets_(ss) {
  const tz = ss.getSpreadsheetTimeZone();
  const out = [];
  ss.getSheets().forEach(sheet => {
    const layout = tabLayout_(sheet.getName());
    if (!layout) return;
    const rows = layout.days * 2;
    const range = sheet.getRange(FIRST_ROW, COL.DATE, rows, COL.TOTAL - COL.DATE + 1);
    const values = range.getValues();
    const text = range.getDisplayValues();
    const days = [];
    for (let i = 0; i < rows; i += 2) {
      const date = values[i][0];
      if (!(date instanceof Date)) continue;
      const iso = Utilities.formatDate(date, tz, 'yyyy-MM-dd');
      const slot = r => [text[r][1], text[r][2]].map(t => (/^[-\s]*$/.test(t) ? '' : t));
      days.push({
        date: iso,
        label: text[i][0],
        slots: [slot(i), slot(i + 1)],
        hours: Number(values[i][4]) || 0,
        holiday: isHoliday_(values[i][1]),
        weekend: [0, 6].includes(new Date(iso + 'T00:00:00Z').getUTCDay()),
      });
    }
    if (!days.length) return;
    out.push({
      name: sheet.getName(),
      gid: sheet.getSheetId(),
      hidden: sheet.isSheetHidden(),
      period: sheet.getRange('E1').getDisplayValue(),
      start: days[0].date,
      end: days[days.length - 1].date,
      days,
      summary: summary_(sheet, FIRST_ROW + rows),
    });
  });
  out.sort((a, b) => (a.start < b.start ? 1 : -1));
  return out;
}

/** Totals block under the days: each label ("OVERTIME", "EXPECTED PAY", …) sits below its value. */
function summary_(sheet, totalRow) {
  const block = sheet.getRange(totalRow, 1, 9, COL.TOTAL).getDisplayValues();
  const summary = { totalHours: block[0][COL.TOTAL - 1] };
  const labels = { 'OVERTIME': 'overtime', 'REGULAR HRS': 'regularHours', 'EXPECTED PAY': 'expectedPay' };
  for (let r = 1; r < block.length; r++) {
    for (let c = 0; c < block[r].length; c++) {
      const field = labels[block[r][c].trim().toUpperCase()];
      if (field) summary[field] = block[r - 1][c];
      if (field === 'expectedPay') summary.monthlyRate = block[r - 1][COL.IN];
    }
  }
  return summary;
}

// ---- Holidays ----

/**
 * Mark each weekday holiday found in a tab (and not worked) as "Holiday" with 8 hours;
 * un-mark days that are no longer holidays. holidays: [{ date: 'yyyy-MM-dd', name }].
 */
function applyHolidays_(ss, holidays) {
  const dates = new Set(holidays.map(h => h.date));
  const tz = ss.getSpreadsheetTimeZone();
  ss.getSheets().forEach(sheet => {
    const layout = tabLayout_(sheet.getName());
    if (!layout || sheet.isSheetHidden()) return;
    const rows = layout.days * 2;
    const values = sheet.getRange(FIRST_ROW, COL.DATE, rows, 3).getValues();
    for (let i = 0; i < rows; i += 2) {
      const date = values[i][0];
      if (!(date instanceof Date)) continue;
      const iso = Utilities.formatDate(date, tz, 'yyyy-MM-dd');
      const weekend = [0, 6].includes(new Date(iso + 'T00:00:00Z').getUTCDay());
      const marked = isHoliday_(values[i][1]);
      const worked = [values[i], values[i + 1]].some(v => !blank_(v[1]) && !isHoliday_(v[1]) || !blank_(v[2]) && !isHoliday_(v[2]));
      const row = FIRST_ROW + i;
      if (dates.has(iso) && !weekend && !marked && !worked) {
        sheet.getRange(row, COL.IN, 2, 2).setValues([[HOLIDAY, ''], ['', '']]);
        sheet.getRange(row, COL.TOTAL).setValue(HOLIDAY_HOURS);
      } else if (marked && !dates.has(iso)) {
        clearHoliday_(ss, sheet, row);
      }
    }
  });
}

function clearHoliday_(ss, sheet, row) {
  sheet.getRange(row, COL.IN, 2, 2).setValues([['', ''], ['', '']]);
  const formula = totalFormula_(ss);
  if (formula) sheet.getRange(row, COL.TOTAL).setFormulaR1C1(formula);
}

/** The per-day TOTAL HOURS formula, borrowed from any day that still has it. */
function totalFormula_(ss) {
  for (const sheet of ss.getSheets()) {
    const layout = tabLayout_(sheet.getName());
    if (!layout) continue;
    const formulas = sheet.getRange(FIRST_ROW, COL.TOTAL, layout.days * 2, 1).getFormulasR1C1();
    const hit = formulas.find(f => f[0]);
    if (hit) return hit[0];
  }
  return '';
}

// ---- Period / tab layout ----

/** Date parts of at in Eastern time. */
function ctx_(at) {
  const [y, m, d] = Utilities.formatDate(at, TZ, 'yyyy-M-d').split('-').map(Number);
  const pad = n => (n < 10 ? '0' : '') + n;
  return { y, m, d, key: y + '-' + pad(m) + '-' + pad(d), label: Utilities.formatDate(at, TZ, 'EEE, MMM d') };
}

function lastDayOfMonth_(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** "1-15", "16-30", "16-30 (Jun 2026)" -> first day and number of day blocks. */
function tabLayout_(name) {
  const match = TAB_NAME.exec(name);
  if (!match) return null;
  const start = Number(match[1]);
  return { start, days: Number(match[2]) - start + 1 };
}

function tabFor_(ss, ctx) {
  if (ctx.d <= 15) {
    const sheet = ss.getSheetByName('1-15');
    if (!sheet) throw new Error('Tab "1-15" not found.');
    return sheet;
  }
  const last = lastDayOfMonth_(ctx.y, ctx.m);
  for (const name of ['16-' + last, '16-30', '16-31']) {
    const sheet = ss.getSheetByName(name);
    if (sheet && tabLayout_(name).days >= last - 15) return sheet;
  }
  throw new Error('Tab "16-' + last + '" not found.');
}

function rowFor_(sheet, ctx) {
  return FIRST_ROW + 2 * (ctx.d - tabLayout_(sheet.getName()).start);
}

function sameDay_(value, ctx, ss) {
  return value instanceof Date && Utilities.formatDate(value, ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd') === ctx.key;
}

/**
 * Make sure sheet holds the period containing ctx. If it still holds an older period,
 * back it up to a hidden tab and reset it. Returns a note when a reset happened.
 */
function ensurePeriod_(ss, sheet, ctx) {
  const row = rowFor_(sheet, ctx);
  if (sameDay_(sheet.getRange(row, COL.DATE).getValue(), ctx, ss)) return '';

  const { start } = tabLayout_(sheet.getName());
  const periodStart = ctx.y + '-' + (ctx.m < 10 ? '0' : '') + ctx.m + '-' + (start < 10 ? '0' : '') + start;
  const first = sheet.getRange(FIRST_ROW, COL.DATE).getValue();
  const firstIso = first instanceof Date ? Utilities.formatDate(first, ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd') : '';
  if (firstIso && firstIso >= periodStart) {
    throw new Error('Tab ' + sheet.getName() + ' already holds a newer period (' + firstIso + ').');
  }
  return startPeriod_(ss, sheet, ctx);
}

/** Back up the old period to a hidden tab, then rewrite dates, clear times, restore formulas. */
function startPeriod_(ss, sheet, ctx) {
  const name = sheet.getName();
  const { start, days } = tabLayout_(name);
  const last = Math.min(lastDayOfMonth_(ctx.y, ctx.m), start + days - 1);
  const tz = ss.getSpreadsheetTimeZone();

  let backupName = '';
  const oldFirst = sheet.getRange(FIRST_ROW, COL.DATE).getValue();
  if (oldFirst instanceof Date) {
    backupName = name + ' (' + Utilities.formatDate(oldFirst, tz, 'MMM yyyy') + ')';
    if (!ss.getSheetByName(backupName)) sheet.copyTo(ss).setName(backupName).hideSheet();
  }

  const formula = totalFormula_(ss);
  const dates = [];
  const times = [];
  for (let i = 0; i < days; i++) {
    const day = start + i;
    const inMonth = day <= last;
    const utc = Date.UTC(ctx.y, ctx.m - 1, day);
    const fill = inMonth && [0, 6].includes(new Date(utc).getUTCDay()) ? '--' : '';
    dates.push([inMonth ? dateSerial_(utc) : ''], ['']);
    times.push([fill, fill], [fill, fill]);
    if (formula) sheet.getRange(FIRST_ROW + 2 * i, COL.TOTAL).setFormulaR1C1(formula);
  }
  sheet.getRange(FIRST_ROW, COL.DATE, days * 2, 1).setValues(dates);
  sheet.getRange(FIRST_ROW, COL.IN, days * 2, 2).setValues(times);

  return 'Started new period ' + ctx.m + '/' + start + '–' + ctx.m + '/' + last + ' in tab ' + name +
    (backupName ? ' (old entries saved to hidden tab "' + backupName + '")' : '');
}

// ---- Cell helpers ----

function readSlots_(sheet, row) {
  const range = sheet.getRange(row, COL.IN, 2, 2);
  const values = range.getValues();
  const text = range.getDisplayValues();
  return values.map((v, i) => ({ row: row + i, in: v[0], out: v[1], inText: text[i][0], outText: text[i][1] }));
}

/** "HOLIDAY" in a time cell, in any case (the sheet has both hand-typed and written ones). */
function isHoliday_(v) {
  return typeof v === 'string' && v.trim().toUpperCase() === HOLIDAY;
}

/** Empty, or a placeholder like "--". */
function blank_(v) {
  return v === '' || v === null || (typeof v === 'string' && /^[-\s]*$/.test(v));
}

/** Sheets time-of-day serial for at in Eastern time, to the minute. */
function timeSerial_(at) {
  const [h, m] = Utilities.formatDate(at, TZ, 'H:m').split(':').map(Number);
  return (h * 60 + m) / 1440;
}

/** Epoch ms of a time-of-day cell value on ctx's date, in Eastern time. */
function wallClockMs_(ctx, timeValue, ss) {
  if (!(timeValue instanceof Date)) return null;
  const hm = Utilities.formatDate(timeValue, ss.getSpreadsheetTimeZone(), 'HH:mm');
  return Utilities.parseDate(ctx.key + ' ' + hm, TZ, 'yyyy-MM-dd HH:mm').getTime();
}

/** Sheets date serial (days since 1899-12-30) for a UTC-midnight timestamp. */
function dateSerial_(utc) {
  return (utc - Date.UTC(1899, 11, 30)) / 86400000;
}
