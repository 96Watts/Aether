use std::io::{BufRead, BufReader};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::client::{AiCapabilities, AiClient, AiRequest, AiResponse, AiStreamKind};
use super::providers::CredentialStore;
use crate::errors::BackendError;

const DEFAULT_ENDPOINT: &str = "https://api.openai.com/v1";

#[derive(Clone)]
pub struct OpenAiClient {
    agent: ureq::Agent,
}

impl Default for OpenAiClient {
    fn default() -> Self {
        Self {
            agent: ureq::AgentBuilder::new()
                .timeout(Duration::from_secs(120))
                .build(),
        }
    }
}

#[derive(Debug, Serialize)]
struct OpenAiChatRequest<'a> {
    model: &'a str,
    messages: &'a [super::client::AiMessage],
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
}

#[derive(Debug, Deserialize, Default)]
struct OpenAiError {
    #[serde(default)]
    message: String,
}

#[derive(Debug, Deserialize, Default, Clone)]
struct OpenAiMessage {
    #[serde(default)]
    role: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    reasoning: Option<String>,
    #[serde(default)]
    reasoning_content: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct OpenAiDelta {
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    reasoning: Option<String>,
    #[serde(default)]
    reasoning_content: Option<String>,
}

#[derive(Deserialize, Default)]
struct OpenAiChoice {
    #[serde(default)]
    message: Option<OpenAiMessage>,
    #[serde(default)]
    delta: Option<OpenAiDelta>,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize, Default)]
struct OpenAiResponse {
    #[serde(default)]
    choices: Vec<OpenAiChoice>,
    #[serde(default)]
    error: Option<OpenAiError>,
}

