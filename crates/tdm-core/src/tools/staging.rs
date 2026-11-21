use chrono::Utc;
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use crate::error::{EngineError, Result};
use crate::tools::trust::{
    build_trusted_http_client, validate_trusted_url, validate_windows_x64_pe_file,
};
use crate::tools::types::ToolId;

pub struct ToolsDirLayout {
    pub root: PathBuf,
    pub versions_ytdlp: PathBuf,
    pub versions_ffmpeg: PathBuf,
    pub staging: PathBuf,
    pub rollback: PathBuf,
    pub manifests: PathBuf,
    pub logs: PathBuf,
}

impl ToolsDirLayout {
    pub fn from_data_dir(data_dir: &Path) -> Self {
        let root = data_dir.join("tools");
        Self {
            versions_ytdlp: root.join("versions").join("yt-dlp"),
            versions_ffmpeg: root.join("versions").join("ffmpeg"),
            staging: root.join("staging"),
            rollback: root.join("rollback"),
            manifests: root.join("manifests"),
            logs: root.join("logs"),
            root,
        }
    }

    pub fn ensure_dirs(&self) -> Result<()> {
        for dir in [
            &self.root,
            &self.versions_ytdlp,
            &self.versions_ffmpeg,
            &self.staging,
            &self.rollback,
            &self.manifests,
            &self.logs,
        ] {
            fs::create_dir_all(dir)?;
        }
        Ok(())
    }

    pub fn active_manifest_path(&self) -> PathBuf {
        self.manifests.join("active-tools.json")
    }

    pub fn active_manifest_backup_path(&self) -> PathBuf {
        self.manifests.join("active-tools.json.bak")
    }

    pub fn log_file_path(&self) -> PathBuf {
        self.logs.join("tools-updater.log")
    }
}

/// Appends a structured diagnostic line to `<data_dir>/tools/logs/tools-updater.log`.
/// Automatically rotates the log file if it exceeds 5 MiB.
pub fn append_tools_log(layout: &ToolsDirLayout, level: &str, action: &str, message: &str) {
    let _ = fs::create_dir_all(&layout.logs);
    let log_path = layout.log_file_path();
    if let Ok(meta) = fs::metadata(&log_path) {
        if meta.len() > 5 * 1024 * 1024 {
            let rotated = layout.logs.join("tools-updater.log.1");
            let _ = fs::remove_file(&rotated);
            let _ = fs::rename(&log_path, &rotated);
        }
    }
    let clean_msg = message.replace(['\r', '\n'], " ");
    let line = format!(
        "{} [{}] [{}] {}\n",
        Utc::now().to_rfc3339(),
        level,
        action,
        clean_msg
    );
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&log_path) {
        let _ = f.write_all(line.as_bytes());
    }
}

pub struct DownloadedArtifact {
    pub path: PathBuf,
    pub size_bytes: u64,
    pub sha256: String,
}

