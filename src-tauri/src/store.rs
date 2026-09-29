//! Local state, persisted as JSON in the app data dir: the timesheet itself (days and
//! their sessions), profile, settings, and holiday data. A copy of the timesheet data is
//! also written to ~/Documents/Narra as a backup after every change.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_REMIND_HOURS: f64 = 8.0;

/// One stretch of work. Times are epoch ms, rounded to the minute like the timesheet.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Session {
    pub start: i64,
    #[serde(default)]
    pub end: Option<i64>,
}

/// A calendar day (Eastern date), keyed "yyyy-mm-dd" in `Store::days`.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Day {
    pub sessions: Vec<Session>,
    /// "leave", "holiday" or "off" (off = don't auto-credit a holiday). None = worked/auto.
    pub kind: Option<String>,
    /// Hours credited for a leave/holiday day (default 8), or a manual total.
    pub hours: Option<f64>,
}

impl Day {
    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty() && self.kind.is_none() && self.hours.is_none()
    }
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
    /// Shown at the top of the timesheet PDF.
    pub name: String,
    /// Monthly rate for expected pay.
    pub monthly_rate: Option<f64>,
    /// The timesheet: Eastern date -> day.
    pub days: BTreeMap<String, Day>,

    /// "local" (timesheet lives in Narra) or "sheet" (also kept in a Google Sheet).
    /// Empty until onboarding is finished.
    pub mode: String,

    /// Google Sheet connection (sheet mode, or a one-time import in local mode).
    pub api_url: String,
    pub api_key: String,
    /// Sheet mode: dates changed in Narra that still need writing to the sheet.
    pub dirty: BTreeSet<String>,
    pub sheet_url: String,
    pub sheet_name: String,
    pub sync_error: String,
    /// Legacy: last data pulled by the first version of the sheet script (for import).
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
}

impl Store {
    pub fn load(path: &PathBuf) -> Store {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &PathBuf) -> Result<(), String> {
        write_atomic(path, &serde_json::to_string_pretty(self).map_err(|e| e.to_string())?)
    }

    /// The part worth backing up: everything needed to rebuild the timesheets.
    pub fn backup_json(&self) -> Value {
        json!({
            "app": "Narra",
            "saved_at": now_ms(),
            "name": self.name,
            "monthly_rate": self.monthly_rate,
            "days": self.days,
            "custom_holidays": self.custom,
            "removed_holidays": self.removed,
        })
    }

    pub fn sheet_mode(&self) -> bool {
        self.mode == "sheet"
    }

    pub fn has_sheet(&self) -> bool {
        !self.api_url.trim().is_empty() && !self.api_key.trim().is_empty()
    }

    pub fn remind_hours(&self) -> f64 {
        self.remind_hours.unwrap_or(DEFAULT_REMIND_HOURS)
    }

    /// The session still running, if any: (date, index).
    pub fn open_session(&self) -> Option<(String, usize)> {
        self.days.iter().rev().find_map(|(date, day)| {
            day.sessions.iter().position(|s| s.end.is_none()).map(|i| (date.clone(), i))
        })
    }

    /// Close the running session at `at` (already rounded to the minute) and return its
    /// date. `picked` is true when the user chose the time rather than "now". Timing out
    /// in the same minute as timing in logs nothing, so that session is simply dropped.
    pub fn time_out(&mut self, at: i64, picked: bool) -> Result<String, String> {
        let Some((date, i)) = self.open_session() else {
            return Err("You're not timed in.".into());
        };
        let day = self.days.get_mut(&date).unwrap();
        let start = day.sessions[i].start;
        if at < start || (at == start && picked) {
            return Err("Time out must be after your time in.".into());
        }
        if at == start {
            day.sessions.remove(i);
            if day.is_empty() {
                self.days.remove(&date);
            }
        } else {
            day.sessions[i].end = Some(at);
        }
        Ok(date)
    }
}

pub fn write_atomic(path: &Path, body: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Round to the whole minute, the timesheet's precision.
pub fn to_minute(ms: i64) -> i64 {
    ms - ms.rem_euclid(60_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60_000;

    fn timed_in_at(start: i64) -> Store {
        let mut s = Store::default();
        s.days.entry("2026-09-30".into()).or_default().sessions.push(Session { start, end: None });
        s
    }

    #[test]
    fn time_out_closes_the_open_session() {
        let mut s = timed_in_at(10 * MIN);
        assert_eq!(s.time_out(12 * MIN, false), Ok("2026-09-30".to_string()));
        assert_eq!(s.days["2026-09-30"].sessions, vec![Session { start: 10 * MIN, end: Some(12 * MIN) }]);
    }

    #[test]
    fn time_out_in_the_same_minute_drops_the_session() {
        let mut s = timed_in_at(10 * MIN);
        assert_eq!(s.time_out(10 * MIN, false), Ok("2026-09-30".to_string()));
        assert!(s.days.get("2026-09-30").is_none());
        assert!(s.open_session().is_none());
    }

    #[test]
    fn same_minute_drop_keeps_the_rest_of_the_day() {
        let mut s = timed_in_at(10 * MIN);
        s.days.get_mut("2026-09-30").unwrap().sessions.insert(0, Session { start: 8 * MIN, end: Some(9 * MIN) });
        s.time_out(10 * MIN, false).unwrap();
        assert_eq!(s.days["2026-09-30"].sessions, vec![Session { start: 8 * MIN, end: Some(9 * MIN) }]);
    }

    #[test]
    fn a_picked_time_must_still_be_after_time_in() {
        let mut s = timed_in_at(10 * MIN);
        assert!(s.time_out(10 * MIN, true).is_err());
        assert!(s.time_out(9 * MIN, false).is_err());
        assert!(s.open_session().is_some());
    }

    #[test]
    fn time_out_needs_an_open_session() {
        assert!(Store::default().time_out(10 * MIN, false).is_err());
    }
}
