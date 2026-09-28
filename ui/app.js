// Narra UI. State lives in the Rust side (store.json); this file renders it and
// derives live numbers (running timer, today/week/period hours) between syncs.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const SYNC_EVERY_MS = 5 * 60 * 1000;

let view = null;             // { configured, api_url, snapshot, synced_at, queue, autostart, widget }
let holidayCache = {};       // year -> [{ date, name, official, enabled }]
let selectedTab = null;      // Timesheets view selection
let holidayYear = null;
let busy = false;
let holidayArmed = false;    // second click needed to clock in on a holiday
let lastTray = null;

// ---- Derived state (helpers live in shared.js) ----

const today = (now = Date.now()) => todayState(view, now);
const timesheets = () => timesheetsOf(view);
const currentPeriod = key => periodFor(view, key);

function holidayOn(key) {
  const list = holidayCache[Number(key.slice(0, 4))] || [];
  return list.find(h => h.date === key && h.enabled);
}

// ---- Rendering ----

function renderClocks(now) {
  $('clockEt').textContent = fmt(now, { hour: 'numeric', minute: '2-digit' });
  $('clockPh').textContent = fmt(now, { hour: 'numeric', minute: '2-digit' }, PH);
}

function renderSyncLine() {
  const line = $('syncLine');
  const queued = (view && view.queue.length) || 0;
  let text = view && view.synced_at ? 'Synced ' + fmt(view.synced_at, { hour: 'numeric', minute: '2-digit' }, PH) + ' PH' : 'Not synced yet';
  if (busy) text = 'Syncing…';
  if (queued) text += ` · ${queued} waiting`;
  line.textContent = text;
  line.classList.toggle('warn', queued > 0);
}

function renderToday(now = Date.now()) {
  const t = today(now);
  const holiday = holidayOn(t.key);

  $('todayTitle').textContent = fmt(now, { weekday: 'long', month: 'long', day: 'numeric' });
  $('todaySub').textContent = t.tab ? `Eastern Time · tab ${t.tab}` : 'Eastern Time';

  const state = $('heroState');
  if (t.open) {
    state.textContent = 'Working · since ' + fmt(t.since, { hour: 'numeric', minute: '2-digit' });
    state.className = 'state on';
  } else if (t.holiday || holiday) {
    state.textContent = 'Holiday' + (holiday ? ' · ' + holiday.name : '');
    state.className = 'state holiday';
  } else {
    state.textContent = t.slots.length ? 'On a break' : 'Off the clock';
    state.className = 'state';
  }
  $('timer').textContent = duration(t.runningMs);

  const btn = $('punchBtn');
  btn.disabled = busy || !view || !view.configured;
  btn.textContent = t.open ? 'Time Out' : holidayArmed ? 'Time In anyway' : 'Time In';
  btn.classList.toggle('out', t.open);
  const word = t.open ? 'time out' : 'time in';
  $('forgotBtn').textContent = `Forgot to ${word}? Set the time`;
  $('forgotBtn').disabled = btn.disabled;
  $('forgotLabel').textContent = `I actually ${t.open ? 'timed out' : 'timed in'} at`;
  $('forgotSave').textContent = t.open ? 'Time Out' : 'Time In';
  $('forgotSave').disabled = btn.disabled;

  let note = `Today ${hours(t.hours)} hrs`;
  if (overThreshold(view, t)) note = `You've passed ${hours(view.remind_hours).replace(/\.00$/, '')} hrs today. Time out when you're done.`;
  if (t.holiday) note = holidayArmed ? 'Clocking in replaces the 8-hour holiday credit with your actual hours.' : '8.00 hrs credited on the sheet';
  $('heroNote').textContent = note;

  const entries = $('entries');
  entries.innerHTML = '';
  for (const s of t.slots) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${s.in}</span><span>→</span><span>${s.out || '…'}</span>`;
    entries.append(li);
  }
  for (const p of t.pending) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${p.kind === 'in' ? 'Time in' : 'Time out'} ${fmt(p.at, { hour: 'numeric', minute: '2-digit' })}</span><span class="pending">waiting to sync</span>`;
    entries.append(li);
  }

  const banner = $('pendingBanner');
  const queued = (view && view.queue.length) || 0;
  banner.hidden = !queued;
  banner.textContent = queued ? `${queued} punch${queued > 1 ? 'es are' : ' is'} saved on this Mac and will be written to the sheet when it's reachable.` : '';

  renderStats(t);
  updateTray(t);
  reminderTick(invoke, view, t);
}

