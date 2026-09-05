use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
#[cfg(debug_assertions)]
use std::time::Instant;

const MAX_JSON_BYTES: usize = 32 * 1024 * 1024;

fn write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub fn read_json(path: &Path) -> Result<String, String> {
    #[cfg(debug_assertions)]
    #[cfg(debug_assertions)]
    #[cfg(debug_assertions)]
    let started = Instant::now();
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    if contents.len() > MAX_JSON_BYTES {
        return Err(format!(
            "stored JSON exceeds {} MiB",
            MAX_JSON_BYTES / (1024 * 1024)
        ));
    }
    #[cfg(debug_assertions)]
    eprintln!(
        "[perf] read {}: {} bytes in {} ms",
        path.display(),
        contents.len(),
        started.elapsed().as_millis()
    );
    Ok(contents)
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    #[cfg(debug_assertions)]
    let serialize_started = Instant::now();
    let contents = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    if contents.len() > MAX_JSON_BYTES {
        return Err(format!(
            "JSON payload exceeds {} MiB",
            MAX_JSON_BYTES / (1024 * 1024)
        ));
    }
    #[cfg(debug_assertions)]
    let serialize_ms = serialize_started.elapsed().as_millis();

    let _guard = write_lock().lock().map_err(|error| error.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("data");
    let temporary_path = path.with_file_name(format!(".{file_name}.{}.tmp", std::process::id()));
    let backup_path = path.with_file_name(format!(".{file_name}.bak"));
    #[cfg(debug_assertions)]
    let started = Instant::now();
    let mut temporary = fs::File::create(&temporary_path).map_err(|error| error.to_string())?;
    temporary
        .write_all(&contents)
        .map_err(|error| error.to_string())?;
    temporary.sync_all().map_err(|error| error.to_string())?;
    drop(temporary);

    if let Err(rename_error) = fs::rename(&temporary_path, path) {
        if !path.exists() {
            let _ = fs::remove_file(&temporary_path);
            return Err(rename_error.to_string());
        }
        if backup_path.exists() {
            fs::remove_file(&backup_path).map_err(|error| error.to_string())?;
        }
        fs::rename(path, &backup_path).map_err(|error| error.to_string())?;
        if let Err(replace_error) = fs::rename(&temporary_path, path) {
            let _ = fs::rename(&backup_path, path);
            let _ = fs::remove_file(&temporary_path);
            return Err(replace_error.to_string());
        }
        let _ = fs::remove_file(&backup_path);
    }

    #[cfg(debug_assertions)]
    eprintln!(
        "[perf] write {}: {} bytes, serialize {} ms, write {} ms",
        path.display(),
        contents.len(),
        serialize_ms,
        started.elapsed().as_millis()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{read_json, write_json};
    use serde_json::json;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn writes_and_reads_json_through_temporary_file() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("aiinterface-storage-test-{unique}"));
        let path = directory.join("nested").join("data.json");

        write_json(&path, &json!({ "value": 42 })).unwrap();
        assert_eq!(read_json(&path).unwrap(), r#"{"value":42}"#);

        fs::remove_dir_all(directory).unwrap();
    }
}
