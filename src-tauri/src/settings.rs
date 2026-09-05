use crate::errors::BackendError;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn settings_path(app: &AppHandle) -> Result<PathBuf, BackendError> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| BackendError::settings(error.to_string()))?;
    fs::create_dir_all(&directory).map_err(|error| BackendError::settings(error.to_string()))?;
    Ok(directory.join("settings.json"))
}

#[tauri::command]
pub async fn load_settings(app: AppHandle) -> Result<Option<Value>, BackendError> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = settings_path(&app)?;
        if !path.exists() {
            return Ok(None);
        }

        let contents = crate::storage::read_json(&path).map_err(BackendError::settings)?;
        serde_json::from_str(&contents)
            .map(Some)
            .map_err(|error| BackendError::settings(error.to_string()))
    })
    .await
    .map_err(|error| BackendError::settings(error.to_string()))?
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, settings: Value) -> Result<(), BackendError> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = settings_path(&app)?;
        crate::storage::write_json(&path, &settings).map_err(BackendError::settings)
    })
    .await
    .map_err(|error| BackendError::settings(error.to_string()))?
}
