use std::io::{BufRead, BufReader};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use std::io;
use serde::{Deserialize, Serialize};

use super::client::{AiCapabilities, AiClient, AiMessage, AiRequest, AiResponse, AiStreamKind};
use crate::errors::BackendError;

const DEFAULT_ENDPOINT: &str = "http://127.0.0.1:11434";
const STREAM_READ_TIMEOUT: Duration = Duration::from_millis(100);

pub struct OllamaClient {
    agent: ureq::Agent,
    stream_agent: ureq::Agent,
    endpoint: String,
}

impl Default for OllamaClient {
    fn default() -> Self {
        Self {
            agent: ureq::AgentBuilder::new()
                .timeout(Duration::from_secs(120))
                .build(),
            stream_agent: ureq::AgentBuilder::new()
                .timeout(Duration::from_secs(120))
                .timeout_read(STREAM_READ_TIMEOUT)
                .build(),
            endpoint: DEFAULT_ENDPOINT.to_string(),
        }
    }
}

#[derive(Debug, Serialize)]
struct OllamaRequest<'a> {
    model: &'a str,
    messages: &'a [AiMessage],
    stream: bool,
    think: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<OllamaOptions>,
}

#[derive(Debug, Serialize)]
struct OllamaOptions {
    num_ctx: u32,
}

#[derive(Debug, Deserialize)]
struct OllamaMessage {
    #[serde(default)]
    content: String,
    #[serde(default)]
    thinking: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OllamaResponse {
    message: Option<OllamaMessage>,
    #[serde(default)]
    error: Option<String>,
}

fn model_name(model: &str) -> Result<&str, BackendError> {
    let name = model.strip_prefix("ollama:").unwrap_or(model).trim();
    if name.is_empty() || name.len() > 256 || name.chars().any(|character| character.is_control()) {
        return Err(BackendError::ai(
            "model_unavailable",
            "Invalid Ollama model name",
        ));
    }
    Ok(name)
}

fn request_error(error: ureq::Error) -> BackendError {
    match error {
        ureq::Error::Status(status, _) if status == 401 || status == 403 => {
            BackendError::ai("authentication_failed", "Ollama rejected the request")
        }
        ureq::Error::Status(_, _) => BackendError::ai("provider_error", "Ollama returned an error"),
        ureq::Error::Transport(_) => {
            BackendError::ai("runtime_unavailable", "Ollama could not be reached")
        }
    }
}

fn parse_response_parts(
    response: OllamaResponse,
    model: &str,
) -> Result<(Option<String>, String), BackendError> {
    if let Some(error) = response.error {
        return Err(BackendError::ai("provider_error", error));
    }
    let message = response.message.ok_or_else(|| {
        BackendError::ai(
            "provider_error",
            format!("Ollama returned no response for {model}"),
        )
    })?;
    Ok((message.thinking, message.content))
}

impl AiClient for OllamaClient {
    fn capabilities(&self) -> AiCapabilities {
        AiCapabilities {
            supports_reasoning: true,
            supports_streaming: true,
            supports_cancellation: true,
            supports_vision: false,
            supports_tools: false,
            supports_system_prompt: false,
            supports_temperature: false,
        }
    }

    fn send(&self, request: &AiRequest) -> Result<AiResponse, BackendError> {
        let model = model_name(&request.model)?;
        let response = self
            .agent
            .post(&format!("{}/api/chat", self.endpoint))
            .send_json(OllamaRequest {
                model,
                messages: &request.messages,
                stream: false,
                think: true,
                options: None,
            })
            .map_err(request_error)?;
        let payload: OllamaResponse = response
            .into_json()
            .map_err(|_| BackendError::ai("provider_error", "Ollama returned invalid JSON"))?;
        let (reasoning, content) = parse_response_parts(payload, model)?;
        Ok(AiResponse {
            request_id: request.request_id.clone(),
            reasoning,
            content,
            model: model.to_string(),
        })
    }

