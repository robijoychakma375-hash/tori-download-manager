use std::fs;
use std::process::Command;

use tdm_core::db::Database;
use tdm_core::engine::EventBus;
use tdm_core::resolver::discovery::{find_ffmpeg, find_ffprobe, find_yt_dlp};
use tdm_core::resolver::downloader::download_managed_media;
use tdm_core::resolver::extractor::clean_ytdlp_error;
use tdm_core::resolver::pipeline::select_compatible_audio_and_container;
use tdm_core::resolver::{FilesizeType, ParsedRawFormat};
use tdm_core::types::{DownloadJob, JobState, JobType, Priority};
use tdm_core::MediaResolver;
use tokio_util::sync::CancellationToken;

#[test]
fn test_gate12_5_portrait_format_labeling_unit() {
    let resolver = MediaResolver::new();

    // 1. Portrait 1080x1920 (Facebook Reel, TikTok, Shorts)
    let json_portrait = serde_json::json!({
        "id": "reel123",
        "title": "Facebook Portrait Reel",
        "extractor": "facebook",
        "formats": [
            {
                "format_id": "dash-1080p",
                "width": 1080,
                "height": 1920,
                "vcodec": "avc1.640028",
                "acodec": "none",
                "ext": "mp4",
                "protocol": "https"
            },
            {
                "format_id": "dash-audio",
                "vcodec": "none",
                "acodec": "mp4a.40.2",
                "ext": "m4a",
                "protocol": "https"
            }
        ]
    });

    let meta = resolver
        .parse_ytdlp_metadata("https://www.facebook.com/reel/123", &json_portrait)
        .expect("Should parse metadata successfully");

    assert!(!meta.formats.is_empty());
    let video_fmt = meta
        .formats
        .iter()
        .find(|f| f.has_video)
        .expect("Should find video format");

    // Must be labelled as Portrait, NOT as '1920p'
    assert_eq!(
        video_fmt.resolution_label, "1080 × 1920 · Portrait",
        "Portrait media must not be misleadingly labeled as 1920p"
    );
    assert_eq!(video_fmt.width, Some(1080));
    assert_eq!(video_fmt.height, Some(1920));
    assert!(
        video_fmt.requires_merge,
        "Video DASH should be paired with audio"
    );

    // 2. Portrait 720x1280
    let json_720p_portrait = serde_json::json!({
        "id": "reel720",
        "title": "720p Portrait Reel",
        "extractor": "facebook",
        "formats": [
            {
                "format_id": "dash-720p",
                "width": 720,
                "height": 1280,
                "vcodec": "avc1",
                "acodec": "none",
                "ext": "mp4",
                "protocol": "https"
            }
        ]
    });

    let meta_720 = resolver
        .parse_ytdlp_metadata("https://www.facebook.com/reel/720", &json_720p_portrait)
        .expect("Should parse");
    let fmt_720 = &meta_720.formats[0];
    assert_eq!(fmt_720.resolution_label, "720 × 1280 · Portrait");

    // 3. Landscape 1920x1080 (standard 1080p landscape)
    let json_landscape = serde_json::json!({
        "id": "vid1080",
        "title": "Standard Landscape Video",
        "extractor": "youtube",
        "formats": [
            {
                "format_id": "137",
                "width": 1920,
                "height": 1080,
                "vcodec": "avc1",
                "acodec": "none",
                "ext": "mp4",
                "protocol": "https"
            }
        ]
    });

    let meta_land = resolver
        .parse_ytdlp_metadata("https://www.youtube.com/watch?v=1080", &json_landscape)
        .expect("Should parse");
    let fmt_land = &meta_land.formats[0];
    assert_eq!(
        fmt_land.resolution_label, "1080p",
        "Standard landscape should remain 1080p"
    );
}

