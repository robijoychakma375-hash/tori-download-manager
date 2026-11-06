use std::fs;
use std::path::PathBuf;

pub use crate::hls::muxer::{find_ffmpeg, find_ffprobe, silent_command};
use crate::resolver::models::ResolverStatus;

/// Locates the `yt-dlp` executable on the system.
pub fn find_yt_dlp() -> Option<PathBuf> {
    // 1. Check PATH via where.exe
    if let Ok(output) = silent_command("where.exe").arg("yt-dlp").output() {
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

    // 2. Check application directory & sidecar bin / resources
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for cand in [
                dir.join("yt-dlp.exe"),
                dir.join("bin").join("yt-dlp.exe"),
                dir.join("resources").join("yt-dlp.exe"),
                dir.join("resources").join("bin").join("yt-dlp.exe"),
            ] {
                if cand.exists() {
                    return Some(cand);
                }
            }
        }
    }

    // 3. User local runtime location (%LOCALAPPDATA%\tori-download-manager\bin\yt-dlp.exe)
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let p = PathBuf::from(&local_app_data)
            .join("tori-download-manager")
            .join("bin")
            .join("yt-dlp.exe");
        if p.exists() {
            return Some(p);
        }

        // 4. WinGet Packages directory
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
                    .map(|s| s.contains("yt-dlp.yt-dlp"))
                    .unwrap_or(false)
                {
                    let bin = path.join("yt-dlp.exe");
                    if bin.exists() {
                        return Some(bin);
                    }
                }
            }
        }
    }

    // 5. Common system locations
    for cand in [
        r"C:\yt-dlp\yt-dlp.exe",
        r"C:\Program Files\yt-dlp\yt-dlp.exe",
        r"C:\ProgramData\chocolatey\bin\yt-dlp.exe",
        r"C:\tools\yt-dlp\yt-dlp.exe",
    ] {
        let p = PathBuf::from(cand);
        if p.exists() {
            return Some(p);
        }
    }

    None
}

/// Locates the `streamlink` executable on the system if installed (optional adapter).
pub fn find_streamlink() -> Option<PathBuf> {
    // 1. Check PATH via where.exe
    if let Ok(output) = silent_command("where.exe").arg("streamlink").output() {
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

    // 2. Check application directory & sidecar bin
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p1 = dir.join("streamlink.exe");
            if p1.exists() {
                return Some(p1);
            }
            let p2 = dir.join("bin").join("streamlink.exe");
            if p2.exists() {
                return Some(p2);
            }
        }
    }

    // 3. User local runtime location (%LOCALAPPDATA%\tori-download-manager\bin\streamlink.exe)
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let p = PathBuf::from(&local_app_data)
            .join("tori-download-manager")
            .join("bin")
            .join("streamlink.exe");
        if p.exists() {
            return Some(p);
        }
    }

    // 4. Common system installation locations
    for cand in [
        r"C:\Program Files\Streamlink\bin\streamlink.exe",
        r"C:\Program Files (x86)\Streamlink\bin\streamlink.exe",
        r"C:\ProgramData\chocolatey\bin\streamlink.exe",
    ] {
        let p = PathBuf::from(cand);
        if p.exists() {
            return Some(p);
        }
    }

    None
}

/// Locates an available JavaScript runtime for yt-dlp-ejs / YouTube signature challenges.
/// Deno is prioritized because it is a single standalone secure executable.
pub fn find_js_runtime() -> Option<(String, PathBuf)> {
    // Check Deno
    if let Ok(output) = silent_command("where.exe").arg("deno").output() {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(line) = stdout.lines().next() {
                let p = PathBuf::from(line.trim());
                if p.exists() {
                    return Some(("Deno".to_string(), p));
                }
            }
        }
    }

    // Check Node.js
    if let Ok(output) = silent_command("where.exe").arg("node").output() {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(line) = stdout.lines().next() {
                let p = PathBuf::from(line.trim());
                if p.exists() {
                    return Some(("Node.js".to_string(), p));
                }
            }
        }
    }

    // Check WinGet Deno
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
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
                    .map(|s| s.contains("DenoLand.Deno"))
                    .unwrap_or(false)
                {
                    let bin = path.join("deno.exe");
                    if bin.exists() {
                        return Some(("Deno".to_string(), bin));
                    }
                }
            }
        }
    }

    None
}

