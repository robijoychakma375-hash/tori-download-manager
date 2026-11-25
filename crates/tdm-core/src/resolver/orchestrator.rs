use futures_util::stream::{self, StreamExt};
use sha2::Digest;
use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::process::Command;
use url::Url;

use crate::error::{EngineError, Result};
use crate::resolver::discovery::find_streamlink;
use crate::resolver::models::{
    DownloadCapability, FilesizeType, MediaMetadata, ResolveRequest, ResolvedMediaFormat,
};
use crate::resolver::pipeline::{is_known_platform_domain, MediaResolver};
use crate::resolver::ssrf::validate_safe_media_url;

/// Overall wall-clock budget for resolving known video platforms (well inside the 32s browser extension timeout).
pub const TOTAL_PLATFORM_RESOLVE_BUDGET: Duration = Duration::from_secs(26);
/// Overall wall-clock budget for resolving generic webpages and candidate streams.
pub const TOTAL_GENERIC_RESOLVE_BUDGET: Duration = Duration::from_secs(22);
/// Maximum budget allotted to the bounded browser candidate sweep.
pub const CANDIDATE_SWEEP_BUDGET: Duration = Duration::from_secs(8);
/// Per-candidate HTTP HEAD/GET/manifest probe timeout.
pub const CANDIDATE_PROBE_TIMEOUT: Duration = Duration::from_secs(4);
/// Maximum time allowed for downloading HTML during webpage scraping fallback.
pub const HTML_FETCH_TIMEOUT: Duration = Duration::from_secs(6);
/// Maximum unique sanitized candidates probed per resolve request.
pub const MAX_DISCOVERY_CANDIDATES: usize = 8;
/// Maximum concurrent candidate probes in flight.
pub const MAX_CANDIDATE_CONCURRENCY: usize = 3;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CandidateFilterReport {
    pub kept: Vec<String>,
    pub dropped_non_url: usize,
    pub dropped_duplicate: usize,
    pub dropped_segment_or_embed: usize,
    pub dropped_over_limit: usize,
}

impl CandidateFilterReport {
    pub fn total_dropped(&self) -> usize {
        self.dropped_non_url
            + self.dropped_duplicate
            + self.dropped_segment_or_embed
            + self.dropped_over_limit
    }
}

/// Redacts query parameter values and non-URL fragments for diagnostic logging without leaking tokens.
pub fn redact_url_for_log(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Ok(parsed) = Url::parse(trimmed) {
        let scheme = parsed.scheme();
        if (scheme == "http" || scheme == "https") && parsed.host_str().is_some() {
            let host = parsed.host_str().unwrap_or("");
            let port_str = parsed
                .port()
                .map(|p| format!(":{}", p))
                .unwrap_or_default();
            let path = parsed.path();
            let q_count = parsed.query_pairs().count();
            if q_count > 0 {
                return format!("{}://{}{}{}?[{}q]", scheme, host, port_str, path, q_count);
            }
            return format!("{}://{}{}{}", scheme, host, port_str, path);
        }
    }
    format!("<non-url:len={}>", trimmed.len())
}

fn has_direct_media_or_manifest_ext(path_lower: &str) -> bool {
    const MEDIA_EXTS: &[&str] = &[
        ".mp4", ".m4v", ".webm", ".mkv", ".mov", ".avi", ".flv", ".wmv", ".ts", ".3gp", ".ogv",
        ".mp3", ".m4a", ".aac", ".flac", ".wav", ".ogg", ".opus", ".weba", ".wma", ".m3u8", ".mpd",
    ];
    MEDIA_EXTS.iter().any(|ext| path_lower.ends_with(ext))
}

fn is_transient_or_unusable_candidate(parsed: &Url, exclude_platform_pages: bool) -> bool {
    let host_lower = parsed.host_str().unwrap_or("").to_lowercase();
    let path_lower = parsed.path().to_lowercase();

    const IGNORED_ASSET_EXTS: &[&str] = &[
        ".m4s", ".cmfv", ".cmfa", ".init", ".vtt", ".srt", ".ttml", ".dfxp", ".jpg", ".jpeg",
        ".png", ".webp", ".gif", ".svg", ".ico", ".css", ".js", ".json", ".xml", ".woff", ".woff2",
        ".ttf", ".otf", ".pdf", ".zip", ".html", ".htm",
    ];
    if IGNORED_ASSET_EXTS.iter().any(|ext| path_lower.ends_with(ext)) {
        return true;
    }

    if path_lower.contains("/frag-")
        || path_lower.contains("/segment-")
        || path_lower.contains("/chunk-")
        || path_lower.contains("/init-")
    {
        return true;
    }

    // Ephemeral YouTube/Google CDN playback chunks lack muxed audio/video metadata and belong to the platform extractor
    if (host_lower == "googlevideo.com" || host_lower.ends_with(".googlevideo.com"))
        && path_lower.contains("videoplayback")
    {
        return true;
    }

    // Byte-range segment requests captured during MSE playback
    if parsed
        .query_pairs()
        .any(|(k, _)| k.eq_ignore_ascii_case("range") || k.eq_ignore_ascii_case("bytestart"))
    {
        return true;
    }

    // Skip non-direct platform URLs (e.g. YouTube /embed/ iframe meta tags) during raw candidate sweeps
    if exclude_platform_pages
        && is_known_platform_domain(parsed.as_str())
        && !has_direct_media_or_manifest_ext(&path_lower)
    {
        return true;
    }

    false
}

