use crate::errors::BackendError;
use serde::{Deserialize, Serialize};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelInfo {
    pub id: String,
    pub name: String,
    pub backend: String,
    pub size_bytes: Option<u64>,
    pub path: Option<String>,
    pub detail: String,
    pub context_length: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub id: String,
    pub name: String,
    pub available: bool,
    pub detail: String,
    pub models: Vec<LocalModelInfo>,
}

const DISCOVERY_CACHE_TTL: Duration = Duration::from_secs(10);
const MAX_DISCOVERY_CACHE_ENTRIES: usize = 4;

struct DiscoveryCacheEntry {
    directories: Vec<PathBuf>,
    expires_at: Instant,
    runtimes: Vec<RuntimeStatus>,
}

fn discovery_cache() -> &'static Mutex<Vec<DiscoveryCacheEntry>> {
    static CACHE: OnceLock<Mutex<Vec<DiscoveryCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

fn find_on_path(names: &[&str]) -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    let started = Instant::now();
    let path_var = std::env::var_os("PATH")?;
    let mut result = None;
    'search: for directory in std::env::split_paths(&path_var) {
        for name in names {
            let candidate = directory.join(name);
            if candidate.is_file() {
                result = Some(candidate);
                break 'search;
            }
            let with_exe = directory.join(format!("{name}.exe"));
            if with_exe.is_file() {
                result = Some(with_exe);
                break 'search;
            }
        }
    }
    #[cfg(debug_assertions)]
    eprintln!(
        "[perf] executable lookup {:?}: {} ms ({})",
        names,
        started.elapsed().as_millis(),
        if result.is_some() { "found" } else { "missing" }
    );
    result
}

fn loopback_available(port: u16) -> bool {
    #[cfg(debug_assertions)]
    let started = Instant::now();
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let available = TcpStream::connect_timeout(&address, Duration::from_millis(120)).is_ok();
    #[cfg(debug_assertions)]
    eprintln!(
        "[perf] loopback preflight 127.0.0.1:{}: {} ms ({})",
        port,
        started.elapsed().as_millis(),
        if available { "open" } else { "closed" }
    );
    available
}

fn http_json(url: &str, port: u16) -> Result<serde_json::Value, String> {
    #[cfg(debug_assertions)]
    let started = Instant::now();
    if !loopback_available(port) {
        return Err("local runtime port is closed".to_string());
    }
    let response = ureq::get(url)
        .timeout(Duration::from_millis(400))
        .call()
        .map_err(|error| error.to_string())?;
    let result = response.into_json().map_err(|error| error.to_string());
    #[cfg(debug_assertions)]
    eprintln!(
        "[perf] runtime HTTP probe {url}: {} ms",
        started.elapsed().as_millis()
    );
    result
}

