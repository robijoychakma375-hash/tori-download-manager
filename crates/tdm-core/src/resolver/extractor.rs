use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::error::{EngineError, Result};
use crate::resolver::discovery::{find_ffmpeg, find_yt_dlp};

pub const DEFAULT_RESOLVER_TIMEOUT: Duration = Duration::from_secs(30);
pub const GENERIC_RESOLVER_TIMEOUT: Duration = Duration::from_secs(10);
pub const MAX_JSON_OUTPUT_BYTES: usize = 12 * 1024 * 1024; // 12 MB max

/// Invokes `yt-dlp` to dump structured JSON metadata for a media URL.
/// Strictly uses explicit argument arrays, bounded memory capture, and process cancellation.
pub async fn execute_yt_dlp_dump(
    url: &str,
    timeout_dur: Option<Duration>,
) -> Result<serde_json::Value> {
    let yt_dlp_bin = find_yt_dlp().ok_or_else(|| {
        EngineError::Other(
            "yt-dlp executable was not found. Please install yt-dlp or place it in the TORI bin folder."
                .to_string(),
        )
    })?;

    let timeout = timeout_dur.unwrap_or(DEFAULT_RESOLVER_TIMEOUT);

    let mut args: Vec<String> = vec![
        "--dump-single-json".to_string(),
        "--no-playlist".to_string(),
        "--no-warnings".to_string(),
        "--no-call-home".to_string(),
        "--no-check-certificates".to_string(),
        "--prefer-free-formats".to_string(),
        "--skip-download".to_string(),
        "--no-color".to_string(),
    ];

    // If FFmpeg is found, provide --ffmpeg-location
    if let Some(ffmpeg_bin) = find_ffmpeg() {
        if let Some(parent) = ffmpeg_bin.parent() {
            args.push("--ffmpeg-location".to_string());
            args.push(parent.to_string_lossy().to_string());
        }
    }

    // Add target URL as the final explicit argument
    args.push(url.to_string());

    let mut cmd = Command::new(&yt_dlp_bin);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Suppress window popup on Windows
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| EngineError::Other(format!("Failed to spawn yt-dlp process: {}", e)))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| EngineError::Other("Failed to capture yt-dlp stdout".to_string()))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| EngineError::Other("Failed to capture yt-dlp stderr".to_string()))?;

    let mut stdout_buf = Vec::new();
    let mut stderr_buf = Vec::new();

    let read_future = async {
        let mut out_chunk = [0u8; 8192];
        let mut err_chunk = [0u8; 8192];

        loop {
            tokio::select! {
                n = stdout.read(&mut out_chunk) => {
                    let n = n.map_err(|e| EngineError::Other(format!("Stdout read error: {}", e)))?;
                    if n == 0 {
                        // EOF on stdout, drain stderr
                        let _ = stderr.read_to_end(&mut stderr_buf).await;
                        break;
                    }
                    if stdout_buf.len() + n > MAX_JSON_OUTPUT_BYTES {
                        return Err(EngineError::Other("yt-dlp output exceeded maximum memory limit (12MB)".to_string()));
                    }
                    stdout_buf.extend_from_slice(&out_chunk[..n]);
                }
                n = stderr.read(&mut err_chunk) => {
                    let n = n.map_err(|e| EngineError::Other(format!("Stderr read error: {}", e)))?;
                    if n > 0 && stderr_buf.len() < 32768 {
                        stderr_buf.extend_from_slice(&err_chunk[..n]);
                    }
                }
            }
        }

        let status = child
            .wait()
            .await
            .map_err(|e| EngineError::Other(format!("Failed waiting for yt-dlp exit: {}", e)))?;

        Ok::<std::process::ExitStatus, EngineError>(status)
    };

    let status = match tokio::time::timeout(timeout, read_future).await {
        Ok(res) => res?,
        Err(_) => {
            return Err(EngineError::Other(format!(
                "yt-dlp resolution timed out after {} seconds.",
                timeout.as_secs()
            )));
        }
    };

    if !status.success() {
        let err_str = String::from_utf8_lossy(&stderr_buf);
        let cleaned_err = clean_ytdlp_error(&err_str);
        return Err(EngineError::Other(cleaned_err));
    }

    let parsed_json: serde_json::Value = serde_json::from_slice(&stdout_buf)
        .map_err(|e| EngineError::Other(format!("Failed to parse yt-dlp JSON output: {}", e)))?;

    Ok(parsed_json)
}