/// Filters, deduplicates, and caps extension or HTML-discovered media candidates before network probing.
pub fn sanitize_candidate_urls(
    raw_candidates: &[String],
    primary_url: &str,
    max_count: usize,
    exclude_platform_pages: bool,
) -> CandidateFilterReport {
    let mut report = CandidateFilterReport::default();
    let mut seen = HashSet::new();
    let primary_trim = primary_url.trim();
    if !primary_trim.is_empty() {
        seen.insert(primary_trim.to_string());
    }

    for raw in raw_candidates {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            report.dropped_non_url += 1;
            continue;
        }

        let parsed = match Url::parse(trimmed) {
            Ok(u) if (u.scheme() == "http" || u.scheme() == "https") && u.host_str().is_some() => {
                u
            }
            _ => {
                report.dropped_non_url += 1;
                continue;
            }
        };

        if !seen.insert(trimmed.to_string()) {
            report.dropped_duplicate += 1;
            continue;
        }

        if is_transient_or_unusable_candidate(&parsed, exclude_platform_pages) {
            report.dropped_segment_or_embed += 1;
            continue;
        }

        if report.kept.len() >= max_count {
            report.dropped_over_limit += 1;
            continue;
        }

        report.kept.push(trimmed.to_string());
    }

    report
}

/// Identifies definitive platform extractor failures (auth/DRM/unavailable/rate-limit/timeout)
/// that should be returned directly instead of being masked by generic HTML fallback errors.
pub fn is_definitive_platform_error(err_msg: &str) -> bool {
    let lower = err_msg.to_lowercase();
    lower.contains("drm")
        || lower.contains("protected")
        || lower.contains("plex.tv")
        || lower.contains("private video")
        || lower.contains("this video is private")
        || lower.contains("sign in")
        || lower.contains("login required")
        || lower.contains("requires authentication")
        || lower.contains("members-only")
        || lower.contains("age-restricted")
        || lower.contains("forbidden")
        || lower.contains("http error 403")
        || lower.contains("rate limit")
        || lower.contains("too many requests")
        || lower.contains("429")
        || lower.contains("video unavailable")
        || lower.contains("unavailable")
        || lower.contains("does not exist")
        || lower.contains("has been removed")
        || lower.contains("copyright")
        || lower.contains("timed out")
        || lower.contains("timeout")
}

#[derive(Debug, Clone, Default)]
pub struct HtmlScrapedMetadata {
    pub title: Option<String>,
    pub thumbnail_url: Option<String>,
    pub media_urls: Vec<String>,
}

