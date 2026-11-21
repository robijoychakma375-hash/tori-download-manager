use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use crate::error::{EngineError, Result};
use crate::hls::muxer::silent_command;
use crate::tools::types::ToolId;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionComparison {
    Newer,
    Equal,
    Older,
    Unknown,
}

/// Runs a short-lived tool command with a strict bounded timeout and hidden console window.
pub fn run_command_with_timeout(
    bin: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<(bool, String, String)> {
    let mut cmd = silent_command(bin);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| {
        EngineError::Other(format!(
            "Failed to launch tool '{}': {}",
            bin.display(),
            e
        ))
    })?;

    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                let output = child.wait_with_output().map_err(|e| {
                    EngineError::Other(format!(
                        "Failed collecting output from '{}': {}",
                        bin.display(),
                        e
                    ))
                })?;
                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                return Ok((output.status.success(), stdout, stderr));
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(EngineError::Other(format!(
                        "Tool '{}' timed out after {}s",
                        bin.display(),
                        timeout.as_secs()
                    )));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(EngineError::Other(format!(
                    "Failed polling tool '{}': {}",
                    bin.display(),
                    e
                )));
            }
        }
    }
}

/// Defensively probes the installed version of yt-dlp, FFmpeg, or FFprobe.
pub fn probe_tool_version(tool: ToolId, bin: &Path) -> Result<String> {
    if !bin.exists() || !bin.is_file() {
        return Err(EngineError::Other(format!(
            "Tool binary for {} not found at '{}'",
            tool.display_name(),
            bin.display()
        )));
    }

    let arg = match tool {
        ToolId::YtDlp => "--version",
        ToolId::Ffmpeg | ToolId::Ffprobe => "-version",
    };

    let (ok, stdout, stderr) = run_command_with_timeout(bin, &[arg], Duration::from_secs(12))?;
    if !ok {
        let err_snippet = stderr
            .lines()
            .next()
            .unwrap_or("non-zero exit code")
            .trim()
            .to_string();
        return Err(EngineError::Other(format!(
            "{} version probe failed: {}",
            tool.display_name(),
            err_snippet
        )));
    }

    parse_tool_version_output(tool, &stdout).ok_or_else(|| {
        EngineError::Other(format!(
            "Unable to parse {} version output: '{}'",
            tool.display_name(),
            stdout.lines().next().unwrap_or("").trim()
        ))
    })
}

pub fn parse_tool_version_output(tool: ToolId, stdout: &str) -> Option<String> {
    let first_line = stdout.lines().find(|l| !l.trim().is_empty())?.trim();
    match tool {
        ToolId::YtDlp => {
            let token = first_line.split_whitespace().next()?.trim();
            if token.is_empty() || token.len() > 64 {
                return None;
            }
            // Expect at least one digit and dot (e.g., 2026.08.19 or 2026.10.26.1)
            if token.chars().any(|c| c.is_ascii_digit()) && token.contains('.') {
                Some(token.to_string())
            } else {
                None
            }
        }
        ToolId::Ffmpeg => {
            // Example: "ffmpeg version N-126374-g089a48eb36-20260831 Copyright (c) 2000-2026..."
            // Or: "ffmpeg version 8.1-essentials_build-www.gyan.dev Copyright..."
            let rest = first_line
                .strip_prefix("ffmpeg version ")
                .or_else(|| first_line.strip_prefix("FFmpeg version "))?;
            let token = rest.split_whitespace().next()?.trim();
            if token.is_empty() || token.len() > 96 {
                None
            } else {
                Some(token.to_string())
            }
        }
        ToolId::Ffprobe => {
            let rest = first_line
                .strip_prefix("ffprobe version ")
                .or_else(|| first_line.strip_prefix("FFprobe version "))?;
            let token = rest.split_whitespace().next()?.trim();
            if token.is_empty() || token.len() > 96 {
                None
            } else {
                Some(token.to_string())
            }
        }
    }
}

fn parse_numeric_tuple(s: &str) -> Option<Vec<u64>> {
    let trimmed = s.trim().trim_start_matches('v').trim_start_matches('V');
    if trimmed.is_empty() {
        return None;
    }
    let parts: Vec<&str> = trimmed.split('.').collect();
    if parts.is_empty() {
        return None;
    }
    let mut nums = Vec::with_capacity(parts.len());
    for part in parts {
        if part.is_empty() || !part.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        nums.push(part.parse::<u64>().ok()?);
    }
    Some(nums)
}

fn compare_numeric_tuples(a: &[u64], b: &[u64]) -> std::cmp::Ordering {
    let max_len = a.len().max(b.len());
    for i in 0..max_len {
        let av = a.get(i).copied().unwrap_or(0);
        let bv = b.get(i).copied().unwrap_or(0);
        match av.cmp(&bv) {
            std::cmp::Ordering::Equal => continue,
            ord => return ord,
        }
    }
    std::cmp::Ordering::Equal
}