/// Invokes `yt-dlp` to dump fast flat JSON metadata for a playlist URL.
pub async fn execute_yt_dlp_playlist_dump(
    url: &str,
    limit: Option<usize>,
    timeout_dur: Option<Duration>,
) -> Result<serde_json::Value> {
    let yt_dlp_bin = find_yt_dlp().ok_or_else(|| {
        EngineError::Other(
            "yt-dlp executable was not found. Please install yt-dlp or place it in the TORI bin folder."
                .to_string(),
        )
    })?;

    let timeout = timeout_dur.unwrap_or(DEFAULT_RESOLVER_TIMEOUT);

    let mut args: Vec<String> = vec![
        "-J".to_string(),
        "--flat-playlist".to_string(),
        "--no-warnings".to_string(),
        "--no-call-home".to_string(),
        "--no-check-certificates".to_string(),
        "--skip-download".to_string(),
        "--no-color".to_string(),
    ];

    if let Some(max_items) = limit {
        args.push("--playlist-end".to_string());
        args.push(max_items.to_string());
    }

    if let Some(ffmpeg_bin) = find_ffmpeg() {
        if let Some(parent) = ffmpeg_bin.parent() {
            args.push("--ffmpeg-location".to_string());
            args.push(parent.to_string_lossy().to_string());
        }
    }

    args.push(url.to_string());

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

    let mut child = cmd
        .spawn()
        .map_err(|e| EngineError::Other(format!("Failed to spawn yt-dlp process: {}", e)))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| EngineError::Other("Failed to capture yt-dlp stdout".to_string()))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| EngineError::Other("Failed to capture yt-dlp stderr".to_string()))?;

    let mut stdout_buf = Vec::new();
    let mut stderr_buf = Vec::new();

    let read_future = async {
        let mut out_chunk = [0u8; 8192];
        let mut err_chunk = [0u8; 8192];

        loop {
            tokio::select! {
                n = stdout.read(&mut out_chunk) => {
                    let n = n.map_err(|e| EngineError::Other(format!("Stdout read error: {}", e)))?;
                    if n == 0 {
                        let _ = stderr.read_to_end(&mut stderr_buf).await;
                        break;
                    }
                    if stdout_buf.len() + n > MAX_JSON_OUTPUT_BYTES {
                        return Err(EngineError::Other("yt-dlp output exceeded maximum memory limit (12MB)".to_string()));
                    }
                    stdout_buf.extend_from_slice(&out_chunk[..n]);
                }
                n = stderr.read(&mut err_chunk) => {
                    let n = n.map_err(|e| EngineError::Other(format!("Stderr read error: {}", e)))?;
                    if n > 0 && stderr_buf.len() < 32768 {
                        stderr_buf.extend_from_slice(&err_chunk[..n]);
                    }
                }
            }
        }

        let status = child
            .wait()
            .await
            .map_err(|e| EngineError::Other(format!("Failed waiting for yt-dlp exit: {}", e)))?;

        Ok::<std::process::ExitStatus, EngineError>(status)
    };

    let status = match tokio::time::timeout(timeout, read_future).await {
        Ok(res) => res?,
        Err(_) => {
            return Err(EngineError::Other(format!(
                "yt-dlp resolution timed out after {} seconds.",
                timeout.as_secs()
            )));
        }
    };

    if !status.success() {
        let err_str = String::from_utf8_lossy(&stderr_buf);
        let cleaned_err = clean_ytdlp_error(&err_str);
        return Err(EngineError::Other(cleaned_err));
    }

    let parsed_json: serde_json::Value = serde_json::from_slice(&stdout_buf)
        .map_err(|e| EngineError::Other(format!("Failed to parse yt-dlp JSON output: {}", e)))?;

    Ok(parsed_json)
}

