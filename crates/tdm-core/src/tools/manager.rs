use chrono::{DateTime, Duration as ChronoDuration, Utc};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, Mutex as AsyncMutex};
use tokio_util::sync::CancellationToken;

use crate::db::Database;
use crate::error::{EngineError, Result};
use crate::tools::activation::{
    global_tool_coordinator, load_active_manifest_with_recovery, prune_obsolete_versions,
    write_active_manifest_atomic, ManagedBinarySlot, ManagedFfmpegBundleSlot,
    ToolUsageCoordinator,
};
use crate::tools::health::{verify_staged_ffmpeg_bundle, verify_staged_ytdlp};
use crate::tools::providers::{
    fetch_ffmpeg_bundle_candidate, fetch_signed_tools_manifest, fetch_ytdlp_candidate,
    ArtifactKind, ProviderFetchError, UpdateCandidate,
};
use crate::tools::staging::{
    append_tools_log, cleanup_staging_directory, copy_file_atomic, download_artifact_to_staging,
    extract_ffmpeg_bundle_zip, ToolsDirLayout,
};
use crate::tools::store;
use crate::tools::trust::compute_file_sha256;
use crate::tools::types::{
    ExternalToolHistoryEntry, ExternalToolRecord, ExternalToolsSettings, ExternalToolsSnapshot,
    ToolBundleId, ToolId, ToolNotificationEvent, ToolNotificationKind, ToolProgressEvent,
    ToolUpdateStatus, ToolsManagerConfig, TrustLevel,
};
use crate::tools::version::{
    compare_tool_versions, probe_tool_version, sanitize_version_dir_name, VersionComparison,
};

#[derive(Debug, Clone)]
pub enum ExternalToolsEvent {
    StatusChanged,
    Progress(ToolProgressEvent),
    Notification(ToolNotificationEvent),
}

pub type BusyJobsCheckFn = Arc<dyn Fn(ToolBundleId) -> bool + Send + Sync>;

struct CheckGuard<'a>(&'a AtomicBool);
impl Drop for CheckGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

pub struct ExternalToolsManager {
    db: Database,
    layout: ToolsDirLayout,
    config: ToolsManagerConfig,
    coordinator: Arc<ToolUsageCoordinator>,
    event_tx: broadcast::Sender<ExternalToolsEvent>,
    check_in_flight: AtomicBool,
    inventory_initialized: AtomicBool,
    ytdlp_lock: AsyncMutex<()>,
    ffmpeg_lock: AsyncMutex<()>,
    last_candidates: Mutex<HashMap<ToolBundleId, UpdateCandidate>>,
    notified_untrusted_versions: Mutex<HashSet<String>>,
    busy_jobs_checker: Mutex<Option<BusyJobsCheckFn>>,
    /// Test-only hook to simulate a post-switch health verification failure and verify automatic rollback.
    fail_post_switch_once: AtomicBool,
}

impl ExternalToolsManager {
    pub fn new(db: Database, data_dir: PathBuf) -> Result<Self> {
        Self::with_config(db, data_dir, ToolsManagerConfig::default())
    }