/// Probes yt-dlp version with a bounded timeout.
pub fn get_yt_dlp_version(bin: &PathBuf) -> Option<String> {
    let output = silent_command(bin).arg("--version").output().ok()?;
    if output.status.success() {
        let ver = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !ver.is_empty() {
            return Some(ver);
        }
    }
    None
}

/// Ensures that `%LOCALAPPDATA%\tori-download-manager\bin` exists and contains copies or
/// links to discovered system dependencies so TORI operates self-contained without developer PATH dependencies.
pub fn ensure_local_runtime_directory() -> Option<PathBuf> {
    let local_app_data = std::env::var("LOCALAPPDATA").ok()?;
    let bin_dir = PathBuf::from(local_app_data)
        .join("tori-download-manager")
        .join("bin");
    let _ = fs::create_dir_all(&bin_dir);

    // If yt-dlp is found but not yet in bin_dir, copy it
    let target_ytdlp = bin_dir.join("yt-dlp.exe");
    if !target_ytdlp.exists() {
        if let Some(src) = find_yt_dlp() {
            if src != target_ytdlp {
                let _ = fs::copy(&src, &target_ytdlp);
            }
        }
    }

    // If ffmpeg is found but not yet in bin_dir, copy it
    let target_ffmpeg = bin_dir.join("ffmpeg.exe");
    if !target_ffmpeg.exists() {
        if let Some(src) = find_ffmpeg() {
            if src != target_ffmpeg {
                let _ = fs::copy(&src, &target_ffmpeg);
            }
        }
    }

    // If ffprobe is found but not yet in bin_dir, copy it
    let target_ffprobe = bin_dir.join("ffprobe.exe");
    if !target_ffprobe.exists() {
        if let Some(src) = find_ffprobe() {
            if src != target_ffprobe {
                let _ = fs::copy(&src, &target_ffprobe);
            }
        }
    }

    // If deno is found but not yet in bin_dir, copy it
    let target_deno = bin_dir.join("deno.exe");
    if !target_deno.exists() {
        if let Some((_, src)) = find_js_runtime() {
            if src
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_lowercase()
                .contains("deno")
                && src != target_deno
            {
                let _ = fs::copy(&src, &target_deno);
            }
        }
    }

    Some(bin_dir)
}

/// Returns a comprehensive snapshot of resolver dependencies.
pub fn get_resolver_status() -> ResolverStatus {
    let runtime_dir_path = ensure_local_runtime_directory();
    let runtime_dir_str = runtime_dir_path.map(|p| p.to_string_lossy().to_string());

    let yt_dlp_path = find_yt_dlp();
    let yt_dlp_available = yt_dlp_path.is_some();
    let yt_dlp_version = yt_dlp_path.as_ref().and_then(get_yt_dlp_version);
    let yt_dlp_str = yt_dlp_path.map(|p| p.to_string_lossy().to_string());

    let ffmpeg_path = find_ffmpeg();
    let ffmpeg_available = ffmpeg_path.is_some();
    let ffmpeg_str = ffmpeg_path.map(|p| p.to_string_lossy().to_string());

    let ffprobe_path = find_ffprobe();
    let ffprobe_available = ffprobe_path.is_some();
    let ffprobe_str = ffprobe_path.map(|p| p.to_string_lossy().to_string());

    let (js_name, js_path) = match find_js_runtime() {
        Some((name, path)) => (Some(name), Some(path.to_string_lossy().to_string())),
        None => (None, None),
    };

    let all_available = yt_dlp_available && ffmpeg_available && ffprobe_available;
    let setup_command = if all_available {
        None
    } else {
        Some("winget install yt-dlp.yt-dlp yt-dlp.FFmpeg DenoLand.Deno".to_string())
    };

    ResolverStatus {
        yt_dlp_available,
        yt_dlp_version,
        yt_dlp_path: yt_dlp_str,
        ffmpeg_available,
        ffmpeg_path: ffmpeg_str,
        ffprobe_available,
        ffprobe_path: ffprobe_str,
        js_runtime_available: js_name.is_some(),
        js_runtime_name: js_name,
        js_runtime_path: js_path,
        runtime_dir: runtime_dir_str,
        setup_command,
    }
}