function renderStats(t) {
  $('statToday').textContent = hours(t.hours);

  // Week (Mon–Sun, Eastern) across the current tabs; today uses the live number.
  const dow = (weekday(t.key) + 6) % 7;
  const monday = addDays(t.key, -dow);
  const sunday = addDays(monday, 6);
  let week = 0;
  const seen = new Set();
  for (const tab of timesheets().filter(x => !x.hidden)) {
    for (const d of tab.days) {
      if (d.date < monday || d.date > sunday || d.date === t.key || seen.has(d.date)) continue;
      seen.add(d.date);
      week += d.hours;
    }
  }
  week += t.hours;
  $('statWeek').textContent = hours(week);
  $('statWeekHint').textContent = `hours · ${prettyDate(monday, { month: 'short', day: 'numeric' })}–${prettyDate(sunday, { month: 'short', day: 'numeric' })}`;

  const period = currentPeriod(t.key);
  if (!period) {
    $('statPeriod').textContent = '—';
    $('statPeriodHint').textContent = 'Sync to load this period';
    $('statPay').textContent = '—';
    $('statPayHint').innerHTML = '&nbsp;';
    renderChart(null, t);
    return;
  }
  const { logged, expectedToDate, expectedTotal } = periodProgress(period, t);
  const diff = logged - expectedToDate;
  $('statPeriod').textContent = hours(logged);
  $('statPeriodHint').innerHTML =
    `of ${expectedTotal} hrs · ${diff >= 0 ? '+' : ''}${hours(diff)} vs pace` +
    `<div class="meter"><span style="width:${Math.min(100, (logged / expectedTotal) * 100)}%"></span></div>`;
  const s = period.summary || {};
  $('statPay').textContent = s.expectedPay || '—';
  $('statPayHint').textContent = s.overtime && s.overtime !== '0.00' ? `incl. ${s.overtime} hrs overtime` : `${s.regularHours || '0.00'} regular hrs`;
  renderChart(period, t);
}

function renderChart(period, t) {
  const chart = $('chart');
  chart.innerHTML = '';
  if (!period) {
    $('chartTitle').textContent = 'This period';
    chart.innerHTML = '<p class="muted">No data yet.</p>';
    return;
  }
  $('chartTitle').textContent = `This period · ${period.period || period.name}`;
  const max = Math.max(10, ...period.days.map(d => d.hours), t.hours);
  const plot = document.createElement('div');
  plot.className = 'plot';
  plot.innerHTML = `<div class="line" style="bottom:${(8 / max) * 100}%"></div>`;
  const labels = document.createElement('div');
  labels.className = 'labels';
  for (const d of period.days) {
    const h = d.date === t.key ? t.hours : d.hours;
    const cls = (d.holiday ? ' holiday' : '') + (d.weekend ? ' weekend' : '') +
      (d.date > t.key ? ' future' : '') + (d.date === t.key ? ' today' : '');
    const bar = document.createElement('div');
    bar.className = 'bar' + cls;
    bar.title = `${d.label}: ${hours(h)} hrs${d.holiday ? ' (holiday)' : ''}`;
    bar.innerHTML = `<div class="fill" style="height:${(h / max) * 100}%"></div>`;
    plot.append(bar);
    const label = document.createElement('div');
    label.className = 'day' + cls;
    label.textContent = Number(d.date.slice(8));
    labels.append(label);
  }
  chart.append(plot, labels);
}