/// Extracts media URLs, OpenGraph metadata, and JSON-LD video references from HTML.
pub fn extract_html_media_candidates(html: &str, base_url: &str) -> HtmlScrapedMetadata {
    let mut meta = HtmlScrapedMetadata::default();
    let base = Url::parse(base_url).ok();

    let resolve_url = |rel: &str| -> Option<String> {
        let clean = rel.trim();
        if clean.is_empty()
            || clean.starts_with("blob:")
            || clean.starts_with("data:")
            || clean.starts_with("javascript:")
        {
            return None;
        }
        if let Some(ref b) = base {
            b.join(clean).ok().map(|u| u.to_string())
        } else {
            Url::parse(clean).ok().map(|u| u.to_string())
        }
    };

    let mut found_media = HashSet::new();

    // 1. Title extraction
    if let Some(t) = extract_tag_content(html, "<title>", "</title>") {
        let clean = t.trim();
        if !clean.is_empty() {
            meta.title = Some(clean.to_string());
        }
    }
    if let Some(t) = extract_meta_property(html, "og:title") {
        let clean = t.trim();
        if !clean.is_empty() {
            meta.title = Some(clean.to_string());
        }
    }

    // 2. Thumbnail extraction
    if let Some(img) = extract_meta_property(html, "og:image") {
        if let Some(abs) = resolve_url(&img) {
            meta.thumbnail_url = Some(abs);
        }
    }
    if meta.thumbnail_url.is_none() {
        if let Some(poster) = extract_attribute(html, "poster") {
            if let Some(abs) = resolve_url(&poster) {
                meta.thumbnail_url = Some(abs);
            }
        }
    }

    // 3. OpenGraph & Twitter video tags
    for prop in [
        "og:video",
        "og:video:url",
        "og:video:secure_url",
        "twitter:player:stream",
    ] {
        if let Some(val) = extract_meta_property(html, prop) {
            if let Some(abs) = resolve_url(&val) {
                if !found_media.contains(&abs) {
                    found_media.insert(abs.clone());
                    meta.media_urls.push(abs);
                }
            }
        }
    }

    // 4. HTML5 <video src="..."> and <audio src="..."> attributes
    for tag in ["video", "audio"] {
        for val in extract_all_attributes(html, tag, "src") {
            if let Some(abs) = resolve_url(&val) {
                if !found_media.contains(&abs) {
                    found_media.insert(abs.clone());
                    meta.media_urls.push(abs);
                }
            }
        }
    }

    // 5. HTML5 <source src="..." type="..."> elements
    for val in extract_all_attributes(html, "source", "src") {
        if let Some(abs) = resolve_url(&val) {
            if !found_media.contains(&abs) {
                found_media.insert(abs.clone());
                meta.media_urls.push(abs);
            }
        }
    }

    // 6. Embedded video players: <iframe src="...">, <embed src="...">, <object data="...">
    // Only accept iframes that route to verified platform video embeds or direct media streams.
    // Do NOT treat subtitle <track>, arbitrary ad/widget iframes, or non-media documents as video downloads.
    for val in extract_all_attributes(html, "iframe", "src") {
        if let Some(abs) = resolve_url(&val) {
            let lower_abs = abs.to_lowercase();
            let is_platform = crate::resolver::pipeline::is_known_platform_domain(&abs);
            let is_direct_media = lower_abs.contains(".mp4")
                || lower_abs.contains(".webm")
                || lower_abs.contains(".m3u8")
                || lower_abs.contains(".mpd");
            if (is_platform || is_direct_media) && !found_media.contains(&abs) {
                found_media.insert(abs.clone());
                meta.media_urls.push(abs);
            }
        }
    }
    for val in extract_all_attributes(html, "embed", "src") {
        if let Some(abs) = resolve_url(&val) {
            let lower_abs = abs.to_lowercase();
            let is_platform = crate::resolver::pipeline::is_known_platform_domain(&abs);
            let is_direct_media = lower_abs.contains(".mp4")
                || lower_abs.contains(".webm")
                || lower_abs.contains(".m3u8")
                || lower_abs.contains(".mpd");
            if (is_platform || is_direct_media) && !found_media.contains(&abs) {
                found_media.insert(abs.clone());
                meta.media_urls.push(abs);
            }
        }
    }
    for val in extract_all_attributes(html, "object", "data") {
        if let Some(abs) = resolve_url(&val) {
            let lower_abs = abs.to_lowercase();
            let is_platform = crate::resolver::pipeline::is_known_platform_domain(&abs);
            let is_direct_media = lower_abs.contains(".mp4")
                || lower_abs.contains(".webm")
                || lower_abs.contains(".m3u8")
                || lower_abs.contains(".mpd");
            if (is_platform || is_direct_media) && !found_media.contains(&abs) {
                found_media.insert(abs.clone());
                meta.media_urls.push(abs);
            }
        }
    }

    // 8. JSON-LD Schema.org VideoObject parsing
    for json_chunk in extract_json_ld_blocks(html) {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&json_chunk) {
            extract_video_urls_from_json(&parsed, &mut |raw, title, thumb| {
                if let Some(abs) = resolve_url(raw) {
                    if !found_media.contains(&abs) {
                        found_media.insert(abs.clone());
                        meta.media_urls.push(abs);
                    }
                }
                if meta.title.is_none() && title.is_some() {
                    meta.title = title.map(|s| s.to_string());
                }
                if meta.thumbnail_url.is_none() && thumb.is_some() {
                    if let Some(abs_thumb) = thumb.and_then(resolve_url) {
                        meta.thumbnail_url = Some(abs_thumb);
                    }
                }
            });
        }
    }

    meta
}

fn extract_tag_content(html: &str, open_tag: &str, close_tag: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start_idx = lower.find(open_tag)? + open_tag.len();
    let end_idx = start_idx + lower[start_idx..].find(close_tag)?;
    Some(html[start_idx..end_idx].to_string())
}

fn extract_meta_property(html: &str, property: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let needle1 = format!("property=\"{}\"", property);
    let needle2 = format!("property='{}'", property);
    let needle3 = format!("name=\"{}\"", property);
    let needle4 = format!("name='{}'", property);

    for needle in [&needle1, &needle2, &needle3, &needle4] {
        if let Some(pos) = lower.find(needle) {
            // Find enclosing tag bounds
            let tag_start = html[..pos].rfind('<').unwrap_or(pos);
            let tag_end = html[pos..].find('>').map(|i| pos + i).unwrap_or(html.len());
            let tag_slice = &html[tag_start..tag_end];
            if let Some(content) = extract_attribute_from_slice(tag_slice, "content") {
                return Some(content);
            }
        }
    }
    None
}

