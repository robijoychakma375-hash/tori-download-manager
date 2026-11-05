use sha2::Digest;
use std::collections::HashMap;
use std::time::Duration;
use url::Url;

use crate::error::{EngineError, Result};
use crate::resolver::extractor::{execute_yt_dlp_dump, execute_yt_dlp_playlist_dump};
use crate::resolver::models::{
    DownloadCapability, FilesizeType, MediaMetadata, PlaylistItem, PlaylistMetadata,
    ResolvedMediaFormat,
};
use crate::resolver::ssrf::validate_safe_media_url;

pub struct MediaResolver {
    client: reqwest::Client,
}

impl Default for MediaResolver {
    fn default() -> Self {
        Self::new()
    }
}

impl MediaResolver {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .unwrap_or_default();
        Self { client }
    }

    /// Resolves media metadata for any direct URL, streaming manifest, or video platform webpage.
    pub async fn resolve(&self, raw_url: &str) -> Result<MediaMetadata> {
        let safe_url = validate_safe_media_url(raw_url).await?;
        let url_str = safe_url.as_str();

        // 1. Direct Media Resource Probe (.mp4, .webm, .mp3, etc.)
        if is_direct_media_extension(url_str) {
            if let Ok(direct_meta) = self.probe_direct_media(url_str).await {
                return Ok(direct_meta);
            }
        }

        // 2. Direct HLS Manifest Probe (.m3u8)
        if url_str.contains(".m3u8") {
            if let Ok(hls_meta) = self.probe_direct_hls(url_str).await {
                return Ok(hls_meta);
            }
        }

        // 3. Direct DASH Manifest Probe (.mpd)
        if url_str.contains(".mpd") {
            if let Ok(dash_meta) = self.probe_direct_dash(url_str).await {
                return Ok(dash_meta);
            }
        }

        // 4. Universal Platform Extraction via yt-dlp
        let json_val = execute_yt_dlp_dump(url_str, None).await?;
        self.parse_ytdlp_metadata(url_str, &json_val)
    }

    /// Resolves metadata and item list for a media playlist (e.g. YouTube playlist, channel).
    pub async fn resolve_playlist(
        &self,
        raw_url: &str,
        limit: Option<usize>,
    ) -> Result<PlaylistMetadata> {
        let safe_url = validate_safe_media_url(raw_url).await?;
        let url_str = safe_url.as_str();

        let json_val = execute_yt_dlp_playlist_dump(url_str, limit, None).await?;
        parse_ytdlp_playlist_metadata(url_str, &json_val)
    }

    /// Probes direct media URLs via HTTP HEAD/GET.
    async fn probe_direct_media(&self, url: &str) -> Result<MediaMetadata> {
        let resp = self
            .client
            .head(url)
            .header(
                "User-Agent",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TORI/2.0",
            )
            .send()
            .await
            .map_err(EngineError::Http)?;

        let _status = resp.status();
        let headers = resp.headers().clone();

        let content_type = headers
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_lowercase();

        // Reject HTML responses
        if content_type.starts_with("text/html") {
            return Err(EngineError::InvalidUrl(
                "Target returned HTML webpage".to_string(),
            ));
        }

        let content_length = headers
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok());

        let filename = extract_filename(url, &headers);
        let ext = filename.rsplit('.').next().unwrap_or("mp4").to_lowercase();

        let is_audio = ext == "mp3"
            || ext == "m4a"
            || ext == "aac"
            || ext == "flac"
            || ext == "wav"
            || ext == "ogg";

        let format = ResolvedMediaFormat {
            format_id: "direct".to_string(),
            format_note: Some(
                if is_audio {
                    "Direct Audio"
                } else {
                    "Direct Video"
                }
                .to_string(),
            ),
            width: None,
            height: None,
            resolution_label: if is_audio { "Audio" } else { "Original" }.to_string(),
            fps: None,
            vcodec: if is_audio {
                None
            } else {
                Some("Original".to_string())
            },
            acodec: Some("Original".to_string()),
            container: ext,
            protocol: "https".to_string(),
            bitrate_kbps: None,
            has_video: !is_audio,
            has_audio: true,
            filesize: content_length,
            filesize_approx: None,
            filesize_type: if content_length.is_some() {
                FilesizeType::Exact
            } else {
                FilesizeType::Unknown
            },
            requires_merge: false,
            merge_audio_format_id: None,
            audio_channels: None,
            sample_rate: None,
            download_capability: DownloadCapability::NativeHttp,
            unavailable_reason: None,
            direct_stream_url: Some(url.to_string()),
            http_headers: None,
        };

        Ok(MediaMetadata {
            source_url: url.to_string(),
            webpage_url: url.to_string(),
            site_name: "Direct Download".to_string(),
            title: filename,
            media_id: format!("{:x}", sha2::Sha256::digest(url.as_bytes())),
            duration_seconds: None,
            thumbnail_url: None,
            extractor: "direct_http".to_string(),
            formats: vec![format],
            is_direct_media: true,
        })
    }

    /// Probes direct HLS master or media playlists.
    async fn probe_direct_hls(&self, url: &str) -> Result<MediaMetadata> {
        let resp = self
            .client
            .get(url)
            .header(
                "User-Agent",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TORI/2.0",
            )
            .send()
            .await
            .map_err(EngineError::Http)?;

        let body = resp.text().await.map_err(EngineError::Http)?;
        if !body.contains("#EXTM3U") {
            return Err(EngineError::InvalidUrl(
                "Not a valid HLS playlist".to_string(),
            ));
        }

        let mut formats = Vec::new();

        if let Ok(master) = crate::hls::parser::parse_master_playlist(&body, url) {
            for (idx, v) in master.variants.into_iter().enumerate() {
                let res_label = if let Some((_w, h)) = v.resolution {
                    format!("{}p", h)
                } else {
                    format!("Variant {}", idx + 1)
                };

                formats.push(ResolvedMediaFormat {
                    format_id: format!("hls_{}", idx + 1),
                    format_note: Some(format!("HLS {}", res_label)),
                    width: v.resolution.map(|(w, _)| w),
                    height: v.resolution.map(|(_, h)| h),
                    resolution_label: res_label,
                    fps: None,
                    vcodec: v.codecs.clone(),
                    acodec: Some("aac".to_string()),
                    container: "mp4".to_string(),
                    protocol: "m3u8".to_string(),
                    bitrate_kbps: Some(v.bandwidth as f64 / 1000.0),
                    has_video: true,
                    has_audio: true,
                    filesize: None,
                    filesize_approx: None,
                    filesize_type: FilesizeType::Unknown,
                    requires_merge: false,
                    merge_audio_format_id: None,
                    audio_channels: None,
                    sample_rate: None,
                    download_capability: DownloadCapability::NativeHls,
                    unavailable_reason: None,
                    direct_stream_url: Some(v.uri),
                    http_headers: None,
                });
            }
        }

        if formats.is_empty() {
            formats.push(ResolvedMediaFormat {
                format_id: "hls_stream".to_string(),
                format_note: Some("HLS VOD Stream".to_string()),
                width: None,
                height: None,
                resolution_label: "Auto".to_string(),
                fps: None,
                vcodec: None,
                acodec: None,
                container: "mp4".to_string(),
                protocol: "m3u8".to_string(),
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
                download_capability: DownloadCapability::NativeHls,
                unavailable_reason: None,
                direct_stream_url: Some(url.to_string()),
                http_headers: None,
            });
        }

        Ok(MediaMetadata {
            source_url: url.to_string(),
            webpage_url: url.to_string(),
            site_name: "HLS Stream".to_string(),
            title: extract_filename(url, &reqwest::header::HeaderMap::new()),
            media_id: format!("{:x}", sha2::Sha256::digest(url.as_bytes())),
            duration_seconds: None,
            thumbnail_url: None,
            extractor: "hls".to_string(),
            formats,
            is_direct_media: true,
        })
    }

    /// Probes direct DASH MPD manifests.
    async fn probe_direct_dash(&self, url: &str) -> Result<MediaMetadata> {
        let resp = self
            .client
            .get(url)
            .header(
                "User-Agent",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TORI/2.0",
            )
            .send()
            .await
            .map_err(EngineError::Http)?;

        let body = resp.text().await.map_err(EngineError::Http)?;
        let mpd = crate::dash::parser::parse_mpd_manifest(&body, url)?;

        let mut formats = Vec::new();
        for period in &mpd.periods {
            for adapt in &period.adaptation_sets {
                let is_video = adapt.content_type.as_deref() == Some("video")
                    || adapt
                        .mime_type
                        .as_deref()
                        .map(|m| m.starts_with("video/"))
                        .unwrap_or(false);
                if !is_video {
                    continue;
                }
                for rep in &adapt.representations {
                    let res_label = if let Some(h) = rep.height {
                        format!("{}p", h)
                    } else {
                        format!("DASH {}", rep.id)
                    };

                    formats.push(ResolvedMediaFormat {
                        format_id: format!("dash_{}", rep.id),
                        format_note: Some(format!("DASH {}", res_label)),
                        width: rep.width,
                        height: rep.height,
                        resolution_label: res_label,
                        fps: None,
                        vcodec: rep.codecs.clone(),
                        acodec: Some("aac".to_string()),
                        container: "mp4".to_string(),
                        protocol: "mpd".to_string(),
                        bitrate_kbps: Some(rep.bandwidth as f64 / 1000.0),
                        has_video: true,
                        has_audio: true,
                        filesize: None,
                        filesize_approx: None,
                        filesize_type: FilesizeType::Unknown,
                        requires_merge: false,
                        merge_audio_format_id: None,
                        audio_channels: None,
                        sample_rate: None,
                        download_capability: DownloadCapability::NativeDash,
                        unavailable_reason: None,
                        direct_stream_url: Some(url.to_string()),
                        http_headers: None,
                    });
                }
            }
        }

        if formats.is_empty() {
            formats.push(ResolvedMediaFormat {
                format_id: "dash_stream".to_string(),
                format_note: Some("DASH VOD Stream".to_string()),
                width: None,
                height: None,
                resolution_label: "Auto".to_string(),
                fps: None,
                vcodec: None,
                acodec: None,
                container: "mp4".to_string(),
                protocol: "mpd".to_string(),
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
                download_capability: DownloadCapability::NativeDash,
                unavailable_reason: None,
                direct_stream_url: Some(url.to_string()),
                http_headers: None,
            });
        }

        Ok(MediaMetadata {
            source_url: url.to_string(),
            webpage_url: url.to_string(),
            site_name: "DASH Stream".to_string(),
            title: extract_filename(url, &reqwest::header::HeaderMap::new()),
            media_id: format!("{:x}", sha2::Sha256::digest(url.as_bytes())),
            duration_seconds: mpd.media_presentation_duration,
            thumbnail_url: None,
            extractor: "dash".to_string(),
            formats,
            is_direct_media: true,
        })
    }

    /// Parses yt-dlp machine-readable single JSON output into a structured metadata model.
    pub fn parse_ytdlp_metadata(
        &self,
        original_url: &str,
        json: &serde_json::Value,
    ) -> Result<MediaMetadata> {
        let title = json
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("Untitled Media")
            .to_string();

        let media_id = json
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let webpage_url = json
            .get("webpage_url")
            .and_then(|v| v.as_str())
            .unwrap_or(original_url)
            .to_string();

        let site_name = json
            .get("extractor_key")
            .or_else(|| json.get("extractor"))
            .and_then(|v| v.as_str())
            .unwrap_or("Web Media")
            .to_string();

        let duration_seconds = json.get("duration").and_then(|v| v.as_f64());
        let thumbnail_url = json
            .get("thumbnail")
            .and_then(|v| v.as_str())
            .map(String::from);
        let extractor = json
            .get("extractor")
            .and_then(|v| v.as_str())
            .unwrap_or("yt-dlp")
            .to_string();

        let raw_formats = json
            .get("formats")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        // 1. Separate audio tracks and find the best audio track for merging
        let mut audio_tracks: Vec<ParsedRawFormat> = Vec::new();
        let mut video_tracks: Vec<ParsedRawFormat> = Vec::new();
        let mut progressive_tracks: Vec<ParsedRawFormat> = Vec::new();

        for f in &raw_formats {
            if let Some(parsed) = parse_single_format(f) {
                if parsed.is_storyboard {
                    continue;
                }
                if parsed.has_video && parsed.has_audio {
                    progressive_tracks.push(parsed);
                } else if parsed.has_video {
                    video_tracks.push(parsed);
                } else if parsed.has_audio {
                    audio_tracks.push(parsed);
                }
            }
        }

        let mut final_formats: Vec<ResolvedMediaFormat> = Vec::new();

        // 2. Add video-only formats paired with compatible audio (or marked requires_merge)
        // Group by resolution height and container to avoid duplicate formats with same resolution
        let mut seen_heights = std::collections::HashSet::new();

        // Sort video tracks descending by height and bitrate
        let mut sorted_videos = video_tracks;
        sorted_videos.sort_by(|a, b| {
            let h_a = a.height.unwrap_or(0);
            let h_b = b.height.unwrap_or(0);
            if h_a != h_b {
                return h_b.cmp(&h_a);
            }
            let br_a = a.bitrate_kbps.unwrap_or(0.0) as u64;
            let br_b = b.bitrate_kbps.unwrap_or(0.0) as u64;
            br_b.cmp(&br_a)
        });

        for v in sorted_videos {
            let h = v.height.unwrap_or(0);
            let key = (h, v.container.clone());
            if seen_heights.contains(&key) && h > 0 {
                continue;
            }
            seen_heights.insert(key);

            let res_label = if let Some(h) = v.height {
                format!("{}p", h)
            } else {
                v.resolution_label.clone()
            };

            // Select compatible audio and strictly standards-compliant container
            let (chosen_audio, output_container) =
                select_compatible_audio_and_container(&v, &audio_tracks);

            // Calculate combined filesize if paired with chosen audio
            let (combo_size, combo_approx, size_type, merge_id) = if let Some(ref a) = chosen_audio
            {
                let merge_id = Some(a.format_id.clone());
                match (v.filesize, a.filesize) {
                    (Some(v_sz), Some(a_sz)) => {
                        (Some(v_sz + a_sz), None, FilesizeType::Exact, merge_id)
                    }
                    _ => {
                        let v_eff = v.filesize.or(v.filesize_approx);
                        let a_eff = a.filesize.or(a.filesize_approx);
                        match (v_eff, a_eff) {
                            (Some(v_e), Some(a_e)) => {
                                (None, Some(v_e + a_e), FilesizeType::Estimated, merge_id)
                            }
                            _ => (None, None, FilesizeType::Unknown, merge_id),
                        }
                    }
                }
            } else {
                (v.filesize, v.filesize_approx, v.filesize_type, None)
            };

            let format_id_spec = if let Some(ref a) = chosen_audio {
                format!("{}+{}", v.format_id, a.format_id)
            } else {
                v.format_id.clone()
            };

            final_formats.push(ResolvedMediaFormat {
                format_id: format_id_spec,
                format_note: v.format_note.clone(),
                width: v.width,
                height: v.height,
                resolution_label: res_label,
                fps: v.fps,
                vcodec: v.vcodec.clone(),
                acodec: chosen_audio.as_ref().and_then(|a| a.acodec.clone()),
                container: output_container,
                protocol: v.protocol.clone(),
                bitrate_kbps: v.bitrate_kbps,
                has_video: true,
                has_audio: chosen_audio.is_some(),
                filesize: combo_size,
                filesize_approx: combo_approx,
                filesize_type: size_type,
                requires_merge: chosen_audio.is_some(),
                merge_audio_format_id: merge_id,
                audio_channels: chosen_audio.as_ref().and_then(|a| a.audio_channels),
                sample_rate: chosen_audio.as_ref().and_then(|a| a.sample_rate),
                download_capability: DownloadCapability::ManagedExtractor,
                unavailable_reason: None,
                direct_stream_url: v.direct_url.clone(),
                http_headers: v.http_headers.clone(),
            });
        }

        // 3. Add progressive tracks (video + audio in single stream) if not redundant
        for p in progressive_tracks {
            let res_label = if let Some(h) = p.height {
                format!("{}p", h)
            } else {
                p.resolution_label.clone()
            };

            final_formats.push(ResolvedMediaFormat {
                format_id: p.format_id.clone(),
                format_note: p.format_note.clone(),
                width: p.width,
                height: p.height,
                resolution_label: res_label,
                fps: p.fps,
                vcodec: p.vcodec.clone(),
                acodec: p.acodec.clone(),
                container: p.container.clone(),
                protocol: p.protocol.clone(),
                bitrate_kbps: p.bitrate_kbps,
                has_video: true,
                has_audio: true,
                filesize: p.filesize,
                filesize_approx: p.filesize_approx,
                filesize_type: p.filesize_type,
                requires_merge: false,
                merge_audio_format_id: None,
                audio_channels: p.audio_channels,
                sample_rate: p.sample_rate,
                download_capability: DownloadCapability::ManagedExtractor,
                unavailable_reason: None,
                direct_stream_url: p.direct_url.clone(),
                http_headers: p.http_headers.clone(),
            });
        }

        // 4. Add audio-only formats
        for a in audio_tracks {
            let label = if let Some(br) = a.bitrate_kbps {
                if br > 0.0 {
                    format!("{:.0}k", br)
                } else {
                    "Audio".to_string()
                }
            } else if let Some(ref note) = a.format_note {
                let clean = note.trim();
                if !clean.is_empty() && clean.len() <= 10 {
                    clean.to_string()
                } else {
                    "Audio".to_string()
                }
            } else {
                "Audio".to_string()
            };

            final_formats.push(ResolvedMediaFormat {
                format_id: a.format_id.clone(),
                format_note: a.format_note.clone(),
                width: None,
                height: None,
                resolution_label: label,
                fps: None,
                vcodec: None,
                acodec: a.acodec.clone(),
                container: a.container.clone(),
                protocol: a.protocol.clone(),
                bitrate_kbps: a.bitrate_kbps,
                has_video: false,
                has_audio: true,
                filesize: a.filesize,
                filesize_approx: a.filesize_approx,
                filesize_type: a.filesize_type,
                requires_merge: false,
                merge_audio_format_id: None,
                audio_channels: a.audio_channels,
                sample_rate: a.sample_rate,
                download_capability: DownloadCapability::ManagedExtractor,
                unavailable_reason: None,
                direct_stream_url: a.direct_url.clone(),
                http_headers: a.http_headers.clone(),
            });
        }

        if final_formats.is_empty() {
            return Err(EngineError::Other(
                "No downloadable media formats could be extracted for this URL.".to_string(),
            ));
        }

        Ok(MediaMetadata {
            source_url: original_url.to_string(),
            webpage_url,
            site_name,
            title,
            media_id,
            duration_seconds,
            thumbnail_url,
            extractor,
            formats: final_formats,
            is_direct_media: false,
        })
    }
}