function renderUpcoming() {
  const key = dateKey(Date.now());
  const list = Object.values(holidayCache).flat()
    .filter(h => h.enabled && h.date >= key)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 5);
  const ul = $('upcoming');
  ul.innerHTML = '';
  if (!list.length) {
    ul.innerHTML = '<li class="muted">Nothing upcoming.</li>';
    return;
  }
  for (const h of list) {
    const days = Math.round((keyToUtc(h.date) - keyToUtc(key)) / 86400000);
    const li = document.createElement('li');
    const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
    li.innerHTML = `<span class="date">${prettyDate(h.date, { month: 'short', day: 'numeric' })}</span><span class="name"></span>` +
      `<span class="badge ${days <= 7 ? 'soon' : ''}">${isWeekend(h.date) ? 'weekend' : when}</span>`;
    li.querySelector('.name').textContent = h.name;
    ul.append(li);
  }
}

function renderTimesheets() {
  const tabs = timesheets();
  const chips = $('tabChips');
  chips.innerHTML = '';
  if (!tabs.length) {
    $('sheetCard').hidden = true;
    chips.innerHTML = '<p class="muted">Sync to load your timesheets.</p>';
    return;
  }
  $('sheetCard').hidden = false;
  const key = dateKey(Date.now());
  if (!selectedTab || !tabs.find(t => t.name === selectedTab)) {
    selectedTab = (currentPeriod(key) || tabs[0]).name;
  }
  for (const tab of tabs) {
    const b = document.createElement('button');
    b.className = tab.name === selectedTab ? 'active' : '';
    b.innerHTML = `${prettyDate(tab.start, { month: 'short', day: 'numeric' })}–${Number(tab.end.slice(8))} ${tab.start.slice(0, 4)}` +
      `<span class="tag">${tab.hidden ? 'archived' : tab.name}</span>`;
    b.onclick = () => { selectedTab = tab.name; renderTimesheets(); };
    chips.append(b);
  }

  const tab = tabs.find(t => t.name === selectedTab);
  $('sheetTitle').textContent = tab.period || tab.name;
  $('sheetSub').textContent = tab.hidden ? `Archived copy · tab “${tab.name}”` : `Tab ${tab.name}`;
  $('openSheetBtn').onclick = () => openUrl(`${SHEET_URL}/edit#gid=${tab.gid}`);
  $('pdfBtn').onclick = () => openUrl(`${SHEET_URL}/export?format=pdf&gid=${tab.gid}&portrait=true&fitw=true&gridlines=false&size=letter`);

  const s = tab.summary || {};
  const worked = tab.days.filter(d => d.hours > 0 && !d.holiday).length;
  const holidays = tab.days.filter(d => d.holiday).length;
  $('sheetSummary').innerHTML = [
    ['Total hours', s.totalHours || '0.00'],
    ['Regular', s.regularHours || '—'],
    ['Overtime', s.overtime || '—'],
    ['Days worked', `${worked}${holidays ? ` + ${holidays} hol.` : ''}`],
    ['Expected pay', s.expectedPay || '—'],
  ].map(([label, value]) => `<div><div class="label">${label}</div><div class="value">${value}</div></div>`).join('');

  const rows = $('sheetRows');
  rows.innerHTML = '';
  for (const d of tab.days) {
    const tr = document.createElement('tr');
    tr.className = (d.weekend ? 'weekend ' : '') + (d.holiday ? 'holiday ' : '') + (d.date === key ? 'today' : '');
    const cells = d.holiday
      ? `<td class="holiday-cell" colspan="4">Holiday${holidayOn(d.date) ? ' · ' + holidayOn(d.date).name : ''}</td>`
      : d.slots.flat().map(v => `<td>${v || (d.weekend ? '' : '—')}</td>`).join('');
    tr.innerHTML = `<td>${d.label}</td>${cells}<td class="num">${hours(d.hours)}</td>`;
    rows.append(tr);
  }
}

