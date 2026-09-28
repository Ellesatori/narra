//! Network calls: the Apps Script API bound to the timesheet, and Nager.Date for holidays.

use crate::store::Holiday;
use serde_json::{json, Value};
use std::time::Duration;

pub enum CallError {
    /// Couldn't reach the sheet, or got something that isn't our JSON. Safe to retry.
    Network(String),
    /// The sheet understood the request and refused it (e.g. "Already timed in").
    Rejected(String),
}

impl CallError {
    pub fn message(&self) -> String {
        match self {
            CallError::Network(m) | CallError::Rejected(m) => m.clone(),
        }
    }
}

/// POST `{ key, action, ...extra }` to the web app and unwrap `{ ok, data | error }`.
pub fn call(url: &str, key: &str, action: &str, extra: Value) -> Result<Value, CallError> {
    let mut body = json!({ "key": key, "action": action });
    if let (Some(body), Some(extra)) = (body.as_object_mut(), extra.as_object()) {
        body.extend(extra.clone());
    }
    let response = ureq::post(url.trim())
        .timeout(Duration::from_secs(45))
        .send_json(body)
        .map_err(|e| CallError::Network(e.to_string()))?;
    let value: Value = response
        .into_json()
        .map_err(|_| CallError::Network("The sheet sent back an unexpected response. Check the web app URL.".into()))?;
    if value["ok"].as_bool() == Some(true) {
        Ok(value["data"].clone())
    } else {
        let error = value["error"].as_str().unwrap_or("Unknown error from the sheet");
        Err(CallError::Rejected(error.to_string()))
    }
}

/// Official Philippine public holidays for `year`.
pub fn fetch_holidays(year: i32) -> Result<Vec<Holiday>, String> {
    let url = format!("https://date.nager.at/api/v3/PublicHolidays/{year}/PH");
    let list: Vec<Value> = ureq::get(&url)
        .timeout(Duration::from_secs(20))
        .call()
        .map_err(|e| e.to_string())?
        .into_json()
        .map_err(|e| e.to_string())?;
    Ok(list
        .iter()
        .filter_map(|h| {
            Some(Holiday {
                date: h["date"].as_str()?.to_string(),
                name: h["name"].as_str()?.to_string(),
            })
        })
        .collect())
}