fn extract_ffmpeg_git_rev(ver: &str) -> Option<u64> {
    // Matches "N-126374-g089a48eb36-20260831"
    let rest = ver.strip_prefix("N-").or_else(|| ver.strip_prefix("n-"))?;
    let rev_str = rest.split('-').next()?;
    if !rev_str.is_empty() && rev_str.chars().all(|c| c.is_ascii_digit()) {
        rev_str.parse::<u64>().ok()
    } else {
        None
    }
}

fn extract_yyyymmdd_date(ver: &str) -> Option<u64> {
    // Matches "...-20260831", "autobuild-2026-11-20-12-55", "2026.11.20", "2026-11-20"
    // 1. Look for 8 consecutive digits starting with "20"
    let bytes = ver.as_bytes();
    if bytes.len() >= 8 {
        for i in 0..=(bytes.len() - 8) {
            if &bytes[i..i + 2] == b"20" && bytes[i..i + 8].iter().all(|b| b.is_ascii_digit()) {
                let before_ok = i == 0 || !bytes[i - 1].is_ascii_digit();
                let after_ok = i + 8 == bytes.len() || !bytes[i + 8].is_ascii_digit();
                if before_ok && after_ok {
                    if let Ok(s) = std::str::from_utf8(&bytes[i..i + 8]) {
                        if let Ok(val) = s.parse::<u64>() {
                            return Some(val);
                        }
                    }
                }
            }
        }
    }

    // 2. Look for YYYY-MM-DD or YYYY.MM.DD
    for sep in ['-', '.'] {
        let tokens: Vec<&str> = ver.split(sep).collect();
        for w in tokens.windows(3) {
            if w[0].len() == 4
                && w[0].starts_with("20")
                && w[1].len() == 2
                && w[2].len() == 2
                && w.iter().all(|p| p.chars().all(|c| c.is_ascii_digit()))
            {
                let combined = format!("{}{}{}", w[0], w[1], w[2]);
                if let Ok(val) = combined.parse::<u64>() {
                    return Some(val);
                }
            }
        }
    }

    None
}

fn extract_ffmpeg_semver(ver: &str) -> Option<Vec<u64>> {
    // Handles "8.1", "n8.1-latest", "8.1-essentials_build-www.gyan.dev", "8.1.2"
    let cleaned = ver
        .trim()
        .trim_start_matches('n')
        .trim_start_matches('N')
        .trim_start_matches('v')
        .trim_start_matches('V');
    let head = cleaned.split('-').next()?;
    let nums = parse_numeric_tuple(head)?;
    if nums.len() >= 2 && nums[0] < 100 {
        Some(nums)
    } else {
        None
    }
}

/// Compares `candidate` against `installed`.
/// Returns `VersionComparison::Newer` ONLY when `candidate` is strictly newer than `installed`.
pub fn compare_tool_versions(
    tool: ToolId,
    installed: &str,
    candidate: &str,
) -> VersionComparison {
    let inst = installed.trim();
    let cand = candidate.trim();
    if inst.is_empty() || cand.is_empty() {
        return VersionComparison::Unknown;
    }
    if inst.eq_ignore_ascii_case(cand) {
        return VersionComparison::Equal;
    }

    match tool {
        ToolId::YtDlp => {
            if let (Some(a), Some(b)) = (parse_numeric_tuple(inst), parse_numeric_tuple(cand)) {
                return match compare_numeric_tuples(&b, &a) {
                    std::cmp::Ordering::Greater => VersionComparison::Newer,
                    std::cmp::Ordering::Equal => VersionComparison::Equal,
                    std::cmp::Ordering::Less => VersionComparison::Older,
                };
            }
            VersionComparison::Unknown
        }
        ToolId::Ffmpeg | ToolId::Ffprobe => {
            // 1. Compare git build revision numbers if both are N-<rev> builds
            if let (Some(ra), Some(rb)) =
                (extract_ffmpeg_git_rev(inst), extract_ffmpeg_git_rev(cand))
            {
                return match rb.cmp(&ra) {
                    std::cmp::Ordering::Greater => VersionComparison::Newer,
                    std::cmp::Ordering::Equal => VersionComparison::Equal,
                    std::cmp::Ordering::Less => VersionComparison::Older,
                };
            }

            // 2. Compare SemVer if both have SemVer release tags (e.g. 8.0.1 vs 8.1)
            if let (Some(sa), Some(sb)) =
                (extract_ffmpeg_semver(inst), extract_ffmpeg_semver(cand))
            {
                return match compare_numeric_tuples(&sb, &sa) {
                    std::cmp::Ordering::Greater => VersionComparison::Newer,
                    std::cmp::Ordering::Equal => VersionComparison::Equal,
                    std::cmp::Ordering::Less => VersionComparison::Older,
                };
            }

            // 3. Compare YYYYMMDD build dates (e.g. N-126374-...-20260831 vs autobuild-2026-11-20-12-55)
            if let (Some(da), Some(db)) =
                (extract_yyyymmdd_date(inst), extract_yyyymmdd_date(cand))
            {
                return match db.cmp(&da) {
                    std::cmp::Ordering::Greater => VersionComparison::Newer,
                    std::cmp::Ordering::Equal => VersionComparison::Equal,
                    std::cmp::Ordering::Less => VersionComparison::Older,
                };
            }

            VersionComparison::Unknown
        }
    }
}

