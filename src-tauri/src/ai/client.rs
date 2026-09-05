use serde::{Deserialize, Serialize};

use crate::errors::BackendError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRequest {
    pub request_id: String,
    pub provider: String,
    pub model: String,
    pub messages: Vec<AiMessage>,
    #[serde(default)]
    pub context_size: Option<u32>,
    #[serde(default)]
    pub provider_config: Option<AiProviderConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderConfig {
    pub id: String,
    pub base_url: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCapabilities {
    pub supports_reasoning: bool,
    pub supports_streaming: bool,
    pub supports_cancellation: bool,
    pub supports_vision: bool,
    pub supports_tools: bool,
    pub supports_system_prompt: bool,
    pub supports_temperature: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiResponse {
    pub request_id: String,
    pub reasoning: Option<String>,
    pub content: String,
    pub model: String,
}

#[derive(Debug, Clone, Copy)]
pub enum AiStreamKind {
    Reasoning,
    Response,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStreamEvent {
    pub request_id: String,
    pub kind: String,
    pub content: Option<String>,
    pub detail: Option<String>,
}

pub trait AiClient: Send + Sync {
    fn capabilities(&self) -> AiCapabilities;

    fn send(&self, request: &AiRequest) -> Result<AiResponse, BackendError>;

    fn stream(
        &self,
        request: &AiRequest,
        cancelled: &dyn Fn() -> bool,
        on_chunk: &mut dyn FnMut(&str, AiStreamKind) -> Result<(), BackendError>,
    ) -> Result<(), BackendError>;
}

pub fn validate_request(request: &AiRequest) -> Result<(), BackendError> {
    if request.request_id.trim().is_empty() {
        return Err(BackendError::ai(
            "invalid_request",
            "Request ID is required",
        ));
    }
    if request.provider.trim().is_empty() {
        return Err(BackendError::ai(
            "provider_not_configured",
            "An AI provider is required",
        ));
    }
    if request.model.trim().is_empty() {
        return Err(BackendError::ai("model_unavailable", "A model is required"));
    }
    if request.messages.is_empty() {
        return Err(BackendError::ai(
            "invalid_request",
            "At least one message is required",
        ));
    }
    if request.messages.len() > 256 {
        return Err(BackendError::ai(
            "invalid_request",
            "The conversation is too long",
        ));
    }
    for message in &request.messages {
        if !matches!(message.role.as_str(), "user" | "assistant") {
            return Err(BackendError::ai(
                "invalid_request",
                "Unsupported message role",
            ));
        }
        if message.content.len() > 1024 * 1024 {
            return Err(BackendError::ai(
                "invalid_request",
                "A message is too large",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{validate_request, AiMessage, AiRequest};

    fn request() -> AiRequest {
        AiRequest {
            request_id: "request-1".to_string(),
            provider: "ollama".to_string(),
            model: "ollama:gemma".to_string(),
            messages: vec![AiMessage {
                role: "user".to_string(),
                content: "Hello".to_string(),
            }],
            context_size: None,
            provider_config: None,
        }
    }

    #[test]
    fn accepts_common_messages() {
        assert!(validate_request(&request()).is_ok());
    }

    #[test]
    fn rejects_unknown_roles() {
        let mut request = request();
        request.messages[0].role = "system".to_string();
        assert_eq!(
            validate_request(&request).unwrap_err().code,
            "invalid_request"
        );
    }
}
