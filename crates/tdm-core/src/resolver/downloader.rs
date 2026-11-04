use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::db::Database;
use crate::engine::EventBus;
use crate::error::{EngineError, Result};
use crate::resolver::discovery::{find_ffmpeg, find_yt_dlp};
use crate::resolver::extractor::clean_ytdlp_error;
use crate::types::{DownloadJob, DownloadProgress, JobState};
use crate::DownloadEvent;

/// Executes an external managed media download using yt-dlp and FFmpeg, streaming real-time
/// progress into SQLite and the TORI EventBus.
pub async fn download_managed_media(
    job: &DownloadJob,
    db: &Database,
    event_bus: &EventBus,
    cancel_token: &CancellationToken,
) -> Result<()> {
    let yt_dlp_bin = find_yt_dlp().ok_or_else(|| {
        EngineError::Other(
            "yt-dlp executable was not found. Please install yt-dlp or place it in the TORI bin directory."
                .to_string(),
        )
    })?;

    let mut args: Vec<String> = vec![
        "--no-playlist".to_string(),
        "--continue".to_string(),
        "--newline".to_string(),
        "--no-warnings".to_string(),
        "--no-call-home".to_string(),
        "--no-color".to_string(),
        "--prefer-free-formats".to_string(),
        "--progress-template".to_string(),
        "download:[TORI_PROG]|%(progress._percent_str)s;%(progress.downloaded_bytes)s;%(progress.total_bytes)s;%(progress.speed)s;%(progress.eta)s".to_string(),
        "--progress-template".to_string(),
        "postprocess:[TORI_MERGE]|%(progress.status)s".to_string(),
    ];

    // Format selection
    if let Some(ref fmt) = job.resolved_url {
        let trimmed = fmt.trim();
        if !trimmed.is_empty() && trimmed != "default" && trimmed != "auto" {
            let format_arg = if trimmed.starts_with("format:") {
                trimmed.strip_prefix("format:").unwrap_or(trimmed).trim()
            } else {
                trimmed
            };
            args.push("-f".to_string());
            let is_audio = format_arg.contains("audio")
                || format_arg.contains("ba")
                || is_common_audio_format(format_arg);
            if format_arg.contains('+') || is_audio {
                args.push(format_arg.to_string());
            } else {
                // If single video format is specified, ensure it pairs with best audio so it's not silent
                args.push(format!("{format_arg}+bestaudio/best/{format_arg}"));
            }
        }
    }

    // Configure FFmpeg location if available for stream-copy muxing
    if let Some(ffmpeg_bin) = find_ffmpeg() {
        if let Some(parent) = ffmpeg_bin.parent() {
            args.push("--ffmpeg-location".to_string());
            args.push(parent.to_string_lossy().to_string());
        }
    }

    // Prefer standard MP4 output container when stream codecs allow, fallback to MKV or WebM
    args.push("--merge-output-format".to_string());
    args.push("mp4/mkv/webm".to_string());

    // Output file path
    args.push("-o".to_string());
    args.push(job.target_path.clone());

    // Target media URL
    args.push(job.url.clone());

    let mut cmd = Command::new(&yt_dlp_bin);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    tracing::info!(
        "[Managed Resolver] Launching yt-dlp download for job '{}': {:?}",
        job.id,
        args
    );

    let mut child = cmd
        .spawn()
        .map_err(|e| EngineError::Other(format!("Failed to spawn yt-dlp process: {}", e)))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| EngineError::Other("Failed to capture yt-dlp stdout".to_string()))?;
    let stderr = child.stderr.take();

    let stderr_buf = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let stderr_c = stderr_buf.clone();

    if let Some(mut err_pipe) = stderr {
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut buf = [0u8; 1024];
            while let Ok(n) = err_pipe.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                let s = String::from_utf8_lossy(&buf[..n]);
                let mut guard = stderr_c.lock().unwrap();
                guard.push_str(&s);
                if guard.len() > 10000 {
                    let trim = guard.len() - 10000;
                    *guard = guard[trim..].to_string();
                }
            }
        });
    }

    let mut reader = BufReader::new(stdout).lines();
    let mut last_progress_emit = Instant::now();
    let mut total_expected_bytes: Option<u64> = job.total_bytes;
    let mut accumulated_completed_bytes: u64 = 0;
    let mut current_stream_last_bytes: u64 = 0;
    let mut is_merging = false;

    loop {
        tokio::select! {
            _ = cancel_token.cancelled() => {
                tracing::info!("[Managed Resolver] Cancellation or pause requested for job '{}'", job.id);
                let _ = child.kill().await;
                // Preserve .part and .ytdl partial files on disk to allow true pause and resume!
                // Partial files are only removed on explicit job deletion or restart.
                return Err(EngineError::Cancelled);
            }
            line_res = reader.next_line() => {
                match line_res {
                    Ok(Some(line)) => {
                        let trimmed = line.trim();
                        if trimmed.starts_with("[download] Destination:") {
                            // A new stream target has begun. Accumulate previous stream's downloaded bytes.
                            accumulated_completed_bytes += current_stream_last_bytes;
                            current_stream_last_bytes = 0;
                        } else if trimmed.starts_with("[TORI_PROG]|") {
                            if let Some(prog) = parse_progress_template(trimmed) {
                                if prog.downloaded_bytes < current_stream_last_bytes {
                                    accumulated_completed_bytes += current_stream_last_bytes;
                                }
                                current_stream_last_bytes = prog.downloaded_bytes;
                                let current_downloaded = accumulated_completed_bytes + current_stream_last_bytes;

                                if total_expected_bytes.is_none() && prog.total_bytes.is_some() {
                                    total_expected_bytes = prog.total_bytes;
                                }

                                if last_progress_emit.elapsed() >= Duration::from_millis(250) {
                                    last_progress_emit = Instant::now();
                                    let _ = db.update_downloaded_bytes(&job.id, current_downloaded);

                                    let active_state = if is_merging {
                                        JobState::Verifying
                                    } else {
                                        JobState::Downloading
                                    };

                                    event_bus.emit(DownloadEvent::Progress(DownloadProgress {
                                        id: job.id.clone(),
                                        downloaded_bytes: current_downloaded,
                                        total_bytes: total_expected_bytes.or(Some(current_downloaded)),
                                        speed_bps: prog.speed_bps,
                                        eta_seconds: prog.eta_seconds,
                                        state: active_state,
                                        error_message: if is_merging {
                                            Some("Merging video and audio streams...".to_string())
                                        } else {
                                            None
                                        },
                                    }));
                                }
                            }
                        } else if trimmed.starts_with("[TORI_MERGE]|started")
                            || trimmed.contains("[Merger]")
                            || trimmed.contains("[Fixup")
                        {
                            is_merging = true;
                            let total_downloaded =
                                accumulated_completed_bytes + current_stream_last_bytes;
                            let _ = db.update_job_state(&job.id, JobState::Verifying, None);
                            event_bus.emit(DownloadEvent::Progress(DownloadProgress {
                                id: job.id.clone(),
                                downloaded_bytes: total_downloaded,
                                total_bytes: total_expected_bytes.or(Some(total_downloaded)),
                                speed_bps: 0,
                                eta_seconds: Some(0),
                                state: JobState::Verifying,
                                error_message: Some(
                                    "Merging video and audio streams via FFmpeg...".to_string(),
                                ),
                            }));
                            event_bus.emit(DownloadEvent::StateChanged {
                                id: job.id.clone(),
                                state: JobState::Verifying,
                                error: None,
                            });
                        }
                    }
                    Ok(None) => {
                        // EOF on stdout
                        break;
                    }
                    Err(e) => {
                        tracing::warn!("[Managed Resolver] Stdout reading error: {}", e);
                        break;
                    }
                }
            }
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| EngineError::Other(format!("Failed waiting for yt-dlp exit: {}", e)))?;

    if !status.success() {
        let raw_err = {
            let guard = stderr_buf.lock().unwrap();
            guard.clone()
        };
        let user_err = clean_ytdlp_error(&raw_err);
        cleanup_partial_files(&job.target_path);
        return Err(EngineError::Other(user_err));
    }

    // Verify output file existence (handle cases where container format changed, e.g. .mkv / .webm)
    let final_path = locate_actual_output_file(&job.target_path);
    if let Some(found_path) = final_path {
        let meta = fs::metadata(&found_path)?;
        let final_size = meta.len();

        let _ = db.update_downloaded_bytes(&job.id, final_size);
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
            "[Managed Resolver] Job '{}' completed successfully ({} bytes) -> {:?}",
            job.id,
            final_size,
            found_path
        );
        Ok(())
    } else {
        Err(EngineError::Other(
            "Download finished but output file was not found on disk.".to_string(),
        ))
    }
}

