use sha2::Digest;
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;
use url::Url;

use crate::error::{EngineError, Result};
use crate::hls::muxer::silent_command;
use crate::resolver::discovery::find_streamlink;
use crate::resolver::models::{
    DownloadCapability, FilesizeType, MediaMetadata, ResolveRequest, ResolvedMediaFormat,
};
use crate::resolver::pipeline::MediaResolver;

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
    let lower = html.to_lowercase();
    let start_idx = lower.find(open_tag)? + open_tag.len();
    let end_idx = start_idx + lower[start_idx..].find(close_tag)?;
    Some(html[start_idx..end_idx].to_string())
}

fn extract_meta_property(html: &str, property: &str) -> Option<String> {
    let lower = html.to_lowercase();
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
    let lower = html.to_lowercase();

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
    let lower = html.to_lowercase();
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
    let lower = html.to_lowercase();
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

    let url_owned = url.to_string();
    let output_res = tokio::time::timeout(
        timeout,
        tokio::task::spawn_blocking(move || {
            silent_command(bin).arg("--json").arg(&url_owned).output()
        }),
    )
    .await
    .map_err(|_| EngineError::Other("Streamlink probe timed out".to_string()))?
    .map_err(|e| EngineError::Other(format!("Streamlink process failure: {}", e)))?;

    let output = output_res.map_err(EngineError::Io)?;
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

impl DiscoveryOrchestrator {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .unwrap_or_default();
        Self { client }
    }

    /// Resolves media across multiple discovery strategies with bounded concurrency.
    pub async fn resolve_multi_strategy(
        &self,
        resolver: &MediaResolver,
        req: &ResolveRequest,
    ) -> Result<MediaMetadata> {
        let raw_url = req.url.trim();
        let safe_url = crate::resolver::ssrf::validate_safe_media_url(raw_url).await?;
        let raw_url = safe_url.as_str();

        // 1. If explicit browser candidates were provided (from DOM or network request interception),
        // probe them first before falling back to heavy scraping!
        let mut discovered_formats = Vec::new();
        let mut discovered_title = req.page_title.clone();
        let mut discovered_thumb = req.thumbnail_url.clone();

        for cand_url in &req.candidates {
            let cand_trim = cand_url.trim();
            if cand_trim.is_empty() || cand_trim.starts_with("blob:") {
                continue;
            }
            let res = if cand_trim.contains(".m3u8") {
                resolver.probe_direct_hls(cand_trim).await
            } else if cand_trim.contains(".mpd") {
                resolver.probe_direct_dash(cand_trim).await
            } else {
                match resolver.probe_direct_media(cand_trim).await {
                    Ok(m) => Ok(m),
                    Err(_) => resolver.resolve(cand_trim).await,
                }
            };
            if let Ok(meta) = res {
                if discovered_title.is_none()
                    && !meta.title.is_empty()
                    && meta.title != "Direct Download"
                {
                    discovered_title = Some(meta.title);
                }
                if discovered_thumb.is_none() && meta.thumbnail_url.is_some() {
                    discovered_thumb = meta.thumbnail_url;
                }
                discovered_formats.extend(meta.formats);
            }
        }

        // 2. If we already found playable formats from passed candidates, synthesize and return!
        if !discovered_formats.is_empty() {
            let ranked = deduplicate_and_rank_formats(discovered_formats);
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
            });
        }

        let is_platform = crate::resolver::pipeline::is_known_platform_domain(raw_url);

        // 3. For known platform domains (YouTube, TikTok, Facebook, etc.), try standard platform resolver pipeline first
        if is_platform {
            match resolver.resolve(raw_url).await {
                Ok(meta) => return Ok(meta),
                Err(e) => {
                    // If it's a DRM protected platform, do not attempt generic bypasses
                    let err_msg = e.to_string();
                    if err_msg.contains("DRM")
                        || err_msg.contains("protected")
                        || err_msg.contains("plex.tv")
                    {
                        return Err(e);
                    }
                }
            }
        }

        // 4. Try HTML metadata extraction if raw_url is an HTTP/HTTPS webpage
        if raw_url.starts_with("http://") || raw_url.starts_with("https://") {
            if let Ok(resp) = self
                .client
                .get(raw_url)
                .header(
                    "User-Agent",
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TORI/2.0",
                )
                .send()
                .await
            {
                if let Ok(html) = resp.text().await {
                    let scraped = extract_html_media_candidates(&html, raw_url);
                    if discovered_title.is_none() {
                        discovered_title = scraped.title;
                    }
                    if discovered_thumb.is_none() {
                        discovered_thumb = scraped.thumbnail_url;
                    }

                    for media_url in scraped.media_urls {
                        let res = if media_url.contains(".m3u8") {
                            resolver.probe_direct_hls(&media_url).await
                        } else if media_url.contains(".mpd") {
                            resolver.probe_direct_dash(&media_url).await
                        } else {
                            match resolver.probe_direct_media(&media_url).await {
                                Ok(m) => Ok(m),
                                Err(_) => resolver.resolve(&media_url).await,
                            }
                        };
                        if let Ok(meta) = res {
                            discovered_formats.extend(meta.formats);
                        }
                    }
                }
            }
        }

        // 5. If not a platform domain and HTML scraping found no direct media, fall back to yt-dlp
        if !is_platform && discovered_formats.is_empty() {
            match resolver.resolve(raw_url).await {
                Ok(meta) => return Ok(meta),
                Err(e) => {
                    let err_msg = e.to_string();
                    if err_msg.contains("DRM")
                        || err_msg.contains("protected")
                        || err_msg.contains("plex.tv")
                    {
                        return Err(e);
                    }
                }
            }
        }

        // 5. Try optional Streamlink probe if installed
        if let Ok(streamlink_formats) =
            probe_streamlink(raw_url, None, Duration::from_secs(6)).await
        {
            discovered_formats.extend(streamlink_formats);
        }

        // 6. If any formats were discovered across the multi-strategy sweep, synthesize results!
        if !discovered_formats.is_empty() {
            let ranked = deduplicate_and_rank_formats(discovered_formats);
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
            });
        }

        // 7. Terminal classification
        Err(EngineError::Other(
            "No supported media stream, HTML5 source, or platform extractor found for this webpage."
                .to_string(),
        ))
    }
}
