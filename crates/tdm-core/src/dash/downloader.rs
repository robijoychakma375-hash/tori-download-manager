use reqwest::header::{ACCEPT_ENCODING, RANGE};
use reqwest::Client;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

use crate::dash::muxer::{probe_duration, remux_dash_to_playable};
use crate::dash::parser::{
    parse_mpd_manifest, resolve_representation_segments, select_best_representations,
    ResolvedDashSegment,
};
use crate::db::Database;
use crate::engine::events::{DownloadEvent, EventBus};
use crate::engine::governor::ConcurrencyGovernor;
use crate::error::{EngineError, Result};
use crate::types::{ChunkRecord, DownloadJob, DownloadProgress, JobState};

/// Validates a DASH segment file on disk before treating it as cached.
pub fn validate_dash_segment(path: &Path, expected_len: Option<u64>, is_webm: bool) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    let len = meta.len();
    if len == 0 {
        return false;
    }
    if let Some(exp) = expected_len {
        if len != exp {
            return false;
        }
    }

    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    use std::io::Read;
    let mut header = [0u8; 16];
    let n = file.read(&mut header).unwrap_or(0);
    if n < 4 {
        return false;
    }

    if is_webm {
        // WebM begins with EBML ID: 0x1A, 0x45, 0xDF, 0xA3
        n >= 4 && header[0..4] == [0x1A, 0x45, 0xDF, 0xA3]
    } else {
        // fMP4 box atom type at header[4..8]
        if n >= 8 {
            let box_type = &header[4..8];
            matches!(
                box_type,
                b"ftyp" | b"moov" | b"moof" | b"styp" | b"sidx" | b"mdat" | b"free" | b"skip"
            )
        } else {
            false
        }
    }
}

/// Downloads a segment with automatic retry backoff on transient errors (429, 502, 503, 504).
async fn download_segment_with_retry(
    client: &Client,
    seg: &ResolvedDashSegment,
    out_path: &Path,
    cancel_token: &CancellationToken,
) -> Result<u64> {
    let max_retries = 3;
    let mut attempt = 0;

    loop {
        if cancel_token.is_cancelled() {
            return Err(EngineError::Cancelled);
        }

        let mut req = client.get(&seg.uri).header(ACCEPT_ENCODING, "identity");
        if let Some((start, end)) = seg.byterange {
            req = req.header(RANGE, format!("bytes={}-{}", start, end));
        }

        match req.send().await {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    let bytes = resp.bytes().await.map_err(EngineError::Http)?;
                    fs::write(out_path, &bytes)?;
                    return Ok(bytes.len() as u64);
                } else if status.as_u16() == 429 || (500..=504).contains(&status.as_u16()) {
                    attempt += 1;
                    if attempt > max_retries {
                        return Err(EngineError::HttpStatus(status.as_u16()));
                    }
                    let backoff = Duration::from_millis(150 * (1 << attempt));
                    tracing::warn!(
                        "[DASH Downloader] Server returned {}. Retrying in {:?} (attempt {}/{})",
                        status,
                        backoff,
                        attempt,
                        max_retries
                    );
                    tokio::select! {
                        _ = cancel_token.cancelled() => return Err(EngineError::Cancelled),
                        _ = tokio::time::sleep(backoff) => continue,
                    }
                } else {
                    return Err(EngineError::HttpStatus(status.as_u16()));
                }
            }
            Err(e) => {
                attempt += 1;
                if attempt > max_retries {
                    return Err(EngineError::Http(e));
                }
                let backoff = Duration::from_millis(150 * (1 << attempt));
                tokio::select! {
                    _ = cancel_token.cancelled() => return Err(EngineError::Cancelled),
                    _ = tokio::time::sleep(backoff) => continue,
                }
            }
        }
    }
}

