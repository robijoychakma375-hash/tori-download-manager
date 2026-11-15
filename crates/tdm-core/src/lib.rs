pub mod dash;
pub mod db;
pub mod engine;
pub mod error;
pub mod hls;
pub mod live;
pub mod resolver;
pub mod torrent;
pub mod types;

pub use db::Database;
pub use engine::{
    apply_referer, apply_user_agent, playlist_format_ext, sanitize_and_validate_referer,
    sanitize_and_validate_user_agent, sanitize_filename, validate_playlist_open_url,
    AdaptiveConfig, AdaptiveScheduler, ConcurrencyGovernor, DownloadEvent, DownloadManager,
    EventBus, GovernorConfig, PartFileWriter, PendingPlaylistRequest, PlaylistOpenConfirmation,
    SplitPlan, DEFAULT_USER_AGENT,
};
pub use error::{EngineError, Result};
pub use live::{detect_live_protocol, LiveProtocol, LiveRecordingOptions};
pub use resolver::{
    deduplicate_and_rank_formats, extract_html_media_candidates, find_ffmpeg, find_ffprobe,
    find_streamlink, find_yt_dlp, probe_streamlink, DiscoveryOrchestrator, DiscoveryStrategy,
    DownloadCapability, FilesizeType, MediaCandidate, MediaMetadata, MediaResolver, PlaylistItem,
    PlaylistMetadata, ResolveRequest, ResolvedMediaFormat, ResolverStatus,
};
pub use types::{
    ChunkRecord, DownloadCompletionOptions, DownloadJob, DownloadProgress, DownloadStatusDetails,
    JobState, JobType, Priority,
};
