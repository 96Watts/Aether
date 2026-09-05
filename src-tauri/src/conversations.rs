use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::errors::BackendError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub folder_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationIndex {
    pub conversations: Vec<ConversationSummary>,
    pub folders: Value,
}

fn conversations_directory(app: &AppHandle) -> Result<PathBuf, BackendError> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| BackendError::conversations(error.to_string()))?
        .join("conversations");
    fs::create_dir_all(&directory)
        .map_err(|error| BackendError::conversations(error.to_string()))?;
    Ok(directory)
}

fn legacy_conversations_path(app: &AppHandle) -> Result<PathBuf, BackendError> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| BackendError::conversations(error.to_string()))?;
    Ok(directory.join("conversations.json"))
}

fn index_path(app: &AppHandle) -> Result<PathBuf, BackendError> {
    Ok(conversations_directory(app)?.join("index.json"))
}

fn validate_conversation_id(id: &str) -> Result<(), BackendError> {
    if id.is_empty() || id == "." || id == ".." || id.contains(['/', '\\']) {
        return Err(BackendError::invalid_input("Invalid conversation ID"));
    }
    Ok(())
}

fn conversation_path(app: &AppHandle, id: &str) -> Result<PathBuf, BackendError> {
    validate_conversation_id(id)?;
    Ok(conversations_directory(app)?.join(format!("{id}.json")))
}

fn document_parts(data: &Value) -> Result<(ConversationIndex, Vec<(String, Value)>), BackendError> {
    let conversations = data
        .get("conversations")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            BackendError::invalid_input("Conversation data must contain a conversations array")
        })?;
    let folders = data.get("folders").cloned().unwrap_or_else(|| json!([]));
    let mut summaries = Vec::with_capacity(conversations.len());
    let mut records = Vec::with_capacity(conversations.len());

    for conversation in conversations {
        let summary: ConversationSummary =
            serde_json::from_value(conversation.clone()).map_err(|error| {
                BackendError::invalid_input(format!("Invalid conversation metadata: {error}"))
            })?;
        validate_conversation_id(&summary.id)?;
        records.push((summary.id.clone(), conversation.clone()));
        summaries.push(summary);
    }

    Ok((
        ConversationIndex {
            conversations: summaries,
            folders,
        },
        records,
    ))
}

fn write_index(app: &AppHandle, index: &ConversationIndex) -> Result<(), BackendError> {
    let path = index_path(app)?;
    crate::storage::write_json(&path, index).map_err(BackendError::conversations)
}

fn write_records(app: &AppHandle, records: Vec<(String, Value)>) -> Result<(), BackendError> {
    for (id, record) in records {
        let path = conversation_path(app, &id)?;
        crate::storage::write_json(&path, &record).map_err(BackendError::conversations)?;
    }
    Ok(())
}

fn migrate_legacy(app: &AppHandle, path: PathBuf) -> Result<ConversationIndex, BackendError> {
    let contents = crate::storage::read_json(&path).map_err(BackendError::conversations)?;
    let data: Value = serde_json::from_str(&contents)
        .map_err(|error| BackendError::conversations(error.to_string()))?;
    let (index, records) = document_parts(&data)?;
    write_records(app, records)?;
    write_index(app, &index)?;
    Ok(index)
}

#[tauri::command]
pub async fn load_conversation_index(
    app: AppHandle,
) -> Result<Option<ConversationIndex>, BackendError> {
    tauri::async_runtime::spawn_blocking(move || {
        let index = index_path(&app)?;
        if index.exists() {
            let contents =
                crate::storage::read_json(&index).map_err(BackendError::conversations)?;
            return serde_json::from_str(&contents)
                .map(Some)
                .map_err(|error| BackendError::conversations(error.to_string()));
        }

        let legacy = legacy_conversations_path(&app)?;
        if legacy.exists() {
            return migrate_legacy(&app, legacy).map(Some);
        }
        Ok(None)
    })
    .await
    .map_err(|error| BackendError::conversations(error.to_string()))?
}

#[tauri::command]
pub async fn load_conversation(app: AppHandle, id: String) -> Result<Option<Value>, BackendError> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = conversation_path(&app, &id)?;
        if !path.exists() {
            return Ok(None);
        }
        let contents = crate::storage::read_json(&path).map_err(BackendError::conversations)?;
        serde_json::from_str(&contents)
            .map(Some)
            .map_err(|error| BackendError::conversations(error.to_string()))
    })
    .await
    .map_err(|error| BackendError::conversations(error.to_string()))?
}

#[tauri::command]
pub async fn save_conversation_index(
    app: AppHandle,
    data: ConversationIndex,
) -> Result<(), BackendError> {
    tauri::async_runtime::spawn_blocking(move || {
        for conversation in &data.conversations {
            validate_conversation_id(&conversation.id)?;
        }
        write_index(&app, &data)
    })
    .await
    .map_err(|error| BackendError::conversations(error.to_string()))?
}

#[tauri::command]
pub async fn save_conversation(
    app: AppHandle,
    id: String,
    data: Value,
) -> Result<(), BackendError> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = conversation_path(&app, &id)?;
        crate::storage::write_json(&path, &data).map_err(BackendError::conversations)
    })
    .await
    .map_err(|error| BackendError::conversations(error.to_string()))?
}

#[tauri::command]
pub async fn delete_conversation(app: AppHandle, id: String) -> Result<(), BackendError> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = conversation_path(&app, &id)?;
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(BackendError::conversations(error.to_string())),
        }
    })
    .await
    .map_err(|error| BackendError::conversations(error.to_string()))?
}

#[tauri::command]
pub async fn clear_conversations(app: AppHandle) -> Result<(), BackendError> {
    tauri::async_runtime::spawn_blocking(move || {
        let directory = conversations_directory(&app)?;
        if directory.exists() {
            fs::remove_dir_all(directory)
                .map_err(|error| BackendError::conversations(error.to_string()))?;
        }
        let legacy = legacy_conversations_path(&app)?;
        if legacy.exists() {
            fs::remove_file(legacy)
                .map_err(|error| BackendError::conversations(error.to_string()))?;
        }
        Ok(())
    })
    .await
    .map_err(|error| BackendError::conversations(error.to_string()))?
}

// Compatibility command for older frontend builds. New code should use the scoped commands above.
#[tauri::command]
pub async fn load_conversations(app: AppHandle) -> Result<Option<Value>, BackendError> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = legacy_conversations_path(&app)?;
        if !path.exists() {
            return Ok(None);
        }
        let contents = crate::storage::read_json(&path).map_err(BackendError::conversations)?;
        serde_json::from_str(&contents)
            .map(Some)
            .map_err(|error| BackendError::conversations(error.to_string()))
    })
    .await
    .map_err(|error| BackendError::conversations(error.to_string()))?
}

#[tauri::command]
pub async fn save_conversations(app: AppHandle, data: Value) -> Result<(), BackendError> {
    tauri::async_runtime::spawn_blocking(move || {
        let (index, records) = document_parts(&data)?;
        write_records(&app, records)?;
        write_index(&app, &index)
    })
    .await
    .map_err(|error| BackendError::conversations(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::validate_conversation_id;

    #[test]
    fn rejects_path_traversal_conversation_ids() {
        assert!(validate_conversation_id("").is_err());
        assert!(validate_conversation_id("../outside").is_err());
        assert!(validate_conversation_id("folder\\conversation").is_err());
        assert!(validate_conversation_id("conversation-123").is_ok());
    }
}