    pub fn with_config(
        db: Database,
        data_dir: PathBuf,
        config: ToolsManagerConfig,
    ) -> Result<Self> {
        let layout = ToolsDirLayout::from_data_dir(&data_dir);
        layout.ensure_dirs()?;

        let coordinator = if config.register_globally {
            global_tool_coordinator()
        } else {
            Arc::new(ToolUsageCoordinator::new())
        };
        coordinator.set_bundled_override_dir(config.bundled_override_dir.clone());

        let (event_tx, _) = broadcast::channel(256);

        let manager = Self {
            db,
            layout,
            config,
            coordinator,
            event_tx,
            check_in_flight: AtomicBool::new(false),
            inventory_initialized: AtomicBool::new(false),
            ytdlp_lock: AsyncMutex::new(()),
            ffmpeg_lock: AsyncMutex::new(()),
            last_candidates: Mutex::new(HashMap::new()),
            notified_untrusted_versions: Mutex::new(HashSet::new()),
            busy_jobs_checker: Mutex::new(None),
            fail_post_switch_once: AtomicBool::new(false),
        };

        manager.recover_on_startup();
        Ok(manager)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ExternalToolsEvent> {
        self.event_tx.subscribe()
    }

    pub fn coordinator(&self) -> Arc<ToolUsageCoordinator> {
        Arc::clone(&self.coordinator)
    }

    pub fn tools_root(&self) -> &Path {
        &self.layout.root
    }

    pub fn set_busy_jobs_checker(&self, checker: BusyJobsCheckFn) {
        let mut guard = self.busy_jobs_checker.lock().unwrap();
        *guard = Some(checker);
    }

    /// Test helper: causes the next post-switch health check to fail so automatic rollback can be verified.
    pub fn arm_simulated_post_switch_failure(&self) {
        self.fail_post_switch_once.store(true, Ordering::SeqCst);
    }

    fn is_bundle_busy_by_jobs(&self, bundle: ToolBundleId) -> bool {
        let guard = self.busy_jobs_checker.lock().unwrap();
        guard.as_ref().map(|f| f(bundle)).unwrap_or(false)
    }

    fn emit_status_changed(&self) {
        let _ = self.event_tx.send(ExternalToolsEvent::StatusChanged);
    }

    fn emit_progress(&self, event: ToolProgressEvent) {
        let _ = self.event_tx.send(ExternalToolsEvent::Progress(event));
    }

    fn emit_notification(
        &self,
        kind: ToolNotificationKind,
        tool_id: ToolId,
        title: impl Into<String>,
        body: impl Into<String>,
        version: Option<String>,
    ) {
        let settings = self.get_settings();
        if !settings.notify_on_update {
            return;
        }
        let evt = ToolNotificationEvent {
            kind,
            tool_id,
            title: title.into(),
            body: body.into(),
            version,
            timestamp: Utc::now(),
        };
        let _ = self
            .event_tx
            .send(ExternalToolsEvent::Notification(evt));
    }

    /// Startup crash recovery:
    /// - Removes interrupted staging files
    /// - Repairs corrupted `active-tools.json` from `.bak` or clean default
    /// - Detects missing/quarantined active managed binaries and automatically falls back
    /// - Ensures registry rows exist in SQLite without blocking startup on network I/O
    pub fn recover_on_startup(&self) {
        let cleaned = cleanup_staging_directory(&self.layout);
        if cleaned > 0 {
            append_tools_log(
                &self.layout,
                "WARN",
                "STARTUP_RECOVERY",
                &format!("Cleaned {} leftover staging entries from interrupted update", cleaned),
            );
        }

        let (mut manifest, recovered_corrupt) = load_active_manifest_with_recovery(&self.layout);
        if recovered_corrupt {
            append_tools_log(
                &self.layout,
                "WARN",
                "MANIFEST_RECOVERY",
                "Recovered corrupted active-tools.json from backup or clean default",
            );
            let _ = store::insert_history_entry(
                &self.db,
                "system",
                "recovery",
                None,
                None,
                "recovered",
                Some("local"),
                None,
                None,
                Some("Recovered corrupted active-tools.json manifest on startup"),
            );
        }

        // Self-heal if an active managed binary disappeared (e.g. antivirus quarantine or manual delete)
        let mut manifest_changed = false;
        if let Some(ref active) = manifest.yt_dlp_active.clone() {
            if !active.binary_path.exists() {
                append_tools_log(
                    &self.layout,
                    "WARN",
                    "ACTIVE_BINARY_MISSING",
                    &format!(
                        "Active managed yt-dlp {} missing at {:?}; restoring fallback",
                        active.version, active.binary_path
                    ),
                );
                manifest.yt_dlp_active = manifest
                    .yt_dlp_rollback
                    .take()
                    .filter(|r| r.source != "bundled" && r.binary_path.exists());
                manifest_changed = true;
                let _ = store::insert_history_entry(
                    &self.db,
                    ToolId::YtDlp.as_str(),
                    "fallback",
                    Some(&active.version),
                    manifest.yt_dlp_active.as_ref().map(|s| s.version.as_str()),
                    "recovered",
                    Some("local"),
                    None,
                    None,
                    Some("Active yt-dlp binary missing on startup; fell back to verified rollback or bundled tool"),
                );
            }
        }

        if let Some(ref active) = manifest.ffmpeg_bundle_active.clone() {
            if !active.ffmpeg_path.exists() || !active.ffprobe_path.exists() {
                append_tools_log(
                    &self.layout,
                    "WARN",
                    "ACTIVE_BINARY_MISSING",
                    &format!(
                        "Active managed FFmpeg bundle {} incomplete on disk; restoring fallback",
                        active.version
                    ),
                );
                manifest.ffmpeg_bundle_active = manifest
                    .ffmpeg_bundle_rollback
                    .take()
                    .filter(|r| {
                        r.source != "bundled"
                            && r.ffmpeg_path.exists()
                            && r.ffprobe_path.exists()
                    });
                manifest_changed = true;
                let _ = store::insert_history_entry(
                    &self.db,
                    ToolId::Ffmpeg.as_str(),
                    "fallback",
                    Some(&active.version),
                    manifest
                        .ffmpeg_bundle_active
                        .as_ref()
                        .map(|s| s.version.as_str()),
                    "recovered",
                    Some("local"),
                    None,
                    None,
                    Some("Active FFmpeg/FFprobe bundle missing on startup; fell back to verified rollback or bundled tools"),
                );
            }
        }

        if manifest_changed {
            let _ = write_active_manifest_atomic(&self.layout, &manifest);
        }

        self.coordinator.set_manifest(manifest);

        // Ensure baseline rows exist for all 3 tools
        for tool in ToolId::ALL {
            if store::get_tool_record(&self.db, tool).ok().flatten().is_none() {
                let rec = ExternalToolRecord::new_default(tool);
                let _ = store::upsert_tool_record(&self.db, &rec);
            }
        }

        // Persist default policy on first run if absent
        if self.db.get_setting("external_tools_settings").ok().flatten().is_none() {
            let _ = store::save_settings(&self.db, &ExternalToolsSettings::default());
        }
    }

    /// Probes currently active binary paths & installed versions and synchronizes SQLite registry rows.
    pub fn sync_local_inventory(&self) -> Result<()> {
        let manifest = self.coordinator.snapshot_manifest();

        for tool in ToolId::ALL {
            let mut rec = store::get_tool_record(&self.db, tool)?
                .unwrap_or_else(|| ExternalToolRecord::new_default(tool));

            if let Some(resolved) = self.coordinator.resolve_tool(tool) {
                let path_str = resolved.path.to_string_lossy().to_string();
                let probed_ver = probe_tool_version(tool, &resolved.path).ok();
                let version = probed_ver
                    .or(resolved.version_hint)
                    .or_else(|| rec.installed_version.clone());

                rec.active_binary_path = Some(path_str);
                rec.source = resolved.source.to_string();
                if let Some(v) = version {
                    rec.installed_version = Some(v.clone());
                    if rec.last_successful_version.is_none() {
                        rec.last_successful_version = Some(v);
                    }
                }
                if rec.artifact_sha256.is_none() {
                    rec.artifact_sha256 = resolved
                        .sha256_hint
                        .or_else(|| compute_file_sha256(&resolved.path).ok());
                }
            } else {
                rec.active_binary_path = None;
                rec.installed_version = None;
                rec.source = "missing".to_string();
            }

            // Sync rollback & pending pointers from active-tools.json
            match tool {
                ToolId::YtDlp => {
                    if let Some(ref rb) = manifest.yt_dlp_rollback {
                        let rb_valid = rb.binary_path.exists();
                        rec.rollback_available = rb_valid;
                        rec.rollback_version = rb_valid.then(|| rb.version.clone());
                        rec.rollback_binary_path = rb_valid
                            .then(|| rb.binary_path.to_string_lossy().to_string());
                    } else {
                        rec.rollback_available = false;
                        rec.rollback_version = None;
                        rec.rollback_binary_path = None;
                    }
                    if let Some(ref pend) = manifest.yt_dlp_pending {
                        rec.pending_version = Some(pend.version.clone());
                        rec.pending_binary_path =
                            Some(pend.binary_path.to_string_lossy().to_string());
                        rec.update_status = ToolUpdateStatus::PendingActivation;
                    } else {
                        rec.pending_version = None;
                        rec.pending_binary_path = None;
                    }
                }
                ToolId::Ffmpeg | ToolId::Ffprobe => {
                    if let Some(ref rb) = manifest.ffmpeg_bundle_rollback {
                        let rb_valid = rb.ffmpeg_path.exists() && rb.ffprobe_path.exists();
                        rec.rollback_available = rb_valid;
                        rec.rollback_version = rb_valid.then(|| match tool {
                            ToolId::Ffmpeg => rb.ffmpeg_version.clone(),
                            ToolId::Ffprobe => rb.ffprobe_version.clone(),
                            ToolId::YtDlp => unreachable!(),
                        });
                        rec.rollback_binary_path = rb_valid.then(|| match tool {
                            ToolId::Ffmpeg => rb.ffmpeg_path.to_string_lossy().to_string(),
                            ToolId::Ffprobe => rb.ffprobe_path.to_string_lossy().to_string(),
                            ToolId::YtDlp => unreachable!(),
                        });
                    } else {
                        rec.rollback_available = false;
                        rec.rollback_version = None;
                        rec.rollback_binary_path = None;
                    }
                    if let Some(ref pend) = manifest.ffmpeg_bundle_pending {
                        rec.pending_version = Some(match tool {
                            ToolId::Ffmpeg => pend.ffmpeg_version.clone(),
                            ToolId::Ffprobe => pend.ffprobe_version.clone(),
                            ToolId::YtDlp => unreachable!(),
                        });
                        rec.pending_binary_path = Some(match tool {
                            ToolId::Ffmpeg => pend.ffmpeg_path.to_string_lossy().to_string(),
                            ToolId::Ffprobe => pend.ffprobe_path.to_string_lossy().to_string(),
                            ToolId::YtDlp => unreachable!(),
                        });
                        rec.update_status = ToolUpdateStatus::PendingActivation;
                    } else {
                        rec.pending_version = None;
                        rec.pending_binary_path = None;
                    }
                }
            }

            // Clean transient in-flight statuses if left over from an abrupt termination
            if matches!(
                rec.update_status,
                ToolUpdateStatus::Checking
                    | ToolUpdateStatus::Downloading
                    | ToolUpdateStatus::Verifying
                    | ToolUpdateStatus::Testing
                    | ToolUpdateStatus::Installing
            ) {
                rec.update_status = if rec.pending_version.is_some() {
                    ToolUpdateStatus::PendingActivation
                } else {
                    ToolUpdateStatus::UpToDate
                };
            }

            store::upsert_tool_record(&self.db, &rec)?;
        }

        self.inventory_initialized.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub fn ensure_inventory_synced(&self) {
        if !self.inventory_initialized.load(Ordering::SeqCst) {
            let _ = self.sync_local_inventory();
        }
    }

    pub fn get_settings(&self) -> ExternalToolsSettings {
        store::load_settings(&self.db)
    }

    pub fn save_settings(&self, settings: &ExternalToolsSettings) -> Result<ExternalToolsSettings> {
        let saved = store::save_settings(&self.db, settings)?;
        append_tools_log(
            &self.layout,
            "INFO",
            "SETTINGS_SAVED",
            &format!(
                "auto_update={}, interval_hours={}, auto_install={}, notify={}, defer_in_use={}",
                saved.auto_update,
                saved.check_interval_hours,
                saved.auto_install,
                saved.notify_on_update,
                saved.defer_while_in_use
            ),
        );
        self.emit_status_changed();
        Ok(saved)
    }

    pub fn get_status_snapshot(&self) -> Result<ExternalToolsSnapshot> {
        self.ensure_inventory_synced();
        let tools = store::list_tool_records(&self.db)?;
        let settings = self.get_settings();
        let scheduler = store::load_scheduler_state(&self.db);
        Ok(ExternalToolsSnapshot {
            tools,
            settings,
            scheduler,
            checking: self.check_in_flight.load(Ordering::SeqCst),
            active_yt_dlp_leases: self.coordinator.active_leases(ToolId::YtDlp),
            active_ffmpeg_leases: self.coordinator.active_leases(ToolId::Ffmpeg),
            active_ffprobe_leases: self.coordinator.active_leases(ToolId::Ffprobe),
        })
    }

    pub fn get_update_history(&self, limit: usize) -> Result<Vec<ExternalToolHistoryEntry>> {
        store::list_history_entries(&self.db, limit)
    }

    pub fn get_tool_location(&self, tool_id: ToolId) -> Option<PathBuf> {
        self.coordinator.resolve_tool(tool_id).map(|r| r.path)
    }

    fn set_bundle_status(
        &self,
        bundle: ToolBundleId,
        status: ToolUpdateStatus,
        last_error: Option<String>,
    ) {
        for &tool in bundle.tools() {
            if let Ok(Some(mut rec)) = store::get_tool_record(&self.db, tool) {
                rec.update_status = status;
                rec.last_error = last_error.clone();
                let _ = store::upsert_tool_record(&self.db, &rec);
            }
        }
        self.emit_status_changed();
    }

    /// Evaluates whether a scheduled background check is due right now (using UTC timestamps,
    /// clock-skew protection, and bounded exponential backoff).
    pub fn is_scheduled_check_due(&self, now: DateTime<Utc>) -> bool {
        let settings = self.get_settings();
        if !settings.background_checks_enabled() {
            return false;
        }
        let sched = store::load_scheduler_state(&self.db);

        // Respect active backoff window (unless clock was set backwards significantly)
        if let Some(retry_after) = sched.next_retry_after {
            if retry_after > now && (retry_after - now) <= ChronoDuration::hours(48) {
                return false;
            }
        }

        let Some(last_ok) = sched.last_successful_check_at else {
            return true;
        };

        // Clock skew guard: if persisted timestamp is far in the future, reset check eligibility
        if last_ok > now + ChronoDuration::minutes(5) {
            return true;
        }

        let interval = ChronoDuration::hours(settings.check_interval_hours as i64);
        now >= last_ok + interval
    }

    fn compute_backoff_secs(consecutive_failures: u32) -> i64 {
        match consecutive_failures {
            0 | 1 => 15 * 60,        // 15 minutes
            2 => 60 * 60,            // 1 hour
            3 => 4 * 60 * 60,        // 4 hours
            4 => 12 * 60 * 60,       // 12 hours
            _ => 24 * 60 * 60,       // 24 hours max
        }
    }

    /// Checks upstream sources for `yt-dlp`, `FFmpeg`, and `FFprobe`.
    /// When `manual == false` (background check) and `settings.auto_update && settings.auto_install`,
    /// automatically downloads, verifies, tests, and installs trusted newer versions!
    pub async fn check_for_updates(&self, manual: bool) -> Result<ExternalToolsSnapshot> {
        // Prevent duplicate concurrent checks
        if self
            .check_in_flight
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            append_tools_log(
                &self.layout,
                "INFO",
                "CHECK_DEDUP",
                "Skipped duplicate concurrent external-tools update check",
            );
            return self.get_status_snapshot();
        }
        let _guard = CheckGuard(&self.check_in_flight);

        self.ensure_inventory_synced();

        // First try activating any deferred pending updates if tools became idle
        let _ = self.try_activate_pending_updates().await;

        append_tools_log(
            &self.layout,
            "INFO",
            "CHECK_START",
            &format!("Starting external-tools update check (manual={})", manual),
        );

        let now = Utc::now();
        let mut sched = store::load_scheduler_state(&self.db);
        sched.last_attempt_at = Some(now);

        for bundle in [ToolBundleId::YtDlp, ToolBundleId::FfmpegBundle] {
            // Preserve PendingActivation indicator if already staged and waiting
            let is_pending = bundle.tools().iter().any(|t| {
                store::get_tool_record(&self.db, *t)
                    .ok()
                    .flatten()
                    .map(|r| r.update_status == ToolUpdateStatus::PendingActivation)
                    .unwrap_or(false)
            });
            if !is_pending {
                self.set_bundle_status(bundle, ToolUpdateStatus::Checking, None);
            }
        }

        // 1. Optional TORI Ed25519-signed manifest check
        let signed_manifest = match fetch_signed_tools_manifest(&self.config).await {
            Ok(m) => m,
            Err(e) => {
                append_tools_log(
                    &self.layout,
                    "WARN",
                    "SIGNED_MANIFEST_ERR",
                    &format!("Signed tools manifest check failed: {}", e),
                );
                None
            }
        };

        let mut any_network_failure = false;
        let mut max_retry_after: Option<i64> = None;
        let mut last_check_err: Option<String> = None;
        let mut auto_install_targets: Vec<ToolBundleId> = Vec::new();

        // 2. Check yt-dlp
        match fetch_ytdlp_candidate(&self.config, signed_manifest.as_ref()).await {
            Ok(candidate) => {
                let should_auto = self.apply_candidate_discovery(
                    ToolBundleId::YtDlp,
                    candidate,
                    now,
                    manual,
                )?;
                if should_auto {
                    auto_install_targets.push(ToolBundleId::YtDlp);
                }
            }
            Err(err) => {
                self.handle_provider_check_error(
                    ToolBundleId::YtDlp,
                    &err,
                    now,
                    &mut any_network_failure,
                    &mut max_retry_after,
                    &mut last_check_err,
                );
            }
        }

        // 3. Check FFmpeg + FFprobe bundle
        match fetch_ffmpeg_bundle_candidate(&self.config, signed_manifest.as_ref()).await {
            Ok(candidate) => {
                let should_auto = self.apply_candidate_discovery(
                    ToolBundleId::FfmpegBundle,
                    candidate,
                    now,
                    manual,
                )?;
                if should_auto {
                    auto_install_targets.push(ToolBundleId::FfmpegBundle);
                }
            }
            Err(err) => {
                self.handle_provider_check_error(
                    ToolBundleId::FfmpegBundle,
                    &err,
                    now,
                    &mut any_network_failure,
                    &mut max_retry_after,
                    &mut last_check_err,
                );
            }
        }

        if any_network_failure {
            sched.consecutive_failures = sched.consecutive_failures.saturating_add(1);
            let backoff = Self::compute_backoff_secs(sched.consecutive_failures);
            let wait_secs = max_retry_after.unwrap_or(backoff).max(backoff);
            sched.next_retry_after = Some(now + ChronoDuration::seconds(wait_secs));
            sched.last_error = last_check_err;
        } else {
            sched.last_successful_check_at = Some(now);
            sched.consecutive_failures = 0;
            sched.next_retry_after = None;
            sched.last_error = None;
        }
        let _ = store::save_scheduler_state(&self.db, &sched);
        self.emit_status_changed();

        // Release check_in_flight before performing potentially long downloads/installs
        drop(_guard);

        // 4. Perform automatic install if policy allows (never on manual check unless user clicks Update Now,
        //    OR background automatic check with auto_update + auto_install enabled!)
        let settings = self.get_settings();
        if !manual && settings.auto_update && settings.auto_install {
            for bundle in auto_install_targets {
                let primary_tool = bundle.tools()[0];
                if let Err(e) = self.update_tool_internal(primary_tool, false).await {
                    append_tools_log(
                        &self.layout,
                        "ERROR",
                        "AUTO_INSTALL_FAILED",
                        &format!("{}: {}", bundle.display_name(), e),
                    );
                }
            }
        }

        self.get_status_snapshot()
    }

    fn handle_provider_check_error(
        &self,
        bundle: ToolBundleId,
        err: &ProviderFetchError,
        now: DateTime<Utc>,
        any_network_failure: &mut bool,
        max_retry_after: &mut Option<i64>,
        last_check_err: &mut Option<String>,
    ) {
        let msg = err.to_string();
        append_tools_log(
            &self.layout,
            "WARN",
            "CHECK_ERROR",
            &format!("{}: {}", bundle.display_name(), msg),
        );

        let status = match err {
            ProviderFetchError::Untrusted(_) => ToolUpdateStatus::SourceUntrusted,
            ProviderFetchError::RateLimited { retry_after_secs, .. } => {
                *any_network_failure = true;
                *max_retry_after =
                    Some(max_retry_after.unwrap_or(0).max(*retry_after_secs as i64));
                *last_check_err = Some(msg.clone());
                ToolUpdateStatus::UpdateFailed
            }
            ProviderFetchError::Network(_) | ProviderFetchError::Other(_) => {
                *any_network_failure = true;
                *last_check_err = Some(msg.clone());
                ToolUpdateStatus::UpdateFailed
            }
        };

        for &tool in bundle.tools() {
            if let Ok(Some(mut rec)) = store::get_tool_record(&self.db, tool) {
                rec.last_checked_at = Some(now);
                // Keep installed tool completely usable; only annotate check status
                if rec.update_status != ToolUpdateStatus::PendingActivation {
                    rec.update_status = status;
                }
                rec.last_error = Some(msg.clone());
                let _ = store::upsert_tool_record(&self.db, &rec);
            }
        }
    }

    fn apply_candidate_discovery(
        &self,
        bundle: ToolBundleId,
        candidate: UpdateCandidate,
        now: DateTime<Utc>,
        manual: bool,
    ) -> Result<bool> {
        {
            let mut cache = self.last_candidates.lock().unwrap();
            cache.insert(bundle, candidate.clone());
        }

        let primary_tool = bundle.tools()[0];
        let rec = store::get_tool_record(&self.db, primary_tool)?
            .unwrap_or_else(|| ExternalToolRecord::new_default(primary_tool));

        let comparison = match rec.installed_version.as_deref() {
            Some(inst) if !inst.trim().is_empty() => {
                compare_tool_versions(primary_tool, inst, &candidate.version)
            }
            _ => VersionComparison::Newer,
        };

        let mut should_auto_install = false;

        match comparison {
            VersionComparison::Equal | VersionComparison::Older => {
                // Already up to date (or installed version is newer — reject downgrades!)
                for &tool in bundle.tools() {
                    let mut r = store::get_tool_record(&self.db, tool)?
                        .unwrap_or_else(|| ExternalToolRecord::new_default(tool));
                    r.available_version = Some(candidate.version.clone());
                    r.last_checked_at = Some(now);
                    r.last_error = None;
                    if r.update_status != ToolUpdateStatus::PendingActivation {
                        r.update_status = ToolUpdateStatus::UpToDate;
                    }
                    store::upsert_tool_record(&self.db, &r)?;
                }
                // Never emit desktop notification when up to date!
            }
            VersionComparison::Newer | VersionComparison::Unknown => {
                let is_quarantined = !manual && rec.failed_versions.contains(&candidate.version);

                if !candidate.trust_level.allows_automatic_install() {
                    let reason = candidate.untrusted_reason.clone().unwrap_or_else(|| {
                        "Update source lacks cryptographic publisher authenticity verification."
                            .to_string()
                    });
                    for &tool in bundle.tools() {
                        let mut r = store::get_tool_record(&self.db, tool)?
                            .unwrap_or_else(|| ExternalToolRecord::new_default(tool));
                        r.available_version = Some(candidate.version.clone());
                        r.last_checked_at = Some(now);
                        r.update_status = ToolUpdateStatus::SourceUntrusted;
                        r.last_error = Some(reason.clone());
                        store::upsert_tool_record(&self.db, &r)?;
                    }

                    // Notify once per detected untrusted upstream version
                    let key = format!("{}:{}", bundle.as_str(), candidate.version);
                    let newly_seen = {
                        let mut seen = self.notified_untrusted_versions.lock().unwrap();
                        seen.insert(key)
                    };
                    if newly_seen {
                        let _ = store::insert_history_entry(
                            &self.db,
                            primary_tool.as_str(),
                            "check",
                            rec.installed_version.as_deref(),
                            Some(&candidate.version),
                            "source_untrusted",
                            Some(&candidate.source_name),
                            candidate.expected_sha256.as_deref(),
                            Some(candidate.trust_level.as_str()),
                            Some(&reason),
                        );
                        self.emit_notification(
                            ToolNotificationKind::ToolOperatorActionRequired,
                            primary_tool,
                            format!("{} Update Requires Signed Source", bundle.display_name()),
                            format!(
                                "Version {} found on {}, but automatic installation is blocked because no cryptographic signature is available.",
                                candidate.version, candidate.source_name
                            ),
                            Some(candidate.version.clone()),
                        );
                    }
                } else if is_quarantined {
                    let msg = format!(
                        "Skipping automatic reinstall of previously failed version {}",
                        candidate.version
                    );
                    append_tools_log(&self.layout, "WARN", "QUARANTINED_SKIP", &msg);
                    for &tool in bundle.tools() {
                        let mut r = store::get_tool_record(&self.db, tool)?
                            .unwrap_or_else(|| ExternalToolRecord::new_default(tool));
                        r.available_version = Some(candidate.version.clone());
                        r.last_checked_at = Some(now);
                        r.update_status = ToolUpdateStatus::UpdateAvailable;
                        r.last_error = Some(msg.clone());
                        store::upsert_tool_record(&self.db, &r)?;
                    }
                } else {
                    for &tool in bundle.tools() {
                        let mut r = store::get_tool_record(&self.db, tool)?
                            .unwrap_or_else(|| ExternalToolRecord::new_default(tool));
                        r.available_version = Some(candidate.version.clone());
                        r.last_checked_at = Some(now);
                        r.last_error = None;
                        if r.update_status != ToolUpdateStatus::PendingActivation {
                            r.update_status = ToolUpdateStatus::UpdateAvailable;
                        }
                        store::upsert_tool_record(&self.db, &r)?;
                    }
                    should_auto_install = true;
                }
            }
        }

        Ok(should_auto_install)
    }

    /// Manually updates a specific tool (updating FFmpeg/FFprobe together atomically).
    pub async fn update_tool(&self, tool_id: ToolId) -> Result<ExternalToolsSnapshot> {
        self.update_tool_internal(tool_id, true).await?;
        self.get_status_snapshot()
    }

    /// Manually updates all trusted tools that have a newer version available.
    pub async fn update_all_tools(&self) -> Result<ExternalToolsSnapshot> {
        // Ensure we have fresh candidate metadata first
        let _ = self.check_for_updates(true).await?;
        for bundle in [ToolBundleId::YtDlp, ToolBundleId::FfmpegBundle] {
            let primary = bundle.tools()[0];
            if let Ok(Some(rec)) = store::get_tool_record(&self.db, primary) {
                if matches!(
                    rec.update_status,
                    ToolUpdateStatus::UpdateAvailable
                        | ToolUpdateStatus::UpdateFailed
                        | ToolUpdateStatus::PendingActivation
                ) {
                    let _ = self.update_tool_internal(primary, true).await;
                }
            }
        }
        self.get_status_snapshot()
    }

    async fn update_tool_internal(&self, tool_id: ToolId, manual: bool) -> Result<()> {
        let bundle = tool_id.bundle_id();
        let _bundle_guard = match bundle {
            ToolBundleId::YtDlp => self.ytdlp_lock.lock().await,
            ToolBundleId::FfmpegBundle => self.ffmpeg_lock.lock().await,
        };

        self.ensure_inventory_synced();

        // If a verified update is already pending activation, try promoting it immediately!
        if self.has_pending_bundle(bundle) {
            if self.try_activate_pending_bundle(bundle).await? {
                return Ok(());
            }
            return Ok(());
        }

        // Obtain candidate from cache or fetch fresh
        let candidate = {
            let cached = self.last_candidates.lock().unwrap().get(&bundle).cloned();
            match cached {
                Some(c) => c,
                None => {
                    let signed = fetch_signed_tools_manifest(&self.config).await.ok().flatten();
                    match bundle {
                        ToolBundleId::YtDlp => {
                            fetch_ytdlp_candidate(&self.config, signed.as_ref()).await
                        }
                        ToolBundleId::FfmpegBundle => {
                            fetch_ffmpeg_bundle_candidate(&self.config, signed.as_ref()).await
                        }
                    }
                    .map_err(|e| EngineError::Other(e.to_string()))?
                }
            }
        };

        let primary_tool = bundle.tools()[0];
        let current_rec = store::get_tool_record(&self.db, primary_tool)?
            .unwrap_or_else(|| ExternalToolRecord::new_default(primary_tool));

        // 1. Enforce cryptographic trust verification BEFORE downloading any executable
        if !candidate.trust_level.allows_automatic_install() {
            let reason = candidate.untrusted_reason.clone().unwrap_or_else(|| {
                "Blocked untrusted external tool update: cryptographic signature missing or invalid"
                    .to_string()
            });
            self.set_bundle_status(bundle, ToolUpdateStatus::SourceUntrusted, Some(reason.clone()));
            let _ = store::insert_history_entry(
                &self.db,
                primary_tool.as_str(),
                "update",
                current_rec.installed_version.as_deref(),
                Some(&candidate.version),
                "blocked_untrusted",
                Some(&candidate.source_name),
                candidate.expected_sha256.as_deref(),
                Some(candidate.trust_level.as_str()),
                Some(&reason),
            );
            return Err(EngineError::Other(reason));
        }

        // 2. Reject downgrades or redundant installs
        if let Some(ref installed) = current_rec.installed_version {
            match compare_tool_versions(primary_tool, installed, &candidate.version) {
                VersionComparison::Equal => {
                    self.set_bundle_status(bundle, ToolUpdateStatus::UpToDate, None);
                    return Ok(());
                }
                VersionComparison::Older => {
                    let msg = format!(
                        "Rejected downgrade for {}: installed '{}' is newer than candidate '{}'",
                        bundle.display_name(),
                        installed,
                        candidate.version
                    );
                    append_tools_log(&self.layout, "WARN", "DOWNGRADE_REJECTED", &msg);
                    self.set_bundle_status(bundle, ToolUpdateStatus::UpToDate, None);
                    return Err(EngineError::Other(msg));
                }
                VersionComparison::Newer | VersionComparison::Unknown => {}
            }
        }

        let expected_sha = candidate.expected_sha256.clone().ok_or_else(|| {
            EngineError::Other("Trusted update candidate missing required SHA-256 digest".to_string())
        })?;

        // Manual retry clears quarantine entry for this version
        if manual && current_rec.failed_versions.contains(&candidate.version) {
            for &t in bundle.tools() {
                if let Ok(Some(mut r)) = store::get_tool_record(&self.db, t) {
                    r.failed_versions.retain(|v| v != &candidate.version);
                    let _ = store::upsert_tool_record(&self.db, &r);
                }
            }
        }

        // Create isolated staging directory for this transaction
        let tx_dir = self
            .layout
            .staging
            .join(format!("{}_{}", bundle.as_str(), uuid::Uuid::new_v4()));
        fs::create_dir_all(&tx_dir)?;

        let result = self
            .execute_staged_bundle_update(bundle, &candidate, &expected_sha, &tx_dir, &current_rec)
            .await;

        let _ = fs::remove_dir_all(&tx_dir);

        if let Err(ref e) = result {
            let err_msg = e.to_string();
            append_tools_log(
                &self.layout,
                "ERROR",
                "UPDATE_FAILED",
                &format!("{} -> {}: {}", bundle.display_name(), candidate.version, err_msg),
            );
            for &t in bundle.tools() {
                if let Ok(Some(mut r)) = store::get_tool_record(&self.db, t) {
                    if r.update_status != ToolUpdateStatus::RolledBack
                        && r.update_status != ToolUpdateStatus::SourceUntrusted
                    {
                        r.update_status = ToolUpdateStatus::UpdateFailed;
                    }
                    r.last_error = Some(err_msg.clone());
                    let _ = store::upsert_tool_record(&self.db, &r);
                }
            }
            let _ = store::insert_history_entry(
                &self.db,
                primary_tool.as_str(),
                "update",
                current_rec.installed_version.as_deref(),
                Some(&candidate.version),
                "failed",
                Some(&candidate.source_name),
                Some(&expected_sha),
                Some(candidate.trust_level.as_str()),
                Some(&err_msg),
            );
            self.emit_status_changed();
            self.emit_notification(
                ToolNotificationKind::ToolUpdateFailed,
                primary_tool,
                format!("{} Update Failed", bundle.display_name()),
                err_msg.clone(),
                Some(candidate.version.clone()),
            );
        }

        result
    }

    async fn execute_staged_bundle_update(
        &self,
        bundle: ToolBundleId,
        candidate: &UpdateCandidate,
        expected_sha: &str,
        tx_dir: &Path,
        current_rec: &ExternalToolRecord,
    ) -> Result<()> {
        let primary_tool = bundle.tools()[0];

        // Stage 1: Download into isolated staging directory
        self.set_bundle_status(bundle, ToolUpdateStatus::Downloading, None);
        self.emit_progress(ToolProgressEvent {
            tool_id: primary_tool,
            status: ToolUpdateStatus::Downloading,
            stage: "Downloading verified artifact".to_string(),
            downloaded_bytes: 0,
            total_bytes: candidate.expected_size,
            speed_bps: 0,
            message: Some(format!("Downloading {} {}", bundle.display_name(), candidate.version)),
        });

        let staged_file_name = match candidate.artifact_kind {
            ArtifactKind::SingleExe => ToolId::YtDlp.exe_name(),
            ArtifactKind::FfmpegZip => "ffmpeg-bundle.zip",
        };
        let staged_download_path = tx_dir.join(staged_file_name);
        let max_bytes = match bundle {
            ToolBundleId::YtDlp => self.config.max_ytdlp_bytes,
            ToolBundleId::FfmpegBundle => self.config.max_ffmpeg_zip_bytes,
        };

        let downloaded = download_artifact_to_staging(
            &candidate.download_url,
            &staged_download_path,
            expected_sha,
            max_bytes,
            self.config.download_timeout_secs,
            self.config.allow_loopback_http,
            |dl, total, speed| {
                self.emit_progress(ToolProgressEvent {
                    tool_id: primary_tool,
                    status: ToolUpdateStatus::Downloading,
                    stage: "Downloading".to_string(),
                    downloaded_bytes: dl,
                    total_bytes: total,
                    speed_bps: speed,
                    message: None,
                });
            },
        )
        .await?;

        // Stage 2: Verifying & extracting
        self.set_bundle_status(bundle, ToolUpdateStatus::Verifying, None);
        self.emit_progress(ToolProgressEvent {
            tool_id: primary_tool,
            status: ToolUpdateStatus::Verifying,
            stage: "Verifying integrity & signature".to_string(),
            downloaded_bytes: downloaded.size_bytes,
            total_bytes: Some(downloaded.size_bytes),
            speed_bps: 0,
            message: Some("Verified SHA-256 and cryptographic publisher signature".to_string()),
        });

        let safe_ver_dir = sanitize_version_dir_name(&candidate.version)?;

        match bundle {
            ToolBundleId::YtDlp => {
                // Stage 3: Testing pre-activation compatibility & health
                self.set_bundle_status(bundle, ToolUpdateStatus::Testing, None);
                self.emit_progress(ToolProgressEvent {
                    tool_id: ToolId::YtDlp,
                    status: ToolUpdateStatus::Testing,
                    stage: "Running yt-dlp compatibility checks".to_string(),
                    downloaded_bytes: downloaded.size_bytes,
                    total_bytes: Some(downloaded.size_bytes),
                    speed_bps: 0,
                    message: None,
                });

                let staged_exe = downloaded.path.clone();
                let expected_ver = candidate.version.clone();
                let health = tokio::task::spawn_blocking(move || {
                    verify_staged_ytdlp(&staged_exe, Some(&expected_ver))
                })
                .await
                .map_err(|e| EngineError::Other(format!("Health check task failed: {}", e)))??;

                // Copy verified executable to immutable versioned directory
                let version_dir = self.layout.versions_ytdlp.join(&safe_ver_dir);
                let final_exe = version_dir.join(ToolId::YtDlp.exe_name());
                copy_file_atomic(&downloaded.path, &final_exe)?;

                let new_slot = ManagedBinarySlot {
                    version: health.detected_version.clone(),
                    binary_path: final_exe.clone(),
                    sha256: Some(downloaded.sha256.clone()),
                    source: candidate.source_name.clone(),
                    activated_at: Utc::now(),
                };

                self.commit_or_defer_ytdlp(new_slot, candidate, current_rec)
                    .await?;
            }
            ToolBundleId::FfmpegBundle => {
                let extract_dir = tx_dir.join("extracted");
                let zip_path = downloaded.path.clone();
                let max_extracted = self.config.max_extracted_bundle_bytes;
                let extracted = tokio::task::spawn_blocking(move || {
                    extract_ffmpeg_bundle_zip(&zip_path, &extract_dir, max_extracted)
                })
                .await
                .map_err(|e| EngineError::Other(format!("ZIP extraction task failed: {}", e)))??;

                // Stage 3: Full FFmpeg + FFprobe pair compatibility & live self-test
                self.set_bundle_status(bundle, ToolUpdateStatus::Testing, None);
                self.emit_progress(ToolProgressEvent {
                    tool_id: ToolId::Ffmpeg,
                    status: ToolUpdateStatus::Testing,
                    stage: "Testing FFmpeg & FFprobe media pipeline".to_string(),
                    downloaded_bytes: downloaded.size_bytes,
                    total_bytes: Some(downloaded.size_bytes),
                    speed_bps: 0,
                    message: None,
                });

                let ff_path = extracted.ffmpeg_path.clone();
                let fp_path = extracted.ffprobe_path.clone();
                let scratch = tx_dir.join("health_scratch");
                let health = tokio::task::spawn_blocking(move || {
                    verify_staged_ffmpeg_bundle(&ff_path, &fp_path, &scratch)
                })
                .await
                .map_err(|e| EngineError::Other(format!("FFmpeg health task failed: {}", e)))??;

                // Copy BOTH binaries into one immutable versioned bundle directory
                let version_dir = self.layout.versions_ffmpeg.join(&safe_ver_dir);
                let final_ffmpeg = version_dir.join(ToolId::Ffmpeg.exe_name());
                let final_ffprobe = version_dir.join(ToolId::Ffprobe.exe_name());
                copy_file_atomic(&extracted.ffmpeg_path, &final_ffmpeg)?;
                copy_file_atomic(&extracted.ffprobe_path, &final_ffprobe)?;

                let new_slot = ManagedFfmpegBundleSlot {
                    version: candidate.version.clone(),
                    ffmpeg_version: health.ffmpeg_version,
                    ffprobe_version: health.ffprobe_version,
                    ffmpeg_path: final_ffmpeg,
                    ffprobe_path: final_ffprobe,
                    sha256: Some(downloaded.sha256.clone()),
                    source: candidate.source_name.clone(),
                    activated_at: Utc::now(),
                };

                self.commit_or_defer_ffmpeg_bundle(new_slot, candidate, current_rec)
                    .await?;
            }
        }

        Ok(())
    }

    async fn commit_or_defer_ytdlp(
        &self,
        new_slot: ManagedBinarySlot,
        candidate: &UpdateCandidate,
        current_rec: &ExternalToolRecord,
    ) -> Result<()> {
        let settings = self.get_settings();
        let prev_manifest = self.coordinator.snapshot_manifest();
        let previous_slot_for_rollback = prev_manifest.yt_dlp_active.clone().or_else(|| {
            current_rec.active_binary_path.as_ref().map(|p| ManagedBinarySlot {
                version: current_rec
                    .installed_version
                    .clone()
                    .unwrap_or_else(|| "bundled".to_string()),
                binary_path: PathBuf::from(p),
                sha256: current_rec.artifact_sha256.clone(),
                source: "bundled".to_string(),
                activated_at: Utc::now(),
            })
        });

        let extra_busy = self.is_bundle_busy_by_jobs(ToolBundleId::YtDlp);
        self.set_bundle_status(ToolBundleId::YtDlp, ToolUpdateStatus::Installing, None);

        let activated = self.coordinator.try_commit_manifest_if_idle(
            ToolBundleId::YtDlp,
            settings.defer_while_in_use,
            extra_busy,
            &self.layout,
            |m| {
                m.yt_dlp_rollback = previous_slot_for_rollback.clone();
                m.yt_dlp_active = Some(new_slot.clone());
                m.yt_dlp_pending = None;
            },
        )?;

        if !activated {
            // Active tool usage detected: defer cleanly without interrupting transfers!
            self.coordinator
                .update_manifest_metadata(&self.layout, |m| {
                    m.yt_dlp_pending = Some(new_slot.clone());
                })?;

            if let Ok(Some(mut rec)) = store::get_tool_record(&self.db, ToolId::YtDlp) {
                rec.pending_version = Some(new_slot.version.clone());
                rec.pending_binary_path =
                    Some(new_slot.binary_path.to_string_lossy().to_string());
                rec.update_status = ToolUpdateStatus::PendingActivation;
                rec.last_error = Some(
                    "yt-dlp is currently in use; verified update will activate automatically when idle."
                        .to_string(),
                );
                let _ = store::upsert_tool_record(&self.db, &rec);
            }
            let _ = store::insert_history_entry(
                &self.db,
                ToolId::YtDlp.as_str(),
                "deferred",
                current_rec.installed_version.as_deref(),
                Some(&new_slot.version),
                "pending_activation",
                Some(&candidate.source_name),
                new_slot.sha256.as_deref(),
                Some(candidate.trust_level.as_str()),
                Some("Deferred yt-dlp activation while active download or extraction is running"),
            );
            append_tools_log(
                &self.layout,
                "INFO",
                "DEFERRED_IN_USE",
                &format!("Deferred yt-dlp {} activation while tool is active", new_slot.version),
            );
            self.emit_status_changed();
            self.emit_notification(
                ToolNotificationKind::ToolUpdatePostponed,
                ToolId::YtDlp,
                "yt-dlp Update Postponed",
                format!(
                    "yt-dlp {} is verified and ready. It will activate automatically once active downloads finish.",
                    new_slot.version
                ),
                Some(new_slot.version.clone()),
            );
            return Ok(());
        }

        // Post-switch verification on the newly activated path
        let post_switch_ok = if self.fail_post_switch_once.swap(false, Ordering::SeqCst) {
            Err(EngineError::Other(
                "Simulated post-switch health verification failure".to_string(),
            ))
        } else if let Some(resolved) = self.coordinator.resolve_tool(ToolId::YtDlp) {
            let p = resolved.path.clone();
            let v = new_slot.version.clone();
            tokio::task::spawn_blocking(move || verify_staged_ytdlp(&p, Some(&v)))
                .await
                .map_err(|e| EngineError::Other(e.to_string()))
                .and_then(|r| r.map(|_| ()))
        } else {
            Err(EngineError::Other(
                "Active yt-dlp binary could not be resolved after activation".to_string(),
            ))
        };

        if let Err(err) = post_switch_ok {
            // Immediate automatic rollback + quarantine failed version
            self.coordinator
                .update_manifest_metadata(&self.layout, |m| {
                    *m = prev_manifest.clone();
                })?;

            if let Ok(Some(mut rec)) = store::get_tool_record(&self.db, ToolId::YtDlp) {
                rec.update_status = ToolUpdateStatus::RolledBack;
                rec.last_error = Some(format!(
                    "Post-activation verification failed ({}); rolled back automatically.",
                    err
                ));
                if !rec.failed_versions.contains(&new_slot.version) {
                    rec.failed_versions.push(new_slot.version.clone());
                }
                let _ = store::upsert_tool_record(&self.db, &rec);
            }
            let _ = store::insert_history_entry(
                &self.db,
                ToolId::YtDlp.as_str(),
                "auto_rollback",
                Some(&new_slot.version),
                current_rec.installed_version.as_deref(),
                "rolled_back",
                Some(&candidate.source_name),
                new_slot.sha256.as_deref(),
                Some(candidate.trust_level.as_str()),
                Some(&format!("Automatic rollback after post-switch failure: {}", err)),
            );
            self.emit_status_changed();
            self.emit_notification(
                ToolNotificationKind::ToolRolledBack,
                ToolId::YtDlp,
                "yt-dlp Rolled Back",
                format!(
                    "yt-dlp {} failed post-activation verification and was rolled back safely.",
                    new_slot.version
                ),
                current_rec.installed_version.clone(),
            );
            return Err(err);
        }

        // Update registry & prune obsolete old versions
        let now = Utc::now();
        let mut rec = store::get_tool_record(&self.db, ToolId::YtDlp)?
            .unwrap_or_else(|| ExternalToolRecord::new_default(ToolId::YtDlp));
        rec.installed_version = Some(new_slot.version.clone());
        rec.available_version = Some(new_slot.version.clone());
        rec.active_binary_path = Some(new_slot.binary_path.to_string_lossy().to_string());
        rec.source = "managed".to_string();
        rec.artifact_sha256 = new_slot.sha256.clone();
        rec.installed_at = Some(now);
        rec.last_updated_at = Some(now);
        rec.last_successful_version = Some(new_slot.version.clone());
        rec.update_status = ToolUpdateStatus::Updated;
        rec.last_error = None;
        rec.pending_version = None;
        rec.pending_binary_path = None;
        if let Some(ref rb) = previous_slot_for_rollback {
            rec.rollback_available = rb.binary_path.exists();
            rec.rollback_version = Some(rb.version.clone());
            rec.rollback_binary_path = Some(rb.binary_path.to_string_lossy().to_string());
        }
        store::upsert_tool_record(&self.db, &rec)?;

        let _ = store::insert_history_entry(
            &self.db,
            ToolId::YtDlp.as_str(),
            "update",
            current_rec.installed_version.as_deref(),
            Some(&new_slot.version),
            "updated",
            Some(&candidate.source_name),
            new_slot.sha256.as_deref(),
            Some(candidate.trust_level.as_str()),
            Some(&format!("Successfully updated yt-dlp to {}", new_slot.version)),
        );

        self.prune_old_tool_versions();
        append_tools_log(
            &self.layout,
            "INFO",
            "ACTIVATED",
            &format!("Activated yt-dlp {} at {:?}", new_slot.version, new_slot.binary_path),
        );
        self.emit_status_changed();
        self.emit_notification(
            ToolNotificationKind::ToolUpdatedYtDlp,
            ToolId::YtDlp,
            "yt-dlp Updated",
            format!("yt-dlp has been updated to version {}.", new_slot.version),
            Some(new_slot.version),
        );

        Ok(())
    }

    async fn commit_or_defer_ffmpeg_bundle(
        &self,
        new_slot: ManagedFfmpegBundleSlot,
        candidate: &UpdateCandidate,
        current_rec: &ExternalToolRecord,
    ) -> Result<()> {
        let settings = self.get_settings();
        let prev_manifest = self.coordinator.snapshot_manifest();

        let previous_bundle_for_rollback = prev_manifest.ffmpeg_bundle_active.clone().or_else(|| {
            let ff = store::get_tool_record(&self.db, ToolId::Ffmpeg).ok().flatten()?;
            let fp = store::get_tool_record(&self.db, ToolId::Ffprobe).ok().flatten()?;
            let ff_path = PathBuf::from(ff.active_binary_path?);
            let fp_path = PathBuf::from(fp.active_binary_path?);
            Some(ManagedFfmpegBundleSlot {
                version: ff
                    .installed_version
                    .clone()
                    .unwrap_or_else(|| "bundled".to_string()),
                ffmpeg_version: ff
                    .installed_version
                    .unwrap_or_else(|| "bundled".to_string()),
                ffprobe_version: fp
                    .installed_version
                    .unwrap_or_else(|| "bundled".to_string()),
                ffmpeg_path: ff_path,
                ffprobe_path: fp_path,
                sha256: ff.artifact_sha256,
                source: "bundled".to_string(),
                activated_at: Utc::now(),
            })
        });

        let extra_busy = self.is_bundle_busy_by_jobs(ToolBundleId::FfmpegBundle);
        self.set_bundle_status(ToolBundleId::FfmpegBundle, ToolUpdateStatus::Installing, None);

        let activated = self.coordinator.try_commit_manifest_if_idle(
            ToolBundleId::FfmpegBundle,
            settings.defer_while_in_use,
            extra_busy,
            &self.layout,
            |m| {
                m.ffmpeg_bundle_rollback = previous_bundle_for_rollback.clone();
                m.ffmpeg_bundle_active = Some(new_slot.clone());
                m.ffmpeg_bundle_pending = None;
            },
        )?;

        if !activated {
            self.coordinator
                .update_manifest_metadata(&self.layout, |m| {
                    m.ffmpeg_bundle_pending = Some(new_slot.clone());
                })?;

            for tool in [ToolId::Ffmpeg, ToolId::Ffprobe] {
                if let Ok(Some(mut rec)) = store::get_tool_record(&self.db, tool) {
                    rec.pending_version = Some(match tool {
                        ToolId::Ffmpeg => new_slot.ffmpeg_version.clone(),
                        ToolId::Ffprobe => new_slot.ffprobe_version.clone(),
                        ToolId::YtDlp => unreachable!(),
                    });
                    rec.pending_binary_path = Some(match tool {
                        ToolId::Ffmpeg => new_slot.ffmpeg_path.to_string_lossy().to_string(),
                        ToolId::Ffprobe => new_slot.ffprobe_path.to_string_lossy().to_string(),
                        ToolId::YtDlp => unreachable!(),
                    });
                    rec.update_status = ToolUpdateStatus::PendingActivation;
                    rec.last_error = Some(
                        "FFmpeg/FFprobe is currently in use; verified bundle will activate automatically when idle."
                            .to_string(),
                    );
                    let _ = store::upsert_tool_record(&self.db, &rec);
                }
            }

            let _ = store::insert_history_entry(
                &self.db,
                ToolId::Ffmpeg.as_str(),
                "deferred",
                current_rec.installed_version.as_deref(),
                Some(&new_slot.ffmpeg_version),
                "pending_activation",
                Some(&candidate.source_name),
                new_slot.sha256.as_deref(),
                Some(candidate.trust_level.as_str()),
                Some("Deferred FFmpeg & FFprobe bundle activation while media processing is active"),
            );
            append_tools_log(
                &self.layout,
                "INFO",
                "DEFERRED_IN_USE",
                &format!(
                    "Deferred FFmpeg/FFprobe {} activation while active media processing is running",
                    new_slot.ffmpeg_version
                ),
            );
            self.emit_status_changed();
            self.emit_notification(
                ToolNotificationKind::ToolUpdatePostponed,
                ToolId::Ffmpeg,
                "FFmpeg & FFprobe Update Postponed",
                format!(
                    "FFmpeg & FFprobe {} is verified and will activate automatically when active media tasks finish.",
                    new_slot.ffmpeg_version
                ),
                Some(new_slot.ffmpeg_version.clone()),
            );
            return Ok(());
        }

        // Post-switch verification of active pair
        let post_switch_ok = if self.fail_post_switch_once.swap(false, Ordering::SeqCst) {
            Err(EngineError::Other(
                "Simulated FFmpeg bundle post-switch verification failure".to_string(),
            ))
        } else if let (Some(ff), Some(fp)) = (
            self.coordinator.resolve_tool(ToolId::Ffmpeg),
            self.coordinator.resolve_tool(ToolId::Ffprobe),
        ) {
            let scratch = self
                .layout
                .staging
                .join(format!("post_verify_{}", uuid::Uuid::new_v4()));
            let scratch_c = scratch.clone();
            let res = tokio::task::spawn_blocking(move || {
                verify_staged_ffmpeg_bundle(&ff.path, &fp.path, &scratch_c)
            })
            .await
            .map_err(|e| EngineError::Other(e.to_string()))
            .and_then(|r| r.map(|_| ()));
            let _ = fs::remove_dir_all(&scratch);
            res
        } else {
            Err(EngineError::Other(
                "Active FFmpeg/FFprobe paths could not be resolved after activation".to_string(),
            ))
        };

        if let Err(err) = post_switch_ok {
            self.coordinator
                .update_manifest_metadata(&self.layout, |m| {
                    *m = prev_manifest.clone();
                })?;

            for tool in [ToolId::Ffmpeg, ToolId::Ffprobe] {
                if let Ok(Some(mut rec)) = store::get_tool_record(&self.db, tool) {
                    rec.update_status = ToolUpdateStatus::RolledBack;
                    rec.last_error = Some(format!(
                        "Post-activation verification failed ({}); rolled back automatically.",
                        err
                    ));
                    if !rec.failed_versions.contains(&candidate.version) {
                        rec.failed_versions.push(candidate.version.clone());
                    }
                    let _ = store::upsert_tool_record(&self.db, &rec);
                }
            }

            let _ = store::insert_history_entry(
                &self.db,
                ToolId::Ffmpeg.as_str(),
                "auto_rollback",
                Some(&new_slot.ffmpeg_version),
                current_rec.installed_version.as_deref(),
                "rolled_back",
                Some(&candidate.source_name),
                new_slot.sha256.as_deref(),
                Some(candidate.trust_level.as_str()),
                Some(&format!("Automatic rollback after FFmpeg post-switch failure: {}", err)),
            );
            self.emit_status_changed();
            self.emit_notification(
                ToolNotificationKind::ToolRolledBack,
                ToolId::Ffmpeg,
                "FFmpeg & FFprobe Rolled Back",
                format!(
                    "FFmpeg & FFprobe {} failed post-activation verification and was rolled back safely.",
                    new_slot.ffmpeg_version
                ),
                current_rec.installed_version.clone(),
            );
            return Err(err);
        }

        let now = Utc::now();
        for tool in [ToolId::Ffmpeg, ToolId::Ffprobe] {
            let mut rec = store::get_tool_record(&self.db, tool)?
                .unwrap_or_else(|| ExternalToolRecord::new_default(tool));
            let (ver, path) = match tool {
                ToolId::Ffmpeg => (&new_slot.ffmpeg_version, &new_slot.ffmpeg_path),
                ToolId::Ffprobe => (&new_slot.ffprobe_version, &new_slot.ffprobe_path),
                ToolId::YtDlp => unreachable!(),
            };
            rec.installed_version = Some(ver.clone());
            rec.available_version = Some(ver.clone());
            rec.active_binary_path = Some(path.to_string_lossy().to_string());
            rec.source = "managed".to_string();
            rec.artifact_sha256 = compute_file_sha256(path).ok().or_else(|| new_slot.sha256.clone());
            rec.installed_at = Some(now);
            rec.last_updated_at = Some(now);
            rec.last_successful_version = Some(ver.clone());
            rec.update_status = ToolUpdateStatus::Updated;
            rec.last_error = None;
            rec.pending_version = None;
            rec.pending_binary_path = None;
            if let Some(ref rb) = previous_bundle_for_rollback {
                rec.rollback_available = rb.ffmpeg_path.exists() && rb.ffprobe_path.exists();
                rec.rollback_version = Some(match tool {
                    ToolId::Ffmpeg => rb.ffmpeg_version.clone(),
                    ToolId::Ffprobe => rb.ffprobe_version.clone(),
                    ToolId::YtDlp => unreachable!(),
                });
                rec.rollback_binary_path = Some(match tool {
                    ToolId::Ffmpeg => rb.ffmpeg_path.to_string_lossy().to_string(),
                    ToolId::Ffprobe => rb.ffprobe_path.to_string_lossy().to_string(),
                    ToolId::YtDlp => unreachable!(),
                });
            }
            store::upsert_tool_record(&self.db, &rec)?;
        }

        let _ = store::insert_history_entry(
            &self.db,
            ToolId::Ffmpeg.as_str(),
            "update",
            current_rec.installed_version.as_deref(),
            Some(&new_slot.ffmpeg_version),
            "updated",
            Some(&candidate.source_name),
            new_slot.sha256.as_deref(),
            Some(candidate.trust_level.as_str()),
            Some(&format!(
                "Successfully updated FFmpeg & FFprobe bundle to {}",
                new_slot.ffmpeg_version
            )),
        );

        self.prune_old_tool_versions();
        append_tools_log(
            &self.layout,
            "INFO",
            "ACTIVATED",
            &format!(
                "Activated FFmpeg & FFprobe {} at {:?}",
                new_slot.ffmpeg_version, new_slot.ffmpeg_path
            ),
        );
        self.emit_status_changed();
        self.emit_notification(
            ToolNotificationKind::ToolUpdatedFfmpegBundle,
            ToolId::Ffmpeg,
            "FFmpeg & FFprobe Updated",
            format!(
                "FFmpeg & FFprobe have been updated to version {}.",
                new_slot.ffmpeg_version
            ),
            Some(new_slot.ffmpeg_version),
        );
        Ok(())
    }

    fn has_pending_bundle(&self, bundle: ToolBundleId) -> bool {
        let m = self.coordinator.snapshot_manifest();
        match bundle {
            ToolBundleId::YtDlp => m.yt_dlp_pending.is_some(),
            ToolBundleId::FfmpegBundle => m.ffmpeg_bundle_pending.is_some(),
        }
    }

    /// Attempts to activate any verified updates that were deferred while tools were in use.
    pub async fn try_activate_pending_updates(&self) -> Result<bool> {
        let mut any_activated = false;
        if self.has_pending_bundle(ToolBundleId::YtDlp) {
            let _g = self.ytdlp_lock.lock().await;
            if self.try_activate_pending_bundle(ToolBundleId::YtDlp).await? {
                any_activated = true;
            }
        }
        if self.has_pending_bundle(ToolBundleId::FfmpegBundle) {
            let _g = self.ffmpeg_lock.lock().await;
            if self
                .try_activate_pending_bundle(ToolBundleId::FfmpegBundle)
                .await?
            {
                any_activated = true;
            }
        }
        Ok(any_activated)
    }

    async fn try_activate_pending_bundle(&self, bundle: ToolBundleId) -> Result<bool> {
        let manifest = self.coordinator.snapshot_manifest();
        match bundle {
            ToolBundleId::YtDlp => {
                let Some(pending) = manifest.yt_dlp_pending else {
                    return Ok(false);
                };
                if !pending.binary_path.exists() {
                    self.coordinator
                        .update_manifest_metadata(&self.layout, |m| {
                            m.yt_dlp_pending = None;
                        })?;
                    return Ok(false);
                }
                let rec = store::get_tool_record(&self.db, ToolId::YtDlp)?
                    .unwrap_or_else(|| ExternalToolRecord::new_default(ToolId::YtDlp));
                let synth_cand = UpdateCandidate {
                    bundle: ToolBundleId::YtDlp,
                    version: pending.version.clone(),
                    download_url: String::new(),
                    expected_sha256: pending.sha256.clone(),
                    expected_size: None,
                    source_name: pending.source.clone(),
                    trust_level: TrustLevel::PublisherOpenPgpVerified,
                    untrusted_reason: None,
                    published_at: None,
                    artifact_kind: ArtifactKind::SingleExe,
                };
                let before_active = manifest
                    .yt_dlp_active
                    .as_ref()
                    .map(|s| s.version.clone());
                self.commit_or_defer_ytdlp(pending.clone(), &synth_cand, &rec)
                    .await?;
                let after = self.coordinator.snapshot_manifest();
                Ok(after.yt_dlp_pending.is_none()
                    && after.yt_dlp_active.as_ref().map(|s| s.version.clone()) != before_active)
            }
            ToolBundleId::FfmpegBundle => {
                let Some(pending) = manifest.ffmpeg_bundle_pending else {
                    return Ok(false);
                };
                if !pending.ffmpeg_path.exists() || !pending.ffprobe_path.exists() {
                    self.coordinator
                        .update_manifest_metadata(&self.layout, |m| {
                            m.ffmpeg_bundle_pending = None;
                        })?;
                    return Ok(false);
                }
                let rec = store::get_tool_record(&self.db, ToolId::Ffmpeg)?
                    .unwrap_or_else(|| ExternalToolRecord::new_default(ToolId::Ffmpeg));
                let synth_cand = UpdateCandidate {
                    bundle: ToolBundleId::FfmpegBundle,
                    version: pending.version.clone(),
                    download_url: String::new(),
                    expected_sha256: pending.sha256.clone(),
                    expected_size: None,
                    source_name: pending.source.clone(),
                    trust_level: TrustLevel::ToriEd25519ManifestVerified,
                    untrusted_reason: None,
                    published_at: None,
                    artifact_kind: ArtifactKind::FfmpegZip,
                };
                let before_active = manifest
                    .ffmpeg_bundle_active
                    .as_ref()
                    .map(|s| s.version.clone());
                self.commit_or_defer_ffmpeg_bundle(pending.clone(), &synth_cand, &rec)
                    .await?;
                let after = self.coordinator.snapshot_manifest();
                Ok(after.ffmpeg_bundle_pending.is_none()
                    && after
                        .ffmpeg_bundle_active
                        .as_ref()
                        .map(|s| s.version.clone())
                        != before_active)
            }
        }
    }

    /// Manually rolls back a tool (or atomic FFmpeg+FFprobe bundle) to the previous known-good version.
    pub async fn rollback_tool(&self, tool_id: ToolId) -> Result<ExternalToolsSnapshot> {
        let bundle = tool_id.bundle_id();
        let _lock = match bundle {
            ToolBundleId::YtDlp => self.ytdlp_lock.lock().await,
            ToolBundleId::FfmpegBundle => self.ffmpeg_lock.lock().await,
        };

        self.ensure_inventory_synced();
        let settings = self.get_settings();
        let manifest = self.coordinator.snapshot_manifest();

        match bundle {
            ToolBundleId::YtDlp => {
                let rollback_slot = manifest.yt_dlp_rollback.clone().ok_or_else(|| {
                    EngineError::Other("No previous yt-dlp rollback version is available.".to_string())
                })?;
                if !rollback_slot.binary_path.exists() {
                    return Err(EngineError::Other(
                        "Previous yt-dlp rollback binary is no longer present on disk.".to_string(),
                    ));
                }

                let from_ver = manifest
                    .yt_dlp_active
                    .as_ref()
                    .map(|s| s.version.clone());
                let extra_busy = self.is_bundle_busy_by_jobs(ToolBundleId::YtDlp);

                let committed = self.coordinator.try_commit_manifest_if_idle(
                    ToolBundleId::YtDlp,
                    settings.defer_while_in_use,
                    extra_busy,
                    &self.layout,
                    |m| {
                        if rollback_slot.source == "bundled" {
                            m.yt_dlp_active = None;
                        } else {
                            m.yt_dlp_active = Some(rollback_slot.clone());
                        }
                        m.yt_dlp_rollback = None;
                        m.yt_dlp_pending = None;
                    },
                )?;

                if !committed {
                    return Err(EngineError::Other(
                        "Cannot roll back yt-dlp while an active download or extraction is using it."
                            .to_string(),
                    ));
                }

                self.sync_local_inventory()?;
                if let Ok(Some(mut rec)) = store::get_tool_record(&self.db, ToolId::YtDlp) {
                    rec.update_status = ToolUpdateStatus::RolledBack;
                    rec.last_error = None;
                    let _ = store::upsert_tool_record(&self.db, &rec);
                }

                let _ = store::insert_history_entry(
                    &self.db,
                    ToolId::YtDlp.as_str(),
                    "rollback",
                    from_ver.as_deref(),
                    Some(&rollback_slot.version),
                    "rolled_back",
                    Some(&rollback_slot.source),
                    rollback_slot.sha256.as_deref(),
                    None,
                    Some(&format!(
                        "Manually rolled back yt-dlp to {}",
                        rollback_slot.version
                    )),
                );
                append_tools_log(
                    &self.layout,
                    "INFO",
                    "ROLLBACK",
                    &format!("Rolled back yt-dlp to {}", rollback_slot.version),
                );
                self.emit_status_changed();
                self.emit_notification(
                    ToolNotificationKind::ToolRolledBack,
                    ToolId::YtDlp,
                    "yt-dlp Rolled Back",
                    format!("yt-dlp has been restored to version {}.", rollback_slot.version),
                    Some(rollback_slot.version),
                );
            }
            ToolBundleId::FfmpegBundle => {
                let rollback_slot = manifest.ffmpeg_bundle_rollback.clone().ok_or_else(|| {
                    EngineError::Other(
                        "No previous FFmpeg & FFprobe rollback version is available.".to_string(),
                    )
                })?;
                if !rollback_slot.ffmpeg_path.exists() || !rollback_slot.ffprobe_path.exists() {
                    return Err(EngineError::Other(
                        "Previous FFmpeg/FFprobe rollback binaries are missing from disk."
                            .to_string(),
                    ));
                }

                let from_ver = manifest
                    .ffmpeg_bundle_active
                    .as_ref()
                    .map(|s| s.ffmpeg_version.clone());
                let extra_busy = self.is_bundle_busy_by_jobs(ToolBundleId::FfmpegBundle);

                let committed = self.coordinator.try_commit_manifest_if_idle(
                    ToolBundleId::FfmpegBundle,
                    settings.defer_while_in_use,
                    extra_busy,
                    &self.layout,
                    |m| {
                        if rollback_slot.source == "bundled" {
                            m.ffmpeg_bundle_active = None;
                        } else {
                            m.ffmpeg_bundle_active = Some(rollback_slot.clone());
                        }
                        m.ffmpeg_bundle_rollback = None;
                        m.ffmpeg_bundle_pending = None;
                    },
                )?;

                if !committed {
                    return Err(EngineError::Other(
                        "Cannot roll back FFmpeg & FFprobe while active media processing is running."
                            .to_string(),
                    ));
                }

                self.sync_local_inventory()?;
                for t in [ToolId::Ffmpeg, ToolId::Ffprobe] {
                    if let Ok(Some(mut rec)) = store::get_tool_record(&self.db, t) {
                        rec.update_status = ToolUpdateStatus::RolledBack;
                        rec.last_error = None;
                        let _ = store::upsert_tool_record(&self.db, &rec);
                    }
                }

                let _ = store::insert_history_entry(
                    &self.db,
                    ToolId::Ffmpeg.as_str(),
                    "rollback",
                    from_ver.as_deref(),
                    Some(&rollback_slot.ffmpeg_version),
                    "rolled_back",
                    Some(&rollback_slot.source),
                    rollback_slot.sha256.as_deref(),
                    None,
                    Some(&format!(
                        "Manually rolled back FFmpeg & FFprobe to {}",
                        rollback_slot.ffmpeg_version
                    )),
                );
                append_tools_log(
                    &self.layout,
                    "INFO",
                    "ROLLBACK",
                    &format!(
                        "Rolled back FFmpeg & FFprobe to {}",
                        rollback_slot.ffmpeg_version
                    ),
                );
                self.emit_status_changed();
                self.emit_notification(
                    ToolNotificationKind::ToolRolledBack,
                    ToolId::Ffmpeg,
                    "FFmpeg & FFprobe Rolled Back",
                    format!(
                        "FFmpeg & FFprobe have been restored to version {}.",
                        rollback_slot.ffmpeg_version
                    ),
                    Some(rollback_slot.ffmpeg_version),
                );
            }
        }

        self.get_status_snapshot()
    }

    fn prune_old_tool_versions(&self) {
        let m = self.coordinator.snapshot_manifest();

        let mut keep_yt: Vec<&Path> = Vec::new();
        if let Some(ref s) = m.yt_dlp_active {
            keep_yt.push(&s.binary_path);
        }
        if let Some(ref s) = m.yt_dlp_rollback {
            keep_yt.push(&s.binary_path);
        }
        if let Some(ref s) = m.yt_dlp_pending {
            keep_yt.push(&s.binary_path);
        }
        let _ = prune_obsolete_versions(&self.layout.versions_ytdlp, &keep_yt);

        let mut keep_ff: Vec<&Path> = Vec::new();
        if let Some(ref s) = m.ffmpeg_bundle_active {
            keep_ff.push(&s.ffmpeg_path);
            keep_ff.push(&s.ffprobe_path);
        }
        if let Some(ref s) = m.ffmpeg_bundle_rollback {
            keep_ff.push(&s.ffmpeg_path);
            keep_ff.push(&s.ffprobe_path);
        }
        if let Some(ref s) = m.ffmpeg_bundle_pending {
            keep_ff.push(&s.ffmpeg_path);
            keep_ff.push(&s.ffprobe_path);
        }
        let _ = prune_obsolete_versions(&self.layout.versions_ffmpeg, &keep_ff);
    }

    /// Runs the non-blocking background scheduler loop until `shutdown` is cancelled:
    /// - Syncs local inventory asynchronously without delaying app startup
    /// - Performs startup update check if due (after a short settle delay)
    /// - Periodically promotes deferred `PendingActivation` updates once tools are idle
    /// - Enforces UTC 24h / 7d check schedule and bounded exponential backoff
    pub async fn run_background_scheduler(self: Arc<Self>, shutdown: CancellationToken) {
        let mgr = self;
        // Sync local tool versions asynchronously so UI startup is never blocked
        let mgr_sync = Arc::clone(&mgr);
        let _ = tokio::task::spawn_blocking(move || {
            let _ = mgr_sync.sync_local_inventory();
        })
        .await;
        mgr.emit_status_changed();

        // Short settle delay before first background check
        tokio::select! {
            _ = shutdown.cancelled() => return,
            _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {}
        }

        loop {
            if shutdown.is_cancelled() {
                break;
            }

            // 1. Promote any deferred verified updates when active tool leases drop to 0
            let _ = mgr.try_activate_pending_updates().await;

            // 2. Run scheduled check if enabled and due
            if mgr.is_scheduled_check_due(Utc::now()) {
                let _ = mgr.check_for_updates(false).await;
            }

            tokio::select! {
                _ = shutdown.cancelled() => break,
                _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => {}
            }
        }
    }

    pub fn spawn_background_scheduler(
        self: &Arc<Self>,
        shutdown: CancellationToken,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(Arc::clone(self).run_background_scheduler(shutdown))
    }
}
