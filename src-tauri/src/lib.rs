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

    // Launch the single-instance persistent Windows Named Pipe IPC Server
    let ipc_manager = manager.clone();
    let ipc_db = db.clone();
    let shutdown_token = CancellationToken::new();
    let ipc_shutdown = shutdown_token.clone();

    tauri::async_runtime::spawn(async move {
        tdm_native_host::ipc::run_ipc_server(ipc_manager, ipc_db, ipc_shutdown).await;
    });

    let is_minimized = std::env::args().any(|a| a == "--minimized");

    tauri::Builder::default()
        .manage(AppState {
            manager: manager.clone(),
        })
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let mut rx = event_bus.subscribe();

            tauri::async_runtime::spawn(async move {
                while let Ok(event) = rx.recv().await {
                    if matches!(event, tdm_core::DownloadEvent::ShowWindow) {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    let _ = app_handle.emit("download-event", &event);
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
        ])
        .run(tauri::generate_context!())
        .expect("Error while running TORI Download Manager desktop application");
}
