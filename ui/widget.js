// Desktop widget: a compact live view of today plus Time In / Time Out.
// State comes from the Rust side; the main window keeps syncing, and every window
// hears the "view" event when anything changes.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const STALE_MS = 10 * 60 * 1000;

let view = null;
let holidays = [];           // [[...this year], [...next year]]
let busy = false;
let holidayArmed = false;
let flashTimer = null;

function flash(text, isError = false) {
  const el = $('flash');
  el.textContent = text;
  el.className = 'flash' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.hidden = true; }, isError ? 7000 : 3500);
}

function render(now = Date.now()) {
  const configured = !!(view && view.configured);
  const forgotOpen = !$('forgotPane').hidden;
  $('setupPane').hidden = configured;
  $('mainPane').hidden = !configured || forgotOpen;
  if (!configured) $('forgotPane').hidden = true;

  const t = todayState(view, now);
  const holidayToday = holidays.flat().find(h => h.date === t.key && h.enabled);
  const queued = (view && view.queue.length) || 0;

  const pill = $('pill');
  if (!configured) { pill.textContent = 'Not connected'; pill.className = 'pill warn'; }
  else if (t.open) { pill.textContent = 'Working'; pill.className = 'pill on'; }
  else if (t.holiday || holidayToday) { pill.textContent = 'Holiday'; pill.className = 'pill holiday'; }
  else if (queued) { pill.textContent = `${queued} to sync`; pill.className = 'pill warn'; }
  else { pill.textContent = t.slots.length ? 'On a break' : 'Off'; pill.className = 'pill'; }

  $('timer').textContent = duration(t.runningMs);
  const over = overThreshold(view, t);
  $('sub').classList.toggle('alert', over);
  $('sub').textContent = over
    ? `${hours(view.remind_hours).replace(/\.00$/, '')} hrs done, time out?`
    : t.open
    ? 'since ' + fmt(t.since, { hour: 'numeric', minute: '2-digit' }, PH) + ' PH'
    : t.holiday ? '8 hrs holiday credit' : holidayToday ? holidayToday.name : 'not clocked in';

  const btn = $('punchBtn');
  btn.disabled = busy || !configured;
  btn.textContent = busy ? '…' : t.open ? 'Time Out' : holidayArmed ? 'Work anyway?' : 'Time In';
  btn.classList.toggle('out', t.open);
  $('forgotLabel').textContent = `I actually ${t.open ? 'timed out' : 'timed in'} at (PH)`;
  $('forgotSave').textContent = t.open ? 'Time Out' : 'Time In';
  $('forgotSave').disabled = busy;

  $('statToday').textContent = hours(t.hours) + 'h';
  reminderTick(invoke, view, t);
  const period = periodFor(view, t.key);
  if (period) {
    const p = periodProgress(period, t);
    $('statPeriod').textContent = `${Math.round(p.logged * 10) / 10}/${p.expectedTotal}h`;
  } else {
    $('statPeriod').textContent = '—';
  }
  const next = nextWeekdayHoliday(holidays, t.key);
  if (next) {
    const days = daysBetween(t.key, next.date);
    const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `${days}d`;
    $('statHoliday').textContent = `${prettyDate(next.date, { month: 'short', day: 'numeric' })} · ${when}`;
    $('statHoliday').title = next.name;
  } else {
    $('statHoliday').textContent = '—';
  }
}

async function punch(at = null) {
  if (busy || !view || !view.configured) return;
  const t = todayState(view);
  const kind = t.open ? 'out' : 'in';
  if (at === null && kind === 'in' && t.holiday && !holidayArmed) {
    holidayArmed = true;
    render();
    setTimeout(() => { holidayArmed = false; render(); }, 6000);
    return;
  }
  if (at !== null && t.open && t.since && at <= t.since) {
    flash('Time out must be after your time in.', true);
    return;
  }
  holidayArmed = false;
  busy = true;
  render();
  try {
    const outcome = await invoke('punch', { kind, at, years: yearsToSync() });
    view = outcome.view;
    if (outcome.errors.length) flash(outcome.errors[0], true);
    else if (outcome.notices.length) flash(outcome.notices[outcome.notices.length - 1]);
  } catch (e) {
    flash(String(e), true);
  } finally {
    busy = false;
    render();
  }
}

function showForgot(open) {
  $('forgotPane').hidden = !open;
  if (open) {
    $('forgotTime').value = nowHHMM();
    $('forgotTime').focus();
  }
  render();
}

async function loadHolidays() {
  const y = Number(dateKey(Date.now()).slice(0, 4));
  try {
    holidays = await Promise.all([y, y + 1].map(year => invoke('holidays', { year })));
  } catch (_) {
    holidays = [];
  }
}

async function refresh() {
  view = await invoke('load');
  render();
  // The main window syncs every few minutes; only step in if it hasn't lately.
  if (view.configured && (!view.synced_at || Date.now() - view.synced_at > STALE_MS) && !busy) {
    busy = true;
    try {
      view = (await invoke('sync', { years: yearsToSync() })).view;
    } catch (_) {
      // Stay quiet on the desktop; the main window reports sync problems.
    } finally {
      busy = false;
      render();
    }
  }
}

$('punchBtn').onclick = () => punch();
$('forgotBtn').onclick = () => showForgot(true);
$('forgotCancel').onclick = () => showForgot(false);
$('forgotPane').onsubmit = e => {
  e.preventDefault();
  const at = pickedTime($('forgotTime').value);
  showForgot(false);
  punch(at);
};
$('openMain').onclick = () => invoke('show_main_view', { view: null });
$('setupBtn').onclick = () => invoke('show_main_view', { view: 'settings' });

listen('view', e => {
  view = e.payload;
  render();
});

setInterval(() => render(), 1000);
setInterval(() => { loadHolidays(); refresh(); }, 5 * 60 * 1000);

(async function start() {
  await loadHolidays();
  await refresh();
})();
