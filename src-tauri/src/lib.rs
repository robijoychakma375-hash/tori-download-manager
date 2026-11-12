use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tdm_core::{Database, DownloadManager, EventBus};
use tokio_util::sync::CancellationToken;

mod commands;
pub mod lifecycle;
mod state;
pub mod tray;

use commands::*;
use state::AppState;

pub fn run() {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .init();
    lifecycle::install_panic_hook();
    let raw_args: Vec<String> = std::env::args().collect();
    lifecycle::log_event(
        "APP",
        "STARTUP",
        &format!(
            "Initializing TORI Download Manager desktop application (args={:?})",
            raw_args
        ),
    );

    let is_minimized = raw_args.iter().any(|a| a == "--minimized");
    let force_enable_close_to_tray = raw_args.iter().any(|a| a == "--enable-close-to-tray")
        || std::env::var("TORI_ENABLE_CLOSE_TO_TRAY")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);

    // Single-Instance Check: If a primary instance is already active with the Named Pipe server,
    // request that the primary instance bring its window to the foreground, then exit cleanly.
    let is_secondary = if let Ok(rt) = tokio::runtime::Runtime::new() {
        rt.block_on(async {
            if tdm_native_host::ipc::try_connect_engine().is_ok() {
                lifecycle::log_event(
                    "APP",
                    "SECONDARY_INSTANCE",
                    &format!(
                        "Active primary instance detected; is_minimized={}; exiting secondary process",
                        is_minimized
                    ),
                );
                if !is_minimized {
                    eprintln!("[TORI] An active instance of TORI Download Manager is already running. Focusing primary window and exiting secondary process.");
                    let msg = tdm_native_host::protocol::NativeMessage {
                        action: "show_window".to_string(),
                        ..Default::default()
                    };
                    let _ = tdm_native_host::ipc::forward_to_persistent_engine(&msg).await;
                }
                true
            } else {
                false
            }
        })
    } else {
        false
    };

    if is_secondary {
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

    // Isolate WebView2 user profile whenever TORI_DATA_DIR is set so QA/test runs
    // never share or pollute the user's production WebView2 localStorage.
    if std::env::var("TORI_DATA_DIR").is_ok()
        && std::env::var("WEBVIEW2_USER_DATA_FOLDER").is_err()
    {
        let isolated_webview = data_dir.join("EBWebView");
        let _ = fs::create_dir_all(&isolated_webview);
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &isolated_webview);
    }

    let db_path = data_dir.join("tdm_storage.sqlite");
    let db = Database::open(&db_path).expect("Failed to initialize TDM SQLite database");
    let event_bus = EventBus::default();

    let manager = Arc::new(
        DownloadManager::new(db.clone(), event_bus.clone())
            .expect("Failed to initialize TDM Download Manager"),
    );

    if force_enable_close_to_tray {
        let mut settings_obj = db
            .get_setting("app_settings")
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        if let Some(map) = settings_obj.as_object_mut() {
            map.insert("closeToTray".to_string(), serde_json::Value::Bool(true));
        }
        if let Ok(serialized) = serde_json::to_string(&settings_obj) {
            let _ = db.set_setting("app_settings", &serialized);
            lifecycle::log_event(
                "APP",
                "CLOSE_TO_TRAY_ENABLED",
                "Explicitly enabled closeToTray in app_settings via flag/env without resetting other settings",
            );
        }
    }

    // Restore persisted engine settings from SQLite if present
    if let Ok(Some(saved)) = db.get_setting("app_settings") {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&saved) {
            commands::apply_settings_to_manager(&manager, &val);
        }
    }

    let is_minimized_launch = Arc::new(std::sync::atomic::AtomicBool::new(is_minimized));

    let ipc_manager = manager.clone();
    let ipc_db = db.clone();
    let srv_manager = manager.clone();
    let srv_db = db.clone();
    let event_manager = manager.clone();
    let shutdown_token = CancellationToken::new();
    let ipc_shutdown = shutdown_token.clone();
    let srv_shutdown = shutdown_token.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(move |app, args, _cwd| {
            lifecycle::log_event(
                "APP",
                "SINGLE_INSTANCE_RESTORE",
                &format!("Secondary instance launched with args: {:?}", args),
            );
            let launch_minimized = args.iter().any(|a| a == "--minimized");
            if !launch_minimized {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState {
            manager: manager.clone(),
            is_minimized_launch: is_minimized_launch.clone(),
        })
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let mut rx = event_bus.subscribe();
            let mgr = event_manager.clone();

            let bus_app_handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                while let Ok(event) = rx.recv().await {
                    match &event {
                        tdm_core::DownloadEvent::ShowWindow => {
                            if let Some(window) = bus_app_handle.get_webview_window("main") {
                                let _ = window.unminimize();
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        tdm_core::DownloadEvent::HideWindow => {
                            if let Some(window) = bus_app_handle.get_webview_window("main") {
                                let _ = window.hide();
                                lifecycle::trim_memory();
                            }
                        }
                        tdm_core::DownloadEvent::OpenProgressWindow { id } => {
                            let app = bus_app_handle.clone();
                            let m = mgr.clone();
                            let id_c = id.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ =
                                    commands::open_progress_window_internal(&app, &m, &id_c, false)
                                        .await;
                            });
                        }
                        tdm_core::DownloadEvent::Deleted { id } => {
                            let _ = bus_app_handle.emit("download-deleted", id);
                        }
                        _ => {}
                    }
                    let _ = bus_app_handle.emit("download-event", &event);
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
                    lifecycle::trim_memory();
                }
            }

            // Fallback safety timeout: ensure main window is displayed even if frontend signal fails
            let safety_handle = app_handle.clone();
            let safety_minimized = is_minimized;
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                if !safety_minimized {
                    if let Some(w) = safety_handle.get_webview_window("main") {
                        if let Ok(false) = w.is_visible() {
                            lifecycle::log_event(
                                "APP",
                                "SAFETY_TIMEOUT_SHOW",
                                "Safety fallback timer triggered; displaying main window",
                            );
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                }
            });

            if let Err(e) = tray::setup_system_tray(&app_handle, manager.clone()) {
                eprintln!("[TORI] Failed to setup system tray: {}", e);
                lifecycle::log_event("TRAY", "ERROR", &format!("Setup failed: {}", e));
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    let app_handle = window.app_handle();
                    let state = app_handle.state::<AppState>();
                    let close_to_tray = tray::is_close_to_tray_enabled(&state.manager);
                    lifecycle::log_event(
                        "WINDOW",
                        "CLOSE_REQUESTED",
                        &format!("label={}, close_to_tray={}", window.label(), close_to_tray),
                    );
                    if window.label() == "main" {
                        if close_to_tray {
                            api.prevent_close();
                            tray::hide_main_window(app_handle);
                        } else {
                            api.prevent_close();
                            tray::perform_clean_exit(app_handle, &state.manager);
                        }
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    if window.label() == "main" {
                        lifecycle::log_event("WINDOW", "DESTROYED", "label=main");
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            create_download,
            start_download,
            stop_recording,
            pause_download,
            resume_download,
            cancel_download,
            retry_download,
            reschedule_download,
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
            frontend_ready,
            show_main_window,
            hide_main_window,
            exit_app,
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
            get_app_version,
            get_active_downloads_count,
            open_external_url,
            get_third_party_licenses,
        ])
        .build(tauri::generate_context!())
        .expect("Error while building TORI Download Manager desktop application");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { code, api, .. } => {
            lifecycle::log_event("APP", "EXIT_REQUESTED", &format!("code={:?}", code));
            if code.is_none() {
                let state = app_handle.state::<AppState>();
                if tray::is_close_to_tray_enabled(&state.manager) {
                    lifecycle::log_event(
                        "APP",
                        "PREVENT_EXIT",
                        "Preventing app exit; running in system tray",
                    );
                    api.prevent_exit();
                } else {
                    lifecycle::log_event(
                        "APP",
                        "ALLOW_EXIT",
                        "Close to tray disabled; allowing app termination",
                    );
                }
            } else {
                lifecycle::log_event(
                    "APP",
                    "EXPLICIT_EXIT",
                    &format!("Exiting with explicit code: {:?}", code),
                );
            }
        }
        tauri::RunEvent::Exit => {
            lifecycle::log_event("APP", "PROCESS_EXIT", "Tauri RunEvent::Exit reached");
        }
        _ => {}
    });
}
