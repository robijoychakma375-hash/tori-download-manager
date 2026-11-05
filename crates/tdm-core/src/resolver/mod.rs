pub mod discovery;
pub mod downloader;
pub mod extractor;
pub mod models;
pub mod orchestrator;
pub mod pipeline;
pub mod ssrf;

pub use discovery::{
    find_js_runtime, find_streamlink, find_yt_dlp, get_resolver_status, get_yt_dlp_version,
};
pub use downloader::download_managed_media;
pub use extractor::{clean_ytdlp_error, execute_yt_dlp_dump, execute_yt_dlp_playlist_dump};
pub use models::{
    DiscoveryStrategy, DownloadCapability, FilesizeType, MediaCandidate, MediaMetadata,
    PlaylistItem, PlaylistMetadata, ResolveRequest, ResolvedMediaFormat, ResolverStatus,
};
pub use orchestrator::{
    deduplicate_and_rank_formats, extract_html_media_candidates, probe_streamlink,
    DiscoveryOrchestrator, HtmlScrapedMetadata,
};
pub use pipeline::{
    extract_bitrate_kbps_from_url, normalize_platform_media_url, parse_single_format,
    parse_ytdlp_playlist_metadata, select_compatible_audio_and_container, MediaResolver,
    ParsedRawFormat,
};
pub use ssrf::validate_safe_media_url;