#[derive(Clone, Debug)]
pub struct ParsedRawFormat {
    pub format_id: String,
    pub format_note: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub resolution_label: String,
    pub fps: Option<f64>,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    pub container: String,
    pub protocol: String,
    pub bitrate_kbps: Option<f64>,
    pub has_video: bool,
    pub has_audio: bool,
    pub filesize: Option<u64>,
    pub filesize_approx: Option<u64>,
    pub filesize_type: FilesizeType,
    pub is_storyboard: bool,
    pub audio_channels: Option<u32>,
    pub sample_rate: Option<u32>,
    pub direct_url: Option<String>,
    pub http_headers: Option<HashMap<String, String>>,
}

/// Determines the most compatible audio track and standard-compliant container format for a video stream.
/// Ensures:
/// - H.264 + AAC: MP4
/// - VP9 + Opus: WebM
/// - VP9 + AAC: Matroska/MKV (never mislabeled as WebM)
/// - H.264 + Opus: Matroska/MKV
pub fn select_compatible_audio_and_container(
    v: &ParsedRawFormat,
    audio_tracks: &[ParsedRawFormat],
) -> (Option<ParsedRawFormat>, String) {
    if audio_tracks.is_empty() {
        return (None, v.container.clone());
    }

    let is_vp9_or_webm = v.container == "webm"
        || v.vcodec.as_deref().unwrap_or("").contains("vp9")
        || v.vcodec.as_deref().unwrap_or("").contains("vp09")
        || v.vcodec.as_deref().unwrap_or("").contains("vp8");

    let is_mp4_or_h264 = v.container == "mp4"
        || v.vcodec.as_deref().unwrap_or("").contains("avc")
        || v.vcodec.as_deref().unwrap_or("").contains("h264")
        || v.vcodec.as_deref().unwrap_or("").contains("hevc")
        || v.vcodec.as_deref().unwrap_or("").contains("h265");

    if is_vp9_or_webm {
        // Look for Opus or Vorbis audio for strictly compliant WebM
        let opus_track = audio_tracks
            .iter()
            .filter(|a| {
                a.container == "webm"
                    || a.container == "opus"
                    || a.acodec
                        .as_deref()
                        .map(|c| c.contains("opus") || c.contains("vorbis"))
                        .unwrap_or(false)
            })
            .max_by_key(|a| a.bitrate_kbps.unwrap_or(0.0) as i64);

        if let Some(opus) = opus_track {
            (Some(opus.clone()), "webm".to_string())
        } else {
            // Only AAC / non-WebM audio available with VP9:
            // Standard WebM container prohibits AAC. Must use Matroska (MKV).
            let best_other = audio_tracks
                .iter()
                .max_by_key(|a| a.bitrate_kbps.unwrap_or(0.0) as i64);
            (best_other.cloned(), "mkv".to_string())
        }
    } else if is_mp4_or_h264 {
        // Look for AAC/M4A audio for strictly compliant MP4
        let aac_track = audio_tracks
            .iter()
            .filter(|a| {
                a.container == "m4a"
                    || a.container == "mp4"
                    || a.acodec
                        .as_deref()
                        .map(|c| c.contains("mp4a") || c.contains("aac"))
                        .unwrap_or(false)
            })
            .max_by_key(|a| a.bitrate_kbps.unwrap_or(0.0) as i64);

        if let Some(aac) = aac_track {
            (Some(aac.clone()), "mp4".to_string())
        } else {
            // Non-AAC audio paired with H.264
            let best_other = audio_tracks
                .iter()
                .max_by_key(|a| a.bitrate_kbps.unwrap_or(0.0) as i64);
            (best_other.cloned(), "mkv".to_string())
        }
    } else {
        // Other video codecs (e.g. AV1)
        let best_audio = audio_tracks
            .iter()
            .max_by_key(|a| a.bitrate_kbps.unwrap_or(0.0) as i64);
        let container = if v.container == "webm" {
            let is_opus = best_audio
                .as_ref()
                .and_then(|a| a.acodec.as_deref())
                .map(|c| c.contains("opus") || c.contains("vorbis"))
                .unwrap_or(false);
            if is_opus {
                "webm".to_string()
            } else {
                "mkv".to_string()
            }
        } else if v.container == "mp4" {
            let is_aac = best_audio
                .as_ref()
                .and_then(|a| a.acodec.as_deref())
                .map(|c| c.contains("mp4a") || c.contains("aac"))
                .unwrap_or(false);
            if is_aac {
                "mp4".to_string()
            } else {
                "mkv".to_string()
            }
        } else {
            v.container.clone()
        };
        (best_audio.cloned(), container)
    }
}