struct ParsedProgress {
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    speed_bps: u64,
    eta_seconds: Option<u64>,
}

fn is_common_audio_format(fmt: &str) -> bool {
    let lower = fmt.to_lowercase();
    matches!(
        lower.as_str(),
        "139"
            | "140"
            | "249"
            | "250"
            | "251"
            | "233"
            | "234"
            | "m4a"
            | "opus"
            | "mp3"
            | "aac"
            | "flac"
            | "wav"
            | "ogg"
            | "bestaudio"
            | "ba"
    ) || lower.starts_with("audio")
}

fn parse_progress_template(line: &str) -> Option<ParsedProgress> {
    // format: [TORI_PROG]|%(progress._percent_str)s;%(progress.downloaded_bytes)s;%(progress.total_bytes)s;%(progress.speed)s;%(progress.eta)s
    let payload = line.strip_prefix("[TORI_PROG]|")?;
    let parts: Vec<&str> = payload.split(';').collect();
    if parts.len() < 5 {
        return None;
    }

    let downloaded = parts[1].trim().parse::<u64>().unwrap_or(0);
    let total = parts[2].trim().parse::<u64>().ok();
    let speed = parts[3]
        .trim()
        .parse::<f64>()
        .map(|s| s as u64)
        .unwrap_or(0);
    let eta = parts[4].trim().parse::<f64>().map(|e| e as u64).ok();

    Some(ParsedProgress {
        downloaded_bytes: downloaded,
        total_bytes: total,
        speed_bps: speed,
        eta_seconds: eta,
    })
}

