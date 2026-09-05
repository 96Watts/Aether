pub mod client;
pub mod local_models;
pub mod ollama;
pub mod openai;
pub mod providers;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use crate::errors::BackendError;
use crate::local_runtimes;
use crate::local_runtimes::RuntimeStatus;
use providers::{CredentialStore, ProviderMetadata};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use client::{validate_request, AiClient, AiRequest, AiResponse, AiStreamEvent, AiStreamKind};
use ollama::{cancellation_flag, OllamaClient};
use openai::OpenAiClient;

#[derive(Clone, Default)]
pub struct RequestRegistry {
    active: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    ollama: Arc<OllamaClient>,
    openai: Arc<OpenAiClient>,
}

impl RequestRegistry {
    fn start(&self, request_id: &str) -> Result<Arc<AtomicBool>, BackendError> {
        let mut active = self.active.lock().map_err(|_| {
            BackendError::ai("request_state_failed", "AI request state is unavailable")
        })?;
        if active.contains_key(request_id) {
            return Err(BackendError::ai(
                "request_in_progress",
                "A request is already active",
            ));
        }
        let flag = Arc::new(AtomicBool::new(false));
        active.insert(request_id.to_string(), flag.clone());
        Ok(flag)
    }

    fn cancel(&self, request_id: &str) -> Result<bool, BackendError> {
        let active = self.active.lock().map_err(|_| {
            BackendError::ai("request_state_failed", "AI request state is unavailable")
        })?;
        if let Some(flag) = active.get(request_id) {
            flag.store(true, std::sync::atomic::Ordering::Relaxed);
            return Ok(true);
        }
        Ok(false)
    }

    fn finish(&self, request_id: &str) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(request_id);
        }
    }
}

fn client_for(
    request: &AiRequest,
    registry: &RequestRegistry,
) -> Result<Arc<dyn AiClient>, BackendError> {
    match request.provider.as_str() {
        "ollama" => Ok(registry.ollama.clone()),
        "openai" | "openrouter" => Ok(registry.openai.clone()),
        _ => Err(BackendError::ai(
            "provider_not_configured",
            "The selected AI provider is not configured",
        )),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSources {
    pub providers: Vec<ProviderMetadata>,
    pub runtimes: Vec<RuntimeStatus>,
}

#[tauri::command]
pub async fn discover_provider_models(
    provider_id: String,
    base_url: String,
) -> Result<Vec<openai::DiscoveredModel>, BackendError> {
    match provider_id.as_str() {
        "openai" | "openrouter" => {}
        _ => {
            return Err(BackendError::ai(
                "provider_not_configured",
                "Provider model discovery is not implemented",
            ));
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        openai::discover_models(&provider_id, &base_url)
            .map_err(|error| BackendError::ai("provider_error", error))
    })
    .await
    .map_err(|error| BackendError::ai("request_failed", error.to_string()))?
}

#[tauri::command]
pub async fn get_ai_sources(
    model_directories: Option<Vec<String>>,
) -> Result<AiSources, BackendError> {
    #[cfg(debug_assertions)]
    let started = std::time::Instant::now();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let runtimes = local_runtimes::discover_local_runtimes(model_directories);

        Ok(AiSources {
            // Legacy provider plumbing: metadata is session-only until API adapters are implemented.
            providers: Vec::new(),
            runtimes,
        })
    })
    .await
    .map_err(|error| BackendError::runtime(error.to_string()))?;
    #[cfg(debug_assertions)]
    eprintln!(
        "[perf] get_ai_sources: {} ms",
        started.elapsed().as_millis()
    );
    result
}

#[tauri::command]
pub async fn send_message(
    state: State<'_, RequestRegistry>,
    request: AiRequest,
) -> Result<AiResponse, BackendError> {
    validate_request(&request)?;
    let registry = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let client = client_for(&request, &registry)?;
        client.send(&request)
    })
    .await
    .map_err(|error| BackendError::ai("request_failed", error.to_string()))?
}

