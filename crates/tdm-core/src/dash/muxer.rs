use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{EngineError, Result};
pub use crate::hls::muxer::{
    find_ffmpeg, find_ffprobe, probe_duration, probe_media_streams, silent_command,
};

/// Remuxes downloaded DASH streams (fMP4 or WebM) into a single valid,
/// playable, standards-compliant container using stream-copy.
pub fn remux_dash_to_playable(
    video_init: Option<&Path>,
    video_segments: &[PathBuf],
    audio_init: Option<&Path>,
    audio_segments: Option<&[PathBuf]>,
    is_webm: bool,
    output_path: &Path,
    work_dir: &Path,
) -> Result<()> {
    if video_segments.is_empty() {
        return Err(EngineError::Other(
            "Cannot remux DASH stream with empty video segments".to_string(),
        ));
    }

    let ffmpeg_bin = find_ffmpeg().ok_or_else(|| {
        EngineError::Other(
            "FFmpeg executable not found. TORI requires FFmpeg for standards-compliant DASH container remuxing."
                .to_string(),
        )
    })?;

    let mut temp_files: Vec<PathBuf> = Vec::new();
    let mut cmd = silent_command(&ffmpeg_bin);
    cmd.arg("-y"); // Overwrite output

    let ext = if is_webm { "webm" } else { "mp4" };

    // 1. Prepare continuous video stream
    let combined_video = work_dir.join(format!("combined_dash_video.{}", ext));
    {
        let mut out = fs::File::create(&combined_video)?;
        if let Some(init_p) = video_init {
            if init_p.exists() {
                let mut init_in = fs::File::open(init_p)?;
                std::io::copy(&mut init_in, &mut out)?;
            }
        }
        for seg in video_segments {
            let mut seg_in = fs::File::open(seg)?;
            std::io::copy(&mut seg_in, &mut out)?;
        }
    }
    cmd.arg("-i").arg(&combined_video);
    temp_files.push(combined_video);

    // 2. Prepare continuous audio stream if present
    let mut has_audio = false;
    if let Some(audio_segs) = audio_segments {
        if !audio_segs.is_empty() {
            has_audio = true;
            let combined_audio = work_dir.join(format!("combined_dash_audio.{}", ext));
            {
                let mut a_out = fs::File::create(&combined_audio)?;
                if let Some(init_p) = audio_init {
                    if init_p.exists() {
                        let mut init_in = fs::File::open(init_p)?;
                        std::io::copy(&mut init_in, &mut a_out)?;
                    }
                }
                for seg in audio_segs {
                    let mut seg_in = fs::File::open(seg)?;
                    std::io::copy(&mut seg_in, &mut a_out)?;
                }
            }
            cmd.arg("-i").arg(&combined_audio);
            cmd.arg("-map").arg("0:v:0?").arg("-map").arg("1:a:0?");
            temp_files.push(combined_audio);
        }
    }

    if !has_audio {
        cmd.arg("-map").arg("0:v:0?");
    }

    // Stream copy flags
    cmd.arg("-c").arg("copy");
    if !is_webm {
        // MP4 faststart moves moov atom to the front for instant seeking
        cmd.arg("-movflags").arg("+faststart");
    }
    cmd.arg(output_path);

    tracing::info!(
        "[DASH Muxer] Executing FFmpeg stream-copy to {:?}",
        output_path
    );

    let output = cmd
        .output()
        .map_err(|e| EngineError::Other(format!("Failed to execute FFmpeg process: {}", e)))?;

    // Cleanup intermediate combined files
    for f in temp_files {
        let _ = fs::remove_file(f);
    }

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        tracing::error!("[DASH Muxer] FFmpeg remuxing error:\n{}", stderr);
        return Err(EngineError::Other(format!(
            "FFmpeg DASH stream-copy muxing failed with code {:?}: {}",
            output.status.code(),
            stderr.lines().last().unwrap_or("Unknown error")
        )));
    }

    if !output_path.exists() || fs::metadata(output_path)?.len() == 0 {
        return Err(EngineError::Other(
            "FFmpeg reported success but output media file is missing or zero bytes".to_string(),
        ));
    }

    tracing::info!(
        "[DASH Muxer] Successfully produced verified media container ({} bytes) at {:?}",
        fs::metadata(output_path)?.len(),
        output_path
    );

    Ok(())
}
