use reqwest::header::{ACCEPT_ENCODING, RANGE};
use reqwest::Client;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

use crate::db::Database;
use crate::engine::events::{DownloadEvent, EventBus};
use crate::engine::governor::ConcurrencyGovernor;
use crate::error::{EngineError, Result};
use crate::hls::decrypt::{decrypt_hls_segment, derive_iv_from_sequence};
use crate::hls::muxer::{probe_duration, remux_hls_to_mp4};
use crate::hls::parser::{
    parse_playlist, select_default_variant, HlsKeyMethod, MediaPlaylist, ParsedPlaylist,
};
use crate::types::{ChunkRecord, DownloadJob, DownloadProgress, JobState};

/// Downloads raw segment or key bytes with automatic retry backoff on transient errors (429, 500..=504) and connection drops.
async fn fetch_hls_bytes_with_retry(
    client: &Client,
    uri: &str,
    byterange: Option<(u64, Option<u64>)>,
    referer: Option<&str>,
    user_agent: Option<&str>,
    cancel_token: &CancellationToken,
) -> Result<Vec<u8>> {
    let max_retries = 3;
    let mut attempt = 0;

    loop {
        if cancel_token.is_cancelled() {
            return Err(EngineError::Cancelled);
        }

        let mut req = client.get(uri).header(ACCEPT_ENCODING, "identity");
        if let Some((len, opt_offset)) = byterange {
            let offset = opt_offset.unwrap_or(0);
            req = req.header(RANGE, format!("bytes={}-{}", offset, offset + len - 1));
        }
        req = crate::engine::referer::apply_referer(req, referer, uri);
        req = crate::engine::user_agent::apply_user_agent(req, user_agent);

        match req.send().await {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    let bytes = resp.bytes().await.map_err(EngineError::Http)?;
                    return Ok(bytes.to_vec());
                } else if status.as_u16() == 429 || (500..=504).contains(&status.as_u16()) {
                    attempt += 1;
                    if attempt > max_retries {
                        return Err(EngineError::HttpStatus(status.as_u16()));
                    }
                    let backoff = Duration::from_millis(150 * (1 << attempt));
                    tracing::warn!(
                        "[HLS Downloader] Server returned {}. Retrying in {:?} (attempt {}/{})",
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
                tracing::warn!(
                    "[HLS Downloader] Network error: {}. Retrying in {:?} (attempt {}/{})",
                    e,
                    backoff,
                    attempt,
                    max_retries
                );
                tokio::select! {
                    _ = cancel_token.cancelled() => return Err(EngineError::Cancelled),
                    _ = tokio::time::sleep(backoff) => continue,
                }
            }
        }
    }
}