#[derive(Debug, Deserialize)]
struct OpenAiModelRef {
    id: String,
    #[serde(default)]
    context_length: Option<u32>,
    #[serde(default)]
    context_window: Option<u32>,
    #[serde(default)]
    max_context_length: Option<u32>,
    #[serde(default)]
    max_output_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct OpenAiModelList {
    data: Vec<OpenAiModelRef>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredModel {
    pub id: String,
    pub name: String,
    pub provider_id: String,
    pub context_length: Option<u32>,
    pub max_output_tokens: Option<u32>,
    pub capabilities: ModelCapabilities,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapabilities {
    pub supports_reasoning: bool,
    pub supports_streaming: bool,
    pub supports_cancellation: bool,
    pub supports_vision: bool,
    pub supports_tools: bool,
    pub supports_system_prompt: bool,
    pub supports_temperature: bool,
}

fn provider_id_for(request: &AiRequest) -> String {
    request
        .provider_config
        .as_ref()
        .filter(|config| !config.id.trim().is_empty())
        .map(|config| config.id.trim().to_string())
        .unwrap_or_else(|| request.provider.trim().to_string())
}

fn endpoint_for(request: &AiRequest) -> String {
    request
        .provider_config
        .as_ref()
        .map(|config| config.base_url.trim())
        .filter(|base_url| !base_url.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string())
        .trim_end_matches('/')
        .to_string()
}

fn model_name(model: &str) -> Result<String, BackendError> {
    let trimmed = model.trim();
    if trimmed.is_empty() || trimmed.len() > 256 || trimmed.chars().any(|character| character.is_control()) {
        return Err(BackendError::ai(
            "model_unavailable",
            "Invalid OpenAI model name",
        ));
    }
    Ok(trimmed.to_string())
}

fn auth_header(provider_id: &str) -> Result<String, BackendError> {
    let api_key = CredentialStore::default().read(provider_id).map_err(|_| {
        BackendError::ai(
            "authentication_failed",
            "OpenAI credentials are not available",
        )
    })?;
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err(BackendError::ai(
            "authentication_failed",
            "OpenAI credentials are empty",
        ));
    }
    Ok(format!("Bearer {api_key}"))
}

fn request_error(error: ureq::Error) -> BackendError {
    match error {
        ureq::Error::Status(status, _) if status == 401 || status == 403 => {
            BackendError::ai("authentication_failed", "OpenAI rejected the request")
        }
        ureq::Error::Status(_, _) => {
            BackendError::ai("provider_error", "OpenAI returned an error")
        }
        ureq::Error::Transport(_) => {
            BackendError::ai("runtime_unavailable", "OpenAI could not be reached")
        }
    }
}

fn response_error(payload: &OpenAiResponse) -> Result<(), BackendError> {
    if let Some(error) = &payload.error {
        if error.message.trim().is_empty() {
            return Err(BackendError::ai("provider_error", "OpenAI returned an error"));
        }
        return Err(BackendError::ai("provider_error", error.message.trim()));
    }
    Ok(())
}

fn choose_message(payload: &OpenAiResponse) -> Result<Option<OpenAiMessage>, BackendError> {
    response_error(payload)?;
    Ok(payload
        .choices
        .iter()
        .find_map(|choice| choice.message.clone()))
}

fn extract_reasoning(message: &OpenAiMessage) -> Option<String> {
    let reasoning = message
        .reasoning
        .as_deref()
        .filter(|content| !content.trim().is_empty())
        .or_else(|| {
            message
                .reasoning_content
                .as_deref()
                .filter(|content| !content.trim().is_empty())
        });
    reasoning.map(str::to_string)
}

fn extract_delta_reasoning(delta: &OpenAiDelta) -> Option<String> {
    delta
        .reasoning
        .as_deref()
        .filter(|content| !content.trim().is_empty())
        .or_else(|| {
            delta
                .reasoning_content
                .as_deref()
                .filter(|content| !content.trim().is_empty())
        })
        .map(str::to_string)
}

impl AiClient for OpenAiClient {
    fn capabilities(&self) -> AiCapabilities {
        AiCapabilities {
            supports_reasoning: false,
            supports_streaming: true,
            supports_cancellation: true,
            supports_vision: false,
            supports_tools: false,
            supports_system_prompt: true,
            supports_temperature: true,
        }
    }

    fn send(&self, request: &AiRequest) -> Result<AiResponse, BackendError> {
        let provider_id = provider_id_for(request);
        let model = model_name(&request.model)?;
        let endpoint = endpoint_for(request);
        let auth = auth_header(&provider_id)?;

        let payload = self
            .agent
            .post(&format!("{endpoint}/chat/completions"))
            .set("Authorization", &auth)
            .set("Content-Type", "application/json")
            .send_json(&OpenAiChatRequest {
                model: &model,
                messages: &request.messages,
                stream: false,
                temperature: None,
            })
            .map_err(request_error)?;

        let response: OpenAiResponse = payload
            .into_json()
            .map_err(|_| BackendError::ai("provider_error", "OpenAI returned invalid JSON"))?;

        let message = choose_message(&response)?.ok_or_else(|| {
            BackendError::ai("provider_error", "OpenAI returned no response content")
        })?;

        Ok(AiResponse {
            request_id: request.request_id.clone(),
            reasoning: extract_reasoning(&message),
            content: message.content.trim().to_string(),
            model: model.clone(),
        })
    }

    fn stream(
        &self,
        request: &AiRequest,
        cancelled: &dyn Fn() -> bool,
        on_chunk: &mut dyn FnMut(&str, AiStreamKind) -> Result<(), BackendError>,
    ) -> Result<(), BackendError> {
        let provider_id = provider_id_for(request);
        let model = model_name(&request.model)?;
        let endpoint = endpoint_for(request);
        let auth = auth_header(&provider_id)?;

        let response = self
            .agent
            .post(&format!("{endpoint}/chat/completions"))
            .set("Authorization", &auth)
            .set("Content-Type", "application/json")
            .send_json(&OpenAiChatRequest {
                model: &model,
                messages: &request.messages,
                stream: true,
                temperature: None,
            })
            .map_err(request_error)?;

        let mut reader = BufReader::new(response.into_reader());
        let mut line = String::new();
        loop {
            if cancelled() {
                return Err(BackendError::ai(
                    "request_cancelled",
                    "The request was cancelled",
                ));
            }

            line.clear();
            let read = reader
                .read_line(&mut line)
                .map_err(|_| BackendError::ai("network_error", "OpenAI streaming failed"))?;
            if read == 0 {
                break;
            }

            let payload = line.trim();
            if payload.is_empty() {
                continue;
            }
            let payload = payload.strip_prefix("data:").unwrap_or(payload).trim();
            if payload.is_empty() || payload == "[DONE]" {
                continue;
            }

            let data: OpenAiResponse = serde_json::from_str(payload).map_err(|_| {
                BackendError::ai("provider_error", "OpenAI returned invalid stream data")
            })?;
            if let Some(error) = &data.error {
                return Err(BackendError::ai("provider_error", error.message.trim()));
            }

            for choice in &data.choices {
                if let Some(delta) = &choice.delta {
                    if let Some(reasoning) = extract_delta_reasoning(delta) {
                        on_chunk(&reasoning, AiStreamKind::Reasoning)?;
                    }
                    if let Some(content) = delta.content.as_deref().filter(|text| !text.trim().is_empty()) {
                        on_chunk(content, AiStreamKind::Response)?;
                    }
                }
            }
        }

        Ok(())
    }
}

pub fn discover_models(provider_id: &str, base_url: &str) -> Result<Vec<DiscoveredModel>, String> {
    let provider_id = provider_id.trim();
    if provider_id.is_empty() {
        return Err("Provider ID is required".to_string());
    }
    let endpoint = if base_url.trim().is_empty() {
        DEFAULT_ENDPOINT.to_string()
    } else {
        base_url.trim().to_string()
    }
    .trim_end_matches('/')
    .to_string();

    let auth = auth_header(provider_id).map_err(|error| error.detail)?;
    let response = ureq::get(&format!("{endpoint}/models"))
        .set("Authorization", &auth)
        .call()
        .map_err(|error| match error {
            ureq::Error::Status(status, _) if status == 401 || status == 403 => {
                "OpenAI rejected the model discovery request".to_string()
            }
            ureq::Error::Status(_, _) => "OpenAI returned an error during model discovery".to_string(),
            ureq::Error::Transport(_) => "OpenAI model discovery could not be reached".to_string(),
        })?;

    let payload: OpenAiModelList = response
        .into_json()
        .map_err(|_| "OpenAI returned invalid model metadata".to_string())?;

    Ok(payload
        .data
        .into_iter()
        .map(|model| DiscoveredModel {
            id: model.id.clone(),
            name: model.id,
            provider_id: provider_id.to_string(),
            context_length: model.context_length.or(model.context_window).or(model.max_context_length),
            max_output_tokens: model.max_output_tokens,
            capabilities: ModelCapabilities {
                supports_reasoning: false,
                supports_streaming: true,
                supports_cancellation: true,
                supports_vision: false,
                supports_tools: false,
                supports_system_prompt: true,
                supports_temperature: true,
            },
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::{choose_message, extract_delta_reasoning, model_name, OpenAiChoice, OpenAiDelta, OpenAiMessage, OpenAiResponse};

    #[test]
    fn validates_openai_model_names() {
        assert_eq!(model_name("gpt-4o-mini").unwrap(), "gpt-4o-mini");
        assert!(model_name(" ").is_err());
    }

    #[test]
    fn extracts_reasoning_when_present() {
        let response = OpenAiResponse {
            choices: vec![OpenAiChoice {
                message: Some(OpenAiMessage {
                    role: "assistant".to_string(),
                    content: "4".to_string(),
                    reasoning: None,
                    reasoning_content: Some("Direct computation".to_string()),
                }),
                delta: None,
                finish_reason: None,
            }],
            error: None,
        };
        let message = choose_message(&response).unwrap().unwrap();
        assert_eq!(message.reasoning_content.as_deref(), Some("Direct computation"));
    }

    #[test]
    fn extracts_stream_reasoning_chunks() {
        let delta = OpenAiDelta {
            role: None,
            content: Some("hello".to_string()),
            reasoning: None,
            reasoning_content: Some("thinking".to_string()),
        };
        assert_eq!(extract_delta_reasoning(&delta).as_deref(), Some("thinking"));
    }
}
