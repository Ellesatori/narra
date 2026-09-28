// Shared by the main window (app.js) and the desktop widget (widget.js): time helpers
// and the numbers derived from the Rust-side view ({ snapshot, queue, ... }).

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/14sMZgxOqTE2QahXwPJ31bG45JuFf5v6qKJLrIKhUy0c';
const ET = 'America/New_York';
const PH = 'Asia/Manila';
const HOUR_MS = 3600 * 1000;

// Pay rules, copied from the timesheet template's formulas:
//   required  = 8 h × weekdays (Mon–Fri) in the period          (NETWORKDAYS)
//   overtime  = max(0, total − required); regular = min(total, required)
//   pay       = rate / 2 + OVERTIME_MULTIPLIER × (rate / HOURS_PER_MONTH) × overtime
const HOURS_PER_DAY = 8;
const HOURS_PER_MONTH = 160;
const OVERTIME_MULTIPLIER = 1.3;

const $ = id => document.getElementById(id);

// ---- Time helpers (everything on the sheet is Eastern) ----

const fmt = (ms, opts, tz = ET) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(ms);
const dateKey = (ms, tz = ET) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(ms); // yyyy-mm-dd
const keyToUtc = key => Date.parse(key + 'T00:00:00Z');
const weekday = key => new Date(keyToUtc(key)).getUTCDay();
const isWeekend = key => [0, 6].includes(weekday(key));
const addDays = (key, n) => new Date(keyToUtc(key) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((keyToUtc(to) - keyToUtc(from)) / 86400000);
const prettyDate = (key, opts = { weekday: 'short', month: 'short', day: 'numeric' }) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(keyToUtc(key));
const hours = h => (Math.round(h * 100) / 100).toFixed(2);

function duration(ms, withSeconds = true) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return withSeconds ? `${h}:${m}:${sec}` : `${h}:${m}`;
}

function yearsToSync() {
  const y = Number(dateKey(Date.now()).slice(0, 4));
  return [y - 1, y, y + 1];
}

/** Epoch ms for an "HH:MM" picked in the Mac's own timezone: today, or yesterday if that's still ahead. */
function pickedTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d.getTime() > Date.now() + 60 * 1000) d.setDate(d.getDate() - 1);
  return d.getTime();
}

/** "HH:MM" for now in the Mac's own timezone, for <input type="time">. */
function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---- Derived state ----

/** Today's clock state: sheet status + punches still waiting in the local queue. */
function todayState(view, now = Date.now()) {
  const key = dateKey(now);
  const status = view && view.snapshot && view.snapshot.status;
  const fresh = status && status.date === key;
  let open = fresh ? status.open : false;
  let since = fresh ? status.sinceMs : null;
  let unsyncedMs = 0;
  const pending = [];
  for (const p of (view && view.queue) || []) {
    if (dateKey(p.at) !== key) continue;
    pending.push(p);
    if (p.kind === 'in') { open = true; since = p.at; }
    else if (open && since) { unsyncedMs += p.at - since; open = false; since = null; }
  }
  const runningMs = open && since ? now - since : 0;
  const baseHours = fresh ? status.hours : 0;
  return {
    key,
    open,
    since,
    runningMs,
    holiday: fresh && (status.holiday || status.slots.some(s => isHolidayText(s.in))),
    hours: baseHours + (unsyncedMs + runningMs) / HOUR_MS,
    slots: fresh ? status.slots : [],
    pending,
    tab: status && status.tab,
  };
}

const isHolidayText = v => typeof v === 'string' && v.trim().toUpperCase() === 'HOLIDAY';

/** Timesheet tabs; days typed by hand as "HOLIDAY" (any case) count as holidays too. */
function timesheetsOf(view) {
  const tabs = (view && view.snapshot && view.snapshot.timesheets) || [];
  for (const tab of tabs) {
    for (const d of tab.days) d.holiday = d.holiday || isHolidayText(d.slots[0][0]);
  }
  return tabs;
}

function periodFor(view, key) {
  return timesheetsOf(view).find(t => !t.hidden && t.start <= key && key <= t.end);
}

/** Hours logged this period (today live) vs. 8 per weekday, to date and in total. */
function periodProgress(period, t) {
  const logged = period.days.reduce((sum, d) => sum + (d.date === t.key ? 0 : d.hours), 0) + t.hours;
  const weekdays = period.days.filter(d => !d.weekend);
  return {
    logged,
    expectedToDate: weekdays.filter(d => d.date <= t.key).length * 8,
    expectedTotal: weekdays.length * 8,
  };
}

const money = n => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const parseMoney = text => {
  const n = Number(String(text || '').replace(/[^0-9.]/g, ''));
  return n > 0 ? n : null;
};

/** The monthly rate set in Narra's Settings, else the one typed in the timesheet. */
function monthlyRate(view) {
  if (view && view.monthly_rate > 0) return view.monthly_rate;
  for (const tab of timesheetsOf(view)) {
    const rate = parseMoney(tab.summary && tab.summary.monthlyRate);
    if (rate) return rate;
  }
  return null;
}

/** Expected pay for a period with `total` hours logged, using the template's formula. */
function payFor(period, total, rate) {
  const required = HOURS_PER_DAY * period.days.filter(d => !d.weekend).length;
  const overtime = Math.max(0, total - required);
  const otRate = rate ? OVERTIME_MULTIPLIER * (rate / HOURS_PER_MONTH) : null;
  return {
    required,
    regular: Math.min(total, required),
    overtime,
    otRate,
    pay: rate ? rate / 2 + otRate * overtime : null,
  };
}

/** Link to the connected spreadsheet (from the last sync), without the /edit suffix. */
function sheetUrl(view) {
  const url = view && view.snapshot && view.snapshot.sheetUrl;
  return url ? url.replace(/\/edit.*$/, '') : SHEET_URL;
}

/** Past the clock-out reminder threshold while still clocked in. */
function overThreshold(view, t) {
  return !!(view && view.remind && t.open && t.hours >= view.remind_hours);
}

let lastReminderTick = 0;
/** Report today's numbers to the backend, which decides when to notify (and dedupes across windows). */
function reminderTick(invoke, view, t) {
  if (!view || !view.configured || Date.now() - lastReminderTick < 30 * 1000) return;
  lastReminderTick = Date.now();
  invoke('reminder_tick', { date: t.key, open: t.open, hours: t.hours }).catch(() => {});
}

/** Next enabled holiday on or after `key` that falls on a weekday (the ones that count). */
function nextWeekdayHoliday(lists, key) {
  return lists.flat()
    .filter(h => h.enabled && h.date >= key && !isWeekend(h.date))
    .sort((a, b) => a.date.localeCompare(b.date))[0];
}