fn extract_attribute(html: &str, attr: &str) -> Option<String> {
    let needle1 = format!("{}=\"", attr);
    let needle2 = format!("{}='", attr);
    let lower = html.to_ascii_lowercase();

    for needle in [&needle1, &needle2] {
        if let Some(pos) = lower.find(needle) {
            let quote_char = if needle.ends_with('"') { '"' } else { '\'' };
            let val_start = pos + needle.len();
            if let Some(end_offset) = html[val_start..].find(quote_char) {
                return Some(html[val_start..val_start + end_offset].to_string());
            }
        }
    }
    None
}

fn extract_attribute_from_slice(slice: &str, attr: &str) -> Option<String> {
    extract_attribute(slice, attr)
}

fn extract_all_attributes(html: &str, tag_name: &str, attr: &str) -> Vec<String> {
    let mut results = Vec::new();
    let lower = html.to_ascii_lowercase();
    let open_pattern = format!("<{}", tag_name);
    let attr_pattern1 = format!("{}=\"", attr);
    let attr_pattern2 = format!("{}='", attr);

    let mut cursor = 0;
    while let Some(tag_pos) = lower[cursor..].find(&open_pattern) {
        let abs_tag_pos = cursor + tag_pos;
        let tag_end = lower[abs_tag_pos..]
            .find('>')
            .map(|i| abs_tag_pos + i)
            .unwrap_or(lower.len());
        let tag_slice = &html[abs_tag_pos..tag_end];
        let lower_slice = &lower[abs_tag_pos..tag_end];

        for needle in [&attr_pattern1, &attr_pattern2] {
            if let Some(attr_pos) = lower_slice.find(needle) {
                let quote = if needle.ends_with('"') { '"' } else { '\'' };
                let val_start = attr_pos + needle.len();
                if let Some(quote_end) = tag_slice[val_start..].find(quote) {
                    let val = tag_slice[val_start..val_start + quote_end].trim();
                    if !val.is_empty() {
                        results.push(val.to_string());
                    }
                }
            }
        }

        cursor = tag_end;
        if cursor >= lower.len() {
            break;
        }
    }

    results
}

fn extract_json_ld_blocks(html: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let lower = html.to_ascii_lowercase();
    let open_tag = "<script type=\"application/ld+json\"";
    let open_tag_alt = "<script type='application/ld+json'";
    let close_tag = "</script>";

    let mut cursor = 0;
    while cursor < lower.len() {
        let found_open = lower[cursor..]
            .find(open_tag)
            .or_else(|| lower[cursor..].find(open_tag_alt));

        if let Some(open_offset) = found_open {
            let abs_open = cursor + open_offset;
            let tag_end = match lower[abs_open..].find('>') {
                Some(i) => abs_open + i + 1,
                None => break,
            };
            if let Some(close_offset) = lower[tag_end..].find(close_tag) {
                let abs_close = tag_end + close_offset;
                blocks.push(html[tag_end..abs_close].trim().to_string());
                cursor = abs_close + close_tag.len();
            } else {
                break;
            }
        } else {
            break;
        }
    }

    blocks
}

fn extract_video_urls_from_json<F>(val: &serde_json::Value, cb: &mut F)
where
    F: FnMut(&str, Option<&str>, Option<&str>),
{
    match val {
        serde_json::Value::Object(map) => {
            let is_video = map
                .get("@type")
                .and_then(|t| t.as_str())
                .map(|t| {
                    t.eq_ignore_ascii_case("VideoObject") || t.eq_ignore_ascii_case("MediaObject")
                })
                .unwrap_or(false);

            let title = map.get("name").and_then(|n| n.as_str());
            let thumbnail = map.get("thumbnailUrl").and_then(|t| match t {
                serde_json::Value::String(s) => Some(s.as_str()),
                serde_json::Value::Array(arr) => arr.first().and_then(|v| v.as_str()),
                _ => None,
            });

            if is_video {
                if let Some(content_url) = map.get("contentUrl").and_then(|u| u.as_str()) {
                    cb(content_url, title, thumbnail);
                }
                if let Some(embed_url) = map.get("embedUrl").and_then(|u| u.as_str()) {
                    cb(embed_url, title, thumbnail);
                }
            }

            for v in map.values() {
                extract_video_urls_from_json(v, cb);
            }
        }
        serde_json::Value::Array(arr) => {
            for v in arr {
                extract_video_urls_from_json(v, cb);
            }
        }
        _ => {}
    }
}