    fn stream(
        &self,
        request: &AiRequest,
        cancelled: &dyn Fn() -> bool,
        on_chunk: &mut dyn FnMut(&str, AiStreamKind) -> Result<(), BackendError>,
    ) -> Result<(), BackendError> {
        let model = model_name(&request.model)?;
        let response = self
            .stream_agent
            .post(&format!("{}/api/chat", self.endpoint))
            .send_json(OllamaRequest {
                model,
                messages: &request.messages,
                stream: true,
                think: true,
                options: request.context_size.map(|num_ctx| OllamaOptions { num_ctx }),
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
            let read = match reader.read_line(&mut line) {
                Ok(read) => read,
                Err(error) if is_stream_read_timeout(&error) => continue,
                Err(_) => return Err(BackendError::ai("network_error", "Ollama streaming failed")),
            };
            if read == 0 {
                break;
            }
            let payload: OllamaResponse = serde_json::from_str(line.trim()).map_err(|_| {
                BackendError::ai("provider_error", "Ollama returned invalid stream data")
            })?;
            if let Some(error) = payload.error {
                return Err(BackendError::ai("provider_error", error));
            }
            if let Some(message) = payload.message {
                if let Some(thinking) = message.thinking {
                    if !thinking.is_empty() {
                        on_chunk(&thinking, AiStreamKind::Reasoning)?;
                    }
                }
                if !message.content.is_empty() {
                    on_chunk(&message.content, AiStreamKind::Response)?;
                }
            }
        }
        Ok(())
    }
}

fn is_stream_read_timeout(error: &io::Error) -> bool {
    matches!(error.kind(), io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock)
}

pub fn cancellation_flag(flag: &Arc<std::sync::atomic::AtomicBool>) -> impl Fn() -> bool + '_ {
    move || flag.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::{is_stream_read_timeout, model_name, parse_response_parts, OllamaMessage, OllamaOptions, OllamaRequest, OllamaResponse};
    use crate::ai::client::AiMessage;

    #[test]
    fn strips_ollama_model_prefix() {
        assert_eq!(model_name("ollama:gemma3").unwrap(), "gemma3");
    }

    #[test]
    fn rejects_empty_model_names() {
        assert!(model_name("ollama:").is_err());
    }

    #[test]
    fn retries_stream_reads_after_timeout() {
        assert!(is_stream_read_timeout(&std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "poll",
        )));
        assert!(is_stream_read_timeout(&std::io::Error::new(
            std::io::ErrorKind::WouldBlock,
            "poll",
        )));
    }

    #[test]
    fn serializes_chat_request_without_streaming_by_default() {
        let message = AiMessage {
            role: "user".to_string(),
            content: "Hello".to_string(),
        };
        let request = OllamaRequest {
            model: "gemma3",
            messages: std::slice::from_ref(&message),
            stream: false,
            think: true,
            options: None,
        };
        let value = serde_json::to_value(request).unwrap();
        assert_eq!(value["model"], "gemma3");
        assert_eq!(value["stream"], false);
        assert_eq!(value["think"], true);
        assert_eq!(value["messages"][0]["role"], "user");
    }

    #[test]
    fn serializes_configured_stream_context_size() {
        let message = AiMessage {
            role: "user".to_string(),
            content: "Hello".to_string(),
        };
        let request = OllamaRequest {
            model: "gemma3",
            messages: std::slice::from_ref(&message),
            stream: true,
            think: true,
            options: Some(OllamaOptions { num_ctx: 32768 }),
        };
        let value = serde_json::to_value(request).unwrap();
        assert_eq!(value["options"]["num_ctx"], 32768);
    }

    #[test]
    fn parses_assistant_response_content() {
        let response = OllamaResponse {
            message: Some(OllamaMessage {
                content: "Hello back".to_string(),
                thinking: None,
            }),
            error: None,
        };
        let (reasoning, content) = parse_response_parts(response, "gemma3").unwrap();
        assert_eq!(reasoning, None);
        assert_eq!(content, "Hello back");
    }

    #[test]
    fn preserves_provider_reasoning_when_returned() {
        let response = OllamaResponse {
            message: Some(OllamaMessage {
                content: "4".to_string(),
                thinking: Some("The arithmetic is direct.".to_string()),
            }),
            error: None,
        };
        let (reasoning, content) = parse_response_parts(response, "gemma3").unwrap();
        assert_eq!(reasoning.as_deref(), Some("The arithmetic is direct."));
        assert_eq!(content, "4");
    }
}
