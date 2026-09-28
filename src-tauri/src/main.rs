// Narra: a menu-bar time clock that writes into the Google Sheets timesheet.
//
// Punches are saved locally first (store.json), then flushed to the sheet's Apps Script
// API in order. If the sheet is unreachable they stay queued and go out on the next sync.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod remote;
mod store;

use remote::CallError;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use store::{now_ms, Holiday, HolidayYear, Punch, Store};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::window::{Effect, EffectState, EffectsBuilder};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_opener::OpenerExt;

const HOLIDAY_REFRESH_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const TRAY_ID: &str = "clock";
const WIDGET: &str = "widget";
/// Same footprint as a medium macOS widget.
const WIDGET_SIZE: (f64, f64) = (344.0, 164.0);

struct AppState {
    path: PathBuf,
    store: Mutex<Store>,
    /// Serialises queue flushes / syncs so a punch is never sent twice.
    net: Mutex<()>,
}

struct TrayItems {
    punch: MenuItem<Wry>,
    widget: CheckMenuItem<Wry>,
}

#[derive(Serialize, Clone)]
struct View {
    configured: bool,
    api_url: String,
    snapshot: Option<Value>,
    synced_at: Option<i64>,
    queue: Vec<Punch>,
    autostart: bool,
    widget: bool,
}

#[derive(Serialize)]
struct Outcome {
    view: View,
    /// Messages from the sheet for punches that went through ("Timed in at 9:02 AM ET").
    notices: Vec<String>,
    /// Punches the sheet refused, or a sync failure.
    errors: Vec<String>,
}

#[derive(Serialize)]
struct HolidayView {
    date: String,
    name: String,
    official: bool,
    enabled: bool,
}

fn view(app: &AppHandle) -> View {
    let state = app.state::<AppState>();
    let store = state.store.lock().unwrap();
    View {
        configured: store.configured(),
        api_url: store.api_url.clone(),
        snapshot: store.snapshot.clone(),
        synced_at: store.synced_at,
        queue: store.queue.clone(),
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
        widget: !store.widget_hidden,
    }
}

/// Tell every window (main + desktop widget) that the state changed.
fn broadcast(app: &AppHandle, view: &View) {
    let _ = app.emit("view", view.clone());
}

fn update_store<T>(app: &AppHandle, f: impl FnOnce(&mut Store) -> T) -> Result<T, String> {
    let state = app.state::<AppState>();
    let mut store = state.store.lock().unwrap();
    let out = f(&mut store);
    store.save(&state.path)?;
    Ok(out)
}

/// Send queued punches oldest-first. Stops at the first network failure (keeps the rest);
/// a punch the sheet rejects is dropped and reported.
fn flush_queue(app: &AppHandle, notices: &mut Vec<String>, errors: &mut Vec<String>) -> Result<(), String> {
    loop {
        let (url, key, next) = {
            let state = app.state::<AppState>();
            let store = state.store.lock().unwrap();
            match store.queue.first() {
                Some(p) => (store.api_url.clone(), store.api_key.clone(), p.clone()),
                None => return Ok(()),
            }
        };
        let result = remote::call(&url, &key, "punch", json!({ "kind": next.kind, "at": next.at }));
        match result {
            Ok(data) => notices.push(data["message"].as_str().unwrap_or("Saved").to_string()),
            Err(CallError::Rejected(msg)) => errors.push(msg),
            Err(CallError::Network(msg)) => return Err(msg),
        }
        update_store(app, |s| {
            if s.queue.first().map(|p| p.at) == Some(next.at) {
                s.queue.remove(0);
            }
        })?;
    }
}

/// Official holidays for `year`, refreshed from Nager.Date at most weekly.
fn ensure_official(app: &AppHandle, year: i32) {
    let fresh = {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        store
            .official
            .get(&year)
            .map(|y| now_ms() - y.fetched_at < HOLIDAY_REFRESH_MS)
            .unwrap_or(false)
    };
    if fresh {
        return;
    }
    if let Ok(list) = remote::fetch_holidays(year) {
        let _ = update_store(app, |s| {
            s.official.insert(year, HolidayYear { fetched_at: now_ms(), list });
        });
    }
}

fn holiday_views(store: &Store, year: i32) -> Vec<HolidayView> {
    let prefix = format!("{year}-");
    let mut out: Vec<HolidayView> = store
        .official
        .get(&year)
        .map(|y| y.list.clone())
        .unwrap_or_default()
        .into_iter()
        .map(|h| HolidayView {
            enabled: !store.removed.contains(&h.date),
            date: h.date,
            name: h.name,
            official: true,
        })
        .collect();
    for h in store.custom.iter().filter(|h| h.date.starts_with(&prefix)) {
        out.retain(|o| o.date != h.date);
        out.push(HolidayView { date: h.date.clone(), name: h.name.clone(), official: false, enabled: true });
    }
    out.sort_by(|a, b| a.date.cmp(&b.date));
    out
}

