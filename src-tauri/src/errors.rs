use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct BackendError {
    pub code: &'static str,
    pub detail: String,
}

impl BackendError {
    pub fn invalid_input(detail: impl Into<String>) -> Self {
        Self {
            code: "invalid_input",
            detail: detail.into(),
        }
    }

    pub fn credential_store(detail: impl Into<String>) -> Self {
        Self {
            code: "credential_store_unavailable",
            detail: detail.into(),
        }
    }

    pub fn credential_delete(detail: impl Into<String>) -> Self {
        Self {
            code: "credential_delete_failed",
            detail: detail.into(),
        }
    }

    pub fn settings(detail: impl Into<String>) -> Self {
        Self {
            code: "settings_io_failed",
            detail: detail.into(),
        }
    }

    pub fn conversations(detail: impl Into<String>) -> Self {
        Self {
            code: "conversations_io_failed",
            detail: detail.into(),
        }
    }

    pub fn files(detail: impl Into<String>) -> Self {
        Self {
            code: "filesystem_operation_failed",
            detail: detail.into(),
        }
    }

    pub fn runtime(detail: impl Into<String>) -> Self {
        Self {
            code: "runtime_discovery_failed",
            detail: detail.into(),
        }
    }

    pub fn system(detail: impl Into<String>) -> Self {
        Self {
            code: "system_info_failed",
            detail: detail.into(),
        }
    }

    pub fn logging(detail: impl Into<String>) -> Self {
        Self {
            code: "logging_failed",
            detail: detail.into(),
        }
    }

    pub fn ai(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}