fn parse_single_format(f: &serde_json::Value) -> Option<ParsedRawFormat> {
    let format_id = f.get("format_id")?.as_str()?.to_string();
    let format_note = f
        .get("format_note")
        .and_then(|v| v.as_str())
        .map(String::from);
    let protocol = f
        .get("protocol")
        .and_then(|v| v.as_str())
        .unwrap_or("https")
        .to_string();

    let container = f
        .get("ext")
        .and_then(|v| v.as_str())
        .unwrap_or("mp4")
        .to_string();

    let vcodec = f.get("vcodec").and_then(|v| v.as_str()).map(String::from);
    let acodec = f.get("acodec").and_then(|v| v.as_str()).map(String::from);

    let is_storyboard = format_note.as_deref() == Some("storyboard")
        || protocol == "mhtml"
        || container == "mhtml"
        || container == "jpg"
        || container == "jpeg"
        || (vcodec.as_deref() == Some("none") && acodec.as_deref() == Some("none"));

    let has_video = match vcodec.as_deref() {
        Some("none") => false,
        Some(_) => true,
        None => !matches!(
            container.as_str(),
            "m4a" | "mp3" | "opus" | "aac" | "flac" | "wav" | "ogg"
        ),
    };

    let has_audio = match acodec.as_deref() {
        Some("none") => false,
        Some(_) => true,
        None => true,
    };

    let width = f.get("width").and_then(|v| v.as_u64()).map(|w| w as u32);
    let height = f.get("height").and_then(|v| v.as_u64()).map(|h| h as u32);

    let resolution_label = if let Some(h) = height {
        format!("{}p", h)
    } else if has_audio && !has_video {
        "Audio Only".to_string()
    } else if let Some(note) = format_note.as_deref() {
        if !note.is_empty() {
            note.to_uppercase()
        } else {
            f.get("resolution")
                .and_then(|v| v.as_str())
                .unwrap_or("Media")
                .to_string()
        }
    } else {
        f.get("resolution")
            .and_then(|v| v.as_str())
            .unwrap_or("Media")
            .to_string()
    };

    let fps = f.get("fps").and_then(|v| v.as_f64());

    let tbr = f.get("tbr").and_then(|v| v.as_f64());
    let vbr = f.get("vbr").and_then(|v| v.as_f64());
    let abr = f.get("abr").and_then(|v| v.as_f64());
    let bitrate_kbps = tbr.or_else(|| {
        if vbr.is_some() || abr.is_some() {
            Some(vbr.unwrap_or(0.0) + abr.unwrap_or(0.0))
        } else {
            None
        }
    });

    let filesize = f.get("filesize").and_then(|v| v.as_u64());
    let filesize_approx = f.get("filesize_approx").and_then(|v| v.as_u64());

    let filesize_type = if filesize.is_some() {
        FilesizeType::Exact
    } else if filesize_approx.is_some() {
        FilesizeType::Estimated
    } else {
        FilesizeType::Unknown
    };

    let audio_channels = f
        .get("audio_channels")
        .and_then(|v| v.as_u64())
        .map(|c| c as u32);
    let sample_rate = f.get("asr").and_then(|v| v.as_u64()).map(|r| r as u32);
    let direct_url = f.get("url").and_then(|v| v.as_str()).map(String::from);

    let http_headers = f
        .get("http_headers")
        .and_then(|v| v.as_object())
        .map(|obj| {
            let mut map = HashMap::new();
            for (k, v) in obj {
                if let Some(s) = v.as_str() {
                    map.insert(k.clone(), s.to_string());
                }
            }
            map
        });

    Some(ParsedRawFormat {
        format_id,
        format_note,
        width,
        height,
        resolution_label,
        fps,
        vcodec,
        acodec,
        container,
        protocol,
        bitrate_kbps,
        has_video,
        has_audio,
        filesize,
        filesize_approx,
        filesize_type,
        is_storyboard,
        audio_channels,
        sample_rate,
        direct_url,
        http_headers,
    })
}