fn locate_actual_output_file(target_str: &str) -> Option<PathBuf> {
    let p = Path::new(target_str);
    if p.exists() {
        return Some(p.to_path_buf());
    }

    let parent = p.parent()?;
    let stem = p.file_stem().and_then(|s| s.to_str())?;

    // Try common alternate extensions directly:
    for ext in ["mp4", "mkv", "webm", "m4a", "opus", "mp3"] {
        let alt = parent.join(format!("{}.{}", stem, ext));
        if alt.exists() {
            return Some(alt);
        }
        let alt_double = parent.join(format!("{}.mp4.{}", stem, ext));
        if alt_double.exists() {
            if fs::rename(&alt_double, &alt).is_ok() {
                return Some(alt);
            }
            return Some(alt_double);
        }
    }

    // Check sibling files whose name starts with stem and ends with playable extension
    if let Ok(entries) = fs::read_dir(parent) {
        for entry in entries.flatten() {
            let candidate = entry.path();
            if candidate.is_file() {
                if let Some(name) = candidate.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with(stem) {
                        let lower = name.to_lowercase();
                        if !lower.ends_with(".part")
                            && !lower.ends_with(".ytdl")
                            && !lower.contains(".temp.")
                            && (lower.ends_with(".mp4")
                                || lower.ends_with(".mkv")
                                || lower.ends_with(".webm")
                                || lower.ends_with(".m4a")
                                || lower.ends_with(".opus"))
                        {
                            return Some(candidate);
                        }
                    }
                }
            }
        }
    }

    None
}

pub(crate) fn cleanup_partial_files(target_str: &str) {
    let p = Path::new(target_str);
    let _ = fs::remove_file(p);

    let part1 = format!("{}.part", target_str);
    let _ = fs::remove_file(part1);

    let part2 = format!("{}.ytdl", target_str);
    let _ = fs::remove_file(part2);

    if let (Some(parent), Some(stem)) = (p.parent(), p.file_stem().and_then(|s| s.to_str())) {
        if let Ok(entries) = fs::read_dir(parent) {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                    if file_name.starts_with(stem) {
                        let lower = file_name.to_lowercase();
                        if lower.ends_with(".part")
                            || lower.ends_with(".ytdl")
                            || lower.contains(".temp.")
                            || (lower.contains(".f")
                                && !lower.ends_with(".mp4")
                                && !lower.ends_with(".mkv")
                                && !lower.ends_with(".webm"))
                        {
                            let _ = fs::remove_file(path);
                        }
                    }
                }
            }
        }
    }
}
