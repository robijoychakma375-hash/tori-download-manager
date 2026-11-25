pub mod cache;
pub mod discovery;
pub mod downloader;
pub mod extractor;
pub mod models;
pub mod orchestrator;
pub mod pipeline;
pub mod ssrf;

pub use cache::{
    is_cacheable, is_valid_cached_metadata, normalize_cache_key, sanitize_for_cache, CacheIdentity,
    DEFAULT_CACHE_TTL_SECS, MAX_CACHE_ENTRIES,
};

pub use discovery::{
    find_ffmpeg, find_ffprobe, find_js_runtime, find_streamlink, find_yt_dlp, get_resolver_status,
    get_yt_dlp_version,
};
pub use downloader::{
    build_format_selector, download_managed_media, escape_ytdlp_output_template, validate_format_id,
};
pub use extractor::{clean_ytdlp_error, execute_yt_dlp_dump, execute_yt_dlp_playlist_dump};
pub use models::{
    DiscoveryStrategy, DownloadCapability, FilesizeType, MediaCandidate, MediaMetadata,
    PlaylistItem, PlaylistMetadata, ResolveRequest, ResolvedMediaFormat, ResolverStatus,
};
pub use orchestrator::{
    deduplicate_and_rank_formats, extract_html_media_candidates, is_definitive_platform_error,
    probe_streamlink, redact_url_for_log, sanitize_candidate_urls, CandidateFilterReport,
    DiscoveryOrchestrator, HtmlScrapedMetadata, CANDIDATE_PROBE_TIMEOUT, CANDIDATE_SWEEP_BUDGET,
    MAX_CANDIDATE_CONCURRENCY, MAX_DISCOVERY_CANDIDATES, TOTAL_GENERIC_RESOLVE_BUDGET,
    TOTAL_PLATFORM_RESOLVE_BUDGET,
};
pub use pipeline::{
    extract_bitrate_kbps_from_url, is_known_platform_domain, normalize_platform_media_url,
    parse_single_format, parse_ytdlp_playlist_metadata, select_compatible_audio_and_container,
    MediaResolver, ParsedRawFormat,
};
pub use ssrf::{
    is_restricted_hostname, is_restricted_ip, ssrf_safe_redirect_policy, validate_http_url_syntax,
    validate_safe_media_url,
};
