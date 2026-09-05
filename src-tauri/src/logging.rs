use crate::errors::BackendError;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Manager, State};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub timestamp: u64,
    pub level: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
pub struct LogInput {
    pub level: Option<String>,
    pub message: String,
}

const MAX_LOG_MESSAGE_BYTES: usize = 16 * 1024;
const MAX_LOG_BATCH: usize = 64;

pub struct LogStore {
    entries: Mutex<Vec<LogEntry>>,
}

impl Default for LogStore {
    fn default() -> Self {
        Self {
            entries: Mutex::new(Vec::new()),
        }
    }
}

fn truncate_message(mut message: String) -> String {
    if message.len() <= MAX_LOG_MESSAGE_BYTES {
        return message;
    }
    let mut end = MAX_LOG_MESSAGE_BYTES;
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    message.truncate(end);
    message.push_str("...[truncated]");
    message
}

fn append_input(entries: &mut Vec<LogEntry>, input: LogInput) {
    let level = input.level.unwrap_or_else(|| "info".to_string());
    entries.push(LogEntry {
        timestamp: current_time_ms(),
        level,
        message: truncate_message(input.message),
    });
    if entries.len() > 200 {
        let excess = entries.len() - 200;
        entries.drain(0..excess);
    }
}

fn current_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn get_logs(state: State<'_, LogStore>) -> Result<Vec<LogEntry>, BackendError> {
    state
        .entries
        .lock()
        .map(|entries| entries.clone())
        .map_err(|error| BackendError::logging(error.to_string()))
}

#[tauri::command]
pub fn clear_logs(state: State<'_, LogStore>) -> Result<(), BackendError> {
    state
        .entries
        .lock()
        .map(|mut entries| entries.clear())
        .map_err(|error| BackendError::logging(error.to_string()))
}

/// Records a log entry pushed from the frontend (e.g. forwarded console output when
/// debug logging is enabled). This keeps all application logs in one managed store.
#[tauri::command]
pub fn append_log(state: State<'_, LogStore>, input: LogInput) -> Result<(), BackendError> {
    let mut entries = state
        .entries
        .lock()
        .map_err(|error| BackendError::logging(error.to_string()))?;
    append_input(&mut entries, input);
    Ok(())
}

#[tauri::command]
pub fn append_logs(state: State<'_, LogStore>, inputs: Vec<LogInput>) -> Result<(), BackendError> {
    let mut entries = state
        .entries
        .lock()
        .map_err(|error| BackendError::logging(error.to_string()))?;
    for input in inputs.into_iter().take(MAX_LOG_BATCH) {
        append_input(&mut entries, input);
    }
    Ok(())
}

/// Registers the log store as managed Tauri state.
pub fn setup(app: &tauri::AppHandle) {
    app.manage(LogStore::default());
}
