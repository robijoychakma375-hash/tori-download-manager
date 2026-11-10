use std::sync::Arc;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tdm_core::{DownloadManager, JobState};

use crate::lifecycle;

pub const TRAY_ID: &str = "tori-system-tray";

pub fn is_close_to_tray_enabled(manager: &DownloadManager) -> bool {
    if let Ok(val) = std::env::var("TORI_CLOSE_TO_TRAY") {
        if val == "0" || val.eq_ignore_ascii_case("false") {
            return false;
        } else if val == "1" || val.eq_ignore_ascii_case("true") {
            return true;
        }
    }
    if let Ok(Some(saved)) = manager.database().get_setting("app_settings") {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&saved) {
            if let Some(close_to_tray) = val.get("closeToTray").and_then(|v| v.as_bool()) {
                return close_to_tray;
            }
        }
    }
    true // Enabled by default
}

pub fn count_active_downloads(manager: &DownloadManager) -> usize {
    if let Ok(jobs) = manager.list_downloads() {
        jobs.into_iter().filter(|j| j.state.is_active()).count()
    } else {
        0
    }
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        lifecycle::log_event("WINDOW", "RESTORE_MAIN", "Restoring main window from tray");
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn hide_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        lifecycle::log_event("WINDOW", "HIDE_MAIN", "Hiding main window to tray");
        let _ = window.hide();
        lifecycle::trim_memory();
    }
}

pub fn perform_clean_exit(app: &AppHandle, manager: &Arc<DownloadManager>) {
    let active = count_active_downloads(manager);
    if active > 0 {
        let app_handle = app.clone();
        let mgr_clone = manager.clone();
        app.dialog()
            .message(format!(
                "TORI is currently downloading {} file(s).\n\nDo you want to pause active downloads and exit?",
                active
            ))
            .title("Active Downloads in Progress")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::YesNo)
            .show(move |confirmed| {
                if confirmed {
                    lifecycle::log_event(
                        "APP",
                        "EXIT_CONFIRMED",
                        "User confirmed exit with active downloads",
                    );
                    if let Ok(jobs) = mgr_clone.list_downloads() {
                        for j in jobs {
                            if j.state.is_active() {
                                let _ = mgr_clone.pause_download(&j.id);
                            }
                        }
                    }
                    app_handle.exit(0);
                } else {
                    lifecycle::log_event(
                        "APP",
                        "EXIT_CANCELLED",
                        "User opted to keep TORI running",
                    );
                }
            });
    } else {
        lifecycle::log_event("APP", "EXIT_CLEAN", "Exiting TORI cleanly");
        app.exit(0);
    }
}

pub fn setup_system_tray(
    app: &AppHandle,
    manager: Arc<DownloadManager>,
) -> Result<(), Box<dyn std::error::Error>> {
    if app.tray_by_id(TRAY_ID).is_some() {
        lifecycle::log_event(
            "TRAY",
            "EXISTS",
            "Tray icon already exists; skipping duplicate setup",
        );
        return Ok(());
    }

    let show_i = MenuItem::with_id(app, "show", "Show TORI", true, None::<&str>)?;
    let hide_i = MenuItem::with_id(app, "hide", "Hide TORI", true, None::<&str>)?;
    let sep0 = PredefinedMenuItem::separator(app)?;
    let active_i = MenuItem::with_id(
        app,
        "active_downloads",
        "Active Downloads: 0",
        false,
        None::<&str>,
    )?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let pause_all_i = MenuItem::with_id(app, "pause_all", "Pause All", true, None::<&str>)?;
    let resume_all_i = MenuItem::with_id(app, "resume_all", "Resume All", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let exit_i = MenuItem::with_id(app, "exit", "Exit TORI", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &show_i,
            &hide_i,
            &sep0,
            &active_i,
            &sep1,
            &pause_all_i,
            &resume_all_i,
            &sep2,
            &exit_i,
        ],
    )?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("Default window icon missing")?;

    let mgr_for_menu = manager.clone();

    let _tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("TORI Download Manager")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| {
            let id = event.id().as_ref();
            lifecycle::log_event("TRAY", "MENU_CLICK", id);
            match id {
                "show" | "open" => {
                    show_main_window(app);
                }
                "hide" => {
                    hide_main_window(app);
                }
                "pause_all" => {
                    if let Ok(jobs) = mgr_for_menu.list_downloads() {
                        for j in jobs {
                            if j.state.is_active() {
                                let _ = mgr_for_menu.pause_download(&j.id);
                            }
                        }
                    }
                }
                "resume_all" => {
                    if let Ok(jobs) = mgr_for_menu.list_downloads() {
                        for j in jobs {
                            if matches!(j.state, JobState::Paused) {
                                let _ = mgr_for_menu.resume_download(&j.id);
                            }
                        }
                    }
                }
                "exit" => {
                    perform_clean_exit(app, &mgr_for_menu);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => {
                show_main_window(tray.app_handle());
            }
            _ => {}
        })
        .build(app)?;

    lifecycle::log_event("TRAY", "INITIALIZED", "System tray icon created with menu");
    Ok(())
}
