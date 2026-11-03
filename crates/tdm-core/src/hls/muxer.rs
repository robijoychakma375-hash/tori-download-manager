use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::{EngineError, Result};

/// Locates the `ffmpeg` executable on the system.
pub fn find_ffmpeg() -> Option<PathBuf> {
    if let Ok(output) = Command::new("where.exe").arg("ffmpeg").output() {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(line) = stdout.lines().next() {
                let p = PathBuf::from(line.trim());
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }

    // App directory and user runtime locations
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p1 = dir.join("ffmpeg.exe");
            if p1.exists() {
                return Some(p1);
            }
            let p2 = dir.join("bin").join("ffmpeg.exe");
            if p2.exists() {
                return Some(p2);
            }
        }
    }

    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let p = PathBuf::from(&local_app_data)
            .join("tori-download-manager")
            .join("bin")
            .join("ffmpeg.exe");
        if p.exists() {
            return Some(p);
        }

        // WinGet Gyan.FFmpeg discovery
        let winget_dir = PathBuf::from(&local_app_data)
            .join("Microsoft")
            .join("WinGet")
            .join("Packages");
        if let Ok(entries) = fs::read_dir(winget_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|s| s.contains("Gyan.FFmpeg"))
                    .unwrap_or(false)
                {
                    // Scan subdirectories for bin\ffmpeg.exe
                    if let Ok(sub_entries) = fs::read_dir(&path) {
                        for sub in sub_entries.flatten() {
                            let bin = sub.path().join("bin").join("ffmpeg.exe");
                            if bin.exists() {
                                return Some(bin);
                            }
                        }
                    }
                }
            }
        }
    }

    // Common system fallback locations
    for cand in [
        r"C:\ffmpeg\bin\ffmpeg.exe",
        r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
    ] {
        let p = PathBuf::from(cand);
        if p.exists() {
            return Some(p);
        }
    }

    None
}

/// Locates the `ffprobe` executable on the system.
pub fn find_ffprobe() -> Option<PathBuf> {
    if let Ok(output) = Command::new("where.exe").arg("ffprobe").output() {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(line) = stdout.lines().next() {
                let p = PathBuf::from(line.trim());
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p1 = dir.join("ffprobe.exe");
            if p1.exists() {
                return Some(p1);
            }
            let p2 = dir.join("bin").join("ffprobe.exe");
            if p2.exists() {
                return Some(p2);
            }
        }
    }

    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let p = PathBuf::from(&local_app_data)
            .join("tori-download-manager")
            .join("bin")
            .join("ffprobe.exe");
        if p.exists() {
            return Some(p);
        }

        // WinGet Gyan.FFmpeg discovery
        let winget_dir = PathBuf::from(&local_app_data)
            .join("Microsoft")
            .join("WinGet")
            .join("Packages");
        if let Ok(entries) = fs::read_dir(winget_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|s| s.contains("Gyan.FFmpeg"))
                    .unwrap_or(false)
                {
                    if let Ok(sub_entries) = fs::read_dir(&path) {
                        for sub in sub_entries.flatten() {
                            let bin = sub.path().join("bin").join("ffprobe.exe");
                            if bin.exists() {
                                return Some(bin);
                            }
                        }
                    }
                }
            }
        }
    }

    for cand in [
        r"C:\ffmpeg\bin\ffprobe.exe",
        r"C:\Program Files\ffmpeg\bin\ffprobe.exe",
    ] {
        let p = PathBuf::from(cand);
        if p.exists() {
            return Some(p);
        }
    }

    None
}

/// Creates a safe FFmpeg concat demuxer text file.
fn create_concat_file(segment_paths: &[PathBuf], concat_txt_path: &Path) -> Result<()> {
    let mut content = String::new();
    for p in segment_paths {
        // Normalize path with forward slashes for FFmpeg concat format
        let path_str = p.to_string_lossy().replace('\\', "/");
        content.push_str(&format!("file '{}'\n", path_str));
    }
    fs::write(concat_txt_path, content)?;
    Ok(())
}