#[test]
fn test_gate12_5_facebook_dash_pairing_and_distinct_notes() {
    let raw_video = ParsedRawFormat {
        format_id: "dash-hd".to_string(),
        format_note: Some("DASH video".to_string()),
        width: Some(1080),
        height: Some(1920),
        resolution_label: "1080 × 1920 · Portrait".to_string(),
        fps: Some(30.0),
        vcodec: Some("avc1.640028".to_string()),
        acodec: None,
        container: "mp4".to_string(),
        protocol: "https".to_string(),
        bitrate_kbps: Some(2500.0),
        has_video: true,
        has_audio: false,
        filesize: Some(15_000_000),
        filesize_approx: None,
        filesize_type: FilesizeType::Exact,
        is_storyboard: false,
        audio_channels: None,
        sample_rate: None,
        direct_url: Some("https://video.xx.fbcdn.net/sample_v.mp4".to_string()),
        http_headers: None,
    };

    let raw_audio = ParsedRawFormat {
        format_id: "dash-audio".to_string(),
        format_note: Some("DASH audio".to_string()),
        width: None,
        height: None,
        resolution_label: "128k".to_string(),
        fps: None,
        vcodec: None,
        acodec: Some("mp4a.40.2".to_string()),
        container: "m4a".to_string(),
        protocol: "https".to_string(),
        bitrate_kbps: Some(128.0),
        has_video: false,
        has_audio: true,
        filesize: Some(1_000_000),
        filesize_approx: None,
        filesize_type: FilesizeType::Exact,
        is_storyboard: false,
        audio_channels: Some(2),
        sample_rate: Some(44100),
        direct_url: Some("https://video.xx.fbcdn.net/sample_a.m4a".to_string()),
        http_headers: None,
    };

    // Pairing video and audio
    let (chosen_audio, container) =
        select_compatible_audio_and_container(&raw_video, std::slice::from_ref(&raw_audio));
    assert!(chosen_audio.is_some());
    assert_eq!(chosen_audio.unwrap().format_id, "dash-audio");
    assert_eq!(container, "mp4");

    // Video without audio companion available
    let (no_audio, solo_container) = select_compatible_audio_and_container(&raw_video, &[]);
    assert!(no_audio.is_none());
    assert_eq!(solo_container, "mp4");
}

#[tokio::test]
async fn test_gate12_5_plex_drm_rejection_and_honest_reporting() {
    let resolver = MediaResolver::new();

    // 1. Direct resolve attempt on watch.plex.tv must honestly state DRM protection
    let plex_urls = [
        "https://watch.plex.tv/movie/night-of-the-living-dead",
        "https://watch.plex.tv/show/classic-tv/season/1/episode/1",
        "https://plex.tv/watch-free",
    ];

    for url in plex_urls {
        let err = resolver
            .resolve(url)
            .await
            .expect_err("Plex free movies must be rejected without circumvention");
        let msg = err.to_string();
        assert!(
            msg.contains(
                "watch.plex.tv content is DRM-protected and not licensed for offline download"
            ),
            "Error for '{}' must explicitly explain DRM restriction, got: {}",
            url,
            msg
        );
    }

    // 2. clean_ytdlp_error on Plex stderr
    let fake_plex_stderr =
        "ERROR: [generic] https://watch.plex.tv/movie/test: Unsupported URL: https://watch.plex.tv";
    let cleaned = clean_ytdlp_error(fake_plex_stderr);
    assert_eq!(
        cleaned,
        "watch.plex.tv content is DRM-protected and not licensed for offline download."
    );
}

#[test]
fn test_gate12_5_error_classification_precision() {
    // Phase 6 error classification coverage
    assert_eq!(
        clean_ytdlp_error("ERROR: HTTP Error 403: Forbidden for https://video.xx.fbcdn.net/..."),
        "Remote server denied access (HTTP 403 Forbidden)."
    );

    assert_eq!(
        clean_ytdlp_error("ERROR: The access token has expired or url signature has expired"),
        "Media URL expired. Please refresh the stream to obtain a new token."
    );

    assert_eq!(
        clean_ytdlp_error("ERROR: HTTP Error 429: Too Many Requests from host"),
        "Rate limited by the host platform (HTTP 429). Please wait before retrying."
    );

    assert_eq!(
        clean_ytdlp_error("ERROR: Unable to download webpage: Connection reset by peer"),
        "Connection interrupted. Network or remote server closed the connection."
    );

    assert_eq!(
        clean_ytdlp_error("ERROR: [facebook] 12345: Log in to continue or private content"),
        "Authentication required on the host platform. This media is restricted to logged-in users."
    );

    assert_eq!(
        clean_ytdlp_error("ERROR: This video is DRM protected and cannot be processed"),
        "This media is protected by Digital Rights Management (DRM) and cannot be downloaded."
    );

    assert_eq!(
        clean_ytdlp_error("ERROR: Requested format not available for video"),
        "Requested media format is unavailable on the host server."
    );
}