/// Probes an optional Streamlink runtime installation for playable streaming variants.
pub async fn probe_streamlink(
    url: &str,
    streamlink_bin: Option<&PathBuf>,
    timeout: Duration,
) -> Result<Vec<ResolvedMediaFormat>> {
    let bin = match streamlink_bin {
        Some(b) => b.clone(),
        None => match find_streamlink() {
            Some(p) => p,
            None => return Ok(vec![]), // Graceful degradation if Streamlink is not installed
        },
    };

    let parsed_url = crate::resolver::ssrf::validate_http_url_syntax(url)?;

    let mut cmd = Command::new(&bin);
    cmd.arg("--json")
        .arg("--")
        .arg(parsed_url.as_str())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let child = cmd
        .spawn()
        .map_err(|e| EngineError::Other(format!("Streamlink process failure: {}", e)))?;

    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| EngineError::Other("Streamlink probe timed out".to_string()))?
        .map_err(EngineError::Io)?;
    if !output.status.success() {
        return Ok(vec![]);
    }

    let parsed: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| EngineError::Other(format!("Streamlink JSON parsing error: {}", e)))?;

    let streams_obj = match parsed.get("streams").and_then(|s| s.as_object()) {
        Some(o) => o,
        None => return Ok(vec![]),
    };

    let mut formats = Vec::new();
    for (name, details) in streams_obj {
        if name == "worst" || name == "best" {
            continue; // Skip aliases in favor of specific quality names
        }
        let stream_url = match details.get("url").and_then(|u| u.as_str()) {
            Some(u) => u,
            None => continue,
        };
        let stream_type = details
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or("hls")
            .to_lowercase();

        let is_dash = stream_type == "dash" || stream_url.contains(".mpd");
        let is_hls = stream_type == "hls" || stream_url.contains(".m3u8");

        let height = name
            .trim_end_matches('p')
            .trim_end_matches('k')
            .parse::<u32>()
            .ok();

        let format = ResolvedMediaFormat {
            format_id: format!("streamlink_{}", name),
            format_note: Some(format!("Streamlink {}", name)),
            width: None,
            height,
            resolution_label: if let Some(h) = height {
                format!("{}p", h)
            } else {
                name.clone()
            },
            fps: None,
            vcodec: None,
            acodec: Some("aac".to_string()),
            container: "mp4".to_string(),
            protocol: if is_dash {
                "mpd".to_string()
            } else if is_hls {
                "m3u8".to_string()
            } else {
                "https".to_string()
            },
            bitrate_kbps: None,
            has_video: true,
            has_audio: true,
            filesize: None,
            filesize_approx: None,
            filesize_type: FilesizeType::Unknown,
            requires_merge: false,
            merge_audio_format_id: None,
            audio_channels: None,
            sample_rate: None,
            download_capability: if is_dash {
                DownloadCapability::NativeDash
            } else if is_hls {
                DownloadCapability::NativeHls
            } else {
                DownloadCapability::NativeHttp
            },
            unavailable_reason: None,
            direct_stream_url: Some(stream_url.to_string()),
            http_headers: None,
        };

        formats.push(format);
    }

    Ok(formats)
}

/// Deduplicates and ranks media formats by height (descending) and bitrate (descending).
pub fn deduplicate_and_rank_formats(formats: Vec<ResolvedMediaFormat>) -> Vec<ResolvedMediaFormat> {
    let mut seen_keys = HashSet::new();
    let mut deduped = Vec::new();

    for f in formats {
        let key = if let Some(ref d) = f.direct_stream_url {
            format!("stream:{}:{}", f.container, d)
        } else {
            format!(
                "spec:{}:{}:{}",
                f.container,
                f.resolution_label,
                f.format_note.as_deref().unwrap_or("")
            )
        };

        if !seen_keys.contains(&key) {
            seen_keys.insert(key);
            deduped.push(f);
        }
    }

    deduped.sort_by(|a, b| {
        let h_a = a.height.unwrap_or(0);
        let h_b = b.height.unwrap_or(0);
        if h_a != h_b {
            return h_b.cmp(&h_a);
        }
        let b_a = (a.bitrate_kbps.unwrap_or(0.0) * 100.0) as i64;
        let b_b = (b.bitrate_kbps.unwrap_or(0.0) * 100.0) as i64;
        b_b.cmp(&b_a)
    });

    deduped
}

/// Orchestrates multi-strategy media discovery across platform extractors, direct probes,
/// HTML metadata, and streaming manifests.
pub struct DiscoveryOrchestrator {
    client: reqwest::Client,
}

impl Default for DiscoveryOrchestrator {
    fn default() -> Self {
        Self::new()
    }
}

async fn probe_single_candidate(
    resolver: &MediaResolver,
    cand_url: String,
    probe_timeout: Duration,
    allow_platform_subresolve: bool,
) -> Option<MediaMetadata> {
    if probe_timeout.is_zero() {
        return None;
    }

    let safe_url = validate_safe_media_url(&cand_url).await.ok()?;
    let safe_str = safe_url.as_str();
    let lower = safe_str.to_lowercase();

    let probe_fut = async {
        if lower.contains(".m3u8") {
            resolver.probe_direct_hls(safe_str).await
        } else if lower.contains(".mpd") {
            resolver.probe_direct_dash(safe_str).await
        } else {
            match resolver.probe_direct_media(safe_str).await {
                Ok(m) => Ok(m),
                Err(e) if allow_platform_subresolve && is_known_platform_domain(safe_str) => {
                    resolver
                        .resolve_with_options_budget(safe_str, false, Some(probe_timeout))
                        .await
                        .map_err(|_| e)
                }
                Err(e) => Err(e),
            }
        }
    };

    match tokio::time::timeout(probe_timeout, probe_fut).await {
        Ok(Ok(meta)) if !meta.formats.is_empty() => Some(meta),
        _ => None,
    }
}

