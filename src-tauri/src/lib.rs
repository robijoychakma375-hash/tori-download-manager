use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tdm_core::{Database, DownloadManager, EventBus};
use tokio_util::sync::CancellationToken;

mod commands;
mod state;

use commands::*;
use state::AppState;

pub fn run() {
    tracing_subscriber::fmt::init();

    // Single-Instance Check: If a primary instance is already active with the Named Pipe server,
    // request that the primary instance bring its window to the foreground, then exit cleanly.
    if tdm_native_host::ipc::try_connect_engine().is_ok() {
        eprintln!("[TORI] An active instance of TORI Download Manager is already running. Focusing primary window and exiting secondary process.");
        if let Ok(rt) = tokio::runtime::Runtime::new() {
            rt.block_on(async {
                let msg = tdm_native_host::protocol::NativeMessage {
                    action: "show_window".to_string(),
                    url: None,
                    filename: None,
                    destination: None,
                    priority: None,
                    job_id: None,
                };
                let _ = tdm_native_host::ipc::forward_to_persistent_engine(&msg).await;
            });
        }
        return;
    }

    // Data directory resolution: TORI_DATA_DIR or %APPDATA%/tori-download-manager
    let data_dir = if let Ok(override_dir) = std::env::var("TORI_DATA_DIR") {
        PathBuf::from(override_dir)
    } else if let Ok(app_data) = std::env::var("APPDATA") {
        PathBuf::from(app_data).join("tori-download-manager")
    } else {
        PathBuf::from(".tdm-data")
    };

    if !data_dir.exists() {
        let _ = fs::create_dir_all(&data_dir);
    }

    let db_path = data_dir.join("tdm_storage.sqlite");
    let db = Database::open(&db_path).expect("Failed to initialize TDM SQLite database");
    let event_bus = EventBus::default();

    let manager = Arc::new(
        DownloadManager::new(db.clone(), event_bus.clone())
            .expect("Failed to initialize TDM Download Manager"),
    );

    // Restore persisted engine settings from SQLite if present
    if let Ok(Some(saved)) = db.get_setting("app_settings") {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&saved) {
            commands::apply_settings_to_manager(&manager, &val);
        }
    }

    let is_minimized = std::env::args().any(|a| a == "--minimized");

    let ipc_manager = manager.clone();
    let ipc_db = db.clone();
    let srv_manager = manager.clone();
    let srv_db = db.clone();
    let event_manager = manager.clone();
    let shutdown_token = CancellationToken::new();
    let ipc_shutdown = shutdown_token.clone();
    let srv_shutdown = shutdown_token.clone();

    tauri::Builder::default()
        .manage(AppState {
            manager: manager.clone(),
        })
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let mut rx = event_bus.subscribe();
            let mgr = event_manager.clone();

            tauri::async_runtime::spawn(async move {
                while let Ok(event) = rx.recv().await {
                    match &event {
                        tdm_core::DownloadEvent::ShowWindow => {
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let _ = window.unminimize();
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        tdm_core::DownloadEvent::OpenProgressWindow { id } => {
                            let app = app_handle.clone();
                            let m = mgr.clone();
                            let id_c = id.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ =
                                    commands::open_progress_window_internal(&app, &m, &id_c, false)
                                        .await;
                            });
                        }
                        _ => {}
                    }
                    let _ = app_handle.emit("download-event", &event);
                }
            });

            // Launch the single-instance persistent Windows Named Pipe IPC Server
            tauri::async_runtime::spawn(async move {
                tdm_native_host::ipc::run_ipc_server(ipc_manager, ipc_db, ipc_shutdown).await;
            });

            // Launch the local HTTP/SSE browser integration server on 127.0.0.1
            tauri::async_runtime::spawn(async move {
                if let Err(e) =
                    tdm_native_host::server::start_server(srv_manager, srv_db, srv_shutdown).await
                {
                    eprintln!("[TORI] Failed to start local integration server: {}", e);
                }
            });

            if is_minimized {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.minimize();
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_download,
            start_download,
            stop_recording,
            pause_download,
            resume_download,
            cancel_download,
            retry_download,
            list_downloads,
            delete_download,
            delete_downloads,
            set_download_priority,
            open_folder,
            get_default_download_dir,
            get_download_chunks,
            open_file,
            verify_checksum,
            open_data_folder,
            check_extension_status,
            register_native_host,
            window_minimize,
            window_maximize,
            window_close,
            update_engine_settings,
            get_engine_settings,
            get_browser_integration_info,
            regenerate_pairing_token,
            get_download,
            open_progress_window,
            update_toast_bounds,
            hide_toast_window,
            save_toast_position,
            save_toast_size,
            get_toast_size,
            resolve_playlist,
            enqueue_playlist_items,
            resolve_media,
            create_media_download,
        ])
        .run(tauri::generate_context!())
        .expect("Error while running TORI Download Manager desktop application");
}