fn is_direct_media_extension(url: &str) -> bool {
    let lower = url.to_lowercase();
    let clean = lower.split('?').next().unwrap_or(&lower);
    clean.ends_with(".mp4")
        || clean.ends_with(".webm")
        || clean.ends_with(".mkv")
        || clean.ends_with(".mov")
        || clean.ends_with(".avi")
        || clean.ends_with(".mp3")
        || clean.ends_with(".m4a")
        || clean.ends_with(".aac")
        || clean.ends_with(".flac")
        || clean.ends_with(".ogg")
        || clean.ends_with(".opus")
        || clean.ends_with(".wav")
}

fn extract_filename(url: &str, headers: &reqwest::header::HeaderMap) -> String {
    if let Some(cd) = headers.get(reqwest::header::CONTENT_DISPOSITION) {
        if let Ok(cd_str) = cd.to_str() {
            if let Some(filename) = parse_content_disposition(cd_str) {
                return filename;
            }
        }
    }

    if let Ok(parsed) = Url::parse(url) {
        if let Some(mut segments) = parsed.path_segments() {
            if let Some(last) = segments.next_back() {
                let decoded = url_decode_str(last);
                let trimmed = decoded.trim();
                if !trimmed.is_empty() && trimmed != "/" {
                    return trimmed.to_string();
                }
            }
        }
    }

    "media_download".to_string()
}