async fn probe_candidates_bounded(
    resolver: &MediaResolver,
    candidates: Vec<String>,
    sweep_budget: Duration,
    per_probe_timeout: Duration,
    allow_platform_subresolve: bool,
) -> Vec<MediaMetadata> {
    if candidates.is_empty() || sweep_budget.is_zero() {
        return Vec::new();
    }

    let effective_probe = per_probe_timeout.min(sweep_budget);
    let mut results = Vec::new();
    let collect_fut = async {
        let mut stream = stream::iter(candidates.into_iter().map(|cand| {
            probe_single_candidate(resolver, cand, effective_probe, allow_platform_subresolve)
        }))
        .buffer_unordered(MAX_CANDIDATE_CONCURRENCY);

        while let Some(item) = stream.next().await {
            if let Some(meta) = item {
                results.push(meta);
            }
        }
    };

    let _ = tokio::time::timeout(sweep_budget, collect_fut).await;
    results
}

fn merge_discovered_metadata(
    metas: Vec<MediaMetadata>,
    discovered_title: &mut Option<String>,
    discovered_thumb: &mut Option<String>,
    discovered_formats: &mut Vec<ResolvedMediaFormat>,
) {
    for meta in metas {
        if discovered_title.is_none() && !meta.title.is_empty() && meta.title != "Direct Download" {
            *discovered_title = Some(meta.title);
        }
        if discovered_thumb.is_none() && meta.thumbnail_url.is_some() {
            *discovered_thumb = meta.thumbnail_url;
        }
        discovered_formats.extend(meta.formats);
    }
}

