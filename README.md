# Narra

Menu-bar time clock (Tauri) that writes Time In / Time Out into the
"Biweekly Timesheet (Monthly)" Google Sheet, marks PH holidays as 8 hours, and shows
every timesheet period (including archived months).

- `apps-script/Code.gs`: bound to the sheet (Extensions → Apps Script). JSON API for the app
  plus a "🌼 Narra" menu in the sheet.
- `src-tauri/`: Rust backend. Local store, offline punch queue, Nager.Date holidays, tray.
- `ui/`: plain HTML/CSS/JS front end (no bundler).

## One-time setup

1. Apps Script editor → **Deploy → New deployment → Web app**
   - Execute as: **Me** · Who has access: **Anyone**
   - Authorize when Google asks. Copy the **Web app URL**.
2. Reload the sheet → **🌼 Narra → Desktop app key…** → copy the key.
3. Narra → **Settings** → paste URL + key → **Save & sync**.

The URL alone does nothing: every request must carry the key.

## Build

```bash
pnpm install
npx tauri build
cp -R "src-tauri/target/release/bundle/macos/Narra.app" /Applications/
```

After changing `Code.gs`: paste it into the Apps Script editor, save, then
**Deploy → Manage deployments → Edit → Version: New version** (same URL).

## Behaviour

- Times are Eastern (the template asks for it). Each day has 2 slots (before/after lunch).
- Punches are stored locally first (`~/Library/Application Support/com.renz.narra/store.json`)
  and sent in order; offline punches keep their original time.
- A tab still holding an older period is copied to a hidden tab (e.g. `16-30 (Jun 2026)`),
  then reset with new dates, "--" weekends, and restored TOTAL HOURS formulas.
- Weekday PH holidays (Nager.Date + your additions − ones you switch off) get
  "Holiday" in the time cells and 8 in TOTAL HOURS. Clocking in on a holiday replaces that.
- Clock-out reminder: macOS notification once today passes the threshold (default 8 h, Settings),
  then every 30 min while still clocked in. Both windows report ticks; the backend dedupes.
- Desktop widget (`ui/widget.*`): frameless HUD-glass window, always below other windows,
  on every Space. Drag it anywhere; its position is saved in store.json (`widget_pos`).
  Toggle it from the menu-bar icon → Desktop Widget, or Settings.
- `ui/shared.js` holds time helpers and derived state used by both windows. Each window
  listens for the `view` event the backend emits after every punch/sync.