fn url_decode_str(s: &str) -> String {
    url::form_urlencoded::parse(s.as_bytes())
        .next()
        .map(|(k, _)| k.to_string())
        .unwrap_or_else(|| s.to_string())
}

fn parse_content_disposition(header: &str) -> Option<String> {
    for part in header.split(';') {
        let trimmed = part.trim();
        if trimmed.to_lowercase().starts_with("filename*=") {
            let val = trimmed["filename*=".len()..].trim();
            if let Some(actual) = val
                .strip_prefix("UTF-8''")
                .or_else(|| val.strip_prefix("utf-8''"))
            {
                let unquoted = actual.trim_matches('"');
                return Some(url_decode_str(unquoted));
            }
        } else if trimmed.to_lowercase().starts_with("filename=") {
            let val = trimmed["filename=".len()..].trim().trim_matches('"');
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    None
}

/// Parses yt-dlp flat-playlist JSON into structured PlaylistMetadata.
pub fn parse_ytdlp_playlist_metadata(
    url_str: &str,
    json_val: &serde_json::Value,
) -> Result<PlaylistMetadata> {
    let id = json_val
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    let title = json_val
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("Untitled Playlist")
        .to_string();

    let webpage_url = json_val
        .get("webpage_url")
        .and_then(|v| v.as_str())
        .unwrap_or(url_str)
        .to_string();

    let extractor = json_val
        .get("extractor")
        .and_then(|v| v.as_str())
        .unwrap_or("generic")
        .to_string();

    let channel = json_val
        .get("channel")
        .or_else(|| json_val.get("uploader"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let thumbnail_url = if let Some(thumb) = json_val.get("thumbnail").and_then(|v| v.as_str()) {
        Some(thumb.to_string())
    } else if let Some(thumbs) = json_val.get("thumbnails").and_then(|v| v.as_array()) {
        thumbs
            .last()
            .and_then(|t| t.get("url").and_then(|u| u.as_str()))
            .map(|s| s.to_string())
    } else {
        None
    };

    let mut items = Vec::new();

    if let Some(entries) = json_val.get("entries").and_then(|v| v.as_array()) {
        for (i, entry) in entries.iter().enumerate() {
            if entry.is_null() {
                continue;
            }
            let item_id = entry
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let item_title = entry
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("Untitled Video")
                .to_string();

            let item_url = if let Some(u) = entry.get("url").and_then(|v| v.as_str()) {
                if u.starts_with("http://") || u.starts_with("https://") {
                    u.to_string()
                } else if !item_id.is_empty() {
                    format!("https://www.youtube.com/watch?v={}", item_id)
                } else {
                    u.to_string()
                }
            } else if !item_id.is_empty() {
                format!("https://www.youtube.com/watch?v={}", item_id)
            } else {
                url_str.to_string()
            };

            let duration_seconds = entry
                .get("duration")
                .and_then(|v| v.as_f64().or_else(|| v.as_u64().map(|u| u as f64)));

            let item_thumb = if let Some(t) = entry.get("thumbnail").and_then(|v| v.as_str()) {
                Some(t.to_string())
            } else if let Some(thumbs) = entry.get("thumbnails").and_then(|v| v.as_array()) {
                thumbs
                    .last()
                    .and_then(|t| t.get("url").and_then(|u| u.as_str()))
                    .map(|s| s.to_string())
            } else {
                None
            };

            let item_channel = entry
                .get("channel")
                .or_else(|| entry.get("uploader"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            items.push(PlaylistItem {
                id: item_id,
                title: item_title,
                url: item_url,
                duration_seconds,
                thumbnail_url: item_thumb,
                channel: item_channel,
                index: i + 1,
            });
        }
    } else {
        // Single video fallback treated as 1-item playlist
        let item_id = json_val
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        let item_url = json_val
            .get("webpage_url")
            .and_then(|v| v.as_str())
            .unwrap_or(url_str)
            .to_string();

        let duration_seconds = json_val
            .get("duration")
            .and_then(|v| v.as_f64().or_else(|| v.as_u64().map(|u| u as f64)));

        items.push(PlaylistItem {
            id: item_id,
            title: title.clone(),
            url: item_url,
            duration_seconds,
            thumbnail_url: thumbnail_url.clone(),
            channel: channel.clone(),
            index: 1,
        });
    }

    let item_count = items.len();

    Ok(PlaylistMetadata {
        id,
        title,
        webpage_url,
        thumbnail_url,
        extractor,
        channel,
        item_count,
        items,
    })
}