fn active_holidays(store: &Store, years: &[i32]) -> Vec<Holiday> {
    years
        .iter()
        .flat_map(|y| holiday_views(store, *y))
        .filter(|h| h.enabled)
        .map(|h| Holiday { date: h.date, name: h.name })
        .collect()
}

/// Flush the queue, then pull a fresh snapshot (the sheet also rolls periods and marks holidays).
fn sync_blocking(app: &AppHandle, years: &[i32]) -> Outcome {
    let state = app.state::<AppState>();
    let _net = state.net.lock().unwrap();
    let mut notices = vec![];
    let mut errors = vec![];

    if !state.store.lock().unwrap().configured() {
        errors.push("Connect the sheet in Settings first.".into());
        return Outcome { view: view(app), notices, errors };
    }

    if let Err(msg) = flush_queue(app, &mut notices, &mut errors) {
        errors.push(format!("Couldn't reach the sheet — punches saved on this Mac and will sync later. ({msg})"));
        return Outcome { view: view(app), notices, errors };
    }

    for year in years {
        ensure_official(app, *year);
    }
    let (url, key, holidays) = {
        let store = state.store.lock().unwrap();
        (store.api_url.clone(), store.api_key.clone(), active_holidays(&store, years))
    };
    match remote::call(&url, &key, "sync", json!({ "holidays": holidays })) {
        Ok(data) => {
            if let Some(list) = data["notes"].as_array() {
                notices.extend(list.iter().filter_map(|n| n.as_str().map(String::from)));
            }
            let _ = update_store(app, |s| {
                s.snapshot = Some(data);
                s.synced_at = Some(now_ms());
            });
        }
        Err(e) => errors.push(format!("Sync failed: {}", e.message())),
    }
    Outcome { view: view(app), notices, errors }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

// ---- Commands ----

#[tauri::command]
fn load(app: AppHandle) -> View {
    view(&app)
}

#[tauri::command]
fn save_settings(app: AppHandle, api_url: String, api_key: Option<String>) -> Result<View, String> {
    update_store(&app, |s| {
        s.api_url = api_url.trim().to_string();
        if let Some(key) = api_key.filter(|k| !k.trim().is_empty()) {
            s.api_key = key.trim().to_string();
        }
    })?;
    let view = view(&app);
    broadcast(&app, &view);
    Ok(view)
}

#[tauri::command]
async fn sync(app: AppHandle, years: Vec<i32>) -> Result<Outcome, String> {
    let handle = app.clone();
    let outcome = blocking(move || sync_blocking(&handle, &years)).await?;
    broadcast(&app, &outcome.view);
    Ok(outcome)
}

#[tauri::command]
async fn punch(app: AppHandle, kind: String, at: Option<i64>, years: Vec<i32>) -> Result<Outcome, String> {
    if kind != "in" && kind != "out" {
        return Err(format!("Unknown punch: {kind}"));
    }
    // `at` is set when the user forgot to punch and picks the real time.
    let now = now_ms();
    let at = at.unwrap_or(now);
    if at > now + 60_000 {
        return Err("That time is in the future.".into());
    }
    if now - at > 24 * 60 * 60 * 1000 {
        return Err("Pick a time within the last 24 hours, or edit the sheet directly.".into());
    }
    update_store(&app, |s| s.queue.push(Punch { kind, at }))?;
    let handle = app.clone();
    let outcome = blocking(move || sync_blocking(&handle, &years)).await?;
    broadcast(&app, &outcome.view);
    Ok(outcome)
}

#[tauri::command]
async fn holidays(app: AppHandle, year: i32) -> Result<Vec<HolidayView>, String> {
    blocking(move || {
        ensure_official(&app, year);
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        holiday_views(&store, year)
    })
    .await
}

#[tauri::command]
fn set_holiday(app: AppHandle, date: String, name: String, enabled: bool) -> Result<(), String> {
    update_store(&app, |s| {
        let official = s.official.values().any(|y| y.list.iter().any(|h| h.date == date));
        s.custom.retain(|h| h.date != date);
        s.removed.retain(|d| d != &date);
        if official && !enabled {
            s.removed.push(date);
        } else if !official && enabled {
            s.custom.push(Holiday { date, name });
        }
    })
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let launcher = app.autolaunch();
    if enabled { launcher.enable() } else { launcher.disable() }.map_err(|e| e.to_string())?;
    launcher.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("Only https links can be opened".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Menu-bar text (e.g. running session length) and the punch item's label.
#[tauri::command]
fn set_tray(app: AppHandle, title: String, clocked_in: bool) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_title(if title.is_empty() { None } else { Some(title) }).map_err(|e| e.to_string())?;
    }
    let items = app.state::<TrayItems>();
    items
        .punch
        .set_text(if clocked_in { "Time Out" } else { "Time In" })
        .map_err(|e| e.to_string())
}

/// Bring up the main window, optionally on a given page ("settings", "timesheets", …).
#[tauri::command]
fn show_main_view(app: AppHandle, view: Option<String>) {
    show_main(&app);
    if let Some(page) = view {
        let _ = app.emit_to("main", "navigate", page);
    }
}

#[tauri::command]
fn set_widget(app: AppHandle, visible: bool) -> Result<bool, String> {
    update_store(&app, |s| s.widget_hidden = !visible)?;
    apply_widget(&app, visible).map_err(|e| e.to_string())?;
    let _ = app.state::<TrayItems>().widget.set_checked(visible);
    Ok(visible)
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Show (creating on first use) or hide the desktop widget: a small frameless window on
/// HUD glass that sits below other windows on every Space. Its position is remembered.
fn apply_widget(app: &AppHandle, visible: bool) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(WIDGET) {
        return if visible { window.show() } else { window.hide() };
    }
    if !visible {
        return Ok(());
    }
    // Default: under the stock widgets at the top-left of the desktop.
    let (x, y) = app.state::<AppState>().store.lock().unwrap().widget_pos.unwrap_or((24.0, 380.0));
    let window = WebviewWindowBuilder::new(app, WIDGET, WebviewUrl::App("widget.html".into()))
        .title("Narra Widget")
        .inner_size(WIDGET_SIZE.0, WIDGET_SIZE.1)
        .position(x, y)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .skip_taskbar(true)
        .focused(false)
        .accept_first_mouse(true)
        .effects(
            EffectsBuilder::new()
                .effect(Effect::HudWindow)
                .state(EffectState::Active)
                .radius(22.0)
                .build(),
        )
        .build()?;
    #[cfg(target_os = "macos")]
    pin_to_desktop(&window);
    Ok(())
}

/// Put the widget in the desktop layer, just above the desktop icons, and make it
/// "stationary": Show Desktop / clicking the wallpaper slides every other window away
/// but leaves this one in place, and it appears on every Space — like macOS widgets.
#[cfg(target_os = "macos")]
fn pin_to_desktop(window: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowLevelForKey(key: i32) -> i32;
    }
    const DESKTOP_ICON_LEVEL_KEY: i32 = 18; // kCGDesktopIconWindowLevelKey

    let Ok(ptr) = window.ns_window() else { return };
    let ptr = ptr as usize;
    let _ = window.run_on_main_thread(move || unsafe {
        let ns_window = &*(ptr as *const NSWindow);
        ns_window.setLevel((CGWindowLevelForKey(DESKTOP_ICON_LEVEL_KEY) + 1) as isize);
        ns_window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .setup(|app| {
            let path = app.path().app_data_dir()?.join("store.json");
            app.manage(AppState { store: Mutex::new(Store::load(&path)), path, net: Mutex::new(()) });

            let punch = MenuItem::with_id(app, "punch", "Time In", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Open Narra", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Narra", true, None::<&str>)?;
            let widget_on = !app.state::<AppState>().store.lock().unwrap().widget_hidden;
            let widget = CheckMenuItem::with_id(app, "widget", "Desktop Widget", true, widget_on, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let separator2 = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&punch, &show, &separator, &widget, &separator2, &quit])?;
            app.manage(TrayItems { punch, widget });

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .tooltip("Narra")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "punch" => {
                        let _ = app.emit("tray-punch", ());
                    }
                    "show" => show_main(app),
                    "widget" => {
                        // The check mark has already toggled; make the widget follow it.
                        let visible = app.state::<TrayItems>().widget.is_checked().unwrap_or(true);
                        if set_widget(app.clone(), visible).is_ok() {
                            broadcast(app, &view(app));
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            if std::env::args().any(|a| a == "--hidden") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            apply_widget(app.handle(), widget_on)?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Closing a window keeps the clock running in the menu bar.
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            // Remember where the widget was dragged.
            WindowEvent::Moved(pos) if window.label() == WIDGET => {
                let scale = window.scale_factor().unwrap_or(1.0);
                let logical = pos.to_logical::<f64>(scale);
                let _ = update_store(window.app_handle(), |s| s.widget_pos = Some((logical.x, logical.y)));
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            load,
            save_settings,
            sync,
            punch,
            holidays,
            set_holiday,
            set_autostart,
            open_url,
            set_tray,
            set_widget,
            show_main_view
        ])
        .build(tauri::generate_context!())
        .expect("error while building Narra")
        .run(|app, event| {
            if let RunEvent::Reopen { .. } = event {
                show_main(app);
            }
        });
}