/// Validates that an FFmpeg + FFprobe pair originate from the exact same release/build.
pub fn ffmpeg_ffprobe_versions_compatible(ffmpeg_ver: &str, ffprobe_ver: &str) -> bool {
    let f1 = ffmpeg_ver.trim();
    let f2 = ffprobe_ver.trim();
    if f1.is_empty() || f2.is_empty() {
        return false;
    }
    if f1.eq_ignore_ascii_case(f2) {
        return true;
    }
    // Check identical git rev or identical SemVer prefix
    if let (Some(r1), Some(r2)) = (extract_ffmpeg_git_rev(f1), extract_ffmpeg_git_rev(f2)) {
        return r1 == r2;
    }
    if let (Some(s1), Some(s2)) = (extract_ffmpeg_semver(f1), extract_ffmpeg_semver(f2)) {
        return s1 == s2;
    }
    false
}

/// Produces a filesystem-safe version directory name (never allows path traversal).
pub fn sanitize_version_dir_name(version: &str) -> Result<String> {
    let trimmed = version.trim();
    if trimmed.is_empty() || trimmed.len() > 96 {
        return Err(EngineError::Other("Invalid tool version string".to_string()));
    }
    let mut out = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out == "." || out == ".." || out.contains("..") || out.starts_with('.') {
        return Err(EngineError::Other(format!(
            "Rejected unsafe version directory name '{}'",
            version
        )));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ytdlp_version_comparison() {
        assert_eq!(
            compare_tool_versions(ToolId::YtDlp, "2026.08.19", "2026.10.26"),
            VersionComparison::Newer
        );
        assert_eq!(
            compare_tool_versions(ToolId::YtDlp, "2026.10.26", "2026.10.26"),
            VersionComparison::Equal
        );
        assert_eq!(
            compare_tool_versions(ToolId::YtDlp, "2026.10.26", "2026.08.19"),
            VersionComparison::Older
        );
        assert_eq!(
            compare_tool_versions(ToolId::YtDlp, "2026.10.26", "2026.10.26.1"),
            VersionComparison::Newer
        );
    }

    #[test]
    fn test_ffmpeg_version_comparison_and_pair_compatibility() {
        assert_eq!(
            compare_tool_versions(
                ToolId::Ffmpeg,
                "N-126374-g089a48eb36-20260831",
                "N-128000-gdeadbeef00-20261120"
            ),
            VersionComparison::Newer
        );
        assert_eq!(
            compare_tool_versions(
                ToolId::Ffmpeg,
                "N-126374-g089a48eb36-20260831",
                "autobuild-2026-11-20-12-55"
            ),
            VersionComparison::Newer
        );
        assert_eq!(
            compare_tool_versions(ToolId::Ffmpeg, "8.1", "8.2.1"),
            VersionComparison::Newer
        );
        assert_eq!(
            compare_tool_versions(ToolId::Ffmpeg, "8.2", "8.1"),
            VersionComparison::Older
        );
        assert!(ffmpeg_ffprobe_versions_compatible(
            "N-126374-g089a48eb36-20260831",
            "N-126374-g089a48eb36-20260831"
        ));
        assert!(!ffmpeg_ffprobe_versions_compatible(
            "N-126374-g089a48eb36-20260831",
            "N-125000-g1111111111-20260701"
        ));
    }

    #[test]
    fn test_parse_version_outputs() {
        assert_eq!(
            parse_tool_version_output(ToolId::YtDlp, "2026.08.19\r\n").as_deref(),
            Some("2026.08.19")
        );
        assert_eq!(
            parse_tool_version_output(
                ToolId::Ffmpeg,
                "ffmpeg version N-126374-g089a48eb36-20260831 Copyright (c) 2000-2026 the FFmpeg developers\n"
            )
            .as_deref(),
            Some("N-126374-g089a48eb36-20260831")
        );
        assert_eq!(
            parse_tool_version_output(
                ToolId::Ffprobe,
                "ffprobe version N-126374-g089a48eb36-20260831 Copyright (c) 2000-2026"
            )
            .as_deref(),
            Some("N-126374-g089a48eb36-20260831")
        );
    }
}
