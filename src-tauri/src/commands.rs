use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{Emitter, Manager, State};
use tdm_core::{ChunkRecord, DownloadJob};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
fn silent_explorer_command() -> Command {
    let mut cmd = Command::new("explorer");
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd
}

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
pub async fn delete_downloads(
    ids: Vec<String>,
    delete_files: bool,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let mut deleted = Vec::new();
    for id in ids {
        if state.manager.delete_download(&id, delete_files).is_ok() {
            deleted.push(id);
        }
    }
    Ok(deleted)
}

#[tauri::command]
pub async fn open_folder(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        #[cfg(target_os = "windows")]
        {
            silent_explorer_command()
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
                silent_explorer_command()
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
            silent_explorer_command()
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
        silent_explorer_command()
            .arg(&data_dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn check_extension_status(state: State<'_, AppState>) -> Result<bool, String> {
    let db = state.manager.database();
    if let Ok(Some(ts_str)) = db.get_setting("last_extension_ping") {
        if let Ok(ts) = chrono::DateTime::parse_from_rfc3339(&ts_str) {
            let now = chrono::Utc::now();
            let diff = (now - ts.with_timezone(&chrono::Utc)).num_seconds();
            if diff < 120 {
                return Ok(true);
            }
        }
    }
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

#[tauri::command]
pub async fn get_browser_integration_info(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let db = state.manager.database();
    let port = tdm_native_host::server::get_configured_port(db);
    let active_port = db
        .get_setting("active_server_port")
        .ok()
        .flatten()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(port);
    let token = tdm_native_host::server::get_or_create_token(db);

    let is_extension_active = if let Ok(Some(ts_str)) = db.get_setting("last_extension_ping") {
        if let Ok(ts) = chrono::DateTime::parse_from_rfc3339(&ts_str) {
            let now = chrono::Utc::now();
            let diff = (now - ts.with_timezone(&chrono::Utc)).num_seconds();
            diff < 120
        } else {
            false
        }
    } else {
        false
    };

    Ok(serde_json::json!({
        "port": port,
        "active_port": active_port,
        "token": token,
        "status": "running",
        "extension_active": is_extension_active
    }))
}

#[tauri::command]
pub async fn regenerate_pairing_token(state: State<'_, AppState>) -> Result<String, String> {
    let db = state.manager.database();
    let u1 = uuid::Uuid::new_v4();
    let u2 = uuid::Uuid::new_v4();
    let token = format!(
        "tori_{}{}",
        hex::encode(&u1.as_bytes()[..8]),
        hex::encode(&u2.as_bytes()[..8])
    );
    db.set_setting("browser_integration_token", &token)
        .map_err(|e| e.to_string())?;

    if let Ok(Some(saved)) = db.get_setting("app_settings") {
        if let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&saved) {
            if let Some(obj) = val.as_object_mut() {
                obj.insert("key".to_string(), serde_json::Value::String(token.clone()));
                if let Ok(serialized) = serde_json::to_string(&val) {
                    let _ = db.set_setting("app_settings", &serialized);
                }
            }
        }
    }

    Ok(token)
}

#[tauri::command]
pub async fn get_download(
    id: String,
    state: State<'_, AppState>,
) -> Result<Option<DownloadJob>, String> {
    state.manager.get_download(&id).map_err(|e| e.to_string())
}

pub async fn open_progress_window_internal(
    app: &tauri::AppHandle,
    manager: &tdm_core::DownloadManager,
    id: &str,
    force: bool,
) -> Result<(), String> {
    if !force {
        let db = manager.database();
        if let Ok(Some(saved)) = db.get_setting("app_settings") {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&saved) {
                if let Some(mode) = val.get("showDownloadPopup").and_then(|v| v.as_str()) {
                    if mode == "never" {
                        return Ok(());
                    }
                }
            }
        }
    }

    let job = manager
        .get_download(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Job {} not found", id))?;

    let label = "progress_toast";
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = app.emit("toast-add-download", id);
        return Ok(());
    }

    let url = format!("index.html?window=toast&id={}", id);
    let title = format!("TORI Download - {}", job.filename);

    let mut builder =
        tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App(url.into()))
            .title(title)
            .inner_size(494.0, 100.0)
            .always_on_top(true)
            .decorations(false)
            .transparent(true)
            .skip_taskbar(true)
            .focused(false)
            .resizable(false)
            .shadow(false);

    let (saved_x, saved_y) =
        if let Ok(Some(saved)) = manager.database().get_setting("toast_window_position") {
            if let Ok(pos) = serde_json::from_str::<ToastPosition>(&saved) {
                if pos.is_manual
                    && !(pos.x >= 239.0 && pos.x <= 241.0 && pos.y >= 179.0 && pos.y <= 181.0)
                {
                    (Some(pos.x), Some(pos.y))
                } else {
                    let _ = manager.database().set_setting("toast_window_position", "");
                    (None, None)
                }
            } else {
                (None, None)
            }
        } else {
            (None, None)
        };

    let (x, y) = get_clamped_toast_position(app, saved_x, saved_y, 494.0, 100.0);
    builder = builder.position(x, y);

    let _win = builder
        .build()
        .map_err(|e| format!("Failed to create progress window: {}", e))?;

    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
struct ToastPosition {
    x: f64,
    y: f64,
    #[serde(default)]
    is_manual: bool,
}

#[cfg(target_os = "windows")]
#[allow(clippy::upper_case_acronyms)]
mod win_workarea {
    #[repr(C)]
    #[derive(Copy, Clone, Debug)]
    pub struct RECT {
        pub left: i32,
        pub top: i32,
        pub right: i32,
        pub bottom: i32,
    }

    #[repr(C)]
    pub struct POINT {
        pub x: i32,
        pub y: i32,
    }

    #[repr(C)]
    pub struct MONITORINFO {
        pub cb_size: u32,
        pub rc_monitor: RECT,
        pub rc_work: RECT,
        pub dw_flags: u32,
    }

    extern "system" {
        pub fn MonitorFromPoint(pt: POINT, dw_flags: u32) -> isize;
        pub fn GetMonitorInfoW(h_monitor: isize, lpmi: *mut MONITORINFO) -> i32;
        pub fn SystemParametersInfoW(
            ui_action: u32,
            ui_param: u32,
            pv_param: *mut std::ffi::c_void,
            f_win_ini: u32,
        ) -> i32;
    }

    pub fn get_primary_work_area() -> Option<(f64, f64, f64, f64)> {
        unsafe {
            let mut rect = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            if SystemParametersInfoW(
                0x0030, // SPI_GETWORKAREA
                0,
                &mut rect as *mut _ as *mut std::ffi::c_void,
                0,
            ) != 0
            {
                Some((
                    rect.left as f64,
                    rect.top as f64,
                    rect.right as f64,
                    rect.bottom as f64,
                ))
            } else {
                None
            }
        }
    }

    pub fn get_work_area_at(x: i32, y: i32) -> Option<(f64, f64, f64, f64)> {
        unsafe {
            let pt = POINT { x, y };
            let h_mon = MonitorFromPoint(pt, 1 /* MONITOR_DEFAULTTOPRIMARY */);
            if h_mon != 0 {
                let mut mi = MONITORINFO {
                    cb_size: std::mem::size_of::<MONITORINFO>() as u32,
                    rc_monitor: RECT {
                        left: 0,
                        top: 0,
                        right: 0,
                        bottom: 0,
                    },
                    rc_work: RECT {
                        left: 0,
                        top: 0,
                        right: 0,
                        bottom: 0,
                    },
                    dw_flags: 0,
                };
                if GetMonitorInfoW(h_mon, &mut mi) != 0 {
                    return Some((
                        mi.rc_work.left as f64,
                        mi.rc_work.top as f64,
                        mi.rc_work.right as f64,
                        mi.rc_work.bottom as f64,
                    ));
                }
            }
            get_primary_work_area()
        }
    }
}

fn get_clamped_toast_position(
    app: &tauri::AppHandle,
    preferred_x: Option<f64>,
    preferred_y: Option<f64>,
    width: f64,
    height: f64,
) -> (f64, f64) {
    let monitors = app.available_monitors().unwrap_or_default();

    if let (Some(px), Some(py)) = (preferred_x, preferred_y) {
        let primary = app.primary_monitor().ok().flatten();
        let best_monitor = monitors
            .iter()
            .find(|m| {
                let scale = m.scale_factor();
                let pos = m.position();
                let size = m.size();
                let left = pos.x as f64 / scale;
                let top = pos.y as f64 / scale;
                let right = left + (size.width as f64 / scale);
                let bottom = top + (size.height as f64 / scale);
                px >= left && px <= right && py >= top && py <= bottom
            })
            .or(primary.as_ref())
            .or_else(|| monitors.first());

        let scale = best_monitor.map(|m| m.scale_factor()).unwrap_or(1.0);

        #[cfg(target_os = "windows")]
        let work_area = win_workarea::get_work_area_at((px * scale) as i32, (py * scale) as i32);
        #[cfg(not(target_os = "windows"))]
        let work_area: Option<(f64, f64, f64, f64)> = None;

        if let Some((wl, wt, wr, wb)) = work_area {
            let work_left = wl / scale;
            let work_top = wt / scale;
            let work_right = wr / scale;
            let work_bottom = wb / scale;

            let min_x = work_left + 10.0;
            let max_x = (work_right - width - 10.0).max(min_x);
            let min_y = work_top + 10.0;
            let max_y = (work_bottom - height - 10.0).max(min_y);

            (px.clamp(min_x, max_x), py.clamp(min_y, max_y))
        } else if let Some(mon) = best_monitor {
            let scale = mon.scale_factor();
            let pos = mon.position();
            let size = mon.size();
            let left = pos.x as f64 / scale;
            let top = pos.y as f64 / scale;
            let mon_w = size.width as f64 / scale;
            let mon_h = size.height as f64 / scale;

            let min_x = left + 10.0;
            let max_x = (left + mon_w - width - 10.0).max(min_x);
            let min_y = top + 10.0;
            let max_y = (top + mon_h - height - 10.0).max(min_y);

            (px.clamp(min_x, max_x), py.clamp(min_y, max_y))
        } else {
            (px, py)
        }
    } else {
        let primary = app
            .primary_monitor()
            .ok()
            .flatten()
            .or_else(|| monitors.into_iter().next());
        let scale = primary.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);

        #[cfg(target_os = "windows")]
        let work_area = win_workarea::get_primary_work_area();
        #[cfg(not(target_os = "windows"))]
        let work_area: Option<(f64, f64, f64, f64)> = None;

        if let Some((_wl, _wt, wr, wb)) = work_area {
            let work_right = wr / scale;
            let work_bottom = wb / scale;
            let x = work_right - width - 20.0;
            let y = work_bottom - height - 20.0;
            (x, y)
        } else if let Some(mon) = primary {
            let pos = mon.position();
            let size = mon.size();
            let mon_w = size.width as f64 / scale;
            let mon_h = size.height as f64 / scale;
            let x = pos.x as f64 / scale + mon_w - width - 20.0;
            let y = pos.y as f64 / scale + mon_h - height - 20.0;
            (x, y)
        } else {
            (100.0, 100.0)
        }
    }
}

#[tauri::command]
pub async fn save_toast_position(x: f64, y: f64, state: State<'_, AppState>) -> Result<(), String> {
    let pos = ToastPosition {
        x,
        y,
        is_manual: true,
    };
    let json = serde_json::to_string(&pos).map_err(|e| e.to_string())?;
    state
        .manager
        .database()
        .set_setting("toast_window_position", &json)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn open_progress_window(
    id: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    open_progress_window_internal(&app, &state.manager, &id, true).await
}

#[tauri::command]
pub async fn update_toast_bounds(
    width: f64,
    height: f64,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("progress_toast") {
        let _ = win.set_size(tauri::LogicalSize::new(width, height));

        let (saved_x, saved_y) = if let Ok(Some(saved)) = state
            .manager
            .database()
            .get_setting("toast_window_position")
        {
            if let Ok(pos) = serde_json::from_str::<ToastPosition>(&saved) {
                if pos.is_manual
                    && !(pos.x >= 239.0 && pos.x <= 241.0 && pos.y >= 179.0 && pos.y <= 181.0)
                {
                    (Some(pos.x), Some(pos.y))
                } else {
                    let _ = state
                        .manager
                        .database()
                        .set_setting("toast_window_position", "");
                    (None, None)
                }
            } else {
                (None, None)
            }
        } else {
            (None, None)
        };

        let (x, y) = get_clamped_toast_position(&app, saved_x, saved_y, width, height);
        let _ = win.set_position(tauri::LogicalPosition::new(x, y));
    }
    Ok(())
}

#[tauri::command]
pub async fn hide_toast_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("progress_toast") {
        let _ = win.hide();
    }
    Ok(())
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

#[derive(Debug, Clone, serde::Deserialize)]
pub struct EnqueuePlaylistItemReq {
    pub url: String,
    pub title: String,
    pub thumbnail_url: Option<String>,
}

#[tauri::command]
pub async fn resolve_playlist(
    url: String,
    limit: Option<usize>,
) -> Result<tdm_core::PlaylistMetadata, String> {
    let resolver = tdm_core::MediaResolver::new();
    resolver
        .resolve_playlist(&url, limit)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn enqueue_playlist_items(
    items: Vec<EnqueuePlaylistItemReq>,
    destination: Option<String>,
    format_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let dest_path = if let Some(ref d) = destination {
        let clean = d.trim();
        if !clean.is_empty() {
            PathBuf::from(clean)
        } else {
            get_default_download_path()
        }
    } else {
        get_default_download_path()
    };

    let format = format_id.as_deref().unwrap_or("best");
    let mut created_ids = Vec::new();

    for item in items {
        if item.url.trim().is_empty() {
            continue;
        }
        let clean_filename = format!("{}.mp4", tdm_core::sanitize_filename(&item.title));
        match state
            .manager
            .create_managed_media_download(
                &item.url,
                format,
                &clean_filename,
                &dest_path,
                tdm_core::Priority::Normal,
                item.thumbnail_url,
            )
            .await
        {
            Ok(job) => {
                let id = job.id.clone();
                let _ = state.manager.start_download(&id);
                created_ids.push(id);
            }
            Err(e) => {
                eprintln!(
                    "[TORI] Failed to enqueue playlist item '{}': {}",
                    item.title, e
                );
            }
        }
    }

    Ok(created_ids)
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct CreateMediaDownloadArgs {
    pub url: String,
    pub format_id: Option<String>,
    pub filename: Option<String>,
    pub destination: Option<String>,
    pub priority: Option<String>,
    pub thumbnail_url: Option<String>,
    pub start_immediately: Option<bool>,
}

#[tauri::command]
pub async fn resolve_media(url: String) -> Result<tdm_core::MediaMetadata, String> {
    let raw_url = url.trim();
    if raw_url.is_empty() {
        return Err("Missing media URL to resolve".to_string());
    }
    let resolver = tdm_core::MediaResolver::new();
    resolver.resolve(raw_url).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_media_download(
    args: CreateMediaDownloadArgs,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<DownloadJob, String> {
    let raw_url = args.url.trim();
    if raw_url.is_empty() {
        return Err("Missing media URL".to_string());
    }

    let format_id = args.format_id.unwrap_or_else(|| "best".to_string());

    let dest_path = if let Some(ref d) = args.destination {
        let clean = d.trim();
        if clean.contains("..") {
            return Err("Invalid destination path: directory traversal rejected.".to_string());
        }
        if !clean.is_empty() {
            PathBuf::from(clean)
        } else {
            get_default_download_path()
        }
    } else if let Some(def) = state.manager.default_download_dir() {
        PathBuf::from(def)
    } else {
        get_default_download_path()
    };

    let prio = match args.priority.as_deref() {
        Some("high") => tdm_core::Priority::High,
        Some("low") => tdm_core::Priority::Low,
        _ => tdm_core::Priority::Normal,
    };

    let initial_filename = args
        .filename
        .map(|f| tdm_core::sanitize_filename(&f))
        .filter(|f| !f.is_empty())
        .unwrap_or_else(|| "media_download.mp4".to_string());

    let filename_with_ext = if !initial_filename.contains('.') {
        format!("{}.mp4", initial_filename)
    } else {
        initial_filename
    };

    let job = state
        .manager
        .create_managed_media_download(
            raw_url,
            &format_id,
            &filename_with_ext,
            &dest_path,
            prio,
            args.thumbnail_url,
        )
        .await
        .map_err(|e| e.to_string())?;

    let start_now = args.start_immediately.unwrap_or(true);
    if start_now {
        state
            .manager
            .start_download(&job.id)
            .map_err(|e| e.to_string())?;

        let _ = open_progress_window_internal(&app, &state.manager, &job.id, false).await;
    }

    Ok(job)
}