async function renderHolidays() {
  $('yearLabel').textContent = holidayYear;
  const list = await loadHolidays(holidayYear);
  const ul = $('holidayList');
  ul.innerHTML = '';
  if (!list.length) ul.innerHTML = '<li class="muted">No holidays loaded for this year (offline?).</li>';
  for (const h of list) {
    const li = document.createElement('li');
    li.className = h.enabled ? '' : 'off';
    li.innerHTML = `<span class="date">${prettyDate(h.date)}</span><span class="name"></span>` +
      `${isWeekend(h.date) ? '<span class="badge">weekend</span>' : ''}` +
      `<span class="badge ${h.official ? '' : 'custom'}">${h.official ? 'official' : 'added'}</span>` +
      `<label class="toggle"><input type="checkbox" ${h.enabled ? 'checked' : ''}></label>`;
    li.querySelector('.name').textContent = h.name;
    li.querySelector('input').onchange = e => changeHoliday(h, e.target.checked);
    ul.append(li);
  }
}

function renderSettings() {
  if (!view) return;
  if (document.activeElement !== $('apiUrl')) $('apiUrl').value = view.api_url || '';
  $('apiKey').placeholder = view.configured ? 'Saved — paste a new key to replace it' : 'Paste the key from 🌼 Narra → Desktop app key…';
  $('autostart').checked = !!view.autostart;
  $('widgetToggle').checked = !!view.widget;
  $('remindToggle').checked = !!view.remind;
  if (document.activeElement !== $('remindHours')) $('remindHours').value = view.remind_hours;
  $('remindHours').disabled = !view.remind;
}

function renderAll() {
  renderSyncLine();
  renderToday();
  renderUpcoming();
  renderTimesheets();
  renderSettings();
}

function updateTray(t) {
  const title = t.open ? duration(t.runningMs, false) : '';
  const key = title + '|' + t.open;
  if (key === lastTray) return;
  lastTray = key;
  invoke('set_tray', { title, clockedIn: t.open }).catch(() => {});
}

// ---- Actions ----

let toastTimer = null;
function toast(text, isError = false) {
  const el = $('toast');
  el.textContent = text;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 9000 : 5000);
}

function applyOutcome(outcome) {
  view = outcome.view;
  if (outcome.errors.length) toast(outcome.errors.join('\n'), true);
  else if (outcome.notices.length) toast(outcome.notices.join('\n'));
}

async function sync(quiet = true) {
  if (busy || !view || !view.configured) return;
  busy = true;
  renderSyncLine();
  try {
    const outcome = await invoke('sync', { years: yearsToSync() });
    applyOutcome(outcome);
    if (!quiet && !outcome.errors.length && !outcome.notices.length) toast('Synced with your sheet');
  } catch (e) {
    toast(String(e), true);
  } finally {
    busy = false;
    renderAll();
  }
}

function toggleForgot(open) {
  $('forgotForm').hidden = !open;
  $('forgotBtn').hidden = open;
  if (open) {
    $('forgotTime').value = nowHHMM();
    $('forgotTime').focus();
  }
}

async function punchAt(hhmm) {
  const t = today();
  const at = pickedTime(hhmm);
  if (t.open && t.since && at <= t.since) {
    toast(`Time out must be after your time in (${fmt(t.since, { hour: 'numeric', minute: '2-digit' })} ET).`, true);
    return;
  }
  toggleForgot(false);
  await punch(at);
}

async function punch(at = null) {
  if (busy || !view || !view.configured) return;
  const t = today();
  const kind = t.open ? 'out' : 'in';
  if (at === null && kind === 'in' && t.holiday && !holidayArmed) {
    holidayArmed = true;
    renderToday();
    setTimeout(() => { holidayArmed = false; renderToday(); }, 8000);
    return;
  }
  holidayArmed = false;
  busy = true;
  renderAll();
  try {
    applyOutcome(await invoke('punch', { kind, at, years: yearsToSync() }));
  } catch (e) {
    toast(String(e), true);
  } finally {
    busy = false;
    renderAll();
  }
}

async function loadHolidays(year, refresh = false) {
  if (!holidayCache[year] || refresh) {
    try {
      holidayCache[year] = await invoke('holidays', { year });
    } catch (_) {
      holidayCache[year] = holidayCache[year] || [];
    }
  }
  return holidayCache[year];
}

