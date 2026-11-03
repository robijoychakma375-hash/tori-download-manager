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
use crate::engine::planner::plan_chunks;
use crate::engine::probe::{probe_url, sanitize_filename};
use crate::engine::worker::{download_chunk, download_stream};
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

        Ok(Self {
            client,
            db,
            event_bus,
            governor: ConcurrencyGovernor::new(gov_config),
            adaptive_scheduler: Arc::new(AdaptiveScheduler::new(adaptive_config)),
            torrent_manager: Arc::new(tokio::sync::OnceCell::new()),
            active_tokens: Arc::new(Mutex::new(HashMap::new())),
            stop_tokens: Arc::new(Mutex::new(HashMap::new())),
            max_active_jobs: Arc::new(AtomicUsize::new(4)),
        })
    }

    pub fn max_active_jobs(&self) -> usize {
        self.max_active_jobs.load(Ordering::SeqCst)
    }

    pub fn set_max_active_jobs(&self, max: usize) {
        self.max_active_jobs.store(max, Ordering::SeqCst);
        let _ = self.process_queue();
    }

    pub fn process_queue(&self) -> Result<Option<String>> {
        let active_count = self.active_tokens.lock().unwrap().len();
        let max = self.max_active_jobs.load(Ordering::SeqCst);
        if active_count >= max {
            return Ok(None);
        }

        if let Some(next_job) = self.db.get_next_queued_job()? {
            self.start_download(&next_job.id)?;
            return Ok(Some(next_job.id));
        }

        Ok(None)
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
        let probe = probe_url(&self.client, url).await?;

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

        let mut target_path = dir.join(&base_filename);
        let mut counter = 1;

        // Collision avoidance if target exists
        while target_path.exists() {
            let stem = Path::new(&base_filename)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("file");
            let ext = Path::new(&base_filename)
                .extension()
                .and_then(|s| s.to_str())
                .map(|e| format!(".{}", e))
                .unwrap_or_default();
            target_path = dir.join(format!("{} ({}){}", stem, counter, ext));
            counter += 1;
        }

        let temp_filename = format!(
            "{}.tdm-part",
            target_path.file_name().unwrap().to_str().unwrap()
        );
        let temp_path = dir.join(temp_filename);

        let id = Uuid::new_v4().to_string();
        let chunks = plan_chunks(&id, probe.total_bytes, probe.supports_ranges);

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
            state: JobState::Queued,
            job_type,
            priority,
            etag: probe.etag,
            last_modified: probe.last_modified,
            is_resumable: probe.supports_ranges,
            chunk_count: chunks.len(),
            error_message: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        };

        self.db.insert_job(&job)?;
        self.db.save_chunks(&chunks)?;

        self.event_bus.emit(DownloadEvent::StateChanged {
            id: id.clone(),
            state: JobState::Queued,
            error: None,
        });

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
    ) -> Result<()> {
        let job = match db.get_job(id)? {
            Some(j) => j,
            None => return Err(EngineError::JobNotFound(id.to_string())),
        };

        if job.state == JobState::Completed {
            return Ok(());
        }

        let mut tokens = active_tokens.lock().unwrap();
        if tokens.contains_key(id) {
            // Already running
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

        db.update_job_state(id, JobState::Downloading, None)?;
        event_bus.emit(DownloadEvent::StateChanged {
            id: id.to_string(),
            state: JobState::Downloading,
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
                    tracing::info!("Download {} was paused/cancelled", download_id);
                }
                Err(e) => {
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

            // Real priority queue scheduling: automatically advance next queued job!
            if active_count < max_jobs_c.load(Ordering::SeqCst) {
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
                    );
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

        // Reset chunks and temp file
        let _ = fs::remove_file(&job.temp_path);
        self.db.reset_job_for_restart(id)?;

        let chunks = plan_chunks(&job.id, job.total_bytes, job.is_resumable);
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
            }
        }

        self.db.delete_job(id)?;
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
    ) -> Result<()> {
        let job = match db.get_job(&download_id)? {
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

        let temp_path = PathBuf::from(&job.temp_path);
        let target_path = PathBuf::from(&job.target_path);

        // Resume validation: if we have existing progress, probe to ensure server resource didn't change
        let existing_chunks = db.get_chunks(&download_id)?;
        let initial_written: u64 = existing_chunks.iter().map(|c| c.written_bytes).sum();

        if initial_written > 0 && job.is_resumable {
            // Re-probe to check ETag or Last-Modified match
            if let Ok(probe) = probe_url(&client, &job.url).await {
                let mut etag_changed = false;
                if let (Some(expected_etag), Some(new_etag)) = (&job.etag, &probe.etag) {
                    if expected_etag != new_etag {
                        etag_changed = true;
                    }
                }

                if etag_changed {
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
                }
            }
        }

        let writer = PartFileWriter::open_or_create(&temp_path, job.total_bytes)?;
        let chunks = db.get_chunks(&download_id)?;

        let current_downloaded: u64 = chunks.iter().map(|c| c.written_bytes).sum();
        let total_downloaded_atomic = Arc::new(AtomicU64::new(current_downloaded));

        // Progress reporter loop
        let progress_cancel = cancel_token.clone();
        let progress_download_id = download_id.clone();
        let progress_event_bus = event_bus.clone();
        let progress_total_bytes = job.total_bytes;
        let progress_counter = total_downloaded_atomic.clone();

        let cancel_for_progress = progress_cancel.clone();
        let progress_handle = tokio::spawn(async move {
            let mut last_bytes = progress_counter.load(Ordering::Relaxed);
            let mut last_time = Instant::now();

            loop {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(250)) => {
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
        let download_result: Result<()> = if job.is_resumable && chunks.len() > 1 {
            let host = url::Url::parse(&job.url)
                .ok()
                .and_then(|u| u.host_str().map(|h| h.to_string()))
                .unwrap_or_else(|| "default".to_string());

            let active_chunk_bounds: Arc<Mutex<HashMap<usize, Arc<AtomicU64>>>> =
                Arc::new(Mutex::new(HashMap::new()));
            let active_chunk_progress: Arc<Mutex<HashMap<usize, Arc<AtomicU64>>>> =
                Arc::new(Mutex::new(HashMap::new()));
            let mut join_set: JoinSet<Result<(usize, u64)>> = JoinSet::new();

            let max_concurrency = adaptive_scheduler.config.max_concurrency;

            // Spawn initial workers
            for chunk in &chunks {
                if chunk.is_complete {
                    continue;
                }
                if join_set.len() >= max_concurrency {
                    break;
                }

                let permit = governor.acquire_permit(&host);
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
                let writer_c = writer.clone();
                let db_c = db.clone();
                let cancel_c = cancel_token.clone();
                let counter_c = total_downloaded_atomic.clone();

                join_set.spawn(async move {
                    let _p = permit;
                    let res = download_chunk(
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
                        |written| {
                            counter_c.fetch_add(written, Ordering::Relaxed);
                        },
                    )
                    .await;
                    res.map(|()| (chunk_copy.chunk_index, chunk_copy.written_bytes))
                });
            }

            let mut first_error: Option<EngineError> = None;

            while let Some(join_res) = tokio::select! {
                _ = cancel_token.cancelled() => {
                    join_set.abort_all();
                    return Err(EngineError::Cancelled);
                }
                res = join_set.join_next() => res,
            } {
                let worker_res = match join_res {
                    Ok(r) => r,
                    Err(join_err) => {
                        if first_error.is_none() {
                            first_error = Some(EngineError::Other(join_err.to_string()));
                        }
                        break;
                    }
                };

                match worker_res {
                    Ok((finished_index, _)) => {
                        active_chunk_bounds.lock().unwrap().remove(&finished_index);
                        active_chunk_progress
                            .lock()
                            .unwrap()
                            .remove(&finished_index);
                    }
                    Err(e) => {
                        if matches!(e, EngineError::Cancelled) || cancel_token.is_cancelled() {
                            join_set.abort_all();
                            return Err(EngineError::Cancelled);
                        }
                        if first_error.is_none() {
                            first_error = Some(e);
                        }
                        break;
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
                    if join_set.len() < max_concurrency {
                        let permit = governor.acquire_permit(&host);
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
                        let url_c = job.resolved_url.clone().unwrap_or_else(|| job.url.clone());
                        let etag_c = job.etag.clone();
                        let lm_c = job.last_modified.clone();
                        let writer_c = writer.clone();
                        let db_c = db.clone();
                        let cancel_c = cancel_token.clone();
                        let counter_c = total_downloaded_atomic.clone();

                        join_set.spawn(async move {
                            let _p = permit;
                            let res = download_chunk(
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
                                |written| {
                                    counter_c.fetch_add(written, Ordering::Relaxed);
                                },
                            )
                            .await;
                            res.map(|()| (chunk_copy.chunk_index, chunk_copy.written_bytes))
                        });
                    }
                } else if join_set.len() < max_concurrency {
                    // Safe Straggler Tail Splitting:
                    if let Some(plan) = adaptive_scheduler.evaluate_straggler_split(&current_chunks)
                    {
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

                        if let (Some(orig_bound), Some(orig_prog)) = (orig_bound_opt, orig_prog_opt)
                        {
                            let orig_chunk = current_chunks
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
                                    let permit = governor.acquire_permit(&host);
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
                                    let url_c =
                                        job.resolved_url.clone().unwrap_or_else(|| job.url.clone());
                                    let etag_c = job.etag.clone();
                                    let lm_c = job.last_modified.clone();
                                    let writer_c = writer.clone();
                                    let db_c = db.clone();
                                    let cancel_c = cancel_token.clone();
                                    let counter_c = total_downloaded_atomic.clone();

                                    join_set.spawn(async move {
                                        let _p = permit;
                                        let res = download_chunk(
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
                                            |written| {
                                                counter_c.fetch_add(written, Ordering::Relaxed);
                                            },
                                        )
                                        .await;
                                        res.map(|()| {
                                            (new_chunk.chunk_index, new_chunk.written_bytes)
                                        })
                                    });
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
            // Single chunk or non-range streaming
            let url = job.resolved_url.clone().unwrap_or_else(|| job.url.clone());
            let counter = total_downloaded_atomic.clone();

            let bytes_written = download_stream(
                &client,
                &url,
                &writer,
                &db,
                &download_id,
                &cancel_token,
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

        // Ensure all bytes flushed to disk
        writer.sync()?;
        drop(writer);

        let final_chunks = db.get_chunks(&download_id)?;
        let total_downloaded: u64 = final_chunks.iter().map(|c| c.written_bytes).sum();

        if let Some(expected_total) = job.total_bytes {
            if total_downloaded != expected_total {
                return Err(EngineError::ContentLengthMismatch {
                    expected: expected_total,
                    actual: total_downloaded,
                });
            }
        }

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
