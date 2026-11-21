use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use reqwest::Client;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::db::Database;
use crate::engine::adaptive::{AdaptiveConfig, AdaptiveScheduler};
use crate::engine::client::build_http_client;
use crate::engine::events::{DownloadEvent, EventBus};
use crate::engine::governor::{ConcurrencyGovernor, GovernorConfig};
use crate::engine::limiter::BandwidthLimiter;
use crate::engine::planner::plan_chunks;
use crate::engine::probe::{extract_safe_header_filename_candidate, sanitize_filename, ProbeResult};
use crate::engine::worker::{download_chunk_with_limiters, download_stream_with_limiters};
use crate::engine::writer::PartFileWriter;
use crate::error::{EngineError, Result};
use crate::types::{
    ChunkRecord, DownloadCompletionOptions, DownloadJob, DownloadProgress, DownloadStatusDetails,
    JobState, JobType, Priority,
};

#[derive(Clone)]
struct ActiveJobTelemetry {
    active_chunk_bounds: Arc<Mutex<HashMap<usize, Arc<AtomicU64>>>>,
    active_chunk_progress: Arc<Mutex<HashMap<usize, Arc<AtomicU64>>>>,
    stream_downloaded: Arc<AtomicU64>,
    is_stream_mode: Arc<AtomicBool>,
    max_connections: Arc<AtomicUsize>,
}

pub struct DownloadManager {
    client: Client,
    db: Database,
    event_bus: EventBus,
    governor: Arc<ConcurrencyGovernor>,
    adaptive_scheduler: Arc<AdaptiveScheduler>,
    torrent_manager: Arc<tokio::sync::OnceCell<Arc<crate::torrent::TorrentSessionManager>>>,
    active_tokens: Arc<Mutex<HashMap<String, CancellationToken>>>,
    stop_tokens: Arc<Mutex<HashMap<String, CancellationToken>>>,
    max_active_jobs: Arc<AtomicUsize>,
    rate_limiter: Arc<BandwidthLimiter>,
    job_rate_limiters: Arc<Mutex<HashMap<String, Arc<BandwidthLimiter>>>>,
    active_job_telemetry: Arc<Mutex<HashMap<String, ActiveJobTelemetry>>>,
    max_connections_per_download: Arc<AtomicUsize>,
    max_retries: Arc<AtomicUsize>,
    dynamic_segmentation: Arc<std::sync::atomic::AtomicBool>,
    default_download_dir: Arc<Mutex<Option<String>>>,
    use_category_by_default: Arc<std::sync::atomic::AtomicBool>,
    scheduler_notify: Arc<tokio::sync::Notify>,
    in_flight_creations: Arc<Mutex<HashMap<String, Arc<tokio::sync::Notify>>>>,
    recent_handoffs: Arc<Mutex<HashMap<String, (String, Instant)>>>,
    path_alloc_lock: Arc<Mutex<()>>,
    desktop_gui_attached: Arc<std::sync::atomic::AtomicBool>,
    frontend_playlist_ready: Arc<std::sync::atomic::AtomicBool>,
    pending_playlist_requests: Arc<Mutex<Vec<PendingPlaylistRequest>>>,
    playlist_waiters: Arc<Mutex<HashMap<String, Vec<tokio::sync::oneshot::Sender<Result<()>>>>>>,
    active_playlist_request_by_url: Arc<Mutex<HashMap<String, (String, Instant)>>>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PendingPlaylistRequest {
    pub request_id: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaylistOpenConfirmation {
    pub request_id: String,
    pub url: String,
    pub confirmed: bool,
}

pub fn validate_playlist_open_url(raw_url: &str) -> Result<String> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return Err(EngineError::InvalidUrl("Missing playlist URL".to_string()));
    }

    let parsed = url::Url::parse(trimmed)
        .map_err(|_| EngineError::InvalidUrl("Invalid playlist URL".to_string()))?;
    match parsed.scheme() {
        "http" | "https" => {}
        scheme => {
            return Err(EngineError::InvalidUrl(format!(
                "Unsupported playlist URL scheme: {}",
                scheme
            )));
        }
    }
    if parsed.host_str().map(str::trim).unwrap_or("").is_empty() {
        return Err(EngineError::InvalidUrl(
            "Playlist URL must contain a valid host".to_string(),
        ));
    }

    let lower = parsed.as_str().to_lowercase();
    if (lower.contains("list=rd") || lower.contains("list=ul") || lower.contains("start_radio=1"))
        && !lower.contains("list=pl")
        && !lower.contains("list=olak")
    {
        return Err(EngineError::Other(
            "YouTube Mix/Radio queues are auto-generated dynamic collections and cannot be downloaded as a fixed batch.".to_string(),
        ));
    }

    Ok(parsed.to_string())
}

pub fn playlist_format_ext(format_id: Option<&str>) -> &'static str {
    let fmt = format_id.unwrap_or("best").trim().to_ascii_lowercase();
    if fmt == "audio_mp3" {
        "mp3"
    } else if fmt.contains("audio") {
        "m4a"
    } else {
        "mp4"
    }
}

#[derive(Clone, Copy)]
enum DestinationTarget<'a> {
    Fixed(&'a Path),
    Configured(Option<&'a str>),
}

fn choose_http_filename(probe: &ProbeResult, suggested_filename: Option<&str>) -> String {
    if probe.has_filename_from_header {
        return sanitize_filename(&probe.filename);
    }
    if let Some(raw_suggested) = suggested_filename.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(cand) = extract_safe_header_filename_candidate(raw_suggested) {
            let cand_ext = Path::new(&cand)
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_ascii_lowercase())
                .unwrap_or_default();
            let is_browser_temp = matches!(
                cand_ext.as_str(),
                "crdownload" | "part" | "partial" | "tmp" | "download"
            );
            let probe_ext = Path::new(&probe.filename)
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            let cand_has_real_ext = !cand_ext.is_empty() && !is_browser_temp;
            let probe_lacks_real_ext =
                probe_ext.is_empty() || probe.filename.eq_ignore_ascii_case("download.bin");
            if cand_has_real_ext || probe_lacks_real_ext {
                return sanitize_filename(&cand);
            }
        }
    }
    sanitize_filename(&probe.filename)
}

impl DownloadManager {
    pub fn new(db: Database, event_bus: EventBus) -> Result<Self> {
        Self::with_config(
            db,
            event_bus,
            GovernorConfig::default(),
            AdaptiveConfig::default(),
        )
    }

