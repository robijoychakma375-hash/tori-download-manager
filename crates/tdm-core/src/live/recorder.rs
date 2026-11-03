use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::db::Database;
use crate::engine::{DownloadEvent, EventBus};
use crate::error::{EngineError, Result};
use crate::hls::muxer::{find_ffmpeg, find_ffprobe, probe_duration};
use crate::types::{DownloadJob, DownloadProgress, JobState};

use super::protocol::{detect_live_protocol, LiveProtocol};

/// Options for live stream recording.
#[derive(Debug, Clone, Default)]
pub struct LiveRecordingOptions {
    /// Optional limit on recording duration.
    pub max_duration: Option<Duration>,
}

/// Records a live stream to disk using FFmpeg and updates progress and checkpoints in SQLite.
pub async fn record_live_stream(
    job: &DownloadJob,
    db: &Database,
    event_bus: &EventBus,
    cancel_token: &CancellationToken,
    stop_token: &CancellationToken,
    options: Option<LiveRecordingOptions>,
) -> Result<()> {
    let ffmpeg_bin = find_ffmpeg().ok_or_else(|| {
        EngineError::Other("FFmpeg executable not found on system PATH".to_string())
    })?;

    let temp_path = PathBuf::from(&job.temp_path);
    let target_path = PathBuf::from(&job.target_path);

    // Ensure target directory exists
    if let Some(parent) = temp_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)?;
        }
    }
    if let Some(parent) = target_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)?;
        }
    }

    // Clean up any stale temp file
    if temp_path.exists() {
        let _ = fs::remove_file(&temp_path);
    }

    let protocol = detect_live_protocol(&job.url).unwrap_or_else(|| {
        let lower = job.url.to_lowercase();
        if lower.contains(".m3u8") {
            LiveProtocol::LiveHls
        } else if lower.contains(".mpd") {
            LiveProtocol::LiveDash
        } else {
            LiveProtocol::Tcp
        }
    });

    // Build FFmpeg command arguments
    let mut cmd = Command::new(&ffmpeg_bin);
    cmd.arg("-y"); // overwrite output

    // Protocol-specific input tuning flags
    for flag in protocol.ffmpeg_input_flags() {
        cmd.arg(flag);
    }

    // URL input
    cmd.arg("-i").arg(&job.url);

    // Stream copy to avoid transcoding CPU load and maintain source quality
    cmd.arg("-c").arg("copy");

    // Preserve timestamps and prevent A/V desync across discontinuities
    cmd.arg("-fflags").arg("+genpts");
    cmd.arg("-avoid_negative_ts").arg("make_zero");

    // Container-specific stream formatting
    let target_str = target_path.to_string_lossy().to_lowercase();
    if target_str.ends_with(".mp4") || target_str.ends_with(".m4v") {
        // Fragmented MP4 guarantees valid playback even if recording is interrupted or stopped
        cmd.arg("-f").arg("mp4");
        cmd.arg("-movflags")
            .arg("+frag_keyframe+empty_moov+default_base_moof");
    } else if target_str.ends_with(".ts") {
        cmd.arg("-f").arg("mpegts");
    } else if target_str.ends_with(".mkv") {
        cmd.arg("-f").arg("matroska");
    } else {
        cmd.arg("-f").arg("mp4");
        cmd.arg("-movflags")
            .arg("+frag_keyframe+empty_moov+default_base_moof");
    }

    // Optional duration limit
    if let Some(opts) = &options {
        if let Some(max_dur) = opts.max_duration {
            cmd.arg("-t").arg(format!("{}", max_dur.as_secs()));
        }
    }

    cmd.arg(&temp_path);

    // Windows: prevent console popup window
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    cmd.kill_on_drop(true);

    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());

    tracing::info!(
        "[Live Recorder] Starting FFmpeg process for job '{}' ({:?}): {:?}",
        job.id,
        protocol,
        cmd
    );

    let mut child = cmd
        .spawn()
        .map_err(|e| EngineError::Other(format!("Failed to spawn FFmpeg process: {}", e)))?;

    let mut stdin = child.stdin.take();
    let stderr = child.stderr.take();
    let stderr_logs = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let stderr_c = stderr_logs.clone();

    if let Some(mut err_pipe) = stderr {
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut buf = [0u8; 1024];
            while let Ok(n) = err_pipe.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                let s = String::from_utf8_lossy(&buf[..n]);
                let mut l = stderr_c.lock().unwrap();
                l.push_str(&s);
                if l.len() > 10000 {
                    let trim = l.len() - 10000;
                    *l = l[trim..].to_string();
                }
            }
        });
    }

    let mut last_bytes = 0u64;
    let mut last_instant = Instant::now();
    let start_instant = Instant::now();
    let mut user_stopped = false;

    // Monitoring and progress loop
    loop {
        // Check if child has exited on its own
        match child.try_wait() {
            Ok(Some(status)) => {
                tracing::info!(
                    "[Live Recorder] FFmpeg process exited with status: {}",
                    status
                );
                let _ = child.wait().await;
                break;
            }
            Ok(None) => {}
            Err(e) => {
                tracing::warn!("[Live Recorder] Error polling FFmpeg process: {}", e);
                break;
            }
        }

        // Check if user requested clean STOP
        if stop_token.is_cancelled() {
            tracing::info!(
                "[Live Recorder] Stop recording requested for job '{}'",
                job.id
            );
            user_stopped = true;

            // Send 'q' to FFmpeg stdin to request graceful stream finalization
            if let Some(mut sin) = stdin.take() {
                let _ = sin.write_all(b"q\n").await;
                let _ = sin.flush().await;
                drop(sin);
            }

            // Allow up to 4 seconds for FFmpeg to write trailers and exit
            let stop_wait = Instant::now();
            let mut exited = false;
            while stop_wait.elapsed() < Duration::from_millis(4000) {
                if let Ok(Some(_)) = child.try_wait() {
                    exited = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }

            // Force kill if not exited after grace period
            if !exited {
                let _ = child.kill().await;
            }
            let _ = child.wait().await;
            break;
        }

        // Check if user requested CANCEL (abort and discard)
        if cancel_token.is_cancelled() {
            tracing::info!("[Live Recorder] Recording cancelled for job '{}'", job.id);
            drop(stdin.take());
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = fs::remove_file(&temp_path);
            return Err(EngineError::Cancelled);
        }

        // Sample recorded bytes from disk
        let current_bytes = fs::metadata(&temp_path).map(|m| m.len()).unwrap_or(0);
        let now = Instant::now();
        let elapsed_sec = now.duration_since(last_instant).as_secs_f64();

        let speed_bps = if elapsed_sec > 0.05 && current_bytes >= last_bytes {
            ((current_bytes - last_bytes) as f64 / elapsed_sec) as u64
        } else {
            0
        };

        if current_bytes != last_bytes {
            last_bytes = current_bytes;
            last_instant = now;

            let _ = db.update_downloaded_bytes(&job.id, current_bytes);

            event_bus.emit(DownloadEvent::Progress(DownloadProgress {
                id: job.id.clone(),
                downloaded_bytes: current_bytes,
                total_bytes: None,
                speed_bps,
                eta_seconds: None,
                state: JobState::Downloading,
                error_message: None,
            }));
        }

        // If options specify max duration, let FFmpeg exit via -t, with safety timeout
        if let Some(opts) = &options {
            if let Some(max_dur) = opts.max_duration {
                let safety_timeout = max_dur + Duration::from_secs(4);
                if start_instant.elapsed() >= safety_timeout {
                    tracing::info!(
                        "[Live Recorder] Safety timeout reached for job '{}'",
                        job.id
                    );
                    user_stopped = true;
                    if let Some(mut sin) = stdin.take() {
                        let _ = sin.write_all(b"q\n").await;
                        let _ = sin.flush().await;
                        drop(sin);
                    }
                    let stop_wait = Instant::now();
                    let mut exited = false;
                    while stop_wait.elapsed() < Duration::from_millis(3000) {
                        if let Ok(Some(_)) = child.try_wait() {
                            exited = true;
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                    if !exited {
                        let _ = child.kill().await;
                    }
                    let _ = child.wait().await;
                    break;
                }
            }
        }

        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    // Verify resulting recorded file
    if !temp_path.exists() {
        let start_check = Instant::now();
        while !temp_path.exists() && start_check.elapsed() < Duration::from_millis(500) {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    if !temp_path.exists() {
        let logs = stderr_logs.lock().unwrap().clone();
        return Err(EngineError::Other(format!(
            "Live stream recording produced no output file. FFmpeg stderr:\n{}",
            logs
        )));
    }

    let file_size = fs::metadata(&temp_path)?.len();
    if file_size == 0 {
        let _ = fs::remove_file(&temp_path);
        return Err(EngineError::Other(
            "Recorded live stream file is empty (0 bytes)".to_string(),
        ));
    }

    // FFprobe verification
    if find_ffprobe().is_some() {
        match probe_duration(&temp_path) {
            Ok(duration) => {
                if duration <= 0.0 && !user_stopped {
                    tracing::warn!(
                        "[Live Recorder] Probe reported duration {:.2}s for {:?}",
                        duration,
                        temp_path
                    );
                } else {
                    tracing::info!(
                        "[Live Recorder] Successfully verified recorded media: duration={:.2}s, size={} bytes",
                        duration,
                        file_size
                    );
                }
            }
            Err(e) => {
                // If user deliberately stopped after capturing bytes, partial files are often valid
                if !user_stopped && file_size < 4096 {
                    let _ = fs::remove_file(&temp_path);
                    return Err(EngineError::Other(format!(
                        "Recorded media stream probe failed: {}",
                        e
                    )));
                }
            }
        }
    }

    // Publish to final destination with retry backoff against Windows locks
    publish_final_file(&temp_path, &target_path).await?;

    // Transition to Completed in database
    db.update_job_state(&job.id, JobState::Completed, None)?;
    let _ = db.update_downloaded_bytes(&job.id, file_size);

    event_bus.emit(DownloadEvent::StateChanged {
        id: job.id.clone(),
        state: JobState::Completed,
        error: None,
    });

    tracing::info!(
        "[Live Recorder] Job '{}' completed. Saved to {:?}",
        job.id,
        target_path
    );

    Ok(())
}

/// Publishes the recorded file to final target with exponential retry backoff.
pub async fn publish_final_file(temp_path: &Path, target_path: &Path) -> Result<()> {
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
                    "[Live Recorder] Rename {:?} to {:?} failed (attempt {}): {}. Retrying in {}ms...",
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