/// Streams a remote verified-host artifact into a `.part` staging file with bounded size,
/// computes streaming SHA-256, verifies against `expected_sha256`, and atomically renames to `dest_path`.
#[allow(clippy::too_many_arguments)]
pub async fn download_artifact_to_staging<F>(
    raw_url: &str,
    dest_path: &Path,
    expected_sha256: &str,
    max_bytes: u64,
    timeout_secs: u64,
    allow_loopback_http: bool,
    mut on_progress: F,
) -> Result<DownloadedArtifact>
where
    F: FnMut(u64, Option<u64>, u64),
{
    let safe_url = validate_trusted_url(raw_url, allow_loopback_http)?;
    let client = build_trusted_http_client(timeout_secs, allow_loopback_http)?;

    let resp = client
        .get(safe_url.as_str())
        .send()
        .await
        .map_err(|e| EngineError::Other(format!("Tool artifact download failed: {}", e)))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(EngineError::Other(format!(
            "Tool artifact server returned HTTP {}",
            status.as_u16()
        )));
    }

    let total_bytes = resp.content_length();
    if let Some(len) = total_bytes {
        if len > max_bytes {
            return Err(EngineError::Other(format!(
                "Tool artifact size ({} bytes) exceeds maximum allowed limit ({} bytes)",
                len, max_bytes
            )));
        }
    }

    if let Some(parent) = dest_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let part_path = dest_path.with_extension("part");
    if part_path.exists() {
        let _ = fs::remove_file(&part_path);
    }

    let mut file = File::create(&part_path)?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let start = Instant::now();
    let mut last_emit = Instant::now();

    let mut stream = resp.bytes_stream();
    while let Some(chunk_res) = stream.next().await {
        let chunk = match chunk_res {
            Ok(c) => c,
            Err(e) => {
                drop(file);
                let _ = fs::remove_file(&part_path);
                return Err(EngineError::Other(format!(
                    "Interrupted tool download stream: {}",
                    e
                )));
            }
        };

        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > max_bytes {
            drop(file);
            let _ = fs::remove_file(&part_path);
            return Err(EngineError::Other(format!(
                "Tool artifact download exceeded maximum allowed limit ({} bytes)",
                max_bytes
            )));
        }

        if let Err(e) = file.write_all(&chunk) {
            drop(file);
            let _ = fs::remove_file(&part_path);
            return Err(EngineError::Io(e));
        }
        hasher.update(&chunk);

        if last_emit.elapsed() >= Duration::from_millis(120) {
            let elapsed = start.elapsed().as_secs_f64().max(0.05);
            let speed_bps = (downloaded as f64 / elapsed) as u64;
            on_progress(downloaded, total_bytes, speed_bps);
            last_emit = Instant::now();
        }
    }

    file.flush()?;
    file.sync_all()?;
    drop(file);

    if downloaded == 0 {
        let _ = fs::remove_file(&part_path);
        return Err(EngineError::Other(
            "Downloaded tool artifact is empty (0 bytes)".to_string(),
        ));
    }

    if let Some(expected_len) = total_bytes {
        if downloaded != expected_len {
            let _ = fs::remove_file(&part_path);
            return Err(EngineError::Other(format!(
                "Truncated tool artifact: downloaded {} of {} bytes",
                downloaded, expected_len
            )));
        }
    }

    let elapsed = start.elapsed().as_secs_f64().max(0.05);
    let final_speed = (downloaded as f64 / elapsed) as u64;
    on_progress(downloaded, total_bytes.or(Some(downloaded)), final_speed);

    let actual_sha256 = hex::encode(hasher.finalize());
    let expected_norm = expected_sha256.trim().to_ascii_lowercase();
    if actual_sha256 != expected_norm {
        let _ = fs::remove_file(&part_path);
        return Err(EngineError::Other(format!(
            "Artifact SHA-256 verification failed: expected {}, got {}",
            expected_norm, actual_sha256
        )));
    }

    if dest_path.exists() {
        let _ = fs::remove_file(dest_path);
    }
    fs::rename(&part_path, dest_path)?;

    Ok(DownloadedArtifact {
        path: dest_path.to_path_buf(),
        size_bytes: downloaded,
        sha256: actual_sha256,
    })
}

/// Validates a ZIP entry's relative path against path traversal (`..`), absolute paths,
/// Windows drive prefixes, null bytes, and symlinks.
fn validate_zip_entry_safety(name: &str, unix_mode: Option<u32>) -> Result<()> {
    if name.is_empty() || name.contains('\0') {
        return Err(EngineError::Other(
            "Rejected archive entry with empty or null-containing name".to_string(),
        ));
    }

    // Reject symlinks stored via Unix external attributes (S_IFLNK == 0o120000)
    if let Some(mode) = unix_mode {
        if (mode & 0o170000) == 0o120000 {
            return Err(EngineError::Other(format!(
                "Rejected archive symlink entry '{}'",
                name
            )));
        }
    }

    // Reject Windows drive letters or absolute paths regardless of slash direction
    let normalized = name.replace('\\', "/");
    if normalized.starts_with('/') || normalized.starts_with("//") {
        return Err(EngineError::Other(format!(
            "Rejected absolute path in archive: '{}'",
            name
        )));
    }
    if normalized.len() >= 2 && normalized.as_bytes()[1] == b':' {
        return Err(EngineError::Other(format!(
            "Rejected drive-prefixed path in archive: '{}'",
            name
        )));
    }

    let path = Path::new(&normalized);
    for comp in path.components() {
        match comp {
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(EngineError::Other(format!(
                    "Rejected path traversal in archive entry '{}'",
                    name
                )));
            }
            Component::CurDir | Component::Normal(_) => {}
        }
    }

    Ok(())
}

pub struct ExtractedFfmpegBundle {
    pub ffmpeg_path: PathBuf,
    pub ffprobe_path: PathBuf,
}