async function changeHoliday(h, enabled) {
  await invoke('set_holiday', { date: h.date, name: h.name, enabled });
  await loadHolidays(Number(h.date.slice(0, 4)), true);
  renderHolidays();
  renderUpcoming();
  sync();
}

function openUrl(url) {
  invoke('open_url', { url }).catch(e => toast(String(e), true));
}

function showView(name) {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== 'view-' + name; });
  if (name === 'holidays') renderHolidays();
  if (name === 'timesheets') renderTimesheets();
}

// ---- Wiring ----

document.querySelectorAll('nav button').forEach(b => { b.onclick = () => showView(b.dataset.view); });
$('punchBtn').onclick = () => punch();
$('forgotBtn').onclick = () => toggleForgot(true);
$('forgotCancel').onclick = () => toggleForgot(false);
$('forgotForm').onsubmit = e => { e.preventDefault(); punchAt($('forgotTime').value); };
$('syncNow').onclick = () => sync(false);
$('openSheetLink').onclick = () => openUrl(SHEET_URL + '/edit');
$('yearPrev').onclick = () => { holidayYear--; renderHolidays(); };
$('yearNext').onclick = () => { holidayYear++; renderHolidays(); };

$('settingsForm').onsubmit = async e => {
  e.preventDefault();
  try {
    view = await invoke('save_settings', { apiUrl: $('apiUrl').value, apiKey: $('apiKey').value || null });
    $('apiKey').value = '';
    await sync(false);
    if (view.configured && view.synced_at) showView('today');
  } catch (err) {
    toast(String(err), true);
  }
};

$('autostart').onchange = async e => {
  try {
    view.autostart = await invoke('set_autostart', { enabled: e.target.checked });
  } catch (err) {
    toast(String(err), true);
  }
  renderSettings();
};

$('addHoliday').onsubmit = async e => {
  e.preventDefault();
  const date = $('newHolidayDate').value;
  const name = $('newHolidayName').value.trim();
  if (!date || !name) return;
  await invoke('set_holiday', { date, name, enabled: true });
  $('newHolidayName').value = '';
  holidayYear = Number(date.slice(0, 4));
  await loadHolidays(holidayYear, true);
  renderHolidays();
  renderUpcoming();
  sync();
};

$('widgetToggle').onchange = async e => {
  try {
    view.widget = await invoke('set_widget', { visible: e.target.checked });
  } catch (err) {
    toast(String(err), true);
  }
  renderSettings();
};

async function saveReminder() {
  const h = Number($('remindHours').value);
  try {
    view = await invoke('set_reminder', { enabled: $('remindToggle').checked, hours: h });
  } catch (err) {
    toast(String(err), true);
  }
  renderSettings();
}
$('remindToggle').onchange = saveReminder;
$('remindHours').onchange = saveReminder;
$('testReminder').onclick = () =>
  invoke('test_reminder').then(() => toast('Sent. If nothing appeared, allow Narra in System Settings → Notifications.'))
    .catch(err => toast(String(err), true));

listen('tray-punch', () => punch());
listen('navigate', e => showView(e.payload));
// Another window (the desktop widget) punched or synced: pick up the new state.
listen('view', e => {
  view = e.payload;
  renderAll();
});
window.addEventListener('focus', () => {
  if (!view || !view.synced_at || Date.now() - view.synced_at > 60 * 1000) sync();
});

setInterval(() => {
  const now = Date.now();
  renderClocks(now);
  renderToday(now);
}, 1000);
setInterval(() => sync(), SYNC_EVERY_MS);

(async function start() {
  holidayYear = Number(dateKey(Date.now()).slice(0, 4));
  view = await invoke('load');
  renderClocks(Date.now());
  renderAll();
  if (!view.configured) {
    showView('settings');
    return;
  }
  await Promise.all(yearsToSync().slice(1).map(y => loadHolidays(y)));
  renderUpcoming();
  sync();
})();
