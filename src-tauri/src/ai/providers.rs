#![allow(dead_code)]

use keyring::Entry;
use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProviderMetadata {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub enabled: bool,
    pub has_credentials: bool,
    pub base_url: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    pub supports_reasoning: bool,
    pub supports_streaming: bool,
    pub supports_cancellation: bool,
}

pub trait ProviderAdapter: Send + Sync {
    fn id(&self) -> &'static str;
    fn metadata(&self) -> ProviderMetadata;
    fn capabilities(&self) -> ProviderCapabilities;
    fn list_models(&self) -> Result<Vec<String>, String>;
}

#[derive(Default)]
pub struct CredentialStore;

impl CredentialStore {
    pub fn store(&self, provider_id: &str, api_key: &str) -> Result<(), keyring::Error> {
        let entry = Entry::new("aiinterface", provider_id)?;
        entry.set_password(api_key)
    }

    pub fn delete(&self, provider_id: &str) -> Result<(), keyring::Error> {
        let entry = Entry::new("aiinterface", provider_id)?;
        entry.delete_credential()
    }

    pub fn read(&self, provider_id: &str) -> Result<String, keyring::Error> {
        Entry::new("aiinterface", provider_id)?.get_password()
    }
}
