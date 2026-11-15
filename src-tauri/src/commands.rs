use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager, State};
use tdm_core::{
    ChunkRecord, DownloadCompletionOptions, DownloadJob, DownloadStatusDetails,
};

static AUTO_OPENED_PROGRESS_IDS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn mark_auto_opened_once(id: &str) -> bool {
    let lock = AUTO_OPENED_PROGRESS_IDS.get_or_init(|| Mutex::new(HashSet::new()));
    let mut set = lock.lock().unwrap();
    if set.contains(id) {
        return false;
    }
    if set.len() > 2048 {
        set.clear();
    }
    set.insert(id.to_string());
    true
}

pub fn progress_window_label(id: &str) -> String {
    let mut clean = String::with_capacity(id.len());
    for ch in id.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            clean.push(ch);
        } else {
            clean.push('_');
        }
    }
    format!("progress_{}", clean)
}

fn always_on_top_enabled(manager: &tdm_core::DownloadManager) -> bool {
    if let Ok(Some(saved)) = manager.database().get_setting("app_settings") {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&saved) {
            if let Some(aot) = val.get("alwaysOnTop").and_then(|v| v.as_bool()) {
                return aot;
            }
        }
    }
    true
}

fn url_encode_query_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(*b, b'-' | b'_' | b'.' | b'~') {
            out.push(*b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}

pub fn send_desktop_notification(title: &str, body: &str) {
    crate::lifecycle::log_event(
        "NOTIFY",
        "DOWNLOAD_COMPLETE",
        &format!("title={}, body={}", title, body),
    );

    #[cfg(windows)]
    {
        let safe_title = xml_escape(title).replace('\'', "''");
        let safe_body = xml_escape(body).replace('\'', "''");
        let ps_script = format!(
            "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; \
             [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null; \
             $xml = New-Object Windows.Data.Xml.Dom.XmlDocument; \
             $xml.LoadXml('<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>'); \
             $toast = New-Object Windows.UI.Notifications.ToastNotification $xml; \
             [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('TORI Download Manager').Show($toast)",
            safe_title, safe_body
        );
        std::thread::spawn(move || {
            let _ = silent_command("powershell.exe")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-WindowStyle",
                    "Hidden",
                    "-Command",
                    &ps_script,
                ])
                .output();
        });
    }
}

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
fn silent_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd
}

#[cfg(windows)]
fn silent_explorer_command() -> Command {
    silent_command("explorer")
}

use crate::state::AppState;

fn is_media_portal_url(url: &str) -> bool {
    let u = url.trim().to_lowercase();
    u.contains("youtube.com/watch")
        || u.contains("youtu.be/")
        || u.contains("youtube.com/shorts/")
        || u.contains("facebook.com/reel/")
        || u.contains("facebook.com/watch")
        || (u.contains("facebook.com/") && (u.contains("/videos/") || u.contains("/reel/")))
        || u.contains("fb.watch/")
        || u.contains("instagram.com/reel/")
        || u.contains("instagram.com/p/")
        || u.contains("vimeo.com/")
        || u.contains("tiktok.com/")
        || u.contains("twitter.com/")
        || u.contains("x.com/")
        || u.contains("reddit.com/r/")
}

#[tauri::command]
pub async fn create_download(
    url: String,
    destination: Option<String>,
    priority: Option<String>,
    referer: Option<String>,
    user_agent: Option<String>,
    scheduled_at: Option<String>,
    state: State<'_, AppState>,
) -> Result<DownloadJob, String> {
    if let Some(ref d) = destination {
        tdm_core::DownloadManager::validate_destination_path(d).map_err(|e| e.to_string())?;
    }

    let prio = match priority.as_deref() {
        Some(p) => p.parse::<tdm_core::Priority>().unwrap_or_default(),
        None => tdm_core::Priority::Normal,
    };

    let clean_referer = referer
        .as_deref()
        .and_then(|r| tdm_core::sanitize_and_validate_referer(r, &url));

    let clean_user_agent = user_agent
        .as_deref()
        .and_then(tdm_core::sanitize_and_validate_user_agent);

    let parsed_sched = scheduled_at
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&chrono::Utc));

    let job = if is_media_portal_url(&url) {
        let dest_dir = state
            .manager
            .resolve_destination_folder("media_download.mp4", destination.as_deref());
        state
            .manager
            .create_managed_media_download_with_all_options_scheduled(
                &url,
                "best",
                "media_download.mp4",
                &dest_dir,
                prio,
                None,
                clean_referer,
                clean_user_agent,
                parsed_sched,
            )
            .await
            .map_err(|e| e.to_string())?
    } else {
        state
            .manager
            .create_download_to_destination(
                &url,
                destination.as_deref(),
                prio,
                clean_referer,
                clean_user_agent,
                parsed_sched,
            )
            .await
            .map_err(|e| e.to_string())?
    };

    // Auto-start download upon creation if not scheduled
    if job.state != tdm_core::JobState::Scheduled {
        state
            .manager
            .start_download(&job.id)
            .map_err(|e| e.to_string())?;
    }

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
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .manager
        .delete_download(&id, delete_files)
        .map_err(|e| e.to_string())?;

    let label = progress_window_label(&id);
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.close();
    }
    let _ = app.emit("download-deleted", &id);
    Ok(())
}

