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

    // Initialize Independent External Tools Auto-Update Manager (yt-dlp, FFmpeg, FFprobe)
    let mut tools_cfg = tdm_core::tools::ToolsManagerConfig::default();
    // Isolated QA harness override: ONLY active when TORI_DATA_DIR is explicitly set.
    // - Loopback `http://127.0.0.1:` allows local mock server + optional test key.
    // - Official HTTPS staging prefix `https://toridownload.xyz/assets/tools/staging/`
    //   STRICTLY preserves embedded production Ed25519 public key (key ID CDC23D8CC8DA5397).
    if std::env::var("TORI_DATA_DIR").is_ok() {
        let mut is_gate33_staging_url = false;
        if let Ok(manifest_url) = std::env::var("TORI_TEST_TOOLS_MANIFEST_URL") {
            let trimmed = manifest_url.trim().to_string();
            if trimmed.starts_with("http://127.0.0.1:") {
                tools_cfg.signed_manifest_url = Some(trimmed);
                tools_cfg.allow_loopback_http = true;
            } else if trimmed.starts_with(tdm_core::tools::TORI_STAGING_TOOLS_MANIFEST_PREFIX) {
                is_gate33_staging_url =
                    trimmed.starts_with(tdm_core::tools::TORI_STAGING_GATE33_TOOLS_MANIFEST_PREFIX);
                tools_cfg.signed_manifest_url = Some(trimmed);
                tools_cfg.allow_loopback_http = false;
            }
        }
        if let Ok(pubkey) = std::env::var("TORI_TEST_TOOLS_PUBKEY") {
            if !pubkey.trim().is_empty() && tools_cfg.allow_loopback_http {
                tools_cfg.tori_manifest_pubkey_b64 = pubkey;
                tools_cfg.expected_manifest_key_id = None;
            }
        }
        // Isolated multi-key keyring QA override (strictly restricted to loopback tests or
        // isolated Gate 33 HTTPS staging prefix; NEVER applies to production or Gate 32.1 staging).
        if let Ok(keyring_json) = std::env::var("TORI_TEST_TOOLS_KEYRING_JSON") {
            if !keyring_json.trim().is_empty()
                && (tools_cfg.allow_loopback_http || is_gate33_staging_url)
            {
                if let Ok(parsed_kr) =
                    serde_json::from_str::<tdm_core::tools::TrustedToolsKeyring>(&keyring_json)
                {
                    tools_cfg.tools_keyring = Some(parsed_kr);
                }
            }
        }
    }
    let tools_manager = Arc::new(
        tdm_core::tools::ExternalToolsManager::with_config(db.clone(), data_dir.clone(), tools_cfg)
            .expect("Failed to initialize External Tools Auto-Update Manager"),
    );
    let busy_mgr = manager.clone();
    tools_manager.set_busy_jobs_checker(Arc::new(move |bundle| {
        busy_mgr.has_active_external_tool_jobs(bundle)
    }));

    let already_migrated_tray = db
        .get_setting("close_to_tray_migrated_v104")
        .ok()
        .flatten()
        .is_some();

    if !already_migrated_tray || force_enable_close_to_tray {
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
            let _ = db.set_setting("close_to_tray_migrated_v104", "true");
            lifecycle::log_event(
                "APP",
                "CLOSE_TO_TRAY_ENABLED",
                "Default v1.0.4 closeToTray migration activated in app_settings without resetting other settings",
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
    let event_minimized_flag = is_minimized_launch.clone();
    let setup_minimized_flag = is_minimized_launch.clone();
    let shutdown_token = CancellationToken::new();
    let ipc_shutdown = shutdown_token.clone();
    let srv_shutdown = shutdown_token.clone();
    let tools_shutdown = shutdown_token.clone();
    let setup_tools_manager = tools_manager.clone();

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
            tools_manager: tools_manager.clone(),
            is_minimized_launch: is_minimized_launch.clone(),
        })
        .setup(move |app| {
            manager.set_desktop_gui_attached(true);
            let app_handle = app.handle().clone();
            let mut rx = event_bus.subscribe();
            let mgr = event_manager.clone();
            let bus_minimized_flag = event_minimized_flag.clone();

            let bus_app_handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                while let Ok(event) = rx.recv().await {
                    match &event {
                        tdm_core::DownloadEvent::ShowWindow => {
                            bus_minimized_flag.store(false, std::sync::atomic::Ordering::SeqCst);
                            tray::show_main_window(&bus_app_handle);
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
                        tdm_core::DownloadEvent::OpenPlaylistModal { url } => {
                            bus_minimized_flag.store(false, std::sync::atomic::Ordering::SeqCst);
                            tray::show_main_window(&bus_app_handle);
                            if mgr.is_frontend_playlist_ready() {
                                let pending = mgr.pending_playlist_requests_snapshot();
                                if !pending.is_empty() {
                                    for req in pending {
                                        let _ =
                                            bus_app_handle.emit("open-playlist-modal-request", &req);
                                    }
                                } else {
                                    let _ = bus_app_handle.emit("open-playlist-modal", url);
                                }
                            }
                        }
                        tdm_core::DownloadEvent::StateChanged {
                            id,
                            state: tdm_core::JobState::Completed,
                            error: None,
                        } => {
                            let app = bus_app_handle.clone();
                            let m = mgr.clone();
                            let id_c = id.clone();
                            tauri::async_runtime::spawn(async move {
                                let opts = m.get_completion_options(&id_c);
                                if opts.notify_on_complete {
                                    let fname = m
                                        .get_download(&id_c)
                                        .ok()
                                        .flatten()
                                        .map(|j| j.filename)
                                        .unwrap_or_else(|| "Download".to_string());
                                    let _ = app.emit(
                                        "download-complete-notification",
                                        serde_json::json!({ "id": &id_c, "filename": &fname }),
                                    );
                                    commands::send_desktop_notification(
                                        "TORI Download Complete",
                                        &fname,
                                    );
                                }
                                if opts.open_on_complete {
                                    if let Ok(Some(job)) = m.get_download(&id_c) {
                                        let _ = commands::open_file(job.target_path).await;
                                    }
                                }
                                if opts.close_on_complete {
                                    tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                                    let label = commands::progress_window_label(&id_c);
                                    if let Some(win) = app.get_webview_window(&label) {
                                        let _ = win.close();
                                    }
                                }
                            });
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

            // Forward External Tools Updater events to frontend & native notifications
            let tools_events_app = app_handle.clone();
            let mut tools_rx = setup_tools_manager.subscribe();
            tauri::async_runtime::spawn(async move {
                while let Ok(evt) = tools_rx.recv().await {
                    match evt {
                        tdm_core::tools::ExternalToolsEvent::StatusChanged => {
                            let _ = tools_events_app.emit("external-tools-status-changed", ());
                        }
                        tdm_core::tools::ExternalToolsEvent::Progress(prog) => {
                            let _ = tools_events_app.emit("external-tools-progress", &prog);
                        }
                        tdm_core::tools::ExternalToolsEvent::Notification(notif) => {
                            let _ = tools_events_app.emit("external-tools-notification", &notif);
                            commands::send_tool_update_notification(&notif.title, &notif.body);
                        }
                    }
                }
            });

            // Start non-blocking background External Tools Update scheduler (every 24h by default)
            tauri::async_runtime::spawn(
                setup_tools_manager.run_background_scheduler(tools_shutdown),
            );

            if setup_minimized_flag.load(std::sync::atomic::Ordering::SeqCst)
                && manager.pending_playlist_requests_snapshot().is_empty()
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.minimize();
                    lifecycle::trim_memory();
                }
            }

            // Fallback safety timeout: ensure main window is displayed even if frontend signal fails
            let safety_handle = app_handle.clone();
            let safety_minimized_flag = setup_minimized_flag.clone();
            let safety_mgr = manager.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                let has_pending_playlist = !safety_mgr.pending_playlist_requests_snapshot().is_empty();
                let should_show_fallback = (!safety_minimized_flag.load(std::sync::atomic::Ordering::SeqCst)
                    && !safety_mgr.is_frontend_playlist_ready())
                    || has_pending_playlist;
                if should_show_fallback {
                    if let Some(w) = safety_handle.get_webview_window("main") {
                        if let Ok(false) = w.is_visible() {
                            lifecycle::log_event(
                                "APP",
                                "SAFETY_TIMEOUT_SHOW",
                                "Safety fallback timer triggered; displaying main window",
                            );
                            tray::show_main_window(&safety_handle);
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
            take_pending_playlist_requests,
            acknowledge_playlist_modal,
            show_main_window,
            hide_main_window,
            exit_app,
            update_engine_settings,
            get_engine_settings,
            get_browser_integration_info,
            regenerate_pairing_token,
            get_download,
            get_download_status_details,
            set_download_speed_limit,
            set_download_completion_options,
            get_download_completion_options,
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
            get_external_tools_status,
            check_external_tools_updates,
            update_external_tool,
            update_all_external_tools,
            get_external_tool_update_history,
            rollback_external_tool,
            open_external_tool_location,
            get_external_tool_update_settings,
            save_external_tool_update_settings,
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