fn format_bytes(bytes: u64) -> String {
    if bytes >= 1024 * 1024 * 1024 {
        format!("{:.1} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    } else if bytes >= 1024 * 1024 {
        format!("{:.0} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{bytes} B")
    }
}

#[derive(Debug, Deserialize)]
struct OllamaTag {
    name: String,
    #[serde(default)]
    size: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct OllamaTags {
    #[serde(default)]
    models: Vec<OllamaTag>,
}

fn ollama_model_context_length(name: &str) -> Option<u32> {
    let response = ureq::post("http://127.0.0.1:11434/api/show")
        .timeout(Duration::from_millis(400))
        .send_json(serde_json::json!({ "name": name }))
        .ok()?;
    let payload: serde_json::Value = response.into_json().ok()?;
    payload
        .get("model_info")?
        .as_object()?
        .iter()
        .find_map(|(key, value)| key.ends_with(".context_length").then(|| value.as_u64()).flatten())
        .and_then(|value| u32::try_from(value).ok())
}

fn ollama_model_context_lengths(names: &[String]) -> Vec<Option<u32>> {
    const MAX_METADATA_WORKERS: usize = 4;
    let results = Arc::new(Mutex::new(vec![None; names.len()]));

    std::thread::scope(|scope| {
        for start in (0..names.len()).step_by(MAX_METADATA_WORKERS) {
            let end = (start + MAX_METADATA_WORKERS).min(names.len());
            let results = Arc::clone(&results);
            scope.spawn(move || {
                for index in start..end {
                    let context_length = ollama_model_context_length(&names[index]);
                    if let Ok(mut results) = results.lock() {
                        results[index] = context_length;
                    }
                }
            });
        }
    });

    Arc::try_unwrap(results)
        .ok()
        .and_then(|results| results.into_inner().ok())
        .unwrap_or_else(|| vec![None; names.len()])
}

fn detect_ollama() -> RuntimeStatus {
    #[cfg(debug_assertions)]
    let started = Instant::now();
    let cli = find_on_path(&["ollama"]);
    let server_models = match http_json("http://127.0.0.1:11434/api/tags", 11434) {
        Ok(value) => Some(serde_json::from_value::<OllamaTags>(value)),
        Err(_) => None,
    };

    let (available, detail, models) = match server_models {
        Some(Ok(tags)) => {
            let context_lengths = ollama_model_context_lengths(
                &tags.models.iter().map(|tag| tag.name.clone()).collect::<Vec<_>>(),
            );
            (
                true,
                "Running".to_string(),
                tags.models
                    .into_iter()
                    .enumerate()
                    .map(|(index, tag)| LocalModelInfo {
                    id: format!("ollama:{}", tag.name),
                    name: tag.name.clone(),
                    backend: "ollama".to_string(),
                    size_bytes: tag.size,
                    path: None,
                    detail: tag
                        .size
                        .map(format_bytes)
                        .unwrap_or_else(|| "Installed".to_string()),
                    context_length: context_lengths.get(index).copied().flatten(),
                    })
                    .collect(),
            )
        }
        Some(Err(_)) => (
            false,
            "Server responded with an unexpected response".to_string(),
            Vec::new(),
        ),
        None if cli.is_some() => (
            false,
            "Installed — server is not running".to_string(),
            Vec::new(),
        ),
        None => (false, "Not detected".to_string(), Vec::new()),
    };

    #[cfg(debug_assertions)]
    eprintln!(
        "[perf] Ollama detection total: {} ms",
        started.elapsed().as_millis()
    );
    RuntimeStatus {
        id: "ollama".to_string(),
        name: "Ollama".to_string(),
        available,
        detail,
        models,
    }
}

#[derive(Debug, Deserialize)]
struct LmStudioModels {
    #[serde(default)]
    data: Vec<LmStudioModel>,
}

#[derive(Debug, Deserialize)]
struct LmStudioModel {
    id: String,
}

fn lm_studio_install_probe() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    let started = Instant::now();
    let local_app_data = std::env::var_os("LOCALAPPDATA")?;
    let candidates = [
        Path::new(&local_app_data)
            .join("Programs")
            .join("LM-Studio")
            .join("LM Studio.exe"),
        Path::new(&local_app_data)
            .join("Programs")
            .join("LM Studio")
            .join("LM Studio.exe"),
    ];
    let result = candidates.into_iter().find(|candidate| candidate.is_file());
    #[cfg(debug_assertions)]
    eprintln!(
        "[perf] LM Studio executable lookup: {} ms ({})",
        started.elapsed().as_millis(),
        if result.is_some() { "found" } else { "missing" }
    );
    result
}

fn detect_lm_studio() -> RuntimeStatus {
    #[cfg(debug_assertions)]
    let started = Instant::now();
    let installed = lm_studio_install_probe();

    let (available, detail, models) = match http_json("http://127.0.0.1:1234/v1/models", 1234) {
        Ok(value) => match serde_json::from_value::<LmStudioModels>(value) {
            Ok(payload) => (
                true,
                "Running".to_string(),
                payload
                    .data
                    .into_iter()
                    .map(|model| LocalModelInfo {
                        id: format!("lm-studio:{}", model.id),
                        name: model.id.clone(),
                        backend: "lm-studio".to_string(),
                        size_bytes: None,
                        path: None,
                        detail: "Served by LM Studio".to_string(),
                        context_length: None,
                    })
                    .collect(),
            ),
            Err(_) => (
                false,
                "Server responded with an unexpected response".to_string(),
                Vec::new(),
            ),
        },
        Err(_) if installed.is_some() => (
            false,
            "Installed — local server is not running".to_string(),
            Vec::new(),
        ),
        Err(_) => (false, "Not detected".to_string(), Vec::new()),
    };

    #[cfg(debug_assertions)]
    eprintln!(
        "[perf] LM Studio detection total: {} ms",
        started.elapsed().as_millis()
    );
    RuntimeStatus {
        id: "lm-studio".to_string(),
        name: "LM Studio".to_string(),
        available,
        detail,
        models,
    }
}

#[derive(Default)]
struct ScanStats {
    entries: usize,
    directories: usize,
    models: usize,
    metadata_calls: usize,
    #[cfg(debug_assertions)]
    metadata_ms: u128,
}

fn scan_directory_for_gguf(
    root: &Path,
    depth: usize,
    out: &mut Vec<LocalModelInfo>,
    stats: &mut ScanStats,
) {
    if depth > 4 {
        return;
    }
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries {
        stats.entries += 1;
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        let file_name = entry.file_name();
        let file_name_str = file_name.to_string_lossy();
        if file_name_str.starts_with('.') {
            continue;
        }
        if file_type.is_dir() {
            stats.directories += 1;
            scan_directory_for_gguf(&path, depth + 1, out, stats);
        } else if file_name_str.to_ascii_lowercase().ends_with(".gguf") {
            stats.metadata_calls += 1;
            #[cfg(debug_assertions)]
            let metadata_started = Instant::now();
            let metadata = std::fs::metadata(&path).ok();
            #[cfg(debug_assertions)]
            {
                stats.metadata_ms += metadata_started.elapsed().as_millis();
            }
            let size = metadata.as_ref().map(|m| m.len());
            let detail = size
                .map(format_bytes)
                .unwrap_or_else(|| "GGUF model".to_string());
            out.push(LocalModelInfo {
                id: format!("llama-cpp:{}", path.to_string_lossy()),
                name: file_name_str.to_string(),
                backend: "llama-cpp".to_string(),
                size_bytes: size,
                path: path.to_str().map(str::to_string),
                detail,
                context_length: None,
            });
            stats.models += 1;
        }
    }
}

fn detect_llama_cpp(model_directories: &[PathBuf]) -> RuntimeStatus {
    #[cfg(debug_assertions)]
    let started = Instant::now();
    let mut models = Vec::new();
    let mut stats = ScanStats::default();
    for directory in model_directories {
        if directory.is_dir() {
            scan_directory_for_gguf(directory, 0, &mut models, &mut stats);
        }
    }
    #[cfg(debug_assertions)]
    eprintln!(
        "[perf] GGUF scan: {} entries, {} directories, {} models, {} metadata calls ({} ms) in {} ms",
        stats.entries,
        stats.directories,
        stats.models,
        stats.metadata_calls,
        stats.metadata_ms,
        started.elapsed().as_millis()
    );
    RuntimeStatus {
        id: "llama-cpp".to_string(),
        name: "llama.cpp / GGUF".to_string(),
        available: !models.is_empty() || !model_directories.is_empty(),
        detail: if models.is_empty() {
            if model_directories.is_empty() {
                "No model folders configured".to_string()
            } else {
                "No GGUF models found in configured folders".to_string()
            }
        } else {
            format!(
                "{} GGUF model{} found",
                models.len(),
                if models.len() == 1 { "" } else { "s" }
            )
        },
        models,
    }
}

fn normalize_directories(model_directories: Option<Vec<String>>) -> Vec<PathBuf> {
    #[cfg(debug_assertions)]
    let started = Instant::now();
    let mut directories: Vec<PathBuf> = model_directories
        .unwrap_or_default()
        .into_iter()
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .collect();
    directories.sort_unstable();
    directories.dedup();
    #[cfg(debug_assertions)]
    eprintln!(
        "[perf] model-directory normalization: {} ms ({} directories)",
        started.elapsed().as_millis(),
        directories.len()
    );
    directories
}

fn discover_local_runtimes_uncached(directories: &[PathBuf]) -> Vec<RuntimeStatus> {
    std::thread::scope(|scope| {
        let ollama = scope.spawn(detect_ollama);
        let lm_studio = scope.spawn(detect_lm_studio);
        let llama_cpp = scope.spawn(|| detect_llama_cpp(directories));
        vec![
            ollama
                .join()
                .unwrap_or_else(|_| detect_unavailable("ollama", "Ollama")),
            lm_studio
                .join()
                .unwrap_or_else(|_| detect_unavailable("lm-studio", "LM Studio")),
            llama_cpp
                .join()
                .unwrap_or_else(|_| detect_unavailable("llama-cpp", "llama.cpp / GGUF")),
        ]
    })
}

pub fn discover_local_runtimes(model_directories: Option<Vec<String>>) -> Vec<RuntimeStatus> {
    let directories = normalize_directories(model_directories);
    let now = Instant::now();

    if let Ok(mut cache) = discovery_cache().lock() {
        cache.retain(|entry| entry.expires_at > now);
        if let Some(entry) = cache.iter().find(|entry| entry.directories == directories) {
            #[cfg(debug_assertions)]
            eprintln!("[perf] runtime discovery cache hit");
            return entry.runtimes.clone();
        }
    }

    #[cfg(debug_assertions)]
    let started = Instant::now();
    let runtimes = discover_local_runtimes_uncached(&directories);
    #[cfg(debug_assertions)]
    eprintln!(
        "[perf] runtime discovery: {} ms",
        started.elapsed().as_millis()
    );

    if let Ok(mut cache) = discovery_cache().lock() {
        cache.push(DiscoveryCacheEntry {
            directories,
            expires_at: Instant::now() + DISCOVERY_CACHE_TTL,
            runtimes: runtimes.clone(),
        });
        if cache.len() > MAX_DISCOVERY_CACHE_ENTRIES {
            cache.remove(0);
        }
    }
    runtimes
}

fn detect_unavailable(id: &str, name: &str) -> RuntimeStatus {
    RuntimeStatus {
        id: id.to_string(),
        name: name.to_string(),
        available: false,
        detail: "Detection failed".to_string(),
        models: Vec::new(),
    }
}

#[tauri::command]
pub async fn get_local_runtimes(
    model_directories: Option<Vec<String>>,
) -> Result<Vec<RuntimeStatus>, BackendError> {
    tauri::async_runtime::spawn_blocking(move || discover_local_runtimes(model_directories))
        .await
        .map_err(|error| BackendError::runtime(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::normalize_directories;
    use std::path::PathBuf;

    #[test]
    fn normalizes_empty_and_duplicate_model_directories() {
        let directories = normalize_directories(Some(vec![
            String::new(),
            "models-b".to_string(),
            "models-a".to_string(),
            "models-b".to_string(),
        ]));
        assert_eq!(
            directories,
            vec![PathBuf::from("models-a"), PathBuf::from("models-b")]
        );
    }
}