/// Downloads an HLS VOD resource end-to-end with bounded segment concurrency,
/// durable SQLite progress tracking, AES-128 decryption, and container remuxing.
#[allow(clippy::too_many_arguments)]
pub async fn download_hls_vod(
    client: &Client,
    job: &DownloadJob,
    db: &Database,
    event_bus: &EventBus,
    governor: &Arc<ConcurrencyGovernor>,
    cancel_token: &CancellationToken,
) -> Result<()> {
    tracing::info!("[HLS Downloader] Starting HLS VOD download for {}", job.url);

    // 1. Fetch initial playlist
    let mut req = client.get(&job.url).header(ACCEPT_ENCODING, "identity");
    req = crate::engine::referer::apply_referer(req, job.referer.as_deref(), &job.url);
    req = crate::engine::user_agent::apply_user_agent(req, job.user_agent.as_deref());
    let raw_manifest = req
        .send()
        .await
        .map_err(EngineError::Http)?
        .text()
        .await
        .map_err(EngineError::Http)?;

    let parsed = parse_playlist(&raw_manifest, &job.url)?;

    // 2. Resolve to Media Playlist
    let (media_playlist, audio_media_playlist) = match parsed {
        ParsedPlaylist::Master(master) => {
            let selected_variant = select_default_variant(&master).ok_or_else(|| {
                EngineError::Other("Master playlist has no selectable video variants".to_string())
            })?;

            tracing::info!(
                "[HLS Downloader] Selected variant bandwidth={} resolution={:?} uri={}",
                selected_variant.bandwidth,
                selected_variant.resolution,
                selected_variant.uri
            );

            let mut req = client
                .get(&selected_variant.uri)
                .header(ACCEPT_ENCODING, "identity");
            req = crate::engine::referer::apply_referer(
                req,
                job.referer.as_deref(),
                &selected_variant.uri,
            );
            req = crate::engine::user_agent::apply_user_agent(req, job.user_agent.as_deref());
            let variant_manifest = req
                .send()
                .await
                .map_err(EngineError::Http)?
                .text()
                .await
                .map_err(EngineError::Http)?;

            let v_parsed = parse_playlist(&variant_manifest, &selected_variant.uri)?;
            let v_media = match v_parsed {
                ParsedPlaylist::Media(m) => m,
                _ => {
                    return Err(EngineError::Other(
                        "Variant playlist resolved to another master playlist".to_string(),
                    ))
                }
            };

            // Check for separate audio rendition
            let mut a_media: Option<MediaPlaylist> = None;
            if let Some(ref group_id) = selected_variant.audio_group {
                if let Some(rendition) = master
                    .audio_renditions
                    .iter()
                    .find(|r| &r.group_id == group_id && r.uri.is_some())
                {
                    if let Some(ref audio_uri) = rendition.uri {
                        let mut a_req = client.get(audio_uri);
                        a_req = crate::engine::referer::apply_referer(
                            a_req,
                            job.referer.as_deref(),
                            audio_uri,
                        );
                        a_req = crate::engine::user_agent::apply_user_agent(
                            a_req,
                            job.user_agent.as_deref(),
                        );
                        if let Ok(resp) = a_req.send().await {
                            if let Ok(txt) = resp.text().await {
                                if let Ok(ParsedPlaylist::Media(am)) =
                                    parse_playlist(&txt, audio_uri)
                                {
                                    a_media = Some(am);
                                }
                            }
                        }
                    }
                }
            }

            (v_media, a_media)
        }
        ParsedPlaylist::Media(media) => (media, None),
    };

    if media_playlist.segments.is_empty() {
        return Err(EngineError::Other(
            "HLS playlist contains zero media segments".to_string(),
        ));
    }

    if !media_playlist.is_vod {
        return Err(EngineError::Other(
            "Live HLS streaming is not supported in VOD engine (planned for Gate 7). Only completed VOD playlists containing #EXT-X-ENDLIST are supported."
                .to_string(),
        ));
    }

    let host = url::Url::parse(&job.url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_else(|| "default".to_string());

    // 3. Setup work directory for segments
    let work_dir = PathBuf::from(format!("{}.hls_parts", job.temp_path));
    fs::create_dir_all(&work_dir)?;

    let total_segments = media_playlist.segments.len();
    tracing::info!(
        "[HLS Downloader] Discovered {} segments ({:.2}s duration)",
        total_segments,
        media_playlist.total_duration
    );

    // Save segment chunks to SQLite if not already created
    let existing_chunks = db.get_chunks(&job.id)?;
    if existing_chunks.len() != total_segments {
        let mut chunks = Vec::with_capacity(total_segments);
        for (i, seg) in media_playlist.segments.iter().enumerate() {
            chunks.push(ChunkRecord {
                id: None,
                download_id: job.id.clone(),
                chunk_index: i,
                start_byte: 0,
                end_byte: (seg.duration * 1000.0) as u64, // track duration in ms
                written_bytes: 0,
                is_complete: false,
            });
        }
        db.save_chunks(&chunks)?;
    }

    // 4. Download fMP4 Initialization Segment if present
    let mut init_path: Option<PathBuf> = None;
    if let Some(ref init_seg) = media_playlist.init_segment {
        let p = work_dir.join("init.mp4");
        if !p.exists() || fs::metadata(&p)?.len() == 0 {
            let bytes = fetch_hls_bytes_with_retry(
                client,
                &init_seg.uri,
                init_seg.byterange,
                job.referer.as_deref(),
                job.user_agent.as_deref(),
                cancel_token,
            )
            .await?;
            fs::write(&p, &bytes)?;
        }
        init_path = Some(p);
    }

    // 5. Cache for AES-128 keys (URI -> 16-byte key)
    let mut key_cache: HashMap<String, [u8; 16]> = HashMap::new();

    // Download metrics tracking
    let total_downloaded_bytes = Arc::new(AtomicU64::new(0));
    let completed_segments = Arc::new(AtomicU64::new(0));

    // Calculate previously completed segments from disk
    for (i, _) in media_playlist.segments.iter().enumerate() {
        let seg_file = work_dir.join(format!("seg_{:06}.ts", i));
        if seg_file.exists() && fs::metadata(&seg_file)?.len() > 0 {
            completed_segments.fetch_add(1, Ordering::Relaxed);
        }
    }

    // Progress reporter loop
    let progress_cancel = cancel_token.clone();
    let progress_cancel_c = progress_cancel.clone();
    let progress_job_id = job.id.clone();
    let progress_event_bus = event_bus.clone();
    let progress_counter = total_downloaded_bytes.clone();
    let progress_completed_segs = completed_segments.clone();
    let total_segs_u64 = total_segments as u64;

    let progress_handle = tokio::spawn(async move {
        let mut last_bytes = progress_counter.load(Ordering::Relaxed);
        let mut last_time = Instant::now();

        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(250)) => {
                    let now = Instant::now();
                    let current_bytes = progress_counter.load(Ordering::Relaxed);
                    let done_segs = progress_completed_segs.load(Ordering::Relaxed);
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

    // 6. Download Video Segments with bounded parallelism
    let mut segment_file_paths: Vec<PathBuf> = Vec::with_capacity(total_segments);
    if let Some(ref init) = init_path {
        segment_file_paths.push(init.clone());
    }

    for (i, seg) in media_playlist.segments.iter().enumerate() {
        if cancel_token.is_cancelled() {
            progress_cancel.cancel();
            let _ = progress_handle.await;
            return Err(EngineError::Cancelled);
        }

        let seg_filename = format!("seg_{:06}.ts", i);
        let seg_path = work_dir.join(&seg_filename);

        // Resume: if segment already exists and passes validation, skip downloading!
        let is_fmp4 = seg.uri.ends_with(".m4s") || media_playlist.init_segment.is_some();
        let exp_len = seg.byterange.map(|(len, _)| len);
        if seg_path.exists() {
            if validate_hls_segment(&seg_path, exp_len, is_fmp4) {
                segment_file_paths.push(seg_path);
                continue;
            } else {
                let _ = fs::remove_file(&seg_path);
            }
        }

        // Handle AES-128 Key fetch
        let mut resolved_key: Option<([u8; 16], [u8; 16])> = None;
        if let Some(ref k) = seg.key {
            if k.method == HlsKeyMethod::Aes128 {
                let key_bytes = match key_cache.get(&k.uri) {
                    Some(kb) => *kb,
                    None => {
                        let bytes = fetch_hls_bytes_with_retry(
                            client,
                            &k.uri,
                            None,
                            job.referer.as_deref(),
                            job.user_agent.as_deref(),
                            cancel_token,
                        )
                        .await?;
                        if bytes.len() != 16 {
                            return Err(EngineError::Other(format!(
                                "Invalid AES-128 key length {} from {}",
                                bytes.len(),
                                k.uri
                            )));
                        }
                        let mut arr = [0u8; 16];
                        arr.copy_from_slice(&bytes);
                        key_cache.insert(k.uri.clone(), arr);
                        arr
                    }
                };

                let iv =
                    k.iv.unwrap_or_else(|| derive_iv_from_sequence(seg.sequence_number));
                resolved_key = Some((key_bytes, iv));
            }
        }

        // Concurrency permit from governor
        let _permit = governor.acquire_permit(&host);

        // Download segment bytes with automatic retry
        let raw_bytes = fetch_hls_bytes_with_retry(
            client,
            &seg.uri,
            seg.byterange,
            job.referer.as_deref(),
            job.user_agent.as_deref(),
            cancel_token,
        )
        .await?;
        total_downloaded_bytes.fetch_add(raw_bytes.len() as u64, Ordering::Relaxed);

        // Decrypt if AES-128
        let final_bytes = if let Some((ref kb, ref iv)) = resolved_key {
            decrypt_hls_segment(&raw_bytes, kb, iv)?
        } else {
            raw_bytes
        };

        fs::write(&seg_path, &final_bytes)?;
        segment_file_paths.push(seg_path);

        completed_segments.fetch_add(1, Ordering::Relaxed);
        let _ = db.update_chunk_progress(&job.id, i, final_bytes.len() as u64, true);
    }

    // 7. Download Separate Audio Segments if present
    let mut audio_segment_paths: Vec<PathBuf> = Vec::new();
    if let Some(ref audio_media) = audio_media_playlist {
        tracing::info!(
            "[HLS Downloader] Downloading {} audio rendition segments",
            audio_media.segments.len()
        );
        for (i, seg) in audio_media.segments.iter().enumerate() {
            if cancel_token.is_cancelled() {
                progress_cancel.cancel();
                let _ = progress_handle.await;
                return Err(EngineError::Cancelled);
            }

            let a_filename = format!("audio_seg_{:06}.ts", i);
            let a_path = work_dir.join(&a_filename);

            let is_fmp4 = seg.uri.ends_with(".m4s") || audio_media.init_segment.is_some();
            let exp_len = seg.byterange.map(|(len, _)| len);
            if a_path.exists() {
                if validate_hls_segment(&a_path, exp_len, is_fmp4) {
                    audio_segment_paths.push(a_path);
                    continue;
                } else {
                    let _ = fs::remove_file(&a_path);
                }
            }

            let _permit = governor.acquire_permit(&host);
            let bytes = fetch_hls_bytes_with_retry(
                client,
                &seg.uri,
                seg.byterange,
                job.referer.as_deref(),
                job.user_agent.as_deref(),
                cancel_token,
            )
            .await?;
            fs::write(&a_path, &bytes)?;
            audio_segment_paths.push(a_path);
        }
    }

    // Stop progress loop
    progress_cancel.cancel();
    let _ = progress_handle.await;

    // 8. Remux Phase: execute FFmpeg stream-copy to produce valid .mp4 container
    db.update_job_state(&job.id, JobState::Verifying, None)?;
    event_bus.emit(DownloadEvent::StateChanged {
        id: job.id.clone(),
        state: JobState::Verifying,
        error: None,
    });

    let target_path = Path::new(&job.target_path);
    let audio_arg = if audio_segment_paths.is_empty() {
        None
    } else {
        Some(audio_segment_paths.as_slice())
    };

    remux_hls_to_mp4(&segment_file_paths, audio_arg, target_path, &work_dir)?;

    // Verify output with ffprobe if present
    if let Ok(duration) = probe_duration(target_path) {
        tracing::info!(
            "[HLS Downloader] FFprobe verified playable output duration: {:.2}s",
            duration
        );
    }

    // Cleanup segment temp directory
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
        "[HLS Downloader] Download complete for {}: {} bytes saved to {:?}",
        job.id,
        final_size,
        target_path
    );

    Ok(())
}

/// Validates an HLS segment file on disk: ensures non-zero length, expected byte size if known,
/// and valid container header (MPEG-TS 0x47 sync byte or fMP4 atom type) rather than truncated
/// or HTML error data.
pub fn validate_hls_segment(path: &Path, expected_len: Option<u64>, is_fmp4: bool) -> bool {
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

    if is_fmp4 {
        if n >= 8 {
            let box_type = &header[4..8];
            matches!(
                box_type,
                b"ftyp" | b"moov" | b"moof" | b"styp" | b"sidx" | b"mdat" | b"free" | b"skip"
            )
        } else {
            false
        }
    } else {
        header[0] == 0x47 || (n >= 8 && header[4] == 0x47)
    }
}