/// Downloads an MPEG-DASH VOD resource end-to-end with bounded segment parallelism,
/// SQLite recovery tracking, robust retries, and container remuxing.
#[allow(clippy::too_many_arguments)]
pub async fn download_dash_vod(
    client: &Client,
    job: &DownloadJob,
    db: &Database,
    event_bus: &EventBus,
    governor: &Arc<ConcurrencyGovernor>,
    cancel_token: &CancellationToken,
) -> Result<()> {
    tracing::info!(
        "[DASH Downloader] Starting MPEG-DASH VOD download for {}",
        job.url
    );

    // 1. Fetch MPD manifest
    let raw_manifest = client
        .get(&job.url)
        .header(ACCEPT_ENCODING, "identity")
        .send()
        .await
        .map_err(EngineError::Http)?
        .text()
        .await
        .map_err(EngineError::Http)?;

    // 2. Parse MPD
    let manifest = parse_mpd_manifest(&raw_manifest, &job.url)?;

    if manifest.is_dynamic {
        return Err(EngineError::Other(
            "Live MPEG-DASH streaming is not supported in VOD engine (planned for Gate 7). Only static VOD manifests (type=\"static\") are supported."
                .to_string(),
        ));
    }

    // 3. Select best video and audio representations
    let tracks = select_best_representations(&manifest)?;

    let v_stream = resolve_representation_segments(
        &manifest,
        tracks.period,
        tracks.video_adaptation,
        tracks.video_representation,
        "video",
    )?;
    let opt_a_stream = if let Some((a_adaptation, a_rep)) = tracks.audio {
        Some(resolve_representation_segments(
            &manifest,
            tracks.period,
            a_adaptation,
            a_rep,
            "audio",
        )?)
    } else {
        None
    };

    let is_webm = v_stream.mime_type.contains("webm");
    let total_video_segs = v_stream.media_segments.len();
    let total_audio_segs = opt_a_stream
        .as_ref()
        .map(|s| s.media_segments.len())
        .unwrap_or(0);
    let grand_total_segments = total_video_segs + total_audio_segs;

    let host = url::Url::parse(&job.url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_else(|| "default".to_string());

    // 4. Setup temporary work directory for fragments
    let work_dir = PathBuf::from(format!("{}.dash_parts", job.temp_path));
    fs::create_dir_all(&work_dir)?;

    // 5. Initialize SQLite chunk records if not already created
    let existing_chunks = db.get_chunks(&job.id)?;
    if existing_chunks.len() != grand_total_segments {
        let mut chunks = Vec::with_capacity(grand_total_segments);
        for (i, seg) in v_stream.media_segments.iter().enumerate() {
            chunks.push(ChunkRecord {
                id: None,
                download_id: job.id.clone(),
                chunk_index: i,
                start_byte: 0,
                end_byte: (seg.duration_seconds * 1000.0) as u64,
                written_bytes: 0,
                is_complete: false,
            });
        }
        if let Some(ref a_stream) = opt_a_stream {
            for (j, seg) in a_stream.media_segments.iter().enumerate() {
                chunks.push(ChunkRecord {
                    id: None,
                    download_id: job.id.clone(),
                    chunk_index: total_video_segs + j,
                    start_byte: 0,
                    end_byte: (seg.duration_seconds * 1000.0) as u64,
                    written_bytes: 0,
                    is_complete: false,
                });
            }
        }
        db.save_chunks(&chunks)?;
    }

    // Progress metrics
    let total_downloaded_bytes = Arc::new(AtomicU64::new(0));
    let completed_segments_count = Arc::new(AtomicU64::new(0));

    // Progress background reporter
    let progress_cancel = cancel_token.clone();
    let progress_cancel_c = progress_cancel.clone();
    let progress_job_id = job.id.clone();
    let progress_event_bus = event_bus.clone();
    let progress_bytes = total_downloaded_bytes.clone();
    let progress_segs = completed_segments_count.clone();
    let total_segs_u64 = grand_total_segments as u64;

    let progress_handle = tokio::spawn(async move {
        let mut last_bytes = progress_bytes.load(Ordering::Relaxed);
        let mut last_time = Instant::now();

        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(250)) => {
                    let now = Instant::now();
                    let current_bytes = progress_bytes.load(Ordering::Relaxed);
                    let done_segs = progress_segs.load(Ordering::Relaxed);
                    let elapsed = (now - last_time).as_secs_f64();

                    let speed = if elapsed > 0.05 {
                        let diff = current_bytes.saturating_sub(last_bytes);
                        (diff as f64 / elapsed) as u64
                    } else {
                        0
                    };

                    progress_event_bus.emit(DownloadEvent::Progress(DownloadProgress {
                        id: progress_job_id.clone(),
                        downloaded_bytes: done_segs,
                        total_bytes: Some(total_segs_u64),
                        speed_bps: speed,
                        eta_seconds: None,
                        state: JobState::Downloading,
                        error_message: None,
                    }));

                    last_bytes = current_bytes;
                    last_time = now;
                }
                _ = progress_cancel_c.cancelled() => break,
            }
        }
    });

    // 6. Download Video Initialization Segment if present
    let mut video_init_path: Option<PathBuf> = None;
    if let Some(ref init_seg) = v_stream.init_segment {
        let ext = if is_webm { "webm" } else { "mp4" };
        let p = work_dir.join(format!("video_init.{}", ext));
        let exp_len = init_seg.byterange.map(|(s, e)| e - s + 1);

        if !p.exists() || !validate_dash_segment(&p, exp_len, is_webm) {
            let _permit = governor.acquire_permit(&host);
            let n = download_segment_with_retry(client, init_seg, &p, cancel_token).await?;
            total_downloaded_bytes.fetch_add(n, Ordering::Relaxed);
        }
        video_init_path = Some(p);
    }

    // 7. Download Video Segments
    let mut video_segment_paths: Vec<PathBuf> = Vec::with_capacity(total_video_segs);

    for (i, seg) in v_stream.media_segments.iter().enumerate() {
        if cancel_token.is_cancelled() {
            progress_cancel.cancel();
            let _ = progress_handle.await;
            return Err(EngineError::Cancelled);
        }

        let ext = if is_webm { "webm" } else { "m4s" };
        let seg_path = work_dir.join(format!("video_seg_{:06}.{}", i, ext));
        let exp_len = seg.byterange.map(|(s, e)| e - s + 1);

        // Resume: if valid, skip download!
        if seg_path.exists() && validate_dash_segment(&seg_path, exp_len, is_webm) {
            video_segment_paths.push(seg_path);
            completed_segments_count.fetch_add(1, Ordering::Relaxed);
            continue;
        }

        let _permit = governor.acquire_permit(&host);
        let n = download_segment_with_retry(client, seg, &seg_path, cancel_token).await?;
        total_downloaded_bytes.fetch_add(n, Ordering::Relaxed);
        completed_segments_count.fetch_add(1, Ordering::Relaxed);

        let _ = db.update_chunk_progress(&job.id, i, n, true);
        video_segment_paths.push(seg_path);
    }

    // 8. Download Audio Stream if present
    let mut audio_init_path: Option<PathBuf> = None;
    let mut audio_segment_paths: Vec<PathBuf> = Vec::new();

    if let Some(ref a_stream) = opt_a_stream {
        let is_audio_webm = a_stream.mime_type.contains("webm");

        // Audio initialization segment
        if let Some(ref init_seg) = a_stream.init_segment {
            let ext = if is_audio_webm { "webm" } else { "mp4" };
            let p = work_dir.join(format!("audio_init.{}", ext));
            let exp_len = init_seg.byterange.map(|(s, e)| e - s + 1);

            if !p.exists() || !validate_dash_segment(&p, exp_len, is_audio_webm) {
                let _permit = governor.acquire_permit(&host);
                let n = download_segment_with_retry(client, init_seg, &p, cancel_token).await?;
                total_downloaded_bytes.fetch_add(n, Ordering::Relaxed);
            }
            audio_init_path = Some(p);
        }

        // Audio media segments
        for (j, seg) in a_stream.media_segments.iter().enumerate() {
            if cancel_token.is_cancelled() {
                progress_cancel.cancel();
                let _ = progress_handle.await;
                return Err(EngineError::Cancelled);
            }

            let ext = if is_audio_webm { "webm" } else { "m4s" };
            let a_path = work_dir.join(format!("audio_seg_{:06}.{}", j, ext));
            let exp_len = seg.byterange.map(|(s, e)| e - s + 1);

            if a_path.exists() && validate_dash_segment(&a_path, exp_len, is_audio_webm) {
                audio_segment_paths.push(a_path);
                completed_segments_count.fetch_add(1, Ordering::Relaxed);
                continue;
            }

            let _permit = governor.acquire_permit(&host);
            let n = download_segment_with_retry(client, seg, &a_path, cancel_token).await?;
            total_downloaded_bytes.fetch_add(n, Ordering::Relaxed);
            completed_segments_count.fetch_add(1, Ordering::Relaxed);

            let chunk_idx = total_video_segs + j;
            let _ = db.update_chunk_progress(&job.id, chunk_idx, n, true);
            audio_segment_paths.push(a_path);
        }
    }

    // Stop progress loop
    progress_cancel.cancel();
    let _ = progress_handle.await;

    // 9. Remux Phase: execute FFmpeg stream-copy to produce valid container
    db.update_job_state(&job.id, JobState::Verifying, None)?;
    event_bus.emit(DownloadEvent::StateChanged {
        id: job.id.clone(),
        state: JobState::Verifying,
        error: None,
    });

    let target_path = Path::new(&job.target_path);
    let opt_audio_segs = if audio_segment_paths.is_empty() {
        None
    } else {
        Some(audio_segment_paths.as_slice())
    };

    remux_dash_to_playable(
        video_init_path.as_deref(),
        &video_segment_paths,
        audio_init_path.as_deref(),
        opt_audio_segs,
        is_webm,
        target_path,
        &work_dir,
    )?;

    // 10. Verify duration with FFprobe if available
    if let Ok(duration) = probe_duration(target_path) {
        tracing::info!(
            "[DASH Downloader] FFprobe verified playable DASH output duration: {:.2}s",
            duration
        );
    }

    // 11. Cleanup temporary work directory
    let _ = fs::remove_dir_all(&work_dir);

    let final_size = fs::metadata(target_path)?.len();
    db.update_downloaded_bytes(&job.id, final_size)?;
    db.update_job_state(&job.id, JobState::Completed, None)?;

    event_bus.emit(DownloadEvent::Progress(DownloadProgress {
        id: job.id.clone(),
        downloaded_bytes: final_size,
        total_bytes: Some(final_size),
        speed_bps: 0,
        eta_seconds: Some(0),
        state: JobState::Completed,
        error_message: None,
    }));

    event_bus.emit(DownloadEvent::StateChanged {
        id: job.id.clone(),
        state: JobState::Completed,
        error: None,
    });

    tracing::info!(
        "[DASH Downloader] MPEG-DASH download complete for {}: {} bytes saved to {:?}",
        job.id,
        final_size,
        target_path
    );

    Ok(())
}