#[tauri::command]
pub async fn delete_downloads(
    ids: Vec<String>,
    delete_files: bool,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let mut deleted = Vec::new();
    for id in ids {
        if state.manager.delete_download(&id, delete_files).is_ok() {
            let label = progress_window_label(&id);
            if let Some(win) = app.get_webview_window(&label) {
                let _ = win.close();
            }
            let _ = app.emit("download-deleted", &id);
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
pub async fn get_default_download_dir(state: State<'_, AppState>) -> Result<String, String> {
    if let Some(dir) = state.manager.default_download_dir() {
        if !dir.trim().is_empty() {
            return Ok(dir);
        }
    }
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
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub fn get_active_downloads_count(state: State<'_, AppState>) -> usize {
    state.manager.active_downloads_count()
}

#[tauri::command]
pub async fn open_external_url(url: String) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Only http and https URLs are supported".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        silent_command("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[tauri::command]
pub fn get_third_party_licenses() -> Result<String, String> {
    let candidates = [
        PathBuf::from("resources").join("LICENSE-THIRD-PARTY.txt"),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("LICENSE-THIRD-PARTY.txt")))
            .unwrap_or_default(),
        std::env::current_exe()
            .ok()
            .and_then(|p| {
                p.parent()
                    .map(|d| d.join("resources").join("LICENSE-THIRD-PARTY.txt"))
            })
            .unwrap_or_default(),
    ];
    for c in candidates {
        if c.exists() {
            if let Ok(content) = std::fs::read_to_string(&c) {
                return Ok(content);
            }
        }
    }
    Ok(include_str!("../../resources/LICENSE-THIRD-PARTY.txt").to_string())
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
pub async fn frontend_ready(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    crate::lifecycle::log_event("FRONTEND", "READY", "Frontend reported visual readiness");
    state.manager.set_frontend_playlist_ready(true);
    let has_pending_playlist = !state.manager.pending_playlist_requests_snapshot().is_empty();
    if has_pending_playlist
        || !state
            .is_minimized_launch
            .load(std::sync::atomic::Ordering::SeqCst)
    {
        if has_pending_playlist {
            state
                .is_minimized_launch
                .store(false, std::sync::atomic::Ordering::SeqCst);
        }
        crate::tray::show_main_window(&app);
    }
    Ok(())
}

#[tauri::command]
pub async fn take_pending_playlist_requests(
    state: State<'_, AppState>,
) -> Result<Vec<tdm_core::PendingPlaylistRequest>, String> {
    state.manager.set_frontend_playlist_ready(true);
    Ok(state.manager.take_pending_playlist_requests())
}

#[tauri::command]
pub async fn acknowledge_playlist_modal(
    request_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    Ok(state.manager.acknowledge_playlist_modal(&request_id))
}

#[tauri::command]
pub async fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    crate::tray::show_main_window(&app);
    Ok(())
}

#[tauri::command]
pub async fn hide_main_window(app: tauri::AppHandle) -> Result<(), String> {
    crate::tray::hide_main_window(&app);
    Ok(())
}

#[tauri::command]
pub async fn window_minimize(window: tauri::Window) -> Result<(), String> {
    let res = window.minimize().map_err(|e| e.to_string());
    crate::lifecycle::trim_memory();
    res
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
pub async fn window_close(
    window: tauri::Window,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let close_to_tray = crate::tray::is_close_to_tray_enabled(&state.manager);
    crate::lifecycle::log_event(
        "WINDOW",
        "WINDOW_CLOSE_COMMAND",
        &format!("label={}, close_to_tray={}", window.label(), close_to_tray),
    );
    if window.label() == "main" {
        if close_to_tray {
            let app = window.app_handle().clone();
            crate::tray::hide_main_window(&app);
            Ok(())
        } else {
            let app = window.app_handle().clone();
            crate::tray::perform_clean_exit(&app, &state.manager);
            Ok(())
        }
    } else {
        window.close().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn exit_app(
    app: tauri::AppHandle,
    force: Option<bool>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let is_force = force.unwrap_or(false);
    let active = crate::tray::count_active_downloads(&state.manager);
    crate::lifecycle::log_event(
        "APP",
        "EXIT_APP_COMMAND",
        &format!("force={}, active_downloads={}", is_force, active),
    );
    if !is_force && active > 0 {
        return Err("active_downloads".to_string());
    }
    app.exit(0);
    Ok(())
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
    if let Some(sort) = settings.get("sort").and_then(|v| v.as_bool()) {
        manager.set_use_category_by_default(sort);
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
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    apply_settings_to_manager(&state.manager, &settings);
    let serialized = serde_json::to_string(&settings).map_err(|e| e.to_string())?;
    state
        .manager
        .database()
        .set_setting("app_settings", &serialized)
        .map_err(|e| e.to_string())?;
    let aot = settings
        .get("alwaysOnTop")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    for (label, win) in app.webview_windows() {
        if label.starts_with("progress_") {
            let _ = win.set_always_on_top(aot);
        }
    }
    let _ = app.emit("settings-updated", &settings);
    if let Some(close_to_tray) = settings.get("closeToTray").and_then(|v| v.as_bool()) {
        crate::lifecycle::log_event(
            "SETTINGS",
            "CLOSE_TO_TRAY_UPDATED",
            &format!("enabled={}", close_to_tray),
        );
    }
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
    let mut initial_theme: Option<String> = None;
    let mut initial_accent: Option<String> = None;
    let mut popup_mode = "always".to_string();

    if let Ok(Some(saved)) = manager.database().get_setting("app_settings") {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&saved) {
            if let Some(mode) = val.get("showDownloadPopup").and_then(|v| v.as_str()) {
                popup_mode = mode.to_string();
            }
            if let Some(t) = val.get("theme").and_then(|v| v.as_str()) {
                if matches!(t, "light" | "dark" | "system") {
                    initial_theme = Some(t.to_string());
                }
            }
            if let Some(a) = val.get("accent").and_then(|v| v.as_str()) {
                if matches!(a, "indigo" | "ocean" | "emerald" | "rose") {
                    initial_accent = Some(a.to_string());
                }
            }
        }
    }

    if !force {
        if popup_mode == "never" {
            return Ok(());
        }
        if popup_mode == "on_start" && !mark_auto_opened_once(id) {
            return Ok(());
        }
    }

    let job = manager
        .get_download(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Job {} not found", id))?;

    let always_on_top = always_on_top_enabled(manager);
    let label = progress_window_label(id);
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.set_always_on_top(always_on_top);
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        if force {
            let _ = app.emit_to(&label, "progress-restore-full", id);
        }
        return Ok(());
    }

    let open_count = app
        .webview_windows()
        .keys()
        .filter(|k| k.starts_with("progress_"))
        .count();

    let mut url = format!("index.html?window=toast&id={}", url_encode_query_component(id));
    if let Some(t) = initial_theme {
        url.push_str(&format!("&theme={}", t));
    }
    if let Some(a) = initial_accent {
        url.push_str(&format!("&accent={}", a));
    }

    let initial_pct = match job.total_bytes {
        Some(tot) if tot > 0 => ((job.downloaded_bytes as f64 / tot as f64) * 100.0).floor().clamp(0.0, 100.0) as u32,
        _ => 0,
    };
    let title = match job.state {
        tdm_core::JobState::Completed => "Download complete".to_string(),
        tdm_core::JobState::Failed => "Download failed".to_string(),
        _ => format!("{}% {}", initial_pct, job.filename),
    };

    let initial_width = 460.0;
    let initial_height = 382.0;

    let mut builder =
        tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App(url.into()))
            .title(title)
            .inner_size(initial_width, initial_height)
            .min_inner_size(360.0, 34.0)
            .max_inner_size(720.0, 760.0)
            .always_on_top(always_on_top)
            .decorations(false)
            .transparent(false)
            .skip_taskbar(false)
            .focused(force)
            .resizable(false)
            .shadow(true);

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

    let cascade = (open_count.min(6) as f64) * 26.0;
    let (base_x, base_y) = match (saved_x, saved_y) {
        (Some(sx), Some(sy)) => (Some(sx + cascade), Some(sy + cascade)),
        _ => (None, None),
    };
    let (mut x, mut y) = get_clamped_toast_position(app, base_x, base_y, initial_width, initial_height);
    if saved_x.is_none() && cascade > 0.0 {
        x = (x - cascade).max(16.0);
        y = (y - cascade).max(16.0);
    }
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

            let min_x = work_left + 8.0;
            let max_x = (work_right - width - 8.0).max(min_x);
            let min_y = work_top + 8.0;
            let max_y = (work_bottom - height - 8.0).max(min_y);

            (px.clamp(min_x, max_x), py.clamp(min_y, max_y))
        } else if let Some(mon) = best_monitor {
            let scale = mon.scale_factor();
            let pos = mon.position();
            let size = mon.size();
            let left = pos.x as f64 / scale;
            let top = pos.y as f64 / scale;
            let mon_w = size.width as f64 / scale;
            let mon_h = size.height as f64 / scale;

            let min_x = left + 8.0;
            let max_x = (left + mon_w - width - 8.0).max(min_x);
            let min_y = top + 8.0;
            let max_y = (top + mon_h - height - 8.0).max(min_y);

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

        if let Some((wl, wt, wr, wb)) = work_area {
            let work_left = wl / scale;
            let work_top = wt / scale;
            let work_right = wr / scale;
            let work_bottom = wb / scale;
            let x = (work_right - width - 8.0).max(work_left + 8.0);
            let y = (work_bottom - height - 8.0).max(work_top + 8.0);
            (x, y)
        } else if let Some(mon) = primary {
            let pos = mon.position();
            let size = mon.size();
            let mon_left = pos.x as f64 / scale;
            let mon_top = pos.y as f64 / scale;
            let mon_w = size.width as f64 / scale;
            let mon_h = size.height as f64 / scale;
            let x = (mon_left + mon_w - width - 8.0).max(mon_left + 8.0);
            let y = (mon_top + mon_h - height - 8.0).max(mon_top + 8.0);
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
pub async fn save_toast_size(width: f64, state: State<'_, AppState>) -> Result<(), String> {
    let clamped = width.clamp(384.0, 744.0);
    state
        .manager
        .database()
        .set_setting("toast_preferred_width", &clamped.to_string())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_toast_size(state: State<'_, AppState>) -> Result<Option<f64>, String> {
    if let Ok(Some(s)) = state
        .manager
        .database()
        .get_setting("toast_preferred_width")
    {
        if let Ok(w) = s.parse::<f64>() {
            return Ok(Some(w.clamp(384.0, 744.0)));
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn open_progress_window(
    id: String,
    force: Option<bool>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    open_progress_window_internal(&app, &state.manager, &id, force.unwrap_or(true)).await
}

#[tauri::command]
pub async fn update_toast_bounds(
    width: f64,
    height: f64,
    window: tauri::Window,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let w = width.clamp(360.0, 720.0);
    let h = height.clamp(34.0, 760.0);
    let target = if window.label().starts_with("progress_") {
        app.get_webview_window(window.label())
    } else {
        app.get_webview_window("progress_toast")
    };

    if let Some(win) = target {
        let _ = win.set_size(tauri::LogicalSize::new(w, h));
        let scale = win.scale_factor().unwrap_or(1.0);
        let cur_pos = win.outer_position().ok().map(|p| (p.x as f64 / scale, p.y as f64 / scale));
        if let Some((cx, cy)) = cur_pos {
            let (nx, ny) = get_clamped_toast_position(&app, Some(cx), Some(cy), w, h);
            if (nx - cx).abs() > 1.0 || (ny - cy).abs() > 1.0 {
                let _ = win.set_position(tauri::LogicalPosition::new(nx, ny));
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn hide_toast_window(window: tauri::Window, app: tauri::AppHandle) -> Result<(), String> {
    if window.label() != "main" {
        let _ = window.close();
    } else if let Some(win) = app.get_webview_window("progress_toast") {
        let _ = win.close();
    }
    Ok(())
}

#[tauri::command]
pub async fn get_download_status_details(
    id: String,
    state: State<'_, AppState>,
) -> Result<DownloadStatusDetails, String> {
    state
        .manager
        .get_download_status_details(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_download_speed_limit(
    id: String,
    limit_bps: u64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .manager
        .set_job_speed_limit(&id, limit_bps)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_download_completion_options(
    id: String,
    options: DownloadCompletionOptions,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .manager
        .set_completion_options(&id, &options)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_download_completion_options(
    id: String,
    state: State<'_, AppState>,
) -> Result<DownloadCompletionOptions, String> {
    Ok(state.manager.get_completion_options(&id))
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
    let format = format_id.as_deref().unwrap_or("best");
    let ext = tdm_core::playlist_format_ext(Some(format));
    let sample_name = format!("playlist.{}", ext);
    let dest_path = state
        .manager
        .resolve_destination_folder(&sample_name, destination.as_deref());
    let mut created_ids = Vec::new();

    let existing_jobs = state.manager.list_downloads().unwrap_or_default();

    for item in items {
        if item.url.trim().is_empty() {
            continue;
        }

        // Deduplication: prevent creating duplicate jobs for identical URL and format
        if let Some(existing) = existing_jobs.iter().find(|j| {
            j.url == item.url
                && j.resolved_url.as_deref() == Some(format)
                && j.state != tdm_core::JobState::Failed
                && j.state != tdm_core::JobState::Cancelled
        }) {
            created_ids.push(existing.id.clone());
            continue;
        }

        let clean_filename = format!("{}.{}", tdm_core::sanitize_filename(&item.title), ext);
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
    pub direct_stream_url: Option<String>,
    #[serde(default)]
    pub scheduled_at: Option<String>,
}

#[tauri::command]
pub async fn resolve_media(
    url: String,
    state: State<'_, AppState>,
) -> Result<tdm_core::MediaMetadata, String> {
    let raw_url = url.trim();
    if raw_url.is_empty() {
        return Err("Missing media URL to resolve".to_string());
    }
    let resolver = tdm_core::MediaResolver::new().with_database(state.manager.database().clone());
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

    if let Some(ref d) = args.destination {
        let clean = d.trim();
        if clean.contains("..") {
            return Err("Invalid destination path: directory traversal rejected.".to_string());
        }
    }

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

    let dest_path = state
        .manager
        .resolve_destination_folder(&filename_with_ext, args.destination.as_deref());

    let prio = match args.priority.as_deref() {
        Some("high") => tdm_core::Priority::High,
        Some("low") => tdm_core::Priority::Low,
        _ => tdm_core::Priority::Normal,
    };

    let target_media_url = args
        .direct_stream_url
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(raw_url);

    let parsed_sched = args
        .scheduled_at
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&chrono::Utc));

    let job = state
        .manager
        .create_managed_media_download_with_all_options_scheduled(
            target_media_url,
            &format_id,
            &filename_with_ext,
            &dest_path,
            prio,
            args.thumbnail_url,
            None,
            None,
            parsed_sched,
        )
        .await
        .map_err(|e| e.to_string())?;

    let start_now = args.start_immediately.unwrap_or(true);
    if start_now && job.state != tdm_core::JobState::Scheduled {
        state
            .manager
            .start_download(&job.id)
            .map_err(|e| e.to_string())?;

        let _ = open_progress_window_internal(&app, &state.manager, &job.id, false).await;
    }

    Ok(job)
}

#[tauri::command]
pub async fn reschedule_download(
    id: String,
    scheduled_at: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let parsed_sched = match scheduled_at {
        Some(ref s) if !s.trim().is_empty() => {
            match chrono::DateTime::parse_from_rfc3339(s.trim()) {
                Ok(dt) => Some(dt.with_timezone(&chrono::Utc)),
                Err(e) => return Err(format!("Invalid scheduled_at RFC 3339 format: {}", e)),
            }
        }
        _ => None,
    };

    state
        .manager
        .reschedule_download(&id, parsed_sched)
        .map_err(|e| e.to_string())
}