    pub fn with_config(
        db: Database,
        event_bus: EventBus,
        gov_config: GovernorConfig,
        adaptive_config: AdaptiveConfig,
    ) -> Result<Self> {
        let client = build_http_client()?;
        let _ = db.reconcile_on_startup();

        // Safe metadata and thumbnail backfill on startup for existing completed downloads
        let db_backfill = db.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let _ = crate::engine::backfill_missing_thumbnails(&db_backfill).await;
            });
        } else {
            std::thread::spawn(move || {
                if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    rt.block_on(async move {
                        let _ = crate::engine::backfill_missing_thumbnails(&db_backfill).await;
                    });
                }
            });
        }

        let scheduler_notify = Arc::new(tokio::sync::Notify::new());

        let active_tokens = Arc::new(Mutex::new(HashMap::new()));
        let stop_tokens = Arc::new(Mutex::new(HashMap::new()));
        let max_active_jobs = Arc::new(AtomicUsize::new(4));
        let rate_limiter = Arc::new(BandwidthLimiter::new(0));
        let job_rate_limiters = Arc::new(Mutex::new(HashMap::new()));
        let active_job_telemetry = Arc::new(Mutex::new(HashMap::new()));
        let max_connections_per_download = Arc::new(AtomicUsize::new(16));
        let max_retries = Arc::new(AtomicUsize::new(3));
        let dynamic_segmentation = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let default_download_dir = Arc::new(Mutex::new(None));
        let use_category_by_default = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let governor = ConcurrencyGovernor::new(gov_config);
        let adaptive_scheduler = Arc::new(AdaptiveScheduler::new(adaptive_config));
        let torrent_manager = Arc::new(tokio::sync::OnceCell::new());
        let in_flight_creations = Arc::new(Mutex::new(HashMap::new()));
        let recent_handoffs = Arc::new(Mutex::new(HashMap::new()));
        let path_alloc_lock = Arc::new(Mutex::new(()));
        let desktop_gui_attached = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let frontend_playlist_ready = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let pending_playlist_requests = Arc::new(Mutex::new(Vec::new()));
        let playlist_waiters = Arc::new(Mutex::new(HashMap::new()));
        let active_playlist_request_by_url = Arc::new(Mutex::new(HashMap::new()));

        // Event-driven background download scheduler loop
        let db_sched = db.clone();
        let notify_sched = scheduler_notify.clone();
        let event_bus_sched = event_bus.clone();
        let active_tokens_sched = Arc::clone(&active_tokens);
        let stop_tokens_sched = Arc::clone(&stop_tokens);
        let max_jobs_sched = Arc::clone(&max_active_jobs);
        let client_sched = client.clone();
        let governor_sched = Arc::clone(&governor);
        let adaptive_sched = Arc::clone(&adaptive_scheduler);
        let torrent_sched = Arc::clone(&torrent_manager);
        let rate_limiter_sched = Arc::clone(&rate_limiter);
        let job_limiters_sched = Arc::clone(&job_rate_limiters);
        let telemetry_sched = Arc::clone(&active_job_telemetry);
        let max_retries_sched = Arc::clone(&max_retries);
        let dynamic_seg_sched = Arc::clone(&dynamic_segmentation);

        let scheduler_loop = async move {
            loop {
                let earliest = db_sched.get_earliest_scheduled_time().unwrap_or(None);
                let sleep_duration = match earliest {
                    Some(due) => {
                        let now = chrono::Utc::now();
                        if due <= now {
                            std::time::Duration::ZERO
                        } else {
                            (due - now)
                                .to_std()
                                .unwrap_or(std::time::Duration::from_millis(50))
                        }
                    }
                    None => std::time::Duration::from_secs(86400 * 365),
                };

                tokio::select! {
                    _ = tokio::time::sleep(sleep_duration) => {
                        let now = chrono::Utc::now();
                        if let Ok(admitted_ids) = db_sched.admit_due_scheduled_jobs(now) {
                            for id in &admitted_ids {
                                event_bus_sched.emit(DownloadEvent::StateChanged {
                                    id: id.clone(),
                                    state: JobState::Queued,
                                    error: None,
                                });
                            }
                            if !admitted_ids.is_empty() {
                                let max_jobs = max_jobs_sched.load(Ordering::SeqCst);
                                let mut current_active = active_tokens_sched.lock().unwrap().len();
                                while current_active < max_jobs {
                                    if let Ok(Some(next_job)) = db_sched.get_next_queued_job() {
                                        let _ = Self::start_job_internal(
                                            &next_job.id,
                                            &db_sched,
                                            &event_bus_sched,
                                            &client_sched,
                                            &governor_sched,
                                            &adaptive_sched,
                                            &torrent_sched,
                                            &active_tokens_sched,
                                            &stop_tokens_sched,
                                            &max_jobs_sched,
                                            &rate_limiter_sched,
                                            &job_limiters_sched,
                                            &telemetry_sched,
                                            &max_retries_sched,
                                            &dynamic_seg_sched,
                                        );
                                        let new_active = active_tokens_sched.lock().unwrap().len();
                                        if new_active <= current_active {
                                            break;
                                        }
                                        current_active = new_active;
                                    } else {
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    _ = notify_sched.notified() => {}
                }
            }
        };

        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(scheduler_loop);
        } else {
            std::thread::spawn(move || {
                if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    rt.block_on(scheduler_loop);
                }
            });
        }

        let mgr = Self {
            client,
            db,
            event_bus,
            governor,
            adaptive_scheduler,
            torrent_manager,
            active_tokens,
            stop_tokens,
            max_active_jobs,
            rate_limiter,
            job_rate_limiters,
            active_job_telemetry,
            max_connections_per_download,
            max_retries,
            dynamic_segmentation,
            default_download_dir,
            use_category_by_default,
            scheduler_notify,
            in_flight_creations,
            recent_handoffs,
            path_alloc_lock,
            desktop_gui_attached,
            frontend_playlist_ready,
            pending_playlist_requests,
            playlist_waiters,
            active_playlist_request_by_url,
        };

        // Automatically process queue on startup to start any queued or overdue downloads
        let _ = mgr.process_queue();

        Ok(mgr)
    }

    pub fn rate_limiter(&self) -> &Arc<BandwidthLimiter> {
        &self.rate_limiter
    }

    pub fn set_speed_limit(&self, limit_bps: u64) {
        self.rate_limiter.set_rate_limit(limit_bps);
    }

    pub fn speed_limit(&self) -> u64 {
        self.rate_limiter.rate_limit()
    }

    fn job_limiter_for_id(
        id: &str,
        db: &Database,
        job_rate_limiters: &Arc<Mutex<HashMap<String, Arc<BandwidthLimiter>>>>,
    ) -> Arc<BandwidthLimiter> {
        if let Some(existing) = job_rate_limiters.lock().unwrap().get(id).cloned() {
            return existing;
        }
        let key = format!("job_speed_limit:{}", id);
        let initial = db
            .get_setting(&key)
            .ok()
            .flatten()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(0);
        let mut guard = job_rate_limiters.lock().unwrap();
        guard
            .entry(id.to_string())
            .or_insert_with(|| Arc::new(BandwidthLimiter::new(initial)))
            .clone()
    }

    /// Sets and persists the per-download speed limit (bytes/sec, 0 = disabled) and takes immediate effect on active workers.
    pub fn set_job_speed_limit(&self, id: &str, limit_bps: u64) -> Result<()> {
        let key = format!("job_speed_limit:{}", id);
        if limit_bps == 0 {
            let _ = self.db.delete_setting(&key);
        } else {
            self.db.set_setting(&key, &limit_bps.to_string())?;
        }
        let limiter = Self::job_limiter_for_id(id, &self.db, &self.job_rate_limiters);
        limiter.set_rate_limit(limit_bps);
        Ok(())
    }

    pub fn job_speed_limit(&self, id: &str) -> u64 {
        if let Some(existing) = self.job_rate_limiters.lock().unwrap().get(id).cloned() {
            return existing.rate_limit();
        }
        let key = format!("job_speed_limit:{}", id);
        self.db
            .get_setting(&key)
            .ok()
            .flatten()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(0)
    }

    /// Persists per-download completion preferences (close popup, notify, open file).
    pub fn set_completion_options(&self, id: &str, opts: &DownloadCompletionOptions) -> Result<()> {
        let key = format!("job_completion_opts:{}", id);
        let json = serde_json::to_string(opts).map_err(|e| EngineError::Other(e.to_string()))?;
        self.db.set_setting(&key, &json)?;
        Ok(())
    }

    pub fn get_completion_options(&self, id: &str) -> DownloadCompletionOptions {
        let key = format!("job_completion_opts:{}", id);
        self.db
            .get_setting(&key)
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str::<DownloadCompletionOptions>(&s).ok())
            .unwrap_or_default()
    }

    /// Returns a lightweight real-time snapshot of active connections, live per-chunk bytes, and speed limits.
    pub fn get_download_status_details(&self, id: &str) -> Result<DownloadStatusDetails> {
        let mut chunks = self.db.get_chunks(id)?;
        let telemetry = self.active_job_telemetry.lock().unwrap().get(id).cloned();

        let (active_connections, max_connections) = if let Some(tel) = telemetry {
            let max_con = tel.max_connections.load(Ordering::Relaxed).max(1);
            if tel.is_stream_mode.load(Ordering::Relaxed) {
                let downloaded = tel.stream_downloaded.load(Ordering::Relaxed);
                if let Some(first) = chunks.first_mut() {
                    first.written_bytes = first.written_bytes.max(downloaded);
                }
                (1, max_con)
            } else {
                let bounds_snap: HashMap<usize, u64> = tel
                    .active_chunk_bounds
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|(k, v)| (*k, v.load(Ordering::Relaxed)))
                    .collect();
                let prog_snap: HashMap<usize, u64> = tel
                    .active_chunk_progress
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|(k, v)| (*k, v.load(Ordering::Relaxed)))
                    .collect();
                let active_con = bounds_snap.len();
                for c in &mut chunks {
                    if let Some(&b) = bounds_snap.get(&c.chunk_index) {
                        c.end_byte = b;
                    }
                    if let Some(&p) = prog_snap.get(&c.chunk_index) {
                        c.written_bytes = c.written_bytes.max(p);
                    }
                }
                (active_con, max_con)
            }
        } else {
            let is_active = self.active_tokens.lock().unwrap().contains_key(id);
            let max_con = self.max_connections_per_download();
            (if is_active { 1 } else { 0 }, max_con)
        };

        Ok(DownloadStatusDetails {
            id: id.to_string(),
            active_connections,
            max_connections,
            chunks,
            global_speed_limit_bps: self.speed_limit(),
            job_speed_limit_bps: self.job_speed_limit(id),
        })
    }

    pub fn set_max_connections_per_download(&self, con: usize) {
        let c = con.clamp(1, 32);
        self.max_connections_per_download.store(c, Ordering::SeqCst);
        self.governor.set_limits(c.max(16), (c / 2).max(4));
        self.adaptive_scheduler.set_max_concurrency(c);
    }

    pub fn max_connections_per_download(&self) -> usize {
        self.max_connections_per_download.load(Ordering::Relaxed)
    }

    pub fn set_max_retries(&self, retries: usize) {
        self.max_retries.store(retries, Ordering::SeqCst);
    }

    pub fn max_retries(&self) -> usize {
        self.max_retries.load(Ordering::Relaxed)
    }

    pub fn set_dynamic_segmentation(&self, enabled: bool) {
        self.dynamic_segmentation.store(enabled, Ordering::SeqCst);
    }

    pub fn is_dynamic_segmentation_enabled(&self) -> bool {
        self.dynamic_segmentation.load(Ordering::Relaxed)
    }

    pub fn set_min_split_size(&self, size: u64) {
        self.adaptive_scheduler.set_min_split_size(size);
    }

    pub fn min_split_size(&self) -> u64 {
        self.adaptive_scheduler.min_split_size()
    }

    pub fn set_default_download_dir(&self, dir: Option<String>) {
        *self.default_download_dir.lock().unwrap() = dir;
    }

    pub fn default_download_dir(&self) -> Option<String> {
        self.default_download_dir.lock().unwrap().clone()
    }

    pub fn set_use_category_by_default(&self, enabled: bool) {
        self.use_category_by_default
            .store(enabled, Ordering::SeqCst);
    }

    pub fn is_use_category_by_default(&self) -> bool {
        self.use_category_by_default.load(Ordering::Relaxed)
    }

    pub fn get_system_download_dir() -> PathBuf {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            let downloads = PathBuf::from(profile).join("Downloads");
            if downloads.exists() {
                return downloads;
            }
            return downloads;
        }
        if let Ok(home) = std::env::var("HOME") {
            let downloads = PathBuf::from(home).join("Downloads");
            return downloads;
        }
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    }

    pub fn classify_category(hint: &str) -> &'static str {
        let clean = hint.split('?').next().unwrap_or(hint);
        let clean = clean.split('#').next().unwrap_or(clean);
        let path = Path::new(clean);
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();

        match ext.as_str() {
            "exe" | "msi" | "dmg" | "bat" | "cmd" | "sh" | "apk" => "Programs",
            "iso" | "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" => "Compressed",
            "mp4" | "mkv" | "webm" | "mov" | "avi" | "flv" | "wmv" | "m4v" | "ts" | "m2ts"
            | "mts" | "mpg" | "mpeg" | "vob" | "ogv" | "3gp" => "Video",
            "mp3" | "m4a" | "aac" | "flac" | "ogg" | "opus" | "wav" => "Music",
            "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "csv" | "md" => {
                "Documents"
            }
            _ => "Other",
        }
    }

    /// Classifies destination folder using the resolved filename extension first, falling back to
    /// specific container/media `Content-Type` headers only when no meaningful extension exists.
    pub fn classify_category_with_content_type(
        hint: &str,
        content_type: Option<&str>,
    ) -> &'static str {
        let by_ext = Self::classify_category(hint);
        if by_ext != "Other" {
            return by_ext;
        }

        let clean = hint.split('?').next().unwrap_or(hint);
        let clean = clean.split('#').next().unwrap_or(clean);
        let ext = Path::new(clean)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        let has_meaningful_ext = !ext.is_empty() && !clean.eq_ignore_ascii_case("download.bin");
        if has_meaningful_ext {
            return "Other";
        }

        let Some(raw_ct) = content_type else {
            return "Other";
        };
        let mime = raw_ct
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();

        // Never treat generic binary/text streams as media without filename/extension evidence.
        if mime.is_empty()
            || mime == "application/octet-stream"
            || mime == "binary/octet-stream"
            || mime == "application/unknown"
            || mime == "text/plain"
        {
            return "Other";
        }

        if mime.starts_with("video/")
            || matches!(mime.as_str(), "application/x-matroska" | "application/matroska")
        {
            "Video"
        } else if mime.starts_with("audio/") {
            "Music"
        } else if matches!(
            mime.as_str(),
            "application/pdf"
                | "application/msword"
                | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                | "application/vnd.ms-excel"
                | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                | "application/vnd.ms-powerpoint"
                | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
                | "text/csv"
                | "text/markdown"
        ) {
            "Documents"
        } else if matches!(
            mime.as_str(),
            "application/zip"
                | "application/x-rar-compressed"
                | "application/vnd.rar"
                | "application/x-7z-compressed"
                | "application/x-tar"
                | "application/gzip"
                | "application/x-bzip2"
                | "application/x-xz"
                | "application/x-iso9660-image"
        ) {
            "Compressed"
        } else if matches!(
            mime.as_str(),
            "application/vnd.microsoft.portable-executable"
                | "application/x-msdownload"
                | "application/x-msi"
                | "application/x-apple-diskimage"
                | "application/vnd.android.package-archive"
        ) {
            "Programs"
        } else {
            "Other"
        }
    }

    pub fn validate_destination_path(dest: &str) -> Result<()> {
        let clean = dest.trim();
        if clean.is_empty() {
            return Ok(());
        }
        if clean.chars().any(|c| c == '\0' || (c as u32) < 32 || c == '\x7f') {
            return Err(EngineError::InvalidDestination(
                "Invalid destination path: control characters rejected.".to_string(),
            ));
        }
        if clean.contains("..")
            || Path::new(clean)
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(EngineError::InvalidDestination(
                "Invalid destination path: directory traversal rejected.".to_string(),
            ));
        }
        Ok(())
    }

    pub fn resolve_destination_folder(
        &self,
        hint_filename_or_url: &str,
        explicit_dest: Option<&str>,
    ) -> PathBuf {
        self.resolve_destination_folder_with_content_type(
            hint_filename_or_url,
            None,
            explicit_dest,
        )
    }

    pub fn resolve_destination_folder_with_content_type(
        &self,
        hint_filename_or_url: &str,
        content_type: Option<&str>,
        explicit_dest: Option<&str>,
    ) -> PathBuf {
        let default_dir = self.default_download_dir();
        let safe_explicit = explicit_dest.and_then(|d| {
            let clean = d.trim();
            if clean.is_empty() || Self::validate_destination_path(clean).is_err() {
                None
            } else {
                Some(clean)
            }
        });

        let is_explicit_override = match safe_explicit {
            Some(clean) => {
                let pa = Path::new(clean);
                let pb = match default_dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    Some(def) => PathBuf::from(def),
                    None => Self::get_system_download_dir(),
                };
                if pa == pb.as_path() {
                    false
                } else {
                    let ca: Vec<_> = pa
                        .components()
                        .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
                        .collect();
                    let cb: Vec<_> = pb
                        .components()
                        .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
                        .collect();
                    ca != cb
                }
            }
            None => false,
        };

        if is_explicit_override {
            let p = PathBuf::from(safe_explicit.unwrap());
            let _ = fs::create_dir_all(&p);
            return p;
        }

        let base_dir = if let Some(ref def) = default_dir {
            let clean = def.trim();
            if !clean.is_empty() {
                PathBuf::from(clean)
            } else {
                Self::get_system_download_dir()
            }
        } else {
            Self::get_system_download_dir()
        };

        if self.is_use_category_by_default() {
            let category =
                Self::classify_category_with_content_type(hint_filename_or_url, content_type);
            let already_in_category = base_dir
                .file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.eq_ignore_ascii_case(category))
                .unwrap_or(false);

            let final_dir = if already_in_category {
                base_dir
            } else {
                base_dir.join(category)
            };
            let _ = fs::create_dir_all(&final_dir);
            final_dir
        } else {
            let _ = fs::create_dir_all(&base_dir);
            base_dir
        }
    }

    pub fn max_active_jobs(&self) -> usize {
        self.max_active_jobs.load(Ordering::SeqCst)
    }

    pub fn active_downloads_count(&self) -> usize {
        self.active_tokens.lock().unwrap().len()
    }

    pub fn set_max_active_jobs(&self, max: usize) {
        self.max_active_jobs.store(max, Ordering::SeqCst);
        let _ = self.process_queue();
    }

    pub fn process_queue(&self) -> Result<Option<String>> {
        let max = self.max_active_jobs.load(Ordering::SeqCst);
        let mut first_started = None;
        loop {
            let active_count = self.active_tokens.lock().unwrap().len();
            if active_count >= max {
                break;
            }

            if let Some(next_job) = self.db.get_next_queued_job()? {
                let id = next_job.id.clone();
                self.start_download(&id)?;
                if first_started.is_none() {
                    first_started = Some(id);
                }
                let new_active = self.active_tokens.lock().unwrap().len();
                if new_active <= active_count {
                    // Start did not increase active count (e.g. error or reached cap)
                    break;
                }
            } else {
                break;
            }
        }

        Ok(first_started)
    }

    pub fn database(&self) -> &Database {
        &self.db
    }

    pub fn event_bus(&self) -> &EventBus {
        &self.event_bus
    }

    pub fn governor(&self) -> &Arc<ConcurrencyGovernor> {
        &self.governor
    }

    pub fn adaptive_scheduler(&self) -> &Arc<AdaptiveScheduler> {
        &self.adaptive_scheduler
    }

    pub fn notify_scheduler(&self) {
        self.scheduler_notify.notify_one();
    }

    pub fn set_desktop_gui_attached(&self, attached: bool) {
        self.desktop_gui_attached.store(attached, Ordering::SeqCst);
    }

    pub fn is_desktop_gui_attached(&self) -> bool {
        self.desktop_gui_attached.load(Ordering::SeqCst)
    }

    pub fn set_frontend_playlist_ready(&self, ready: bool) {
        self.frontend_playlist_ready.store(ready, Ordering::SeqCst);
    }

    pub fn is_frontend_playlist_ready(&self) -> bool {
        self.frontend_playlist_ready.load(Ordering::SeqCst)
    }

    pub fn pending_playlist_requests_snapshot(&self) -> Vec<PendingPlaylistRequest> {
        self.pending_playlist_requests.lock().unwrap().clone()
    }

    pub fn take_pending_playlist_requests(&self) -> Vec<PendingPlaylistRequest> {
        let mut pending = self.pending_playlist_requests.lock().unwrap();
        std::mem::take(&mut *pending)
    }

    pub fn acknowledge_playlist_modal(&self, request_id: &str) -> bool {
        let trimmed = request_id.trim();
        if trimmed.is_empty() {
            return false;
        }
        {
            let mut pending = self.pending_playlist_requests.lock().unwrap();
            pending.retain(|req| req.request_id != trimmed);
        }
        {
            let mut active = self.active_playlist_request_by_url.lock().unwrap();
            active.retain(|_, (id, _)| id != trimmed);
        }
        let waiters = self.playlist_waiters.lock().unwrap().remove(trimmed);
        if let Some(senders) = waiters {
            let mut notified = false;
            for tx in senders {
                if tx.send(Ok(())).is_ok() {
                    notified = true;
                }
            }
            return notified;
        }
        false
    }

    fn cleanup_closed_playlist_waiters(&self, request_id: &str) {
        let now_empty = {
            let mut waiters = self.playlist_waiters.lock().unwrap();
            if let Some(senders) = waiters.get_mut(request_id) {
                senders.retain(|tx| !tx.is_closed());
                if senders.is_empty() {
                    waiters.remove(request_id);
                    true
                } else {
                    false
                }
            } else {
                true
            }
        };

        if now_empty {
            let mut pending = self.pending_playlist_requests.lock().unwrap();
            pending.retain(|req| req.request_id != request_id);
            let mut active = self.active_playlist_request_by_url.lock().unwrap();
            active.retain(|_, (id, _)| id != request_id);
        }
    }

    /// Validates a playlist URL, wakes/focuses TORI Desktop, queues/emits a tracked playlist
    /// dialog request, and waits for genuine frontend modal mount acknowledgement when GUI is attached.
    pub async fn request_open_playlist_modal(
        &self,
        raw_url: &str,
        timeout: Duration,
    ) -> Result<PlaylistOpenConfirmation> {
        let normalized_url = validate_playlist_open_url(raw_url)?;

        if !self.is_desktop_gui_attached() {
            let request_id = Uuid::new_v4().to_string();
            self.event_bus.emit(DownloadEvent::ShowWindow);
            self.event_bus.emit(DownloadEvent::OpenPlaylistModal {
                url: normalized_url.clone(),
            });
            return Ok(PlaylistOpenConfirmation {
                request_id,
                url: normalized_url,
                confirmed: false,
            });
        }

        struct PlaylistWaitGuard<'a> {
            manager: &'a DownloadManager,
            request_id: String,
            armed: bool,
        }

        impl Drop for PlaylistWaitGuard<'_> {
            fn drop(&mut self) {
                if self.armed {
                    self.manager
                        .cleanup_closed_playlist_waiters(&self.request_id);
                }
            }
        }

        let mut guard = PlaylistWaitGuard {
            manager: self,
            request_id: String::new(),
            armed: false,
        };

        let (request_id, rx, coalesced) = {
            let mut active = self.active_playlist_request_by_url.lock().unwrap();
            active.retain(|_, (_, ts)| ts.elapsed() < Duration::from_secs(30));

            let mut waiters = self.playlist_waiters.lock().unwrap();
            let mut pending = self.pending_playlist_requests.lock().unwrap();

            let (tx, rx) = tokio::sync::oneshot::channel();
            if let Some((existing_id, ts)) = active.get(&normalized_url).cloned() {
                if ts.elapsed() < Duration::from_millis(5000) && waiters.contains_key(&existing_id) {
                    waiters.entry(existing_id.clone()).or_default().push(tx);
                    (existing_id, rx, true)
                } else {
                    let id = Uuid::new_v4().to_string();
                    active.insert(normalized_url.clone(), (id.clone(), Instant::now()));
                    pending.push(PendingPlaylistRequest {
                        request_id: id.clone(),
                        url: normalized_url.clone(),
                    });
                    waiters.insert(id.clone(), vec![tx]);
                    (id, rx, false)
                }
            } else {
                let id = Uuid::new_v4().to_string();
                active.insert(normalized_url.clone(), (id.clone(), Instant::now()));
                pending.push(PendingPlaylistRequest {
                    request_id: id.clone(),
                    url: normalized_url.clone(),
                });
                waiters.insert(id.clone(), vec![tx]);
                (id, rx, false)
            }
        };

        guard.request_id = request_id.clone();
        guard.armed = true;

        self.event_bus.emit(DownloadEvent::ShowWindow);
        if !coalesced {
            self.event_bus.emit(DownloadEvent::OpenPlaylistModal {
                url: normalized_url.clone(),
            });
        }

        let wait_result = tokio::time::timeout(timeout, rx).await;
        match wait_result {
            Ok(Ok(Ok(()))) => {
                guard.armed = false;
                Ok(PlaylistOpenConfirmation {
                    request_id,
                    url: normalized_url,
                    confirmed: true,
                })
            }
            Ok(Ok(Err(e))) => {
                guard.armed = false;
                Err(e)
            }
            Ok(Err(_closed)) => {
                guard.armed = false;
                self.cleanup_closed_playlist_waiters(&request_id);
                Err(EngineError::Other(
                    "Playlist modal request was closed before TORI Desktop confirmed opening it."
                        .to_string(),
                ))
            }
            Err(_elapsed) => {
                guard.armed = false;
                self.cleanup_closed_playlist_waiters(&request_id);
                Err(EngineError::Other(
                    "TORI Desktop did not confirm opening the playlist selection dialog within the timeout. Please bring TORI Desktop to the foreground and retry.".to_string(),
                ))
            }
        }
    }

    pub fn check_scheduled_jobs(&self) -> Result<Vec<String>> {
        let now = chrono::Utc::now();
        let admitted_ids = self.db.admit_due_scheduled_jobs(now)?;
        for id in &admitted_ids {
            self.event_bus.emit(DownloadEvent::StateChanged {
                id: id.clone(),
                state: JobState::Queued,
                error: None,
            });
        }
        if !admitted_ids.is_empty() {
            let _ = self.process_queue();
        }
        Ok(admitted_ids)
    }

    pub fn reschedule_download(
        &self,
        id: &str,
        scheduled_at: Option<chrono::DateTime<chrono::Utc>>,
    ) -> Result<()> {
        let job = match self.db.get_job(id)? {
            Some(j) => j,
            None => return Err(EngineError::JobNotFound(id.to_string())),
        };

        if job.state.is_terminal() {
            return Err(EngineError::Other(format!(
                "Cannot reschedule terminal download (state: {:?})",
                job.state
            )));
        }

        // Cancel running worker token if active
        let mut tokens = self.active_tokens.lock().unwrap();
        if let Some(token) = tokens.remove(id) {
            token.cancel();
        }
        drop(tokens);

        let now = chrono::Utc::now();
        if let Some(sched_time) = scheduled_at {
            if sched_time <= now {
                // Time has already passed: admit to queue immediately
                self.db.update_job_scheduled_at(id, None)?;
                self.event_bus.emit(DownloadEvent::StateChanged {
                    id: id.to_string(),
                    state: JobState::Queued,
                    error: None,
                });
                let _ = self.process_queue();
            } else {
                // Future time: transition to Scheduled
                self.db.update_job_scheduled_at(id, Some(sched_time))?;
                self.event_bus.emit(DownloadEvent::StateChanged {
                    id: id.to_string(),
                    state: JobState::Scheduled,
                    error: None,
                });
                self.notify_scheduler();
            }
        } else {
            // Cleared schedule: transition to Queued
            self.db.update_job_scheduled_at(id, None)?;
            self.event_bus.emit(DownloadEvent::StateChanged {
                id: id.to_string(),
                state: JobState::Queued,
                error: None,
            });
            let _ = self.process_queue();
        }

        Ok(())
    }

    pub async fn create_download<P: AsRef<Path>>(
        &self,
        url: &str,
        destination_dir: P,
    ) -> Result<DownloadJob> {
        self.create_download_with_priority(url, destination_dir, Priority::Normal)
            .await
    }

    pub async fn create_download_with_priority<P: AsRef<Path>>(
        &self,
        url: &str,
        destination_dir: P,
        priority: Priority,
    ) -> Result<DownloadJob> {
        self.create_download_with_options(url, destination_dir, priority, None)
            .await
    }

    pub async fn create_download_with_options<P: AsRef<Path>>(
        &self,
        url: &str,
        destination_dir: P,
        priority: Priority,
        referer: Option<String>,
    ) -> Result<DownloadJob> {
        self.create_download_with_all_options(url, destination_dir, priority, referer, None)
            .await
    }

    pub async fn create_download_with_all_options<P: AsRef<Path>>(
        &self,
        url: &str,
        destination_dir: P,
        priority: Priority,
        referer: Option<String>,
        user_agent: Option<String>,
    ) -> Result<DownloadJob> {
        self.create_download_with_all_options_scheduled(
            url,
            destination_dir,
            priority,
            referer,
            user_agent,
            None,
        )
        .await
    }

    fn allocate_unique_paths(&self, dir: &Path, base_filename: &str) -> (PathBuf, PathBuf) {
        let existing_jobs = self.db.list_jobs().unwrap_or_default();
        let mut target_path = dir.join(base_filename);
        let mut counter = 1u32;

        loop {
            let temp_filename = format!(
                "{}.tdm-part",
                target_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("download.bin")
            );
            let temp_path = dir.join(&temp_filename);

            let target_norm = target_path.to_string_lossy().replace('/', "\\").to_lowercase();
            let temp_norm = temp_path.to_string_lossy().replace('/', "\\").to_lowercase();

            let used_by_existing_job = existing_jobs.iter().any(|j| {
                j.state != JobState::Cancelled && {
                    let jt = j.target_path.replace('/', "\\").to_lowercase();
                    let jtmp = j.temp_path.replace('/', "\\").to_lowercase();
                    jt == target_norm
                        || jtmp == temp_norm
                        || jt == temp_norm
                        || jtmp == target_norm
                }
            });

            if !target_path.exists() && !temp_path.exists() && !used_by_existing_job {
                return (target_path, temp_path);
            }

            let stem = Path::new(base_filename)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("file");
            let ext = Path::new(base_filename)
                .extension()
                .and_then(|s| s.to_str())
                .map(|e| format!(".{}", e))
                .unwrap_or_default();
            target_path = dir.join(format!("{} ({}){}", stem, counter, ext));
            counter += 1;
        }
    }

    fn find_active_or_completed_job_for_url(&self, trimmed_url: &str) -> Option<DownloadJob> {
        self.db.list_jobs().ok()?.into_iter().find(|j| {
            j.url == trimmed_url
                && j.state != JobState::Failed
                && j.state != JobState::Cancelled
        })
    }

    /// Idempotent handoff & creation entrypoint used by the HTTP API and Native Messaging.
    /// Coalesces concurrent/fallback creation requests for the same `handoff_id` or `url`
    /// while probing is in-flight, returning `(job, already_existed)`.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_or_coalesce_download<P: AsRef<Path>>(
        &self,
        url: &str,
        destination_dir: P,
        priority: Priority,
        referer: Option<String>,
        user_agent: Option<String>,
        scheduled_at: Option<chrono::DateTime<chrono::Utc>>,
        handoff_id: Option<&str>,
    ) -> Result<(DownloadJob, bool)> {
        self.create_or_coalesce_download_with_filename(
            url,
            destination_dir,
            priority,
            referer,
            user_agent,
            scheduled_at,
            handoff_id,
            None,
        )
        .await
    }

    /// Idempotent handoff & creation entrypoint supporting an optional suggested filename.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_or_coalesce_download_with_filename<P: AsRef<Path>>(
        &self,
        url: &str,
        destination_dir: P,
        priority: Priority,
        referer: Option<String>,
        user_agent: Option<String>,
        scheduled_at: Option<chrono::DateTime<chrono::Utc>>,
        handoff_id: Option<&str>,
        suggested_filename: Option<&str>,
    ) -> Result<(DownloadJob, bool)> {
        self.create_or_coalesce_download_inner(
            url,
            DestinationTarget::Fixed(destination_dir.as_ref()),
            priority,
            referer,
            user_agent,
            scheduled_at,
            handoff_id,
            suggested_filename,
        )
        .await
    }

    /// Idempotent handoff & creation entrypoint that resolves destination category folders after
    /// HTTP probing (`Content-Disposition`, redirects, `Content-Type`), while honoring explicit
    /// custom destination overrides.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_or_coalesce_download_to_destination(
        &self,
        url: &str,
        explicit_destination: Option<&str>,
        priority: Priority,
        referer: Option<String>,
        user_agent: Option<String>,
        scheduled_at: Option<chrono::DateTime<chrono::Utc>>,
        handoff_id: Option<&str>,
        suggested_filename: Option<&str>,
    ) -> Result<(DownloadJob, bool)> {
        self.create_or_coalesce_download_inner(
            url,
            DestinationTarget::Configured(explicit_destination),
            priority,
            referer,
            user_agent,
            scheduled_at,
            handoff_id,
            suggested_filename,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn create_or_coalesce_download_inner(
        &self,
        url: &str,
        destination_target: DestinationTarget<'_>,
        priority: Priority,
        referer: Option<String>,
        user_agent: Option<String>,
        scheduled_at: Option<chrono::DateTime<chrono::Utc>>,
        handoff_id: Option<&str>,
        suggested_filename: Option<&str>,
    ) -> Result<(DownloadJob, bool)> {
        if let DestinationTarget::Configured(Some(dest)) = destination_target {
            Self::validate_destination_path(dest)?;
        }

        let trimmed_url = url.trim();
        let clean_handoff = handoff_id.map(|s| s.trim()).filter(|s| !s.is_empty());
        // Scope handoff coalescing per URL so identical per-browser download IDs (e.g.
        // Chrome `browser_dl_1` vs Edge/Firefox `browser_dl_1`) never falsely coalesce
        // unrelated URLs across browsers or restarted browser profiles.
        let scoped_handoff = clean_handoff.map(|hid| format!("handoff:{}\0{}", hid, trimmed_url));

        // 1. Check recent handoff ID cache (120s TTL)
        if let Some(ref hid_key) = scoped_handoff {
            let cached_job_id = {
                let mut guard = self.recent_handoffs.lock().unwrap();
                let now = Instant::now();
                guard.retain(|_, (_, ts)| now.duration_since(*ts) < Duration::from_secs(120));
                guard.get(hid_key).map(|(jid, _)| jid.clone())
            };
            if let Some(jid) = cached_job_id {
                if let Ok(Some(existing)) = self.db.get_job(&jid) {
                    if existing.state != JobState::Failed
                        && existing.state != JobState::Cancelled
                        && existing.url.trim() == trimmed_url
                    {
                        return Ok((existing, true));
                    }
                }
            }
        }

        // 2. Check existing persisted jobs in SQLite
        if let Some(existing) = self.find_active_or_completed_job_for_url(trimmed_url) {
            if let Some(ref hid_key) = scoped_handoff {
                self.recent_handoffs
                    .lock()
                    .unwrap()
                    .insert(hid_key.clone(), (existing.id.clone(), Instant::now()));
            }
            return Ok((existing, true));
        }

        // 3. Check or register in-flight probe/creation for this URL / scoped handoff_id
        let inflight_key = trimmed_url.to_string();
        let existing_notify = {
            let mut map = self.in_flight_creations.lock().unwrap();
            if let Some(n) = map.get(&inflight_key) {
                Some(n.clone())
            } else if let Some(ref hid_key) = scoped_handoff {
                if let Some(n) = map.get(hid_key) {
                    Some(n.clone())
                } else {
                    let n = Arc::new(tokio::sync::Notify::new());
                    map.insert(inflight_key.clone(), n.clone());
                    map.insert(hid_key.clone(), n);
                    None
                }
            } else {
                let n = Arc::new(tokio::sync::Notify::new());
                map.insert(inflight_key.clone(), n);
                None
            }
        };

        if let Some(notify) = existing_notify {
            // Another request is currently probing this exact URL/handoff_id; wait for it to finish
            let _ = tokio::time::timeout(Duration::from_secs(20), notify.notified()).await;
            if let Some(ref hid_key) = scoped_handoff {
                let cached_job_id = self
                    .recent_handoffs
                    .lock()
                    .unwrap()
                    .get(hid_key)
                    .map(|(jid, _)| jid.clone());
                if let Some(jid) = cached_job_id {
                    if let Ok(Some(existing)) = self.db.get_job(&jid) {
                        if existing.state != JobState::Failed
                            && existing.state != JobState::Cancelled
                            && existing.url.trim() == trimmed_url
                        {
                            return Ok((existing, true));
                        }
                    }
                }
            }
            if let Some(existing) = self.find_active_or_completed_job_for_url(trimmed_url) {
                if let Some(ref hid_key) = scoped_handoff {
                    self.recent_handoffs
                        .lock()
                        .unwrap()
                        .insert(hid_key.clone(), (existing.id.clone(), Instant::now()));
                }
                return Ok((existing, true));
            }
        }

        struct InFlightCleanup<'a> {
            map: &'a Arc<Mutex<HashMap<String, Arc<tokio::sync::Notify>>>>,
            key1: String,
            key2: Option<String>,
        }
        impl<'a> Drop for InFlightCleanup<'a> {
            fn drop(&mut self) {
                if let Ok(mut guard) = self.map.lock() {
                    if let Some(n) = guard.remove(&self.key1) {
                        n.notify_waiters();
                    }
                    if let Some(ref k2) = self.key2 {
                        if let Some(n) = guard.remove(k2) {
                            n.notify_waiters();
                        }
                    }
                }
            }
        }

        let _cleanup = InFlightCleanup {
            map: &self.in_flight_creations,
            key1: inflight_key,
            key2: scoped_handoff.clone(),
        };

        let job = self
            .create_download_inner(
                trimmed_url,
                destination_target,
                priority,
                referer,
                user_agent,
                scheduled_at,
                suggested_filename,
            )
            .await?;

        if let Some(hid_key) = scoped_handoff {
            self.recent_handoffs
                .lock()
                .unwrap()
                .insert(hid_key, (job.id.clone(), Instant::now()));
        }

        Ok((job, false))
    }

    pub async fn create_download_to_destination(
        &self,
        url: &str,
        explicit_destination: Option<&str>,
        priority: Priority,
        referer: Option<String>,
        user_agent: Option<String>,
        scheduled_at: Option<chrono::DateTime<chrono::Utc>>,
    ) -> Result<DownloadJob> {
        self.create_download_inner(
            url,
            DestinationTarget::Configured(explicit_destination),
            priority,
            referer,
            user_agent,
            scheduled_at,
            None,
        )
        .await
    }

    pub async fn create_download_with_all_options_scheduled<P: AsRef<Path>>(
        &self,
        url: &str,
        destination_dir: P,
        priority: Priority,
        referer: Option<String>,
        user_agent: Option<String>,
        scheduled_at: Option<chrono::DateTime<chrono::Utc>>,
    ) -> Result<DownloadJob> {
        self.create_download_with_all_options_scheduled_and_filename(
            url,
            destination_dir,
            priority,
            referer,
            user_agent,
            scheduled_at,
            None,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create_download_with_all_options_scheduled_and_filename<P: AsRef<Path>>(
        &self,
        url: &str,
        destination_dir: P,
        priority: Priority,
        referer: Option<String>,
        user_agent: Option<String>,
        scheduled_at: Option<chrono::DateTime<chrono::Utc>>,
        suggested_filename: Option<&str>,
    ) -> Result<DownloadJob> {
        self.create_download_inner(
            url,
            DestinationTarget::Fixed(destination_dir.as_ref()),
            priority,
            referer,
            user_agent,
            scheduled_at,
            suggested_filename,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn create_download_inner(
        &self,
        url: &str,
        destination_target: DestinationTarget<'_>,
        priority: Priority,
        referer: Option<String>,
        user_agent: Option<String>,
        scheduled_at: Option<chrono::DateTime<chrono::Utc>>,
        suggested_filename: Option<&str>,
    ) -> Result<DownloadJob> {
        if let DestinationTarget::Configured(Some(dest)) = destination_target {
            Self::validate_destination_path(dest)?;
        }

        let clean_referer = referer
            .as_deref()
            .and_then(|r| crate::engine::referer::sanitize_and_validate_referer(r, url));
        let clean_user_agent = user_agent
            .as_deref()
            .and_then(crate::engine::user_agent::sanitize_and_validate_user_agent);

        let probe = crate::engine::probe::probe_url_with_options(
            &self.client,
            url,
            clean_referer.as_deref(),
            clean_user_agent.as_deref(),
        )
        .await?;

        let is_live = crate::live::detect_live_protocol(url).is_some();
        let is_hls = url.to_lowercase().contains(".m3u8")
            || probe.filename.to_lowercase().ends_with(".m3u8");
        let is_dash =
            url.to_lowercase().contains(".mpd") || probe.filename.to_lowercase().ends_with(".mpd");
        let is_torrent = url.starts_with("magnet:")
            || url.to_lowercase().ends_with(".torrent")
            || probe.filename.to_lowercase().ends_with(".torrent");
        let (job_type, base_filename) = if is_live {
            (JobType::LiveStream, sanitize_filename(&probe.filename))
        } else if is_hls {
            let mut name = sanitize_filename(&probe.filename);
            if name.to_lowercase().ends_with(".m3u8") {
                name = format!("{}.mp4", &name[..name.len() - 5]);
            }
            (JobType::HlsVod, name)
        } else if is_dash {
            let mut name = sanitize_filename(&probe.filename);
            if name.to_lowercase().ends_with(".mpd") {
                name = format!("{}.mp4", &name[..name.len() - 4]);
            }
            (JobType::DashVod, name)
        } else if is_torrent {
            (JobType::Torrent, sanitize_filename(&probe.filename))
        } else {
            (
                JobType::HttpFile,
                choose_http_filename(&probe, suggested_filename),
            )
        };

        let dir = match destination_target {
            DestinationTarget::Fixed(p) => p.to_path_buf(),
            DestinationTarget::Configured(explicit_dest) => self
                .resolve_destination_folder_with_content_type(
                    &base_filename,
                    probe.content_type.as_deref(),
                    explicit_dest,
                ),
        };
        if !dir.exists() {
            fs::create_dir_all(&dir)?;
        }

        let id = Uuid::new_v4().to_string();
        let con = self.max_connections_per_download();
        let chunks = crate::engine::planner::plan_chunks_with_concurrency(
            &id,
            probe.total_bytes,
            probe.supports_ranges,
            con,
        );

        let now = chrono::Utc::now();
        let (initial_state, final_sched) = match scheduled_at {
            Some(time) if time > now => (JobState::Scheduled, Some(time)),
            _ => (JobState::Queued, None),
        };

        let job = {
            let _alloc_guard = self.path_alloc_lock.lock().unwrap();
            let (target_path, temp_path) = self.allocate_unique_paths(&dir, &base_filename);

            let job = DownloadJob {
                id: id.clone(),
                url: url.to_string(),
                resolved_url: Some(probe.resolved_url),
                filename: target_path
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .to_string(),
                target_path: target_path.to_string_lossy().to_string(),
                temp_path: temp_path.to_string_lossy().to_string(),
                total_bytes: probe.total_bytes,
                downloaded_bytes: 0,
                state: initial_state,
                job_type,
                priority,
                etag: probe.etag,
                last_modified: probe.last_modified,
                is_resumable: probe.supports_ranges,
                chunk_count: chunks.len(),
                error_message: None,
                created_at: now,
                updated_at: now,
                thumbnail_url: extract_thumbnail_from_url(url),
                referer: clean_referer,
                user_agent: clean_user_agent,
                scheduled_at: final_sched,
            };

            self.db.insert_job(&job)?;
            self.db.save_chunks(&chunks)?;
            job
        };

        self.event_bus.emit(DownloadEvent::StateChanged {
            id: id.clone(),
            state: initial_state,
            error: None,
        });

        if initial_state == JobState::Scheduled {
            self.notify_scheduler();
        }

        Ok(job)
    }

    pub async fn create_managed_media_download<P: AsRef<Path>>(
        &self,
        url: &str,
        format_id: &str,
        filename: &str,
        destination_dir: P,
        priority: Priority,
        thumbnail_url: Option<String>,
    ) -> Result<DownloadJob> {
        self.create_managed_media_download_with_referer(
            url,
            format_id,
            filename,
            destination_dir,
            priority,
            thumbnail_url,
            None,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create_managed_media_download_with_referer<P: AsRef<Path>>(
        &self,
        url: &str,
        format_id: &str,
        filename: &str,
        destination_dir: P,
        priority: Priority,
        thumbnail_url: Option<String>,
        referer: Option<String>,
    ) -> Result<DownloadJob> {
        self.create_managed_media_download_with_options(
            url,
            format_id,
            filename,
            destination_dir,
            priority,
            thumbnail_url,
            referer,
            None,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create_managed_media_download_with_options<P: AsRef<Path>>(
        &self,
        url: &str,
        format_id: &str,
        filename: &str,
        destination_dir: P,
        priority: Priority,
        thumbnail_url: Option<String>,
        referer: Option<String>,
        user_agent: Option<String>,
    ) -> Result<DownloadJob> {
        self.create_managed_media_download_with_all_options_scheduled(
            url,
            format_id,
            filename,
            destination_dir,
            priority,
            thumbnail_url,
            referer,
            user_agent,
            None,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create_managed_media_download_with_all_options_scheduled<P: AsRef<Path>>(
        &self,
        url: &str,
        format_id: &str,
        filename: &str,
        destination_dir: P,
        priority: Priority,
        thumbnail_url: Option<String>,
        referer: Option<String>,
        user_agent: Option<String>,
        scheduled_at: Option<chrono::DateTime<chrono::Utc>>,
    ) -> Result<DownloadJob> {
        self.create_managed_media_download_with_all_options_scheduled_and_start(
            url,
            format_id,
            filename,
            destination_dir,
            priority,
            thumbnail_url,
            referer,
            user_agent,
            scheduled_at,
            true,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create_managed_media_download_with_all_options_scheduled_and_start<P: AsRef<Path>>(
        &self,
        url: &str,
        format_id: &str,
        filename: &str,
        destination_dir: P,
        priority: Priority,
        thumbnail_url: Option<String>,
        referer: Option<String>,
        user_agent: Option<String>,
        scheduled_at: Option<chrono::DateTime<chrono::Utc>>,
        auto_queue: bool,
    ) -> Result<DownloadJob> {
        let clean_referer = referer
            .as_deref()
            .and_then(|r| crate::engine::referer::sanitize_and_validate_referer(r, url));
        let clean_user_agent = user_agent
            .as_deref()
            .and_then(crate::engine::user_agent::sanitize_and_validate_user_agent);

        let dir = destination_dir.as_ref();
        if !dir.exists() {
            fs::create_dir_all(dir)?;
        }

        let base_filename = sanitize_filename(filename);
        let id = Uuid::new_v4().to_string();
        let thumb = thumbnail_url.or_else(|| extract_thumbnail_from_url(url));

        let now = chrono::Utc::now();
        let (initial_state, final_sched) = match scheduled_at {
            Some(time) if time > now => (JobState::Scheduled, Some(time)),
            _ if !auto_queue => (JobState::Paused, None),
            _ => (JobState::Queued, None),
        };

        let job = {
            let _alloc_guard = self.path_alloc_lock.lock().unwrap();
            let (target_path, temp_path) = self.allocate_unique_paths(dir, &base_filename);

            let job = DownloadJob {
                id: id.clone(),
                url: url.to_string(),
                resolved_url: Some(format_id.to_string()),
                filename: target_path
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .to_string(),
                target_path: target_path.to_str().unwrap().to_string(),
                temp_path: temp_path.to_str().unwrap().to_string(),
                total_bytes: None,
                downloaded_bytes: 0,
                state: initial_state,
                job_type: JobType::ManagedMedia,
                priority,
                etag: None,
                last_modified: None,
                is_resumable: true,
                chunk_count: 1,
                error_message: None,
                created_at: now,
                updated_at: now,
                thumbnail_url: thumb,
                referer: clean_referer,
                user_agent: clean_user_agent,
                scheduled_at: final_sched,
            };

            self.db.insert_job(&job)?;
            job
        };

        self.event_bus.emit(DownloadEvent::StateChanged {
            id: id.clone(),
            state: initial_state,
            error: None,
        });

        if initial_state == JobState::Scheduled {
            self.notify_scheduler();
        } else if auto_queue {
            let _ = self.process_queue();
        }

        Ok(job)
    }

    pub fn set_priority(&self, id: &str, priority: Priority) -> Result<()> {
        self.db.update_priority(id, priority)?;
        let _ = self.process_queue();
        Ok(())
    }

    pub fn start_download(&self, id: &str) -> Result<()> {
        Self::start_job_internal(
            id,
            &self.db,
            &self.event_bus,
            &self.client,
            &self.governor,
            &self.adaptive_scheduler,
            &self.torrent_manager,
            &self.active_tokens,
            &self.stop_tokens,
            &self.max_active_jobs,
            &self.rate_limiter,
            &self.job_rate_limiters,
            &self.active_job_telemetry,
            &self.max_retries,
            &self.dynamic_segmentation,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn start_job_internal(
        id: &str,
        db: &Database,
        event_bus: &EventBus,
        client: &Client,
        governor: &Arc<ConcurrencyGovernor>,
        adaptive_scheduler: &Arc<AdaptiveScheduler>,
        torrent_manager: &Arc<tokio::sync::OnceCell<Arc<crate::torrent::TorrentSessionManager>>>,
        active_tokens: &Arc<Mutex<HashMap<String, CancellationToken>>>,
        stop_tokens: &Arc<Mutex<HashMap<String, CancellationToken>>>,
        max_active_jobs: &Arc<AtomicUsize>,
        rate_limiter: &Arc<BandwidthLimiter>,
        job_rate_limiters: &Arc<Mutex<HashMap<String, Arc<BandwidthLimiter>>>>,
        active_job_telemetry: &Arc<Mutex<HashMap<String, ActiveJobTelemetry>>>,
        max_retries: &Arc<AtomicUsize>,
        dynamic_segmentation: &Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<()> {
        let job = match db.get_job(id)? {
            Some(j) => j,
            None => return Err(EngineError::JobNotFound(id.to_string())),
        };

        if job.state == JobState::Completed || job.state == JobState::Cancelled {
            return Ok(());
        }

        if job.scheduled_at.is_some() {
            let _ = db.update_job_scheduled_at(id, None);
        }

        let mut tokens = active_tokens.lock().unwrap();
        if tokens.contains_key(id) {
            // Already running
            return Ok(());
        }

        let max_jobs = max_active_jobs.load(Ordering::SeqCst);
        if max_jobs > 0 && tokens.len() >= max_jobs {
            // Configured maximum active downloads reached: keep job in Queued state for automatic dispatch
            drop(tokens);
            let _ = db.update_job_state(id, JobState::Queued, None);
            event_bus.emit(DownloadEvent::StateChanged {
                id: id.to_string(),
                state: JobState::Queued,
                error: None,
            });
            return Ok(());
        }

        let cancel_token = CancellationToken::new();
        tokens.insert(id.to_string(), cancel_token.clone());
        drop(tokens);

        let stop_token = CancellationToken::new();
        stop_tokens
            .lock()
            .unwrap()
            .insert(id.to_string(), stop_token.clone());

        let initial_state = if (job.job_type == JobType::Torrent
            && (job.total_bytes.is_none() || job.total_bytes == Some(0)))
            || job.url.starts_with("magnet:")
        {
            JobState::Probing
        } else {
            JobState::Downloading
        };

        db.update_job_state(id, initial_state, None)?;
        event_bus.emit(DownloadEvent::StateChanged {
            id: id.to_string(),
            state: initial_state,
            error: None,
        });
        event_bus.emit(DownloadEvent::OpenProgressWindow {
            id: id.to_string(),
        });

        let client_c = client.clone();
        let db_c = db.clone();
        let event_bus_c = event_bus.clone();
        let governor_c = governor.clone();
        let scheduler_c = adaptive_scheduler.clone();
        let torrent_manager_c = torrent_manager.clone();
        let active_tokens_c = active_tokens.clone();
        let stop_tokens_c = stop_tokens.clone();
        let max_jobs_c = max_active_jobs.clone();
        let limiter_c = rate_limiter.clone();
        let job_limiter_c = Self::job_limiter_for_id(id, db, job_rate_limiters);
        let telemetry_c = active_job_telemetry.clone();
        let max_retries_c = max_retries.load(Ordering::Relaxed) as u32;
        let dynamic_seg_c = dynamic_segmentation.load(Ordering::Relaxed);
        let limiter_for_queued = rate_limiter.clone();
        let job_limiters_for_queued = job_rate_limiters.clone();
        let telemetry_for_queued = active_job_telemetry.clone();
        let retries_for_queued = max_retries.clone();
        let dynamic_for_queued = dynamic_segmentation.clone();
        let download_id = id.to_string();

        tokio::spawn(async move {
            let res = Self::run_download_task(
                client_c.clone(),
                db_c.clone(),
                event_bus_c.clone(),
                governor_c.clone(),
                scheduler_c.clone(),
                torrent_manager_c.clone(),
                download_id.clone(),
                cancel_token,
                stop_token,
                limiter_c,
                job_limiter_c,
                telemetry_c.clone(),
                max_retries_c,
                dynamic_seg_c,
            )
            .await;

            telemetry_c.lock().unwrap().remove(&download_id);

            let mut tokens = active_tokens_c.lock().unwrap();
            tokens.remove(&download_id);
            let active_count = tokens.len();
            drop(tokens);

            let mut stops = stop_tokens_c.lock().unwrap();
            stops.remove(&download_id);
            drop(stops);

            match res {
                Ok(_) => {
                    tracing::info!("Download {} completed successfully", download_id);
                }
                Err(EngineError::Cancelled) => {
                    if let Ok(chunks) = db_c.get_chunks(&download_id) {
                        let sum: u64 = chunks.iter().map(|c| c.written_bytes).sum();
                        if sum > 0 {
                            let _ = db_c.update_downloaded_bytes(&download_id, sum);
                        }
                    }
                    tracing::info!("Download {} was paused/cancelled", download_id);
                }
                Err(e) => {
                    if let Ok(chunks) = db_c.get_chunks(&download_id) {
                        let sum: u64 = chunks.iter().map(|c| c.written_bytes).sum();
                        if sum > 0 {
                            let _ = db_c.update_downloaded_bytes(&download_id, sum);
                        }
                    }
                    tracing::error!("Download {} failed: {}", download_id, e);
                    let _ =
                        db_c.update_job_state(&download_id, JobState::Failed, Some(&e.to_string()));
                    event_bus_c.emit(DownloadEvent::StateChanged {
                        id: download_id,
                        state: JobState::Failed,
                        error: Some(e.to_string()),
                    });
                }
            }

            // Real priority queue scheduling: automatically advance next queued jobs up to max_active_jobs!
            let max_jobs = max_jobs_c.load(Ordering::SeqCst);
            let mut current_active = active_count;
            while current_active < max_jobs {
                if let Ok(Some(next_job)) = db_c.get_next_queued_job() {
                    let _ = Self::start_job_internal(
                        &next_job.id,
                        &db_c,
                        &event_bus_c,
                        &client_c,
                        &governor_c,
                        &scheduler_c,
                        &torrent_manager_c,
                        &active_tokens_c,
                        &stop_tokens_c,
                        &max_jobs_c,
                        &limiter_for_queued,
                        &job_limiters_for_queued,
                        &telemetry_for_queued,
                        &retries_for_queued,
                        &dynamic_for_queued,
                    );
                    let new_active = active_tokens_c.lock().unwrap().len();
                    if new_active <= current_active {
                        break;
                    }
                    current_active = new_active;
                } else {
                    break;
                }
            }
        });

        Ok(())
    }

    pub fn stop_recording(&self, id: &str) -> Result<()> {
        let tokens = self.stop_tokens.lock().unwrap();
        if let Some(token) = tokens.get(id) {
            token.cancel();
            return Ok(());
        }
        drop(tokens);

        // Fallback: if active, cancel active token to finish process
        let active = self.active_tokens.lock().unwrap();
        if let Some(tok) = active.get(id) {
            tok.cancel();
        }
        Ok(())
    }

    pub fn pause_download(&self, id: &str) -> Result<()> {
        if let Ok(Some(job)) = self.db.get_job(id) {
            if job.job_type == JobType::LiveStream {
                // Live streams cannot be paused; pausing finalizes the recording
                return self.stop_recording(id);
            }
            if job.scheduled_at.is_some() {
                let _ = self.db.update_job_scheduled_at(id, None);
                self.notify_scheduler();
            }
        }

        let mut tokens = self.active_tokens.lock().unwrap();
        if let Some(token) = tokens.remove(id) {
            token.cancel();
        }
        drop(tokens);
        self.db.update_job_state(id, JobState::Paused, None)?;
        self.event_bus.emit(DownloadEvent::StateChanged {
            id: id.to_string(),
            state: JobState::Paused,
            error: None,
        });
        let _ = self.process_queue();
        Ok(())
    }

    pub fn resume_download(&self, id: &str) -> Result<()> {
        self.start_download(id)
    }

    pub fn cancel_download(&self, id: &str) -> Result<()> {
        let mut tokens = self.active_tokens.lock().unwrap();
        if let Some(token) = tokens.remove(id) {
            token.cancel();
        }
        drop(tokens);
        let _ = self.db.update_job_scheduled_at(id, None);
        self.notify_scheduler();
        self.db.update_job_state(id, JobState::Cancelled, None)?;
        self.event_bus.emit(DownloadEvent::StateChanged {
            id: id.to_string(),
            state: JobState::Cancelled,
            error: None,
        });
        let _ = self.process_queue();
        Ok(())
    }

    pub fn retry_download(&self, id: &str) -> Result<()> {
        self.pause_download(id)?;

        let job = match self.db.get_job(id)? {
            Some(j) => j,
            None => return Err(EngineError::JobNotFound(id.to_string())),
        };

        // Reset chunks, temp file and partial downloads
        let _ = fs::remove_file(&job.temp_path);
        let _ = fs::remove_file(&job.target_path);
        crate::resolver::downloader::cleanup_partial_files(&job.target_path);
        self.db.reset_job_for_restart(id)?;

        let con = self.max_connections_per_download();
        let chunks = crate::engine::planner::plan_chunks_with_concurrency(
            &job.id,
            job.total_bytes,
            job.is_resumable,
            con,
        );
        self.db.save_chunks(&chunks)?;

        self.start_download(id)
    }

    pub fn list_downloads(&self) -> Result<Vec<DownloadJob>> {
        self.db.list_jobs()
    }

    pub fn get_download(&self, id: &str) -> Result<Option<DownloadJob>> {
        self.db.get_job(id)
    }

    pub fn get_chunks(&self, id: &str) -> Result<Vec<crate::types::ChunkRecord>> {
        self.db.get_chunks(id)
    }

    pub fn delete_download(&self, id: &str, delete_files: bool) -> Result<()> {
        let _ = self.cancel_download(id);

        if let Ok(Some(job)) = self.db.get_job(id) {
            if delete_files {
                let _ = fs::remove_file(&job.temp_path);
                let _ = fs::remove_file(&job.target_path);
                crate::resolver::downloader::cleanup_partial_files(&job.target_path);
            }
            // Remove cached thumbnail if present
            let cache_file = crate::engine::get_thumbnail_cache_dir().join(format!("{}.jpg", id));
            let _ = fs::remove_file(cache_file);
        }

        self.db.delete_job(id)?;
        let _ = self.db.delete_setting(&format!("job_speed_limit:{}", id));
        let _ = self.db.delete_setting(&format!("job_completion_opts:{}", id));
        self.job_rate_limiters.lock().unwrap().remove(id);
        self.active_job_telemetry.lock().unwrap().remove(id);
        self.event_bus
            .emit(DownloadEvent::Deleted { id: id.to_string() });
        let _ = self.process_queue();
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_download_task(
        client: Client,
        db: Database,
        event_bus: EventBus,
        governor: Arc<ConcurrencyGovernor>,
        adaptive_scheduler: Arc<AdaptiveScheduler>,
        torrent_manager: Arc<tokio::sync::OnceCell<Arc<crate::torrent::TorrentSessionManager>>>,
        download_id: String,
        cancel_token: CancellationToken,
        stop_token: CancellationToken,
        rate_limiter: Arc<BandwidthLimiter>,
        job_rate_limiter: Arc<BandwidthLimiter>,
        telemetry_registry: Arc<Mutex<HashMap<String, ActiveJobTelemetry>>>,
        max_retries: u32,
        dynamic_segmentation: bool,
    ) -> Result<()> {
        let mut job = match db.get_job(&download_id)? {
            Some(j) => j,
            None => return Err(EngineError::JobNotFound(download_id)),
        };

        if job.job_type == JobType::LiveStream {
            return crate::live::record_live_stream(
                &job,
                &db,
                &event_bus,
                &cancel_token,
                &stop_token,
                None,
            )
            .await;
        }

        if job.job_type == JobType::HlsVod {
            return crate::hls::download_hls_vod(
                &client,
                &job,
                &db,
                &event_bus,
                &governor,
                &cancel_token,
            )
            .await;
        }

        if job.job_type == JobType::DashVod {
            return crate::dash::download_dash_vod(
                &client,
                &job,
                &db,
                &event_bus,
                &governor,
                &cancel_token,
            )
            .await;
        }

        if job.job_type == JobType::Torrent {
            let tm = torrent_manager
                .get_or_try_init(|| async {
                    let base_dir = Path::new(&job.target_path)
                        .parent()
                        .unwrap_or_else(|| Path::new("."))
                        .to_path_buf();
                    let mgr = crate::torrent::TorrentSessionManager::new(
                        base_dir,
                        crate::torrent::TorrentSessionConfig::default(),
                    )
                    .await?;
                    Ok::<_, EngineError>(Arc::new(mgr))
                })
                .await?;
            return crate::torrent::download_torrent(
                &client,
                tm.session(),
                &job,
                &db,
                &event_bus,
                &cancel_token,
            )
            .await;
        }

        if job.job_type == JobType::ManagedMedia {
            return crate::resolver::download_managed_media(&job, &db, &event_bus, &cancel_token)
                .await;
        }

        let temp_path = PathBuf::from(&job.temp_path);
        let target_path = PathBuf::from(&job.target_path);

        // Resume validation: if we have existing progress, probe to ensure server resource didn't change
        let existing_chunks = db.get_chunks(&download_id)?;
        let initial_written: u64 = existing_chunks.iter().map(|c| c.written_bytes).sum();

        if initial_written > 0 && job.is_resumable {
            // Re-probe to check ETag, Last-Modified, Content-Length, and Range support match
            if let Ok(probe) = crate::engine::probe::probe_url_with_options(
                &client,
                &job.url,
                job.referer.as_deref(),
                job.user_agent.as_deref(),
            )
            .await
            {
                let mut representation_changed = false;
                if let (Some(expected_etag), Some(new_etag)) = (&job.etag, &probe.etag) {
                    if expected_etag != new_etag {
                        representation_changed = true;
                    }
                }
                if let (Some(expected_lm), Some(new_lm)) =
                    (&job.last_modified, &probe.last_modified)
                {
                    if expected_lm != new_lm {
                        representation_changed = true;
                    }
                }
                if let (Some(expected_len), Some(new_len)) = (job.total_bytes, probe.total_bytes) {
                    if expected_len != new_len {
                        representation_changed = true;
                    }
                }
                if !probe.supports_ranges {
                    representation_changed = true;
                }

                if representation_changed {
                    tracing::warn!("Resource representation changed on server. Invalidating stale chunks for {}", download_id);
                    let _ = fs::remove_file(&temp_path);
                    db.reset_job_for_restart(&download_id)?;
                    let fresh_chunks =
                        plan_chunks(&download_id, probe.total_bytes, probe.supports_ranges);
                    db.save_chunks(&fresh_chunks)?;
                    db.update_probe_metadata(
                        &download_id,
                        Some(&probe.resolved_url),
                        probe.total_bytes,
                        probe.etag.as_deref(),
                        probe.last_modified.as_deref(),
                        probe.supports_ranges,
                        fresh_chunks.len(),
                    )?;
                    job.total_bytes = probe.total_bytes;
                    job.etag = probe.etag;
                    job.last_modified = probe.last_modified;
                    job.is_resumable = probe.supports_ranges;
                }
            }
        }

        // Missing or truncated partial file check (after validator check)
        let current_chunks = db.get_chunks(&download_id)?;
        let current_written: u64 = current_chunks.iter().map(|c| c.written_bytes).sum();
        if current_written > 0
            && (!temp_path.exists() || fs::metadata(&temp_path).map(|m| m.len()).unwrap_or(0) == 0)
        {
            tracing::warn!(
                "Partial file missing or empty on disk for {}. Resetting chunk progress.",
                download_id
            );
            let _ = fs::remove_file(&temp_path);
            db.reset_job_for_restart(&download_id)?;
            let fresh_chunks = plan_chunks(&download_id, job.total_bytes, job.is_resumable);
            db.save_chunks(&fresh_chunks)?;
        }

        let writer = PartFileWriter::open_or_create_for_job_async(
            &temp_path,
            job.total_bytes,
            Some(download_id.clone()),
            Some(cancel_token.clone()),
        )
        .await?;
        let mut chunks = db.get_chunks(&download_id)?;
        let can_parallel_write =
            writer.is_sparse() || job.total_bytes.unwrap_or(0) <= 64 * 1024 * 1024;
        if job.is_resumable
            && !can_parallel_write
            && chunks.len() > 1
            && chunks.iter().skip(1).all(|c| c.written_bytes == 0)
        {
            chunks = crate::engine::planner::plan_chunks_with_concurrency(
                &download_id,
                job.total_bytes,
                true,
                1,
            );
            let _ = db.reset_job_for_restart(&download_id);
            let _ = db.save_chunks(&chunks);
            let _ = db.update_job_state(&download_id, JobState::Downloading, None);
        }

        let current_downloaded: u64 = chunks.iter().map(|c| c.written_bytes).sum();
        let total_downloaded_atomic = Arc::new(AtomicU64::new(current_downloaded));

        // Progress reporter loop
        let progress_cancel = cancel_token.clone();
        let progress_download_id = download_id.clone();
        let progress_event_bus = event_bus.clone();
        let progress_total_bytes = job.total_bytes;
        let progress_counter = total_downloaded_atomic.clone();
        let progress_db = db.clone();

        let cancel_for_progress = progress_cancel.clone();
        let progress_handle = tokio::spawn(async move {
            let mut last_bytes = progress_counter.load(Ordering::Relaxed);
            let mut last_db_persisted = last_bytes;
            let mut last_time = Instant::now();
            let mut ticks: u32 = 0;

            loop {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(250)) => {
                        ticks = ticks.wrapping_add(1);
                        let now = Instant::now();
                        let current_bytes = progress_counter.load(Ordering::Relaxed);
                        let elapsed_secs = (now - last_time).as_secs_f64();

                        if elapsed_secs > 0.05 {
                            let diff = current_bytes.saturating_sub(last_bytes);
                            let speed = (diff as f64 / elapsed_secs) as u64;

                            let eta = if speed > 0 {
                                progress_total_bytes.map(|total| {
                                    total.saturating_sub(current_bytes) / speed
                                })
                            } else {
                                None
                            };

                            progress_event_bus.emit(DownloadEvent::Progress(DownloadProgress {
                                id: progress_download_id.clone(),
                                downloaded_bytes: current_bytes,
                                total_bytes: progress_total_bytes,
                                speed_bps: speed,
                                eta_seconds: eta,
                                state: JobState::Downloading,
                                error_message: None,
                            }));

                            if ticks % 8 == 0 && current_bytes > last_db_persisted {
                                let _ = progress_db.update_downloaded_bytes(&progress_download_id, current_bytes);
                                last_db_persisted = current_bytes;
                            }

                            last_bytes = current_bytes;
                            last_time = now;
                        }
                    }
                    _ = cancel_for_progress.cancelled() => {
                        break;
                    }
                }
            }
        });

        // Execute download: adaptive multi-chunk work redistribution or stream
        let download_result: Result<()> = if job.is_resumable && !chunks.is_empty() {
            let effective_url_str = job.resolved_url.as_deref().unwrap_or(&job.url);
            let host = url::Url::parse(effective_url_str)
                .ok()
                .and_then(|u| u.host_str().map(|h| h.to_string()))
                .unwrap_or_else(|| "default".to_string());

            let lower_u = effective_url_str.to_lowercase();
            let is_presigned_cdn = lower_u.contains("?v=")
                || lower_u.contains("&v=")
                || lower_u.contains("token=")
                || lower_u.contains("sig=")
                || lower_u.contains("signature=")
                || lower_u.contains("x-amz-signature=")
                || lower_u.contains("expires=");

            let active_chunk_bounds: Arc<Mutex<HashMap<usize, Arc<AtomicU64>>>> =
                Arc::new(Mutex::new(HashMap::new()));
            let active_chunk_progress: Arc<Mutex<HashMap<usize, Arc<AtomicU64>>>> =
                Arc::new(Mutex::new(HashMap::new()));
            let mut join_set: JoinSet<(usize, Result<u64>)> = JoinSet::new();

            let mut effective_max_concurrency = adaptive_scheduler
                .max_concurrency()
                .min(governor.max_connections_per_host().max(1));
            if !can_parallel_write {
                effective_max_concurrency = 1;
            } else if is_presigned_cdn {
                effective_max_concurrency = effective_max_concurrency.min(4);
            }

            telemetry_registry.lock().unwrap().insert(
                download_id.clone(),
                ActiveJobTelemetry {
                    active_chunk_bounds: active_chunk_bounds.clone(),
                    active_chunk_progress: active_chunk_progress.clone(),
                    stream_downloaded: total_downloaded_atomic.clone(),
                    is_stream_mode: Arc::new(AtomicBool::new(false)),
                    max_connections: Arc::new(AtomicUsize::new(effective_max_concurrency)),
                },
            );

            // Spawn initial workers respecting Governor per-host & global connection permits
            for chunk in &chunks {
                if chunk.is_complete {
                    continue;
                }
                if join_set.len() >= effective_max_concurrency {
                    break;
                }

                let permit = match governor.acquire_permit(&host) {
                    Some(p) => Some(p),
                    None if join_set.is_empty() => None, // Guarantee at least 1 active worker for this job
                    None => break,
                };

                let bound = Arc::new(AtomicU64::new(chunk.end_byte));
                let progress = Arc::new(AtomicU64::new(chunk.written_bytes));
                active_chunk_bounds
                    .lock()
                    .unwrap()
                    .insert(chunk.chunk_index, bound.clone());
                active_chunk_progress
                    .lock()
                    .unwrap()
                    .insert(chunk.chunk_index, progress.clone());

                let mut chunk_copy = chunk.clone();
                let client_c = client.clone();
                let url_c = job.resolved_url.clone().unwrap_or_else(|| job.url.clone());
                let etag_c = job.etag.clone();
                let lm_c = job.last_modified.clone();
                let referer_c = job.referer.clone();
                let user_agent_c = job.user_agent.clone();
                let writer_c = writer.clone();
                let db_c = db.clone();
                let cancel_c = cancel_token.clone();
                let counter_c = total_downloaded_atomic.clone();
                let limiter_c = rate_limiter.clone();
                let job_limiter_c = job_rate_limiter.clone();

                join_set.spawn(async move {
                    let _p = permit;
                    let idx = chunk_copy.chunk_index;
                    let res = download_chunk_with_limiters(
                        &client_c,
                        &url_c,
                        etag_c.as_deref(),
                        lm_c.as_deref(),
                        &mut chunk_copy,
                        &writer_c,
                        &db_c,
                        &cancel_c,
                        Some(bound),
                        Some(progress),
                        Some(&limiter_c),
                        Some(&job_limiter_c),
                        Some(max_retries),
                        referer_c.as_deref(),
                        user_agent_c.as_deref(),
                        |written| {
                            counter_c.fetch_add(written, Ordering::Relaxed);
                        },
                    )
                    .await;
                    (idx, res.map(|()| chunk_copy.written_bytes))
                });
            }

            let mut first_error: Option<EngineError> = None;
            let mut consecutive_worker_failures: usize = 0;

            while let Some(join_res) = tokio::select! {
                _ = cancel_token.cancelled() => {
                    join_set.abort_all();
                    return Err(EngineError::Cancelled);
                }
                res = join_set.join_next() => res,
            } {
                let (chunk_idx, worker_res) = match join_res {
                    Ok(r) => r,
                    Err(join_err) => {
                        if first_error.is_none() {
                            first_error = Some(EngineError::Other(join_err.to_string()));
                        }
                        break;
                    }
                };

                active_chunk_bounds.lock().unwrap().remove(&chunk_idx);
                active_chunk_progress.lock().unwrap().remove(&chunk_idx);

                match worker_res {
                    Ok(_) => {
                        consecutive_worker_failures = 0;
                    }
                    Err(e) => {
                        if matches!(e, EngineError::Cancelled) || cancel_token.is_cancelled() {
                            join_set.abort_all();
                            return Err(EngineError::Cancelled);
                        }

                        let is_fatal = matches!(
                            e,
                            EngineError::DiskWrite(_)
                                | EngineError::Io(_)
                                | EngineError::ETagMismatch { .. }
                                | EngineError::MismatchedContentRange { .. }
                        );
                        if is_fatal {
                            first_error = Some(e);
                            join_set.abort_all();
                            break;
                        }

                        consecutive_worker_failures += 1;
                        effective_max_concurrency = join_set.len().max(1);

                        if join_set.is_empty() && consecutive_worker_failures >= 3 {
                            first_error = Some(e);
                            break;
                        }

                        tracing::warn!(
                            "Chunk {} worker failed ({}); scaling max concurrency to {} and redistributing remaining work",
                            chunk_idx,
                            e,
                            effective_max_concurrency
                        );
                    }
                }

                if cancel_token.is_cancelled() {
                    join_set.abort_all();
                    return Err(EngineError::Cancelled);
                }

                // Adaptive Work Redistribution:
                let current_chunks = db.get_chunks(&download_id)?;
                let bounds_guard = active_chunk_bounds.lock().unwrap();
                let unassigned = current_chunks
                    .iter()
                    .find(|c| !c.is_complete && !bounds_guard.contains_key(&c.chunk_index))
                    .cloned();
                drop(bounds_guard);

                if let Some(next_chunk) = unassigned {
                    if join_set.len() < effective_max_concurrency {
                        let permit = match governor.acquire_permit(&host) {
                            Some(p) => Some(p),
                            None if join_set.is_empty() => None,
                            None => None,
                        };
                        if permit.is_some() || join_set.is_empty() {
                            let bound = Arc::new(AtomicU64::new(next_chunk.end_byte));
                            let progress = Arc::new(AtomicU64::new(next_chunk.written_bytes));
                            active_chunk_bounds
                                .lock()
                                .unwrap()
                                .insert(next_chunk.chunk_index, bound.clone());
                            active_chunk_progress
                                .lock()
                                .unwrap()
                                .insert(next_chunk.chunk_index, progress.clone());

                            let mut chunk_copy = next_chunk;
                            let client_c = client.clone();
                            let url_c =
                                job.resolved_url.clone().unwrap_or_else(|| job.url.clone());
                            let etag_c = job.etag.clone();
                            let lm_c = job.last_modified.clone();
                            let referer_c = job.referer.clone();
                            let user_agent_c = job.user_agent.clone();
                            let writer_c = writer.clone();
                            let db_c = db.clone();
                            let cancel_c = cancel_token.clone();
                            let counter_c = total_downloaded_atomic.clone();
                            let limiter_c = rate_limiter.clone();
                            let job_limiter_c = job_rate_limiter.clone();

                            join_set.spawn(async move {
                                let _p = permit;
                                let idx = chunk_copy.chunk_index;
                                let res = download_chunk_with_limiters(
                                    &client_c,
                                    &url_c,
                                    etag_c.as_deref(),
                                    lm_c.as_deref(),
                                    &mut chunk_copy,
                                    &writer_c,
                                    &db_c,
                                    &cancel_c,
                                    Some(bound),
                                    Some(progress),
                                    Some(&limiter_c),
                                    Some(&job_limiter_c),
                                    Some(max_retries),
                                    referer_c.as_deref(),
                                    user_agent_c.as_deref(),
                                    |written| {
                                        counter_c.fetch_add(written, Ordering::Relaxed);
                                    },
                                )
                                .await;
                                (idx, res.map(|()| chunk_copy.written_bytes))
                            });
                        }
                    }
                } else if dynamic_segmentation
                    && consecutive_worker_failures == 0
                    && join_set.len() < effective_max_concurrency
                {
                    // Safe Straggler Tail Splitting (using live in-memory atomic progress):
                    let mut live_chunks = current_chunks.clone();
                    {
                        let prog_guard = active_chunk_progress.lock().unwrap();
                        for c in &mut live_chunks {
                            if let Some(p) = prog_guard.get(&c.chunk_index) {
                                c.written_bytes = c.written_bytes.max(p.load(Ordering::SeqCst));
                            }
                        }
                    }
                    if let Some(plan) = adaptive_scheduler.evaluate_straggler_split(&live_chunks)
                    {
                        if let Some(permit) = governor.acquire_permit(&host) {
                            let orig_bound_opt = active_chunk_bounds
                                .lock()
                                .unwrap()
                                .get(&plan.original_index)
                                .cloned();
                            let orig_prog_opt = active_chunk_progress
                                .lock()
                                .unwrap()
                                .get(&plan.original_index)
                                .cloned();

                            if let (Some(orig_bound), Some(orig_prog)) =
                                (orig_bound_opt, orig_prog_opt)
                            {
                                let orig_chunk = live_chunks
                                    .iter()
                                    .find(|c| c.chunk_index == plan.original_index);
                                let orig_start = orig_chunk.map(|c| c.start_byte).unwrap_or(0);
                                let current_w = orig_prog.load(Ordering::SeqCst);

                                // Invariant: original worker has NOT already written past the proposed split start
                                if orig_start + current_w < plan.split_start {
                                    // Clamp original worker's boundary first
                                    orig_bound.store(plan.new_end_for_original, Ordering::SeqCst);

                                    // Re-verify progress after atomic store
                                    let recheck_w = orig_prog.load(Ordering::SeqCst);
                                    if orig_start + recheck_w <= plan.split_start
                                        && db
                                            .split_chunk(
                                                &download_id,
                                                plan.original_index,
                                                plan.new_index,
                                                plan.new_end_for_original,
                                                plan.split_start,
                                                plan.original_end,
                                            )
                                            .is_ok()
                                    {
                                        let bound = Arc::new(AtomicU64::new(plan.original_end));
                                        let progress = Arc::new(AtomicU64::new(0));
                                        active_chunk_bounds
                                            .lock()
                                            .unwrap()
                                            .insert(plan.new_index, bound.clone());
                                        active_chunk_progress
                                            .lock()
                                            .unwrap()
                                            .insert(plan.new_index, progress.clone());

                                        let mut new_chunk = ChunkRecord {
                                            id: None,
                                            download_id: download_id.clone(),
                                            chunk_index: plan.new_index,
                                            start_byte: plan.split_start,
                                            end_byte: plan.original_end,
                                            written_bytes: 0,
                                            is_complete: false,
                                        };

                                        let client_c = client.clone();
                                        let url_c = job
                                            .resolved_url
                                            .clone()
                                            .unwrap_or_else(|| job.url.clone());
                                        let etag_c = job.etag.clone();
                                        let lm_c = job.last_modified.clone();
                                        let referer_c = job.referer.clone();
                                        let user_agent_c = job.user_agent.clone();
                                        let writer_c = writer.clone();
                                        let db_c = db.clone();
                                        let cancel_c = cancel_token.clone();
                                        let counter_c = total_downloaded_atomic.clone();
                                        let limiter_c = rate_limiter.clone();
                                        let job_limiter_c = job_rate_limiter.clone();

                                        join_set.spawn(async move {
                                            let _p = permit;
                                            let idx = new_chunk.chunk_index;
                                            let res = download_chunk_with_limiters(
                                                &client_c,
                                                &url_c,
                                                etag_c.as_deref(),
                                                lm_c.as_deref(),
                                                &mut new_chunk,
                                                &writer_c,
                                                &db_c,
                                                &cancel_c,
                                                Some(bound),
                                                Some(progress),
                                                Some(&limiter_c),
                                                Some(&job_limiter_c),
                                                Some(max_retries),
                                                referer_c.as_deref(),
                                                user_agent_c.as_deref(),
                                                |written| {
                                                    counter_c.fetch_add(written, Ordering::Relaxed);
                                                },
                                            )
                                            .await;
                                            (idx, res.map(|()| new_chunk.written_bytes))
                                        });
                                    } else {
                                        // Split aborted because original worker raced past split_start; restore original end bound!
                                        orig_bound.store(plan.original_end, Ordering::SeqCst);
                                    }
                                }
                            }
                        }
                    }
                }
            }

            if cancel_token.is_cancelled() {
                join_set.abort_all();
                Err(EngineError::Cancelled)
            } else if let Some(e) = first_error {
                Err(e)
            } else {
                Ok(())
            }
        } else {
            // Single chunk or non-range streaming (or non-sparse large file fallback)
            if chunks.len() > 1 {
                // Re-plan as a single sequential chunk if falling back on non-sparse filesystem
                let single = crate::engine::planner::plan_chunks_with_concurrency(
                    &download_id,
                    job.total_bytes,
                    false,
                    1,
                );
                let _ = db.reset_job_for_restart(&download_id);
                let _ = db.save_chunks(&single);
                let _ = db.update_job_state(&download_id, JobState::Downloading, None);
            }
            let url = job.resolved_url.clone().unwrap_or_else(|| job.url.clone());
            let counter = total_downloaded_atomic.clone();

            telemetry_registry.lock().unwrap().insert(
                download_id.clone(),
                ActiveJobTelemetry {
                    active_chunk_bounds: Arc::new(Mutex::new(HashMap::new())),
                    active_chunk_progress: Arc::new(Mutex::new(HashMap::new())),
                    stream_downloaded: total_downloaded_atomic.clone(),
                    is_stream_mode: Arc::new(AtomicBool::new(true)),
                    max_connections: Arc::new(AtomicUsize::new(1)),
                },
            );

            let bytes_written = download_stream_with_limiters(
                &client,
                &url,
                &writer,
                &db,
                &download_id,
                &cancel_token,
                Some(&rate_limiter),
                Some(&job_rate_limiter),
                Some(max_retries),
                job.referer.as_deref(),
                job.user_agent.as_deref(),
                |written| {
                    counter.fetch_add(written, Ordering::Relaxed);
                },
            )
            .await?;

            if let Some(mut chunk) = db.get_chunks(&download_id)?.into_iter().next() {
                chunk.written_bytes = bytes_written;
                chunk.is_complete = true;
                db.save_chunks(&[chunk])?;
            }

            Ok(())
        };

        telemetry_registry.lock().unwrap().remove(&download_id);

        // Stop progress loop
        progress_cancel.cancel();
        let _ = progress_handle.await;

        if let Err(e) = download_result {
            if matches!(e, EngineError::Cancelled) {
                return Err(EngineError::Cancelled);
            }
            return Err(e);
        }

        // Completion phase:
        db.update_job_state(&download_id, JobState::Verifying, None)?;
        event_bus.emit(DownloadEvent::StateChanged {
            id: download_id.clone(),
            state: JobState::Verifying,
            error: None,
        });

        // Ensure all bytes flushed to disk without blocking Tokio threads
        writer.sync_async().await?;
        drop(writer);

        let final_chunks = db.get_chunks(&download_id)?;
        let total_downloaded = crate::engine::writer::verify_chunks_complete_and_contiguous(
            &final_chunks,
            job.total_bytes,
            &temp_path,
        )?;

        // Atomic publish: rename .tdm-part to final destination with retry backoff for Windows locks
        Self::publish_final_file(&temp_path, &target_path).await?;

        db.update_downloaded_bytes(&download_id, total_downloaded)?;
        db.update_job_state(&download_id, JobState::Completed, None)?;

        event_bus.emit(DownloadEvent::Progress(DownloadProgress {
            id: download_id.clone(),
            downloaded_bytes: total_downloaded,
            total_bytes: Some(total_downloaded),
            speed_bps: 0,
            eta_seconds: Some(0),
            state: JobState::Completed,
            error_message: None,
        }));

        event_bus.emit(DownloadEvent::StateChanged {
            id: download_id,
            state: JobState::Completed,
            error: None,
        });

        Ok(())
    }

    async fn publish_final_file(temp_path: &Path, target_path: &Path) -> Result<()> {
        if target_path.exists() {
            let _ = fs::remove_file(target_path);
        }

        let mut attempts = 0;
        loop {
            match fs::rename(temp_path, target_path) {
                Ok(()) => return Ok(()),
                Err(e) if attempts < 5 => {
                    attempts += 1;
                    tracing::warn!(
                        "Rename {:?} to {:?} failed (attempt {}): {}. Retrying in {}ms...",
                        temp_path,
                        target_path,
                        attempts,
                        e,
                        attempts * 50
                    );
                    tokio::time::sleep(Duration::from_millis(attempts * 50)).await;
                    if target_path.exists() {
                        let _ = fs::remove_file(target_path);
                    }
                }
                Err(e) => return Err(EngineError::Io(e)),
            }
        }
    }
}

pub fn extract_thumbnail_from_url(url: &str) -> Option<String> {
    if url.contains("youtube.com") || url.contains("youtu.be") {
        if let Some(pos) = url.find("v=") {
            let rest = &url[pos + 2..];
            let id: String = rest
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
                .collect();
            if !id.is_empty() {
                return Some(format!("https://img.youtube.com/vi/{}/hqdefault.jpg", id));
            }
        }
        if let Some(pos) = url.find("youtu.be/") {
            let rest = &url[pos + 9..];
            let id: String = rest
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
                .collect();
            if !id.is_empty() {
                return Some(format!("https://img.youtube.com/vi/{}/hqdefault.jpg", id));
            }
        }
        if let Some(pos) = url.find("/shorts/") {
            let rest = &url[pos + 8..];
            let id: String = rest
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
                .collect();
            if !id.is_empty() {
                return Some(format!("https://img.youtube.com/vi/{}/hqdefault.jpg", id));
            }
        }
    }
    None
}

#[cfg(test)]
mod playlist_handoff_tests {
    use super::*;

    #[test]
    fn validate_playlist_open_url_preserves_pl_and_rejects_mix() {
        let pl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL6B3937A5D230E335&index=2";
        let valid = validate_playlist_open_url(pl).expect("PL playlist must validate");
        assert!(valid.contains("list=PL6B3937A5D230E335"));

        let mix = "https://www.youtube.com/watch?v=mVeAD3nbXGs&list=RDmVeAD3nbXGs&start_radio=1";
        let err = validate_playlist_open_url(mix).expect_err("Mix URL must be rejected");
        assert!(err.to_string().contains("Mix/Radio"));

        let invalid = validate_playlist_open_url("ftp://example.com/list").unwrap_err();
        assert!(invalid.to_string().contains("scheme"));
    }

    #[tokio::test]
    async fn playlist_request_queues_for_cold_start_and_resolves_after_ack() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().join("pl_cold.sqlite")).unwrap();
        let manager = Arc::new(DownloadManager::new(db, EventBus::default()).unwrap());
        manager.set_desktop_gui_attached(true);

        let pl_url = "https://www.youtube.com/playlist?list=PL6B3937A5D230E335";
        let mgr_req = Arc::clone(&manager);
        let req_task = tokio::spawn(async move {
            mgr_req
                .request_open_playlist_modal(pl_url, Duration::from_secs(3))
                .await
        });

        // Simulate slow cold UI mount (wait until queued pending request is visible)
        let pending = loop {
            let items = manager.take_pending_playlist_requests();
            if !items.is_empty() {
                break items;
            }
            tokio::time::sleep(Duration::from_millis(15)).await;
        };
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].url, pl_url);
        // Second take returns empty because already drained
        assert!(manager.take_pending_playlist_requests().is_empty());

        let acked = manager.acknowledge_playlist_modal(&pending[0].request_id);
        assert!(acked);

        let confirmation = req_task.await.unwrap().expect("Handoff must succeed after ack");
        assert!(confirmation.confirmed);
        assert_eq!(confirmation.request_id, pending[0].request_id);
        assert_eq!(confirmation.url, pl_url);
    }

    #[tokio::test]
    async fn playlist_request_coalesces_concurrent_duplicates_and_cleans_up_on_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().join("pl_timeout.sqlite")).unwrap();
        let manager = Arc::new(DownloadManager::new(db, EventBus::default()).unwrap());
        manager.set_desktop_gui_attached(true);

        let pl_url = "https://www.youtube.com/playlist?list=PL1234567890ABCDEF";
        let mgr_a = Arc::clone(&manager);
        let mgr_b = Arc::clone(&manager);

        let task_a = tokio::spawn(async move {
            mgr_a
                .request_open_playlist_modal(pl_url, Duration::from_millis(250))
                .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        let task_b = tokio::spawn(async move {
            mgr_b
                .request_open_playlist_modal(pl_url, Duration::from_millis(250))
                .await
        });

        tokio::time::sleep(Duration::from_millis(30)).await;
        // Duplicate concurrent requests must coalesce to a single queued entry
        let snapshot = manager.pending_playlist_requests_snapshot();
        assert_eq!(snapshot.len(), 1);

        let res_a = task_a.await.unwrap();
        let res_b = task_b.await.unwrap();
        assert!(res_a.is_err());
        assert!(res_b.is_err());
        // After all waiters time out, pending request must be cleaned up cleanly
        assert!(manager.pending_playlist_requests_snapshot().is_empty());
    }
}