/// Remuxes downloaded HLS segments (MPEG-TS or Fragmented MP4) into a single valid,
/// playable, standards-compliant MP4 container using stream-copy (zero re-encoding).
pub fn remux_hls_to_mp4(
    video_segments: &[PathBuf],
    audio_segments: Option<&[PathBuf]>,
    output_mp4_path: &Path,
    work_dir: &Path,
) -> Result<()> {
    if video_segments.is_empty() {
        return Err(EngineError::Other(
            "Cannot remux empty segment list".to_string(),
        ));
    }

    let ffmpeg_bin = find_ffmpeg().ok_or_else(|| {
        EngineError::Other(
            "FFmpeg executable not found. TORI requires FFmpeg for standards-compliant container muxing."
                .to_string(),
        )
    })?;

    // Check if segments are fMP4 (e.g. init.mp4 + .m4s fragments)
    let is_fmp4 = video_segments.iter().any(|p| {
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        name.ends_with(".m4s") || name.contains("init")
    });

    let mut temp_cleanup_files: Vec<PathBuf> = Vec::new();
    let mut cmd = Command::new(&ffmpeg_bin);
    cmd.arg("-y"); // Overwrite output

    if is_fmp4 {
        // In ISO BMFF fragmented MP4, the sequence of init + fragments forms a continuous stream
        let combined_video = work_dir.join("combined_video_fmp4.mp4");
        let mut out = fs::File::create(&combined_video)?;
        for seg in video_segments {
            let mut inp = fs::File::open(seg)?;
            std::io::copy(&mut inp, &mut out)?;
        }
        cmd.arg("-i").arg(&combined_video);
        temp_cleanup_files.push(combined_video);

        if let Some(audio_segs) = audio_segments {
            if !audio_segs.is_empty() {
                let combined_audio = work_dir.join("combined_audio_fmp4.mp4");
                let mut a_out = fs::File::create(&combined_audio)?;
                for seg in audio_segs {
                    let mut inp = fs::File::open(seg)?;
                    std::io::copy(&mut inp, &mut a_out)?;
                }
                cmd.arg("-i").arg(&combined_audio);
                cmd.arg("-map").arg("0:v:0?").arg("-map").arg("1:a:0?");
                temp_cleanup_files.push(combined_audio);
            }
        }
    } else {
        // MPEG-TS path: use concat demuxer
        let video_concat_file = work_dir.join("video_concat.txt");
        create_concat_file(video_segments, &video_concat_file)?;
        cmd.arg("-f")
            .arg("concat")
            .arg("-safe")
            .arg("0")
            .arg("-i")
            .arg(&video_concat_file);
        temp_cleanup_files.push(video_concat_file);

        if let Some(audio_segs) = audio_segments {
            if !audio_segs.is_empty() {
                let ac_path = work_dir.join("audio_concat.txt");
                create_concat_file(audio_segs, &ac_path)?;
                cmd.arg("-f")
                    .arg("concat")
                    .arg("-safe")
                    .arg("0")
                    .arg("-i")
                    .arg(&ac_path);
                cmd.arg("-map").arg("0:v:0?").arg("-map").arg("1:a:0?");
                temp_cleanup_files.push(ac_path);
            }
        }
    }

    // Fast stream copy: -c copy -movflags +faststart
    // +faststart moves the `moov` atom to the beginning of the MP4 file for instant seeking
    cmd.arg("-c")
        .arg("copy")
        .arg("-movflags")
        .arg("+faststart")
        .arg(output_mp4_path);

    tracing::info!(
        "[Media Muxer] Executing FFmpeg stream-copy to {:?}",
        output_mp4_path
    );
    let output = cmd
        .output()
        .map_err(|e| EngineError::Other(format!("Failed to execute FFmpeg process: {}", e)))?;

    // Cleanup intermediate files
    for f in temp_cleanup_files {
        let _ = fs::remove_file(f);
    }

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        tracing::error!("[Media Muxer] FFmpeg remuxing error:\n{}", stderr);
        return Err(EngineError::Other(format!(
            "FFmpeg stream-copy muxing failed with code {:?}: {}",
            output.status.code(),
            stderr.lines().last().unwrap_or("Unknown error")
        )));
    }

    if !output_mp4_path.exists() || fs::metadata(output_mp4_path)?.len() == 0 {
        return Err(EngineError::Other(
            "FFmpeg reported success but output MP4 file is missing or zero bytes".to_string(),
        ));
    }

    tracing::info!(
        "[Media Muxer] Successfully produced verified MP4 ({} bytes) at {:?}",
        fs::metadata(output_mp4_path)?.len(),
        output_mp4_path
    );

    Ok(())
}

/// Probes a media file with `ffprobe` to verify duration and container integrity.
pub fn probe_duration(file_path: &Path) -> Result<f64> {
    let ffprobe_bin = find_ffprobe().ok_or_else(|| {
        EngineError::Other("FFprobe executable not found on system PATH".to_string())
    })?;

    let output = Command::new(&ffprobe_bin)
        .arg("-v")
        .arg("error")
        .arg("-show_entries")
        .arg("format=duration")
        .arg("-of")
        .arg("default=noprint_wrappers=1:nokey=1")
        .arg(file_path)
        .output()
        .map_err(|e| EngineError::Other(format!("Failed to execute FFprobe: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(EngineError::Other(format!(
            "FFprobe validation error: {}",
            stderr
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let duration = stdout
        .trim()
        .parse::<f64>()
        .map_err(|e| EngineError::Other(format!("Failed to parse duration from ffprobe: {}", e)))?;

    Ok(duration)
}

/// Detailed media probe returning `(has_video, has_audio, duration_seconds)`.
pub fn probe_media_streams(file_path: &Path) -> Result<(bool, bool, f64)> {
    let ffprobe_bin = find_ffprobe().ok_or_else(|| {
        EngineError::Other("FFprobe executable not found on system PATH".to_string())
    })?;

    let stream_output = Command::new(&ffprobe_bin)
        .arg("-v")
        .arg("error")
        .arg("-show_entries")
        .arg("stream=codec_type")
        .arg("-of")
        .arg("default=noprint_wrappers=1:nokey=1")
        .arg(file_path)
        .output()
        .map_err(|e| {
            EngineError::Other(format!("Failed to execute FFprobe stream probe: {}", e))
        })?;

    let stream_txt = String::from_utf8_lossy(&stream_output.stdout);
    let has_video = stream_txt.lines().any(|l| l.trim() == "video");
    let has_audio = stream_txt.lines().any(|l| l.trim() == "audio");

    let dur = probe_duration(file_path)?;

    Ok((has_video, has_audio, dur))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ffmpeg_and_ffprobe_discovery() {
        assert!(
            find_ffmpeg().is_some(),
            "FFmpeg should be discoverable in test environment"
        );
        assert!(
            find_ffprobe().is_some(),
            "FFprobe should be discoverable in test environment"
        );
    }
}