/// Categorizes and cleans yt-dlp stderr for user-facing error reporting.
pub fn clean_ytdlp_error(raw_stderr: &str) -> String {
    let lower = raw_stderr.to_lowercase();

    // Specific platform restrictions (Plex, DRM, copy protection)
    if lower.contains("watch.plex.tv") || lower.contains("plex.tv") {
        return "watch.plex.tv content is DRM-protected and not licensed for offline download."
            .to_string();
    }
    if lower.contains("drm protected")
        || lower.contains("this video is drm protected")
        || lower.contains("widevine")
        || lower.contains("playready")
        || lower.contains("fairplay")
    {
        return "This media is protected by Digital Rights Management (DRM) and cannot be downloaded.".to_string();
    }

    // Access control & Authorization
    if lower.contains("private video") || lower.contains("this video is private") {
        return "This media is private and cannot be accessed without authorization.".to_string();
    }
    if lower.contains("sign in to confirm your age") || lower.contains("age-restricted") {
        return "This media requires age verification sign-in on the host platform.".to_string();
    }
    if lower.contains("members-only") || lower.contains("join this channel") {
        return "This media requires a channel membership or paid subscription.".to_string();
    }
    if lower.contains("login required")
        || lower.contains("sign in to facebook")
        || lower.contains("log in to continue")
        || lower.contains("requires authentication")
        || lower.contains("login.php")
    {
        return "Authentication required on the host platform. This media is restricted to logged-in users.".to_string();
    }
    if lower.contains("http error 403")
        || lower.contains("403: forbidden")
        || lower.contains("access denied")
    {
        return "Remote server denied access (HTTP 403 Forbidden).".to_string();
    }

    // Rate limiting & Network connectivity
    if lower.contains("http error 429")
        || lower.contains("rate limit")
        || lower.contains("too many requests")
    {
        return "Rate limited by the host platform (HTTP 429). Please wait before retrying."
            .to_string();
    }
    if lower.contains("connection lost")
        || lower.contains("connection reset")
        || lower.contains("connection timed out")
        || lower.contains("network is unreachable")
        || lower.contains("econnreset")
    {
        return "Connection interrupted. Network or remote server closed the connection."
            .to_string();
    }

    // Expiry & Resource availability
    if lower.contains("signature has expired")
        || lower.contains("url expired")
        || lower.contains("token expired")
        || lower.contains("expired token")
    {
        return "Media URL expired. Please refresh the stream to obtain a new token.".to_string();
    }
    if lower.contains("format not available") || lower.contains("requested format not available") {
        return "Requested media format is unavailable on the host server.".to_string();
    }
    if lower.contains("video unavailable") || lower.contains("media unavailable") {
        return "This media is unavailable or has been removed by the author.".to_string();
    }
    if lower.contains("no video formats") || lower.contains("no formats found") {
        return "No downloadable media found on this page.".to_string();
    }
    if lower.contains("unsupported url") || lower.contains("no suitable extractor") {
        return "No supported media extractor found for this webpage URL.".to_string();
    }

    // Return the last relevant ERROR line if found
    for line in raw_stderr.lines().rev() {
        let l = line.trim();
        if l.starts_with("ERROR:") {
            return l.trim_start_matches("ERROR:").trim().to_string();
        }
    }

    if raw_stderr.trim().is_empty() {
        "Media extraction failed (process returned non-zero exit code).".to_string()
    } else {
        raw_stderr.trim().to_string()
    }
}