#[tauri::command]
pub async fn stream_message(
    app: AppHandle,
    state: State<'_, RequestRegistry>,
    request: AiRequest,
) -> Result<(), BackendError> {
    validate_request(&request)?;
    let registry = state.inner().clone();
    let request_id = request.request_id.clone();
    let cancelled = registry.start(&request_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            let client = client_for(&request, &registry)?;
            let capabilities = client.capabilities();
            if !capabilities.supports_streaming {
                return Err(BackendError::ai(
                    "provider_not_configured",
                    "The selected AI client does not support streaming",
                ));
            }
            let mut emit_chunk = |content: &str, kind: AiStreamKind| {
                app.emit(
                    "ai://stream",
                    AiStreamEvent {
                        request_id: request_id.clone(),
                        kind: match kind {
                            AiStreamKind::Reasoning => "thinking",
                            AiStreamKind::Response => "chunk",
                        }
                        .to_string(),
                        content: Some(content.to_string()),
                        detail: None,
                    },
                )
                .map_err(|error| BackendError::ai("ipc_failed", error.to_string()))
            };
            client.stream(&request, &cancellation_flag(&cancelled), &mut emit_chunk)
        })();
        registry.finish(&request_id);

        match result {
            Ok(()) => app
                .emit(
                    "ai://stream",
                    AiStreamEvent {
                        request_id,
                        kind: "done".to_string(),
                        content: None,
                        detail: None,
                    },
                )
                .map_err(|error| BackendError::ai("ipc_failed", error.to_string())),
            Err(error) => {
                let _ = app.emit(
                    "ai://stream",
                    AiStreamEvent {
                        request_id,
                        kind: "error".to_string(),
                        content: None,
                        detail: Some(error.detail.clone()),
                    },
                );
                Err(error)
            }
        }
    })
    .await
    .map_err(|error| BackendError::ai("request_failed", error.to_string()))?
}

#[tauri::command]
pub fn cancel_message(
    state: State<'_, RequestRegistry>,
    request_id: String,
) -> Result<bool, BackendError> {
    state.cancel(&request_id)
}

#[tauri::command]
pub async fn store_provider_credential(
    provider_id: String,
    api_key: String,
) -> Result<(), BackendError> {
    if provider_id.trim().is_empty() || api_key.trim().is_empty() {
        return Err(BackendError::invalid_input(
            "Provider ID and API key are required",
        ));
    }

    tauri::async_runtime::spawn_blocking(move || {
        CredentialStore::default()
            .store(&provider_id, &api_key)
            .map_err(|error| BackendError::credential_store(error.to_string()))
    })
    .await
    .map_err(|error| BackendError::credential_store(error.to_string()))?
}

#[tauri::command]
pub async fn clear_provider_credential(provider_id: String) -> Result<(), BackendError> {
    tauri::async_runtime::spawn_blocking(move || {
        CredentialStore::default()
            .delete(&provider_id)
            .map_err(|error| BackendError::credential_delete(error.to_string()))
    })
    .await
    .map_err(|error| BackendError::credential_delete(error.to_string()))?
}

#[allow(dead_code)]
pub fn local_backends() -> Vec<Box<dyn local_models::LocalModelBackend>> {
    Vec::new()
}

#[allow(dead_code)]
pub fn configured_model_directories() -> Vec<PathBuf> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::{client_for, AiRequest, RequestRegistry};

    #[test]
    fn request_registry_supports_cancellation_and_cleanup() {
        let registry = RequestRegistry::default();
        let flag = registry.start("request-1").unwrap();
        assert!(!flag.load(std::sync::atomic::Ordering::Relaxed));
        assert!(registry.cancel("request-1").unwrap());
        assert!(flag.load(std::sync::atomic::Ordering::Relaxed));
        registry.finish("request-1");
        assert!(!registry.cancel("request-1").unwrap());
    }

    #[test]
    fn openai_compatible_provider_routes_to_openai_adapter() {
        let registry = RequestRegistry::default();
        let request = AiRequest {
            request_id: "request-2".to_string(),
            provider: "openrouter".to_string(),
            model: "openrouter:model".to_string(),
            messages: vec![],
            context_size: None,
            provider_config: None,
        };
        let result = client_for(&request, &registry);
        assert!(result.is_ok());
    }
}