/// Safely extracts ONLY `ffmpeg.exe` and `ffprobe.exe` from a verified FFmpeg release ZIP
/// into `extract_dir`, rejecting Zip-Slip, symlinks, zip bombs, and invalid/non-x64 executables.
pub fn extract_ffmpeg_bundle_zip(
    zip_path: &Path,
    extract_dir: &Path,
    max_total_uncompressed_bytes: u64,
) -> Result<ExtractedFfmpegBundle> {
    fs::create_dir_all(extract_dir)?;

    let file = File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| EngineError::Other(format!("Corrupted FFmpeg ZIP archive: {}", e)))?;

    let mut total_uncompressed: u64 = 0;
    let mut ffmpeg_out: Option<PathBuf> = None;
    let mut ffprobe_out: Option<PathBuf> = None;

    let ffmpeg_exe = ToolId::Ffmpeg.exe_name();
    let ffprobe_exe = ToolId::Ffprobe.exe_name();

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| {
            EngineError::Other(format!("Failed reading FFmpeg ZIP entry #{}: {}", i, e))
        })?;

        let raw_name = entry.name().to_string();
        validate_zip_entry_safety(&raw_name, entry.unix_mode())?;

        if entry.is_dir() {
            continue;
        }

        // Reject zip bombs via both declared size and streamed bytes
        let declared_size = entry.size();
        if declared_size > max_total_uncompressed_bytes {
            return Err(EngineError::Other(format!(
                "Rejected archive entry '{}': uncompressed size {} exceeds limit {}",
                raw_name, declared_size, max_total_uncompressed_bytes
            )));
        }

        let normalized = raw_name.replace('\\', "/");
        let file_name = Path::new(&normalized)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();

        let target_name = if file_name == ffmpeg_exe {
            ffmpeg_exe
        } else if file_name == ffprobe_exe {
            ffprobe_exe
        } else {
            // Ignore non-allowlisted files (docs, licenses, unexpected executables/scripts)
            continue;
        };

        let target_path = extract_dir.join(target_name);
        let mut out_file = File::create(&target_path)?;
        let mut buf = [0u8; 65536];
        let mut entry_written: u64 = 0;

        loop {
            let n = entry.read(&mut buf).map_err(|e| {
                EngineError::Other(format!(
                    "Failed decompressing '{}' from FFmpeg ZIP: {}",
                    raw_name, e
                ))
            })?;
            if n == 0 {
                break;
            }
            entry_written = entry_written.saturating_add(n as u64);
            total_uncompressed = total_uncompressed.saturating_add(n as u64);
            if total_uncompressed > max_total_uncompressed_bytes {
                drop(out_file);
                let _ = fs::remove_file(&target_path);
                return Err(EngineError::Other(format!(
                    "Archive extraction aborted: total uncompressed size exceeded {} bytes",
                    max_total_uncompressed_bytes
                )));
            }
            out_file.write_all(&buf[..n])?;
        }

        out_file.flush()?;
        out_file.sync_all()?;
        drop(out_file);

        if entry_written == 0 {
            let _ = fs::remove_file(&target_path);
            return Err(EngineError::Other(format!(
                "Extracted '{}' is empty (0 bytes)",
                target_name
            )));
        }

        validate_windows_x64_pe_file(&target_path)?;

        if target_name == ffmpeg_exe {
            ffmpeg_out = Some(target_path);
        } else {
            ffprobe_out = Some(target_path);
        }
    }

    let ffmpeg_path = ffmpeg_out.ok_or_else(|| {
        EngineError::Other(
            "FFmpeg release archive did not contain required ffmpeg.exe binary".to_string(),
        )
    })?;
    let ffprobe_path = ffprobe_out.ok_or_else(|| {
        EngineError::Other(
            "FFmpeg release archive did not contain required ffprobe.exe binary".to_string(),
        )
    })?;

    Ok(ExtractedFfmpegBundle {
        ffmpeg_path,
        ffprobe_path,
    })
}

/// Copies a directory tree or file cleanly into the target version directory.
pub fn copy_file_atomic(src: &Path, dst: &Path) -> Result<()> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = dst.with_extension("tmp");
    if tmp.exists() {
        let _ = fs::remove_file(&tmp);
    }
    {
        let mut r = File::open(src)?;
        let mut w = File::create(&tmp)?;
        io::copy(&mut r, &mut w)?;
        w.flush()?;
        w.sync_all()?;
    }
    if dst.exists() {
        let _ = fs::remove_file(dst);
    }
    fs::rename(&tmp, dst)?;
    Ok(())
}

/// Removes stale or interrupted staging directories on startup.
pub fn cleanup_staging_directory(layout: &ToolsDirLayout) -> usize {
    let Ok(entries) = fs::read_dir(&layout.staging) else {
        return 0;
    };
    let mut removed = 0usize;
    for entry in entries.flatten() {
        let p = entry.path();
        let ok = if p.is_dir() {
            fs::remove_dir_all(&p).is_ok()
        } else {
            fs::remove_file(&p).is_ok()
        };
        if ok {
            removed += 1;
        }
    }
    removed
}
