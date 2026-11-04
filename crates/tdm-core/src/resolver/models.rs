use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FilesizeType {
    Exact,
    Estimated,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadCapability {
    NativeHttp,
    NativeHls,
    NativeDash,
    ManagedExtractor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedMediaFormat {
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
    pub requires_merge: bool,
    pub merge_audio_format_id: Option<String>,
    pub audio_channels: Option<u32>,
    pub sample_rate: Option<u32>,
    pub download_capability: DownloadCapability,
    pub unavailable_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direct_stream_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_headers: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaMetadata {
    pub source_url: String,
    pub webpage_url: String,
    pub site_name: String,
    pub title: String,
    pub media_id: String,
    pub duration_seconds: Option<f64>,
    pub thumbnail_url: Option<String>,
    pub extractor: String,
    pub formats: Vec<ResolvedMediaFormat>,
    pub is_direct_media: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolverStatus {
    pub yt_dlp_available: bool,
    pub yt_dlp_version: Option<String>,
    pub yt_dlp_path: Option<String>,
    pub ffmpeg_available: bool,
    pub ffmpeg_path: Option<String>,
    pub ffprobe_available: bool,
    pub ffprobe_path: Option<String>,
    pub js_runtime_available: bool,
    pub js_runtime_name: Option<String>,
    pub js_runtime_path: Option<String>,
    #[serde(default)]
    pub runtime_dir: Option<String>,
    #[serde(default)]
    pub setup_command: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ResolveRequest {
    pub url: String,
    #[serde(default)]
    pub force_refresh: bool,
}
