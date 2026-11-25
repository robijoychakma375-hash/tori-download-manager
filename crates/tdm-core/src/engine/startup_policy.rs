use crate::types::JobState;

/// Pure decision gate governing whether an automatic (non-forced) standalone download
/// progress window should be created for a given job state and launch mode.
///
/// Gate 35.2 (Priority 3): prevents unwanted `always_on_top` "Download failed" popups
/// during silent background / Windows startup invocations while keeping explicit user
/// actions (`force = true`) and active user-requested downloads working normally.
pub fn should_auto_open_progress_window(
    job_state: JobState,
    popup_mode: &str,
    force: bool,
    is_minimized_launch: bool,
) -> std::result::Result<(), &'static str> {
    if force {
        return Ok(());
    }

    if popup_mode == "never" {
        return Err("popup_mode_never");
    }

    if matches!(job_state, JobState::Failed | JobState::Cancelled) {
        return Err("terminal_failed_or_cancelled");
    }

    if is_minimized_launch
        && !matches!(
            job_state,
            JobState::Downloading | JobState::Probing | JobState::Queued | JobState::Verifying
        )
    {
        return Err("background_launch_non_active_job");
    }

    Ok(())
}

/// Returns true when the main desktop window should remain hidden in the system tray
/// during a `--minimized` background launch.
pub fn should_keep_main_window_hidden_on_startup(
    is_minimized_launch: bool,
    has_pending_playlist: bool,
) -> bool {
    is_minimized_launch && !has_pending_playlist
}

/// Evaluates whether close-to-tray is enabled from optional env override and saved JSON settings.
pub fn is_close_to_tray_enabled_from_settings(
    env_override: Option<&str>,
    settings_json: Option<&str>,
) -> bool {
    if let Some(val) = env_override {
        if val == "0" || val.eq_ignore_ascii_case("false") {
            return false;
        } else if val == "1" || val.eq_ignore_ascii_case("true") {
            return true;
        }
    }
    if let Some(saved) = settings_json {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(saved) {
            if let Some(close_to_tray) = val.get("closeToTray").and_then(|v| v.as_bool()) {
                return close_to_tray;
            }
        }
    }
    true
}
