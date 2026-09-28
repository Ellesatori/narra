//! Local state, persisted as JSON in the app data dir: settings, the offline punch
//! queue, the last snapshot pulled from the sheet, and holiday data.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Punch {
    pub kind: String,
    /// Epoch ms when the button was clicked; the sheet records this time, not the sync time.
    pub at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Holiday {
    pub date: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct HolidayYear {
    pub fetched_at: i64,
    pub list: Vec<Holiday>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Store {
    pub api_url: String,
    pub api_key: String,
    /// Punches not yet written to the sheet, oldest first.
    pub queue: Vec<Punch>,
    /// Last `sync` payload from the sheet: { notes, status, timesheets }.
    pub snapshot: Option<Value>,
    pub synced_at: Option<i64>,
    /// Official PH holidays by year (from Nager.Date).
    pub official: BTreeMap<i32, HolidayYear>,
    /// Holidays added by hand (e.g. proclaimed late).
    pub custom: Vec<Holiday>,
    /// Official holiday dates the user switched off.
    pub removed: Vec<String>,
    /// The desktop widget is on unless switched off.
    pub widget_hidden: bool,
    /// Where the widget was last dragged to (logical px, top-left).
    pub widget_pos: Option<(f64, f64)>,
    /// The clock-out reminder is on unless switched off.
    pub remind_off: bool,
    /// Hours worked in a day before the reminder fires (default 8).
    pub remind_hours: Option<f64>,
    /// Monthly rate for the expected-pay estimate; None = use the one in the sheet.
    pub monthly_rate: Option<f64>,
}

pub const DEFAULT_REMIND_HOURS: f64 = 8.0;

impl Store {
    pub fn remind_hours(&self) -> f64 {
        self.remind_hours.unwrap_or(DEFAULT_REMIND_HOURS)
    }
}

impl Store {
    pub fn load(path: &PathBuf) -> Store {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &PathBuf) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = path.with_extension("json.tmp");
        let body = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())
    }

    pub fn configured(&self) -> bool {
        !self.api_url.trim().is_empty() && !self.api_key.trim().is_empty()
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
