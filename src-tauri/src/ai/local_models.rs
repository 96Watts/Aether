#![allow(dead_code)]

use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelMetadata {
    pub id: String,
    pub name: String,
    pub backend: String,
    pub status: String,
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelCapabilities {
    pub supports_reasoning: bool,
    pub supports_streaming: bool,
    pub supports_cancellation: bool,
}

pub trait LocalModelBackend: Send + Sync {
    fn id(&self) -> &'static str;
    fn capabilities(&self) -> LocalModelCapabilities {
        LocalModelCapabilities {
            supports_reasoning: false,
            supports_streaming: false,
            supports_cancellation: false,
        }
    }
    fn discover_models(&self) -> Result<Vec<LocalModelMetadata>, String>;
}

pub struct OllamaBackend;
pub struct LmStudioBackend;
pub struct LlamaCppBackend;

impl LocalModelBackend for OllamaBackend {
    fn id(&self) -> &'static str {
        "ollama"
    }
    fn discover_models(&self) -> Result<Vec<LocalModelMetadata>, String> {
        Err("Ollama adapter is not connected yet".to_string())
    }
}

impl LocalModelBackend for LmStudioBackend {
    fn id(&self) -> &'static str {
        "lm-studio"
    }
    fn discover_models(&self) -> Result<Vec<LocalModelMetadata>, String> {
        Err("LM Studio adapter is not connected yet".to_string())
    }
}

impl LocalModelBackend for LlamaCppBackend {
    fn id(&self) -> &'static str {
        "llama.cpp"
    }
    fn discover_models(&self) -> Result<Vec<LocalModelMetadata>, String> {
        Err("llama.cpp adapter is not connected yet".to_string())
    }
}