impl DiscoveryOrchestrator {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .redirect(crate::resolver::ssrf::ssrf_safe_redirect_policy())
            .build()
            .unwrap_or_default();
        Self { client }
    }

    /// Resolves media across multiple discovery strategies with platform-first prioritization,
    /// bounded candidate probing, SSRF enforcement, and overall deadline enforcement.
    pub async fn resolve_multi_strategy(
        &self,
        resolver: &MediaResolver,
        req: &ResolveRequest,
    ) -> Result<MediaMetadata> {
        self.resolve_multi_strategy_with_budget(resolver, req, None)
            .await
    }

    /// Resolves media with an explicit total deadline override (useful for deterministic budget tests).
    pub async fn resolve_multi_strategy_with_budget(
        &self,
        resolver: &MediaResolver,
        req: &ResolveRequest,
        total_budget_override: Option<Duration>,
    ) -> Result<MediaMetadata> {
        let request_start = Instant::now();
        let raw_url = req.url.trim();
        let safe_url = validate_safe_media_url(raw_url).await?;
        let raw_url = safe_url.as_str();
        let redacted_url = redact_url_for_log(raw_url);

        let is_platform = is_known_platform_domain(raw_url);
        let default_budget = if is_platform {
            TOTAL_PLATFORM_RESOLVE_BUDGET
        } else {
            TOTAL_GENERIC_RESOLVE_BUDGET
        };
        let total_budget = total_budget_override.unwrap_or(default_budget);
        let remaining_budget = || total_budget.saturating_sub(request_start.elapsed());

        let mut discovered_formats = Vec::new();
        let mut discovered_title = req.page_title.clone();
        let mut discovered_thumb = req.thumbnail_url.clone();
        let mut platform_err: Option<EngineError> = None;

        // Stage timings for structured diagnostic logs
        let mut platform_ms: u128 = 0;
        let mut candidate_ms: u128 = 0;
        let mut html_ms: u128 = 0;
        let mut generic_ytdlp_ms: u128 = 0;
        let mut streamlink_ms: u128 = 0;
        let mut candidate_report = CandidateFilterReport::default();

        // 1. Platform-first resolution: check cache + canonical platform extractor BEFORE probing
        //    browser DOM/network candidates, so slow/embed/segment candidates cannot starve platform resolution.
        if is_platform {
            let budget = remaining_budget();
            if budget.is_zero() {
                tracing::warn!(
                    url = %redacted_url,
                    path = "platform",
                    timeout_source = "total_budget_before_platform",
                    total_ms = request_start.elapsed().as_millis() as u64,
                    "Media resolution timed out before platform extractor start"
                );
                return Err(EngineError::Other(format!(
                    "Media resolution timed out after {} seconds.",
                    total_budget.as_secs()
                )));
            }

            let stage_start = Instant::now();
            let res = tokio::time::timeout(
                budget,
                resolver.resolve_with_options_budget(raw_url, req.force_refresh, Some(budget)),
            )
            .await;
            platform_ms = stage_start.elapsed().as_millis();

            match res {
                Ok(Ok(meta)) => {
                    tracing::info!(
                        url = %redacted_url,
                        path = "platform",
                        cache_hit = meta.is_cached.unwrap_or(false),
                        candidates_total = req.candidates.len(),
                        formats = meta.formats.len(),
                        platform_ms = platform_ms as u64,
                        total_ms = request_start.elapsed().as_millis() as u64,
                        "Media resolution completed via platform pipeline"
                    );
                    return Ok(meta);
                }
                Err(_) => {
                    tracing::warn!(
                        url = %redacted_url,
                        path = "platform",
                        cache_hit = false,
                        candidates_total = req.candidates.len(),
                        platform_ms = platform_ms as u64,
                        total_ms = request_start.elapsed().as_millis() as u64,
                        timeout_source = "platform_overall_deadline",
                        "Platform resolution exceeded overall budget"
                    );
                    return Err(EngineError::Other(format!(
                        "Media resolution timed out after {} seconds.",
                        total_budget.as_secs()
                    )));
                }
                Ok(Err(e)) => {
                    let err_msg = e.to_string();
                    if is_definitive_platform_error(&err_msg)
                        || remaining_budget() < Duration::from_secs(3)
                    {
                        tracing::warn!(
                            url = %redacted_url,
                            path = "platform",
                            cache_hit = false,
                            candidates_total = req.candidates.len(),
                            platform_ms = platform_ms as u64,
                            total_ms = request_start.elapsed().as_millis() as u64,
                            error = %err_msg,
                            "Platform resolution returned definitive error"
                        );
                        return Err(e);
                    }
                    platform_err = Some(e);
                }
            }
        }

        // 2. Bounded candidate probing for generic webpages (or bounded non-definitive platform fallback)
        if !req.candidates.is_empty() && remaining_budget() >= Duration::from_millis(500) {
            candidate_report = sanitize_candidate_urls(
                &req.candidates,
                raw_url,
                MAX_DISCOVERY_CANDIDATES,
                true,
            );

            if !candidate_report.kept.is_empty() {
                let sweep_budget = remaining_budget().min(CANDIDATE_SWEEP_BUDGET);
                let stage_start = Instant::now();
                let probed = probe_candidates_bounded(
                    resolver,
                    candidate_report.kept.clone(),
                    sweep_budget,
                    CANDIDATE_PROBE_TIMEOUT,
                    false,
                )
                .await;
                candidate_ms = stage_start.elapsed().as_millis();

                merge_discovered_metadata(
                    probed,
                    &mut discovered_title,
                    &mut discovered_thumb,
                    &mut discovered_formats,
                );
            }
        }

        if !discovered_formats.is_empty() {
            let ranked = deduplicate_and_rank_formats(discovered_formats);
            tracing::info!(
                url = %redacted_url,
                path = if is_platform { "platform_fallback_candidates" } else { "generic_candidates" },
                candidates_total = req.candidates.len(),
                candidates_kept = candidate_report.kept.len(),
                candidates_dropped = candidate_report.total_dropped(),
                formats = ranked.len(),
                platform_ms = platform_ms as u64,
                candidate_ms = candidate_ms as u64,
                total_ms = request_start.elapsed().as_millis() as u64,
                "Media resolution completed via bounded candidate discovery"
            );
            return Ok(MediaMetadata {
                source_url: raw_url.to_string(),
                webpage_url: raw_url.to_string(),
                site_name: "Stream Capture".to_string(),
                title: discovered_title.unwrap_or_else(|| "Discovered Media Stream".to_string()),
                media_id: format!("{:x}", sha2::Sha256::digest(raw_url.as_bytes())),
                duration_seconds: None,
                thumbnail_url: discovered_thumb,
                extractor: "browser_candidate".to_string(),
                formats: ranked,
                is_direct_media: true,
                is_cached: None,
            });
        }

        // 3. Generic webpage strategies: HTML scraping -> generic yt-dlp -> bounded Streamlink
        if !is_platform && (raw_url.starts_with("http://") || raw_url.starts_with("https://")) {
            let rem = remaining_budget();
            if rem >= Duration::from_secs(2) {
                let stage_start = Instant::now();
                let fetch_budget = rem.min(HTML_FETCH_TIMEOUT);
                let fetch_fut = self
                    .client
                    .get(raw_url)
                    .header(
                        "User-Agent",
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TORI/2.0",
                    )
                    .send();

                if let Ok(Ok(resp)) = tokio::time::timeout(fetch_budget, fetch_fut).await {
                    if let Ok(html) = tokio::time::timeout(
                        remaining_budget().min(HTML_FETCH_TIMEOUT),
                        resp.text(),
                    )
                    .await
                    .unwrap_or(Ok(String::new()))
                    {
                        if !html.is_empty() {
                            let scraped = extract_html_media_candidates(&html, raw_url);
                            if discovered_title.is_none() {
                                discovered_title = scraped.title;
                            }
                            if discovered_thumb.is_none() {
                                discovered_thumb = scraped.thumbnail_url;
                            }

                            let html_report = sanitize_candidate_urls(
                                &scraped.media_urls,
                                raw_url,
                                MAX_DISCOVERY_CANDIDATES,
                                false,
                            );
                            if !html_report.kept.is_empty()
                                && remaining_budget() >= Duration::from_millis(500)
                            {
                                let sweep_budget = remaining_budget().min(CANDIDATE_SWEEP_BUDGET);
                                let probed = probe_candidates_bounded(
                                    resolver,
                                    html_report.kept,
                                    sweep_budget,
                                    CANDIDATE_PROBE_TIMEOUT,
                                    true,
                                )
                                .await;
                                merge_discovered_metadata(
                                    probed,
                                    &mut discovered_title,
                                    &mut discovered_thumb,
                                    &mut discovered_formats,
                                );
                            }
                        }
                    }
                }
                html_ms = stage_start.elapsed().as_millis();
            }
        }

        if !is_platform
            && discovered_formats.is_empty()
            && remaining_budget() >= Duration::from_secs(2)
        {
            let stage_start = Instant::now();
            let rem = remaining_budget();
            let ytdlp_res = tokio::time::timeout(
                rem,
                resolver.resolve_with_options_budget(raw_url, req.force_refresh, Some(rem)),
            )
            .await;
            generic_ytdlp_ms = stage_start.elapsed().as_millis();

            if let Ok(Ok(meta)) = ytdlp_res {
                tracing::info!(
                    url = %redacted_url,
                    path = "generic_ytdlp",
                    cache_hit = meta.is_cached.unwrap_or(false),
                    candidates_total = req.candidates.len(),
                    candidates_kept = candidate_report.kept.len(),
                    candidates_dropped = candidate_report.total_dropped(),
                    candidate_ms = candidate_ms as u64,
                    html_ms = html_ms as u64,
                    generic_ytdlp_ms = generic_ytdlp_ms as u64,
                    total_ms = request_start.elapsed().as_millis() as u64,
                    "Media resolution completed via generic extractor fallback"
                );
                return Ok(meta);
            } else if let Ok(Err(e)) = ytdlp_res {
                let err_msg = e.to_string();
                if err_msg.contains("DRM") || err_msg.contains("protected") || err_msg.contains("plex.tv") {
                    return Err(e);
                }
            }
        }

        if !is_platform
            && discovered_formats.is_empty()
            && remaining_budget() >= Duration::from_secs(2)
        {
            let stage_start = Instant::now();
            let sl_budget = remaining_budget().min(Duration::from_secs(4));
            if let Ok(streamlink_formats) = probe_streamlink(raw_url, None, sl_budget).await {
                discovered_formats.extend(streamlink_formats);
            }
            streamlink_ms = stage_start.elapsed().as_millis();
        }

        if !discovered_formats.is_empty() {
            let ranked = deduplicate_and_rank_formats(discovered_formats);
            tracing::info!(
                url = %redacted_url,
                path = "generic_html_or_streamlink",
                candidates_total = req.candidates.len(),
                candidates_kept = candidate_report.kept.len(),
                candidates_dropped = candidate_report.total_dropped(),
                candidate_ms = candidate_ms as u64,
                html_ms = html_ms as u64,
                generic_ytdlp_ms = generic_ytdlp_ms as u64,
                streamlink_ms = streamlink_ms as u64,
                total_ms = request_start.elapsed().as_millis() as u64,
                formats = ranked.len(),
                "Media resolution completed via generic discovery fallback"
            );
            return Ok(MediaMetadata {
                source_url: raw_url.to_string(),
                webpage_url: raw_url.to_string(),
                site_name: "Generic HTML5 Media".to_string(),
                title: discovered_title.unwrap_or_else(|| "Discovered Video".to_string()),
                media_id: format!("{:x}", sha2::Sha256::digest(raw_url.as_bytes())),
                duration_seconds: None,
                thumbnail_url: discovered_thumb,
                extractor: "multi_strategy_html".to_string(),
                formats: ranked,
                is_direct_media: true,
                is_cached: None,
            });
        }

        let timed_out = remaining_budget().is_zero();
        tracing::warn!(
            url = %redacted_url,
            path = if is_platform { "platform" } else { "generic" },
            candidates_total = req.candidates.len(),
            candidates_kept = candidate_report.kept.len(),
            candidates_dropped = candidate_report.total_dropped(),
            platform_ms = platform_ms as u64,
            candidate_ms = candidate_ms as u64,
            html_ms = html_ms as u64,
            generic_ytdlp_ms = generic_ytdlp_ms as u64,
            streamlink_ms = streamlink_ms as u64,
            total_ms = request_start.elapsed().as_millis() as u64,
            timeout_source = if timed_out { "overall_request_budget" } else { "none" },
            "Media resolution completed without playable formats"
        );

        if timed_out {
            return Err(EngineError::Other(format!(
                "Media resolution timed out after {} seconds.",
                total_budget.as_secs()
            )));
        }

        if let Some(err) = platform_err {
            return Err(err);
        }

        Err(EngineError::Other(
            "No supported media stream, HTML5 source, or platform extractor found for this webpage."
                .to_string(),
        ))
    }
}
