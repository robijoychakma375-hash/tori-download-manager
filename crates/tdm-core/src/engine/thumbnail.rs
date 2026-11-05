use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::db::Database;
use crate::error::{EngineError, Result};
use crate::hls::muxer::{find_ffmpeg, silent_command};
use crate::resolver::ssrf::validate_safe_media_url;

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DEFAULT_MAX_CACHE_BYTES: u64 = 50 * 1024 * 1024; // 50 MB
const DEFAULT_MAX_CACHE_FILES: usize = 500;

/// Pure Rust RFC 4648 base64 encoder (zero extra dependencies).
pub fn base64_encode(data: &[u8]) -> String {
    let mut result = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;

        result.push(BASE64_ALPHABET[((triple >> 18) & 0x3F) as usize] as char);
        result.push(BASE64_ALPHABET[((triple >> 12) & 0x3F) as usize] as char);

        if chunk.len() > 1 {
            result.push(BASE64_ALPHABET[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }

        if chunk.len() > 2 {
            result.push(BASE64_ALPHABET[(triple & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

/// Resolves the dedicated local thumbnail cache directory.
pub fn get_thumbnail_cache_dir() -> PathBuf {
    let dir = if let Ok(override_dir) = std::env::var("TORI_DATA_DIR") {
        PathBuf::from(override_dir).join("thumbnails")
    } else if let Ok(app_data) = std::env::var("APPDATA") {
        PathBuf::from(app_data)
            .join("tori-download-manager")
            .join("thumbnails")
    } else {
        PathBuf::from(".tdm-data").join("thumbnails")
    };

    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir
}

/// Enforces strict cache limits (max total bytes and max file count) using LRU eviction.
pub fn enforce_thumbnail_cache_limits(cache_dir: &Path, max_bytes: u64, max_files: usize) {
    let Ok(entries) = fs::read_dir(cache_dir) else {
        return;
    };

    struct FileEntry {
        path: PathBuf,
        size: u64,
        modified: std::time::SystemTime,
    }

    let mut files = Vec::new();
    let mut total_size = 0u64;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if let Ok(meta) = fs::metadata(&path) {
                let size = meta.len();
                let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
                total_size += size;
                files.push(FileEntry {
                    path,
                    size,
                    modified,
                });
            }
        }
    }

    if total_size <= max_bytes && files.len() <= max_files {
        return;
    }

    // Sort oldest first
    files.sort_by_key(|f| f.modified);
    let mut current_file_count = files.len();

    for f in files {
        if total_size > max_bytes || current_file_count > max_files {
            let _ = fs::remove_file(&f.path);
            total_size = total_size.saturating_sub(f.size);
            current_file_count = current_file_count.saturating_sub(1);
        } else {
            break;
        }
    }
}

/// Extracts a genuine high-resolution thumbnail frame directly from a local video file using FFmpeg.
pub fn extract_thumbnail_from_video(video_path: &Path, output_path: &Path) -> Result<String> {
    if !video_path.exists() {
        return Err(EngineError::Other(format!(
            "Video file does not exist: {:?}",
            video_path
        )));
    }

    let ffmpeg_bin = find_ffmpeg()
        .ok_or_else(|| EngineError::Other("FFmpeg is required for thumbnail extraction".into()))?;

    if let Some(parent) = output_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    // Try extracting at 1 second, then fallback to 0.1s or 0s for short clips
    let seek_times = ["00:00:01", "00:00:00.1", "00:00:00"];
    let mut success = false;

    for seek in seek_times {
        let status = silent_command(&ffmpeg_bin)
            .args([
                "-y",
                "-ss",
                seek,
                "-i",
                video_path.to_str().unwrap_or_default(),
                "-vframes",
                "1",
                "-vf",
                "scale=128:-1",
                "-q:v",
                "3",
                "-update",
                "1",
                output_path.to_str().unwrap_or_default(),
            ])
            .status();

        if let Ok(st) = status {
            if st.success() && output_path.exists() {
                if let Ok(meta) = fs::metadata(output_path) {
                    if meta.len() > 100 {
                        success = true;
                        break;
                    }
                }
            }
        }
    }

    if !success || !output_path.exists() {
        return Err(EngineError::Other(
            "FFmpeg failed to extract video thumbnail".into(),
        ));
    }

    let bytes = fs::read(output_path)?;
    if bytes.is_empty() {
        return Err(EngineError::Other("Extracted thumbnail is empty".into()));
    }

    if let Some(parent) = output_path.parent() {
        enforce_thumbnail_cache_limits(parent, DEFAULT_MAX_CACHE_BYTES, DEFAULT_MAX_CACHE_FILES);
    }

    let data_uri = format!("data:image/jpeg;base64,{}", base64_encode(&bytes));
    Ok(data_uri)
}

/// Downloads and caches a remote image thumbnail locally, returning a persistent data URI.
pub async fn cache_remote_thumbnail(url: &str, output_path: &Path) -> Result<String> {
    let safe_url = validate_safe_media_url(url).await?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) TORI/2.0")
        .build()
        .unwrap_or_default();

    let resp = client
        .get(safe_url.as_str())
        .send()
        .await
        .map_err(|e| EngineError::Other(format!("Thumbnail download request failed: {}", e)))?;

    if !resp.status().is_success() {
        return Err(EngineError::Other(format!(
            "Remote thumbnail returned HTTP {}",
            resp.status()
        )));
    }

    // Limit image download to 2MB to prevent memory exhaustion
    if let Some(len) = resp.content_length() {
        if len > 2 * 1024 * 1024 {
            return Err(EngineError::Other(
                "Remote thumbnail exceeds 2MB limit".into(),
            ));
        }
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| EngineError::Other(format!("Failed reading thumbnail bytes: {}", e)))?;

    if bytes.len() < 100 || bytes.len() > 2 * 1024 * 1024 {
        return Err(EngineError::Other(
            "Invalid thumbnail image byte size".into(),
        ));
    }

    if let Some(parent) = output_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    fs::write(output_path, &bytes)?;

    if let Some(parent) = output_path.parent() {
        enforce_thumbnail_cache_limits(parent, DEFAULT_MAX_CACHE_BYTES, DEFAULT_MAX_CACHE_FILES);
    }

    let mime = if bytes.starts_with(b"\x89PNG") {
        "image/png"
    } else if bytes.starts_with(b"RIFF") && bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "image/jpeg"
    };

    let data_uri = format!("data:{};base64,{}", mime, base64_encode(&bytes));
    Ok(data_uri)
}

/// Ensures a download job has a persistent, locally cached thumbnail, updating SQLite when resolved.
pub async fn ensure_cached_thumbnail(
    job_id: &str,
    thumbnail_url: Option<&str>,
    target_path: Option<&str>,
    db: &Database,
) -> Option<String> {
    // 1. If already a persistent local data URI, return immediately
    if let Some(thumb) = thumbnail_url {
        if thumb.starts_with("data:image/") {
            return Some(thumb.to_string());
        }
    }

    let cache_dir = get_thumbnail_cache_dir();
    let local_file = cache_dir.join(format!("{}.jpg", job_id));

    // 2. If the cached file already exists on disk, encode and update SQLite
    if local_file.exists() {
        if let Ok(bytes) = fs::read(&local_file) {
            if bytes.len() > 100 {
                let data_uri = format!("data:image/jpeg;base64,{}", base64_encode(&bytes));
                let _ = db.update_thumbnail_url(job_id, &data_uri);
                return Some(data_uri);
            }
        }
    }

    // 3. If a remote thumbnail URL is provided, download and cache it locally
    if let Some(remote_url) = thumbnail_url {
        if remote_url.starts_with("http://") || remote_url.starts_with("https://") {
            if let Ok(data_uri) = cache_remote_thumbnail(remote_url, &local_file).await {
                let _ = db.update_thumbnail_url(job_id, &data_uri);
                return Some(data_uri);
            }
        }
    }

    // 4. If the target video file exists on disk, extract genuine thumbnail frame via FFmpeg
    if let Some(path_str) = target_path {
        let p = Path::new(path_str);
        if p.exists() {
            if let Ok(data_uri) = extract_thumbnail_from_video(p, &local_file) {
                let _ = db.update_thumbnail_url(job_id, &data_uri);
                return Some(data_uri);
            }
        }
    }

    None
}

/// Backfills missing or non-persistent thumbnails for completed downloads without re-downloading media.
pub async fn backfill_missing_thumbnails(db: &Database) -> usize {
    let Ok(jobs) = db.list_jobs() else {
        return 0;
    };

    let mut backfilled = 0;

    for job in jobs {
        let needs_backfill = match job.thumbnail_url.as_deref() {
            None => true,
            Some(t) => !t.starts_with("data:image/"),
        };

        if needs_backfill {
            if let Some(_data_uri) = ensure_cached_thumbnail(
                &job.id,
                job.thumbnail_url.as_deref(),
                Some(&job.target_path),
                db,
            )
            .await
            {
                backfilled += 1;
                tracing::info!(
                    "[Thumbnail Backfill] Successfully backfilled thumbnail for job '{}' ({})",
                    job.id,
                    job.filename
                );
            }
        }
    }

    backfilled
}
