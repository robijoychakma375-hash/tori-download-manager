use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::State;
use tdm_core::{ChunkRecord, DownloadJob};

use crate::state::AppState;

#[tauri::command]
pub async fn create_download(
    url: String,
    destination: Option<String>,
    priority: Option<String>,
    state: State<'_, AppState>,
) -> Result<DownloadJob, String> {
    let dest_dir = if let Some(d) = destination {
        PathBuf::from(d)
    } else if let Some(def) = state.manager.default_download_dir() {
        PathBuf::from(def)
    } else {
        get_default_download_path()
    };

    let prio = match priority.as_deref() {
        Some(p) => p.parse::<tdm_core::Priority>().unwrap_or_default(),
        None => tdm_core::Priority::Normal,
    };

    let job = state
        .manager
        .create_download_with_priority(&url, &dest_dir, prio)
        .await
        .map_err(|e| e.to_string())?;

    // Auto-start download upon creation
    state
        .manager
        .start_download(&job.id)
        .map_err(|e| e.to_string())?;

    Ok(job)
}

#[tauri::command]
pub async fn set_download_priority(
    id: String,
    priority: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let prio = priority
        .parse::<tdm_core::Priority>()
        .map_err(|_| "Invalid priority value".to_string())?;
    state
        .manager
        .set_priority(&id, prio)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_download(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.manager.start_download(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stop_recording(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.manager.stop_recording(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pause_download(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.manager.pause_download(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn resume_download(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.manager.start_download(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cancel_download(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state
        .manager
        .cancel_download(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn retry_download(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.manager.retry_download(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_downloads(state: State<'_, AppState>) -> Result<Vec<DownloadJob>, String> {
    state.manager.list_downloads().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_download(
    id: String,
    delete_files: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .manager
        .delete_download(&id, delete_files)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_folder(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        #[cfg(target_os = "windows")]
        {
            Command::new("explorer")
                .args(["/select,", &path])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        #[cfg(not(target_os = "windows"))]
        {
            let parent = p.parent().unwrap_or(p);
            Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    } else if let Some(parent) = p.parent() {
        if parent.exists() {
            #[cfg(target_os = "windows")]
            {
                Command::new("explorer")
                    .arg(parent)
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn get_default_download_dir() -> Result<String, String> {
    Ok(get_default_download_path().to_string_lossy().to_string())
}

#[tauri::command]
pub async fn get_download_chunks(
    id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ChunkRecord>, String> {
    state.manager.get_chunks(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        #[cfg(target_os = "windows")]
        {
            Command::new("explorer")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        #[cfg(not(target_os = "windows"))]
        {
            Command::new("xdg-open")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    } else {
        Err("File does not exist on disk".to_string())
    }
}

#[tauri::command]
pub async fn verify_checksum(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("File does not exist on disk".to_string());
    }
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(p).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| e.to_string())?;
    let hash = hasher.finalize();
    Ok(hex::encode(hash))
}

#[tauri::command]
pub async fn open_data_folder() -> Result<(), String> {
    let data_dir = if let Ok(app_data) = std::env::var("APPDATA") {
        PathBuf::from(app_data).join("tori-download-manager")
    } else {
        PathBuf::from(".tdm-data")
    };
    if !data_dir.exists() {
        let _ = std::fs::create_dir_all(&data_dir);
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&data_dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn check_extension_status() -> Result<bool, String> {
    let manifest_path = tdm_native_host::registry::get_manifest_path();
    Ok(manifest_path.exists())
}

#[tauri::command]
pub async fn register_native_host() -> Result<(), String> {
    tdm_native_host::register_host(None).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn window_minimize(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn window_maximize(window: tauri::Window) -> Result<(), String> {
    if window.is_maximized().map_err(|e| e.to_string())? {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn window_close(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

pub fn apply_settings_to_manager(
    manager: &tdm_core::DownloadManager,
    settings: &serde_json::Value,
) {
    if let Some(con) = settings.get("con").and_then(|v| v.as_u64()) {
        manager.set_max_connections_per_download(con as usize);
    }
    if let Some(maxa) = settings.get("maxa").and_then(|v| v.as_u64()) {
        manager.set_max_active_jobs(maxa as usize);
    }
    if let Some(retries) = settings.get("retries").and_then(|v| v.as_u64()) {
        manager.set_max_retries(retries as usize);
    }
    if let Some(dyn_seg) = settings.get("dyn").and_then(|v| v.as_bool()) {
        manager.set_dynamic_segmentation(dyn_seg);
    }
    if let Some(dir) = settings.get("dir").and_then(|v| v.as_str()) {
        if !dir.trim().is_empty() {
            manager.set_default_download_dir(Some(dir.to_string()));
        }
    }

    // Bandwidth limiter
    let lim_mode = settings
        .get("limMode")
        .and_then(|v| v.as_str())
        .unwrap_or("off");
    if lim_mode == "on" {
        let lim_v = settings.get("limV").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let lim_u = settings
            .get("limU")
            .and_then(|v| v.as_str())
            .unwrap_or("MiB/s");
        let mult: f64 = if lim_u == "KiB/s" {
            1024.0
        } else {
            1024.0 * 1024.0
        };
        let bps = (lim_v * mult).max(1024.0) as u64;
        manager.set_speed_limit(bps);
    } else {
        manager.set_speed_limit(0);
    }

    // Minimum part size
    if let Some(mps) = settings.get("mps").and_then(|v| v.as_f64()) {
        let mps_u = settings
            .get("mpsU")
            .and_then(|v| v.as_str())
            .unwrap_or("MiB");
        let mult: f64 = if mps_u == "KiB" {
            1024.0
        } else {
            1024.0 * 1024.0
        };
        let split_size = (mps * mult).max(65536.0) as u64;
        manager.set_min_split_size(split_size);
    }
}

#[tauri::command]
pub async fn update_engine_settings(
    settings: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    apply_settings_to_manager(&state.manager, &settings);
    let serialized = serde_json::to_string(&settings).map_err(|e| e.to_string())?;
    state
        .manager
        .database()
        .set_setting("app_settings", &serialized)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_engine_settings(
    state: State<'_, AppState>,
) -> Result<Option<serde_json::Value>, String> {
    match state
        .manager
        .database()
        .get_setting("app_settings")
        .map_err(|e| e.to_string())?
    {
        Some(s) => {
            let val: serde_json::Value = serde_json::from_str(&s).map_err(|e| e.to_string())?;
            Ok(Some(val))
        }
        None => Ok(None),
    }
}

fn get_default_download_path() -> PathBuf {
    if let Ok(profile) = std::env::var("USERPROFILE") {
        let downloads = PathBuf::from(profile).join("Downloads");
        if downloads.exists() {
            return downloads;
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}