#[tokio::test]
async fn test_gate12_5_real_public_facebook_video_extraction_download_and_ffprobe() {
    if find_yt_dlp().is_none() || find_ffmpeg().is_none() || find_ffprobe().is_none() {
        eprintln!("[SKIP] yt-dlp, ffmpeg or ffprobe missing from system. Skipping live test.");
        return;
    }

    let resolver = MediaResolver::new();
    let fb_url = "https://www.facebook.com/watch/?v=10153231379946729";

    // 1. Metadata resolution
    let meta = match resolver.resolve(fb_url).await {
        Ok(m) => m,
        Err(e) => {
            eprintln!(
                "[SKIP] Facebook live resolution skipped due to network/firewall: {}",
                e
            );
            return;
        }
    };

    assert!(!meta.formats.is_empty(), "Formats list must not be empty");
    assert_eq!(meta.extractor, "facebook");

    // 2. Download execution into temp file
    let temp_dir = std::env::temp_dir();
    let test_filename = format!("tori_gate12_5_test_{}.mp4", uuid::Uuid::new_v4());
    let target_path = temp_dir.join(&test_filename);
    let temp_path = temp_dir.join(format!("{}.tdm-part", test_filename));

    let db_path = temp_dir.join(format!("tori_gate12_5_db_{}.db", uuid::Uuid::new_v4()));
    let db = Database::open(&db_path).expect("Should open temp db");
    let event_bus = EventBus::new(100);
    let cancel = CancellationToken::new();

    let job = DownloadJob {
        id: uuid::Uuid::new_v4().to_string(),
        url: fb_url.to_string(),
        resolved_url: Some("sd".to_string()),
        filename: test_filename.clone(),
        target_path: target_path.to_str().unwrap().to_string(),
        temp_path: temp_path.to_str().unwrap().to_string(),
        total_bytes: None,
        downloaded_bytes: 0,
        state: JobState::Downloading,
        job_type: JobType::ManagedMedia,
        priority: Priority::High,
        etag: None,
        last_modified: None,
        is_resumable: true,
        chunk_count: 1,
        thumbnail_url: None,
        error_message: None,
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
    };

    let dl_result = download_managed_media(&job, &db, &event_bus, &cancel).await;
    assert!(
        dl_result.is_ok(),
        "download_managed_media failed: {:?}",
        dl_result.err()
    );

    // 3. File existence and non-zero size
    assert!(
        target_path.exists(),
        "Output target file must exist on disk: {:?}",
        target_path
    );
    let meta_file = fs::metadata(&target_path).expect("Should read file metadata");
    let file_len = meta_file.len();
    assert!(
        file_len > 500_000,
        "Downloaded file must be > 500KB, got {} bytes",
        file_len
    );

    // 4. Verify stream codecs via FFprobe
    let ffprobe_bin = find_ffprobe().expect("ffprobe must be available");
    let probe_out = Command::new(&ffprobe_bin)
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,codec_name",
            "-of",
            "json",
            target_path.to_str().unwrap(),
        ])
        .output()
        .expect("FFprobe execution should succeed");

    assert!(probe_out.status.success(), "FFprobe must exit successfully");
    let probe_json: serde_json::Value =
        serde_json::from_slice(&probe_out.stdout).expect("FFprobe output must be valid JSON");

    let streams = probe_json
        .get("streams")
        .and_then(|s| s.as_array())
        .expect("Must have streams array");

    let has_video = streams
        .iter()
        .any(|s| s.get("codec_type").and_then(|c| c.as_str()) == Some("video"));
    let has_audio = streams
        .iter()
        .any(|s| s.get("codec_type").and_then(|c| c.as_str()) == Some("audio"));

    assert!(
        has_video,
        "Downloaded output file must contain video stream"
    );
    assert!(
        has_audio,
        "Downloaded output file must contain audio stream"
    );

    // Clean up
    let _ = fs::remove_file(&target_path);
    let _ = fs::remove_file(&temp_path);
    let _ = fs::remove_file(&db_path);
}
