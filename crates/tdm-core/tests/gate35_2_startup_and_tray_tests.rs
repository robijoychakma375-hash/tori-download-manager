use tdm_core::{
    is_close_to_tray_enabled_from_settings, should_auto_open_progress_window,
    should_keep_main_window_hidden_on_startup, JobState,
};

#[test]
fn test_auto_progress_window_blocked_for_failed_and_cancelled_jobs() {
    // Gate 35.2 Priority 3 regression: an auto-triggered OpenProgressWindow event arriving
    // after a job already failed (e.g. replayed Edge download failing within 400ms) MUST NOT
    // spawn an always_on_top "Download failed" popup window.
    assert_eq!(
        should_auto_open_progress_window(JobState::Failed, "always", false, true),
        Err("terminal_failed_or_cancelled")
    );
    assert_eq!(
        should_auto_open_progress_window(JobState::Failed, "always", false, false),
        Err("terminal_failed_or_cancelled")
    );
    assert_eq!(
        should_auto_open_progress_window(JobState::Cancelled, "always", false, false),
        Err("terminal_failed_or_cancelled")
    );
}

#[test]
fn test_auto_progress_window_blocked_for_non_active_jobs_on_minimized_launch() {
    assert_eq!(
        should_auto_open_progress_window(JobState::Paused, "always", false, true),
        Err("background_launch_non_active_job")
    );
    assert_eq!(
        should_auto_open_progress_window(JobState::Completed, "always", false, true),
        Err("background_launch_non_active_job")
    );
}

#[test]
fn test_progress_window_allowed_for_explicit_user_clicks_and_active_downloads() {
    // Explicit user click (force = true) ALWAYS works even for Failed / Cancelled / Completed jobs
    assert_eq!(
        should_auto_open_progress_window(JobState::Failed, "never", true, true),
        Ok(())
    );
    assert_eq!(
        should_auto_open_progress_window(JobState::Completed, "never", true, false),
        Ok(())
    );

    // Legitimate active downloads open progress window when popup_mode != "never"
    assert_eq!(
        should_auto_open_progress_window(JobState::Downloading, "always", false, false),
        Ok(())
    );
    assert_eq!(
        should_auto_open_progress_window(JobState::Downloading, "on_start", false, true),
        Ok(())
    );
    assert_eq!(
        should_auto_open_progress_window(JobState::Probing, "always", false, true),
        Ok(())
    );

    // User preference "never" strictly suppresses auto-open
    assert_eq!(
        should_auto_open_progress_window(JobState::Downloading, "never", false, false),
        Err("popup_mode_never")
    );
}

#[test]
fn test_minimized_startup_keeps_main_window_hidden_unless_playlist_requested() {
    assert!(should_keep_main_window_hidden_on_startup(true, false));
    assert!(!should_keep_main_window_hidden_on_startup(true, true));
    assert!(!should_keep_main_window_hidden_on_startup(false, false));
    assert!(!should_keep_main_window_hidden_on_startup(false, true));
}

#[test]
fn test_close_to_tray_policy_preserved() {
    // Default enabled
    assert!(is_close_to_tray_enabled_from_settings(None, None));
    assert!(is_close_to_tray_enabled_from_settings(None, Some("{}")));
    assert!(is_close_to_tray_enabled_from_settings(
        None,
        Some(r#"{"closeToTray":true}"#)
    ));
    assert!(!is_close_to_tray_enabled_from_settings(
        None,
        Some(r#"{"closeToTray":false}"#)
    ));

    // Env overrides
    assert!(!is_close_to_tray_enabled_from_settings(
        Some("0"),
        Some(r#"{"closeToTray":true}"#)
    ));
    assert!(!is_close_to_tray_enabled_from_settings(
        Some("false"),
        Some(r#"{"closeToTray":true}"#)
    ));
    assert!(is_close_to_tray_enabled_from_settings(
        Some("1"),
        Some(r#"{"closeToTray":false}"#)
    ));
}
