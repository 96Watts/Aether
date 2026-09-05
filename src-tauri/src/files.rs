use crate::errors::BackendError;
use serde::Deserialize;
use serde::Serialize;
use std::path::PathBuf;
use tauri::AppHandle;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathSelection {
    pub path: Option<String>,
    pub canceled: bool,
}

fn as_string(path: PathBuf) -> Option<String> {
    path.to_str().map(str::to_string)
}

#[tauri::command]
pub async fn pick_folder(
    _app: AppHandle,
    title: Option<String>,
) -> Result<PathSelection, BackendError> {
    let dialog = rfd::AsyncFileDialog::new()
        .set_title(title.unwrap_or_else(|| "Select a folder".to_string()));
    match dialog.pick_folder().await {
        Some(folder) => Ok(PathSelection {
            path: as_string(folder.into()),
            canceled: false,
        }),
        None => Ok(PathSelection {
            path: None,
            canceled: true,
        }),
    }
}

#[tauri::command]
pub async fn pick_file(
    _app: AppHandle,
    title: Option<String>,
) -> Result<PathSelection, BackendError> {
    let dialog =
        rfd::AsyncFileDialog::new().set_title(title.unwrap_or_else(|| "Select a file".to_string()));
    match dialog.pick_file().await {
        Some(file) => Ok(PathSelection {
            path: as_string(file.into()),
            canceled: false,
        }),
        None => Ok(PathSelection {
            path: None,
            canceled: true,
        }),
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct PathValidation {
    pub path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathValidationResult {
    pub exists: bool,
    pub is_dir: bool,
    pub is_file: bool,
    pub readable: bool,
}

fn probe(path: &PathBuf) -> PathValidationResult {
    let metadata = std::fs::metadata(path);
    let exists = metadata.is_ok();
    let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
    let is_file = metadata.as_ref().map(|m| m.is_file()).unwrap_or(false);
    // Readable probe: attempt to read directory entries or open the file.
    let readable = if is_dir {
        std::fs::read_dir(path).map(|_| true).unwrap_or(false)
    } else if is_file {
        std::fs::File::open(path).map(|_| true).unwrap_or(false)
    } else {
        false
    };
    PathValidationResult {
        exists,
        is_dir,
        is_file,
        readable,
    }
}

#[tauri::command]
pub async fn validate_path(input: PathValidation) -> Result<PathValidationResult, BackendError> {
    tauri::async_runtime::spawn_blocking(move || match input.path {
        None => Ok(PathValidationResult {
            exists: false,
            is_dir: false,
            is_file: false,
            readable: false,
        }),
        Some(path) if path.trim().is_empty() => Ok(PathValidationResult {
            exists: false,
            is_dir: false,
            is_file: false,
            readable: false,
        }),
        Some(path) => {
            let expanded = if path.starts_with("~") {
                if let Some(home) =
                    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
                {
                    PathBuf::from(home).join(path.trim_start_matches("~/").trim_start_matches('\\'))
                } else {
                    PathBuf::from(path)
                }
            } else {
                PathBuf::from(path)
            };
            Ok(probe(&expanded))
        }
    })
    .await
    .map_err(|error| BackendError::files(error.to_string()))?
}
