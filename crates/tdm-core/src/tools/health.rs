use std::fs;
use std::path::Path;
use std::time::Duration;

use crate::error::{EngineError, Result};
use crate::tools::trust::validate_windows_x64_pe_file;
use crate::tools::types::ToolId;
use crate::tools::version::{
    ffmpeg_ffprobe_versions_compatible, probe_tool_version, run_command_with_timeout,
};

#[derive(Debug, Clone)]
pub struct VerifiedYtDlpHealth {
    pub detected_version: String,
}

#[derive(Debug, Clone)]
pub struct VerifiedFfmpegBundleHealth {
    pub ffmpeg_version: String,
    pub ffprobe_version: String,
}

/// Executes full pre-activation compatibility & runtime health checks on a staged `yt-dlp` binary.
pub fn verify_staged_ytdlp(
    exe_path: &Path,
    expected_version: Option<&str>,
) -> Result<VerifiedYtDlpHealth> {
    validate_windows_x64_pe_file(exe_path)?;

    let detected_version = probe_tool_version(ToolId::YtDlp, exe_path)?;

    if let Some(expected) = expected_version {
        let exp = expected.trim().trim_start_matches('v');
        let det = detected_version.trim().trim_start_matches('v');
        if !exp.is_empty() && !det.eq_ignore_ascii_case(exp) {
            return Err(EngineError::Other(format!(
                "Staged yt-dlp version mismatch: expected '{}', binary reported '{}'",
                exp, det
            )));
        }
    }

    // Verify CLI help executes cleanly with exit code 0 (catches broken PyInstaller/DLL startups)
    let (ok, stdout, stderr) =
        run_command_with_timeout(exe_path, &["--help"], Duration::from_secs(15))?;
    if !ok || stdout.trim().is_empty() {
        let snippet = stderr.lines().next().unwrap_or("non-zero exit").trim();
        return Err(EngineError::Other(format!(
            "Staged yt-dlp --help self-test failed: {}",
            snippet
        )));
    }

    Ok(VerifiedYtDlpHealth { detected_version })
}

/// Executes full pre-activation compatibility & runtime health checks on a staged
/// FFmpeg + FFprobe pair, including version-parity enforcement and a live synthetic
/// MP4 mux + FFprobe stream/duration verification.
pub fn verify_staged_ffmpeg_bundle(
    ffmpeg_path: &Path,
    ffprobe_path: &Path,
    scratch_dir: &Path,
) -> Result<VerifiedFfmpegBundleHealth> {
    validate_windows_x64_pe_file(ffmpeg_path)?;
    validate_windows_x64_pe_file(ffprobe_path)?;

    let ffmpeg_version = probe_tool_version(ToolId::Ffmpeg, ffmpeg_path)?;
    let ffprobe_version = probe_tool_version(ToolId::Ffprobe, ffprobe_path)?;

    if !ffmpeg_ffprobe_versions_compatible(&ffmpeg_version, &ffprobe_version) {
        return Err(EngineError::Other(format!(
            "FFmpeg/FFprobe version mismatch rejected: ffmpeg='{}', ffprobe='{}'",
            ffmpeg_version, ffprobe_version
        )));
    }

    // Lightweight live media generation & probing check (validates muxer, codecs, and ffprobe parsing)
    fs::create_dir_all(scratch_dir)?;
    let sample_mp4 = scratch_dir.join(format!("health_{}.mp4", uuid::Uuid::new_v4()));
    let sample_str = sample_mp4.to_string_lossy().to_string();

    let (gen_ok, _gen_out, gen_err) = run_command_with_timeout(
        ffmpeg_path,
        &[
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=0.25:size=64x64:rate=10",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=44100:cl=mono",
            "-t",
            "0.25",
            "-c:v",
            "mpeg4",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            &sample_str,
        ],
        Duration::from_secs(20),
    )?;

    if !gen_ok || !sample_mp4.exists() {
        let _ = fs::remove_file(&sample_mp4);
        return Err(EngineError::Other(format!(
            "Staged FFmpeg self-test mux failed: {}",
            gen_err.lines().next().unwrap_or("unknown error").trim()
        )));
    }

    let sample_size = fs::metadata(&sample_mp4).map(|m| m.len()).unwrap_or(0);
    if sample_size < 512 {
        let _ = fs::remove_file(&sample_mp4);
        return Err(EngineError::Other(format!(
            "Staged FFmpeg produced invalid self-test MP4 ({} bytes)",
            sample_size
        )));
    }

    let (probe_ok, probe_out, probe_err) = run_command_with_timeout(
        ffprobe_path,
        &[
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type",
            "-of",
            "default=noprint_wrappers=1",
            &sample_str,
        ],
        Duration::from_secs(15),
    )?;

    let _ = fs::remove_file(&sample_mp4);

    if !probe_ok {
        return Err(EngineError::Other(format!(
            "Staged FFprobe self-test failed: {}",
            probe_err.lines().next().unwrap_or("unknown error").trim()
        )));
    }

    let has_video = probe_out.lines().any(|l| l.trim() == "codec_type=video");
    let has_audio = probe_out.lines().any(|l| l.trim() == "codec_type=audio");
    let duration_valid = probe_out
        .lines()
        .find_map(|l| l.trim().strip_prefix("duration="))
        .and_then(|v| v.parse::<f64>().ok())
        .map(|d| d > 0.05)
        .unwrap_or(false);

    if !has_video || !has_audio || !duration_valid {
        return Err(EngineError::Other(format!(
            "Staged FFprobe self-test validation failed (video={}, audio={}, duration_valid={})",
            has_video, has_audio, duration_valid
        )));
    }

    Ok(VerifiedFfmpegBundleHealth {
        ffmpeg_version,
        ffprobe_version,
    })
}
