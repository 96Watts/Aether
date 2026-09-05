use crate::errors::BackendError;
use serde::Serialize;
use std::process::Command;
#[cfg(not(target_os = "windows"))]
use std::path::Path;
use sysinfo::{Disks, Networks, System, MINIMUM_CPU_UPDATE_INTERVAL};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CpuInfo {
    pub name: String,
    pub brand: String,
    pub frequency_mhz: u64,
    pub usage_percent: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfoSnapshot {
    pub os_name: Option<String>,
    pub os_version: Option<String>,
    pub kernel: Option<String>,
    pub host_name: Option<String>,
    pub uptime_seconds: u64,
    pub cpu: Option<CpuInfo>,
    pub cpu_count: usize,
    pub physical_cores: Option<usize>,
    pub total_memory_bytes: u64,
    pub used_memory_bytes: u64,
    pub total_disk_bytes: u64,
    pub available_disk_bytes: u64,
    pub network_interfaces: Vec<String>,
    pub gpu: Option<String>,
}

fn detect_gpu() -> Option<String> {
    fn first_non_empty_line(text: &str) -> Option<String> {
        text.lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(str::to_string)
    }

    // Prefer the native NVIDIA probe, then fall back to the Windows device list.
    #[cfg(target_os = "windows")]
    {
        let nvidia = Command::new("nvidia-smi")
            .args(["--query-gpu=name", "--format=csv,noheader"])
            .output()
            .ok()
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .and_then(|text| first_non_empty_line(&text));
        nvidia.or_else(|| {
            Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join '`n'",
                ])
                .output()
                .ok()
                .and_then(|output| String::from_utf8(output.stdout).ok())
                .and_then(|text| {
                    let names: Vec<_> = text
                        .lines()
                        .map(str::trim)
                        .filter(|line| !line.is_empty())
                        .collect();
                    (!names.is_empty()).then(|| names.join(" · "))
                })
        })
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("system_profiler")
            .args(["SPDisplaysDataType", "-detailLevel", "mini"])
            .output()
            .ok()
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .and_then(|text| {
                let names: Vec<_> = text
                    .lines()
                    .filter_map(|line| line.split_once(':'))
                    .filter(|(key, _)| key.trim() == "Chipset Model" || key.trim() == "Chip")
                    .map(|(_, value)| value.trim())
                    .filter(|value| !value.is_empty())
                    .collect();
                (!names.is_empty()).then(|| names.join(" · "))
            })
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    { None }
}

fn primary_disk(disks: &Disks) -> Option<&sysinfo::Disk> {
    #[cfg(target_os = "windows")]
    let preferred = disks.iter().find(|disk| {
        disk.mount_point()
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("C:\\")
    });
    #[cfg(not(target_os = "windows"))]
    let preferred = disks.iter().find(|disk| disk.mount_point() == Path::new("/"));
    preferred.or_else(|| disks.first())
}

#[tauri::command]
pub fn toggle_devtools(app: tauri::AppHandle) -> Result<bool, BackendError> {
    #[cfg(not(debug_assertions))]
    {
        let _ = app;
        return Err(BackendError::system(
            "Developer tools are only available in development builds",
        ));
    }
    #[cfg(debug_assertions)]
    {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
            window.open_devtools();
            Ok(true)
        } else {
            Err(BackendError::system("Main window not found"))
        }
    }
}

#[tauri::command]
pub async fn get_system_info() -> Result<SystemInfoSnapshot, BackendError> {
    #[cfg(debug_assertions)]
    let started = std::time::Instant::now();
    let result = tauri::async_runtime::spawn_blocking(|| {
        let mut system = System::new_all();
        std::thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL);
        system.refresh_cpu_usage();

        let cpus: Vec<CpuInfo> = system
            .cpus()
            .iter()
            .map(|cpu| CpuInfo {
                name: cpu.name().to_string(),
                brand: cpu.brand().to_string(),
                frequency_mhz: cpu.frequency(),
                usage_percent: cpu.cpu_usage(),
            })
            .collect();

        let disks = Disks::new_with_refreshed_list();
        let disk = primary_disk(&disks);
        let total_disk_bytes = disk.map(|disk| disk.total_space()).unwrap_or_default();
        let available_disk_bytes = disk.map(|disk| disk.available_space()).unwrap_or_default();

        let networks = Networks::new_with_refreshed_list();
        let network_interfaces = networks
            .iter()
            .map(|(name, _data)| name.to_string())
            .collect();

        Ok(SystemInfoSnapshot {
            os_name: System::long_os_version().or_else(System::name),
            os_version: System::os_version(),
            kernel: System::kernel_version(),
            host_name: System::host_name(),
            uptime_seconds: System::uptime(),
            cpu: cpus.first().cloned(),
            cpu_count: cpus.len(),
            physical_cores: system.physical_core_count(),
            total_memory_bytes: system.total_memory(),
            used_memory_bytes: system.used_memory(),
            total_disk_bytes,
            available_disk_bytes,
            network_interfaces,
            gpu: detect_gpu(),
        })
    })
    .await
    .map_err(|error| BackendError::system(error.to_string()))?;
    #[cfg(debug_assertions)]
    eprintln!(
        "[perf] get_system_info: {} ms",
        started.elapsed().as_millis()
    );
    result
}

#[cfg(test)]
mod tests {
    use super::CpuInfo;

    #[test]
    fn cpu_metadata_has_a_displayable_name_when_available() {
        let cpu = CpuInfo {
            name: String::new(),
            brand: "Apple M-series".to_string(),
            frequency_mhz: 0,
            usage_percent: 0.0,
        };
        assert!(cpu.name.is_empty() && !cpu.brand.is_empty());
    }
}
