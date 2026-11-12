use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
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
use crate::engine::probe::sanitize_filename;
use crate::engine::worker::{download_chunk_with_options, download_stream_with_options};
use crate::engine::writer::PartFileWriter;
use crate::error::{EngineError, Result};
use crate::types::{ChunkRecord, DownloadJob, DownloadProgress, JobState, JobType, Priority};

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
    max_connections_per_download: Arc<AtomicUsize>,
    max_retries: Arc<AtomicUsize>,
    dynamic_segmentation: Arc<std::sync::atomic::AtomicBool>,
    default_download_dir: Arc<Mutex<Option<String>>>,
    use_category_by_default: Arc<std::sync::atomic::AtomicBool>,
    scheduler_notify: Arc<tokio::sync::Notify>,
    in_flight_creations: Arc<Mutex<HashMap<String, Arc<tokio::sync::Notify>>>>,
    recent_handoffs: Arc<Mutex<HashMap<String, (String, Instant)>>>,
    path_alloc_lock: Arc<Mutex<()>>,
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
            max_connections_per_download,
            max_retries,
            dynamic_segmentation,
            default_download_dir,
            use_category_by_default,
            scheduler_notify,
            in_flight_creations,
            recent_handoffs,
            path_alloc_lock,
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
            "mp4" | "mkv" | "webm" | "mov" | "avi" | "flv" | "wmv" | "m4v" | "ts" => "Video",
            "mp3" | "m4a" | "aac" | "flac" | "ogg" | "opus" | "wav" => "Music",
            "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "csv" | "md" => {
                "Documents"
            }
            _ => "Other",
        }
    }

    pub fn resolve_destination_folder(
        &self,
        hint_filename_or_url: &str,
        explicit_dest: Option<&str>,
    ) -> PathBuf {
        let default_dir = self.default_download_dir();
        let is_explicit_override = match explicit_dest {
            Some(d) => {
                let clean = d.trim();
                if clean.is_empty() {
                    false
                } else if let Some(ref def) = default_dir {
                    let pa = Path::new(clean);
                    let pb = Path::new(def.trim());
                    if pa == pb {
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
                } else {
                    let pa = Path::new(clean);
                    let pb = Self::get_system_download_dir();
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
            let p = PathBuf::from(explicit_dest.unwrap().trim());
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
            let category = Self::classify_category(hint_filename_or_url);
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
        let trimmed_url = url.trim();
        let clean_handoff = handoff_id.map(|s| s.trim()).filter(|s| !s.is_empty());

        // 1. Check recent handoff ID cache (120s TTL)
        if let Some(hid) = clean_handoff {
            let cached_job_id = {
                let mut guard = self.recent_handoffs.lock().unwrap();
                let now = Instant::now();
                guard.retain(|_, (_, ts)| now.duration_since(*ts) < Duration::from_secs(120));
                guard.get(hid).map(|(jid, _)| jid.clone())
            };
            if let Some(jid) = cached_job_id {
                if let Ok(Some(existing)) = self.db.get_job(&jid) {
                    if existing.state != JobState::Failed && existing.state != JobState::Cancelled {
                        return Ok((existing, true));
                    }
                }
            }
        }

        // 2. Check existing persisted jobs in SQLite
        if let Some(existing) = self.find_active_or_completed_job_for_url(trimmed_url) {
            if let Some(hid) = clean_handoff {
                self.recent_handoffs
                    .lock()
                    .unwrap()
                    .insert(hid.to_string(), (existing.id.clone(), Instant::now()));
            }
            return Ok((existing, true));
        }

        // 3. Check or register in-flight probe/creation for this URL / handoff_id
        let inflight_key = trimmed_url.to_string();
        let existing_notify = {
            let mut map = self.in_flight_creations.lock().unwrap();
            if let Some(n) = map.get(&inflight_key) {
                Some(n.clone())
            } else if let Some(hid) = clean_handoff {
                if let Some(n) = map.get(hid) {
                    Some(n.clone())
                } else {
                    let n = Arc::new(tokio::sync::Notify::new());
                    map.insert(inflight_key.clone(), n.clone());
                    map.insert(hid.to_string(), n);
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
            if let Some(hid) = clean_handoff {
                let cached_job_id = self
                    .recent_handoffs
                    .lock()
                    .unwrap()
                    .get(hid)
                    .map(|(jid, _)| jid.clone());
                if let Some(jid) = cached_job_id {
                    if let Ok(Some(existing)) = self.db.get_job(&jid) {
                        if existing.state != JobState::Failed
                            && existing.state != JobState::Cancelled
                        {
                            return Ok((existing, true));
                        }
                    }
                }
            }
            if let Some(existing) = self.find_active_or_completed_job_for_url(trimmed_url) {
                if let Some(hid) = clean_handoff {
                    self.recent_handoffs
                        .lock()
                        .unwrap()
                        .insert(hid.to_string(), (existing.id.clone(), Instant::now()));
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
            key2: clean_handoff.map(|s| s.to_string()),
        };

        let job = self
            .create_download_with_all_options_scheduled(
                trimmed_url,
                destination_dir,
                priority,
                referer,
                user_agent,
                scheduled_at,
            )
            .await?;

        if let Some(hid) = clean_handoff {
            self.recent_handoffs
                .lock()
                .unwrap()
                .insert(hid.to_string(), (job.id.clone(), Instant::now()));
        }

        Ok((job, false))
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

        let dir = destination_dir.as_ref();
        if !dir.exists() {
            fs::create_dir_all(dir)?;
        }

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
            (JobType::HttpFile, sanitize_filename(&probe.filename))
        };

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
            let (target_path, temp_path) = self.allocate_unique_paths(dir, &base_filename);

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
        } else {
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
        let max_retries_c = max_retries.load(Ordering::Relaxed) as u32;
        let dynamic_seg_c = dynamic_segmentation.load(Ordering::Relaxed);
        let limiter_for_queued = rate_limiter.clone();
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
                max_retries_c,
                dynamic_seg_c,
            )
            .await;

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

                join_set.spawn(async move {
                    let _p = permit;
                    let idx = chunk_copy.chunk_index;
                    let res = download_chunk_with_options(
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

                            join_set.spawn(async move {
                                let _p = permit;
                                let idx = chunk_copy.chunk_index;
                                let res = download_chunk_with_options(
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

                                        join_set.spawn(async move {
                                            let _p = permit;
                                            let idx = new_chunk.chunk_index;
                                            let res = download_chunk_with_options(
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

            let bytes_written = download_stream_with_options(
                &client,
                &url,
                &writer,
                &db,
                &download_id,
                &cancel_token,
                Some(&rate_limiter),
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
