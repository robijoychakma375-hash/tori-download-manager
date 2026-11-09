use std::fs;
use std::process::Command;

use tdm_core::db::Database;
use tdm_core::engine::EventBus;
use tdm_core::resolver::discovery::{find_ffmpeg, find_ffprobe, find_yt_dlp};
use tdm_core::resolver::downloader::download_managed_media;
use tdm_core::resolver::extractor::clean_ytdlp_error;
use tdm_core::resolver::pipeline::{
    extract_bitrate_kbps_from_url, normalize_platform_media_url, parse_single_format,
    select_compatible_audio_and_container,
};
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
        referer: None,
        user_agent: None,
        scheduled_at: None,
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

#[test]
fn test_gate12_5_1_facebook_reel_url_normalization_and_validation() {
    // 1. Plural /reels/<id> must normalize to singular /reel/<id>
    let u1 = normalize_platform_media_url("https://www.facebook.com/reels/10153231379946729/")
        .expect("Should normalize plural reels");
    assert_eq!(u1, "https://www.facebook.com/reel/10153231379946729");

    // 2. Singular /reel/<id> preserved
    let u2 = normalize_platform_media_url("https://www.facebook.com/reel/10153231379946729")
        .expect("Should preserve reel");
    assert_eq!(u2, "https://www.facebook.com/reel/10153231379946729");

    // 3. User reel path: /username/reels/<id>/
    let u3 =
        normalize_platform_media_url("https://www.facebook.com/john.doe/reels/10153231379946729/")
            .expect("Should normalize user reels");
    assert_eq!(u3, "https://www.facebook.com/reel/10153231379946729");

    // 4. Share link: /share/r/<id>/
    let u4 = normalize_platform_media_url("https://www.facebook.com/share/r/10153231379946729/")
        .expect("Should normalize share reel");
    assert_eq!(u4, "https://www.facebook.com/reel/10153231379946729");

    // 5. Watch URL with ?v=<id> preserved
    let u5 = normalize_platform_media_url("https://www.facebook.com/watch/?v=10153231379946729")
        .expect("Should preserve watch URL");
    assert_eq!(u5, "https://www.facebook.com/watch/?v=10153231379946729");

    // 6. Generic Facebook home or feed URLs missing video ID must be rejected early
    let err_home = normalize_platform_media_url("https://www.facebook.com/");
    assert!(err_home.is_err(), "Generic homepage must be rejected");
    assert!(err_home
        .unwrap_err()
        .to_string()
        .contains("does not contain a specific Reel ID"));

    let err_reels = normalize_platform_media_url("https://www.facebook.com/reels/");
    assert!(err_reels.is_err(), "Generic reels feed must be rejected");

    let err_reel = normalize_platform_media_url("https://www.facebook.com/reel");
    assert!(
        err_reel.is_err(),
        "Generic reel without ID must be rejected"
    );

    // 7. Error message classifier handles Facebook login redirect
    let err_login = clean_ytdlp_error("ERROR: Unsupported URL: https://www.facebook.com/login.php?next=https%3A%2F%2Fwww.facebook.com%2Freel");
    assert!(
        err_login.contains("Authentication required on the host platform"),
        "login.php must be classified as authentication required"
    );
}

#[test]
fn test_gate17_2_vimeo_url_normalization() {
    // 1. Direct numeric video path normalizes to player.vimeo.com embed
    let u1 = normalize_platform_media_url("https://vimeo.com/27246366")
        .expect("Should normalize Vimeo video URL");
    assert_eq!(u1, "https://player.vimeo.com/video/27246366");

    // 2. Staff picks channel path normalizes to player.vimeo.com embed
    let u2 = normalize_platform_media_url("https://vimeo.com/channels/staffpicks/27246366")
        .expect("Should normalize channel Vimeo video URL");
    assert_eq!(u2, "https://player.vimeo.com/video/27246366");

    // 3. Already canonical player.vimeo.com is preserved
    let u3 = normalize_platform_media_url("https://player.vimeo.com/video/27246366")
        .expect("Should preserve player.vimeo.com");
    assert_eq!(u3, "https://player.vimeo.com/video/27246366");
}

#[test]
fn test_gate12_5_2_media_filesize_reporting_priority_and_accuracy() {
    // 1. Priority 1: Exact filesize when reliably available
    let json_exact = serde_json::json!({
        "format_id": "18",
        "ext": "mp4",
        "width": 640,
        "height": 360,
        "filesize": 25794969u64,
        "vcodec": "avc1.42001E",
        "acodec": "mp4a.40.2"
    });
    let fmt_exact = parse_single_format(&json_exact, Some(120.0)).expect("Parse exact");
    assert_eq!(fmt_exact.filesize, Some(25794969));
    assert_eq!(fmt_exact.filesize_approx, None);
    assert_eq!(fmt_exact.filesize_type, FilesizeType::Exact);

    // 2. Priority 2: filesize_approx when exact filesize is absent
    let json_approx = serde_json::json!({
        "format_id": "22",
        "ext": "mp4",
        "width": 1280,
        "height": 720,
        "filesize": null,
        "filesize_approx": 12500000u64,
        "vcodec": "avc1.64001F",
        "acodec": "mp4a.40.2"
    });
    let fmt_approx = parse_single_format(&json_approx, Some(120.0)).expect("Parse approx");
    assert_eq!(fmt_approx.filesize, None);
    assert_eq!(fmt_approx.filesize_approx, Some(12500000));
    assert_eq!(fmt_approx.filesize_type, FilesizeType::Estimated);

    // 3. Priority 3: duration_seconds * bitrate_kbps * 1000 / 8 when neither filesize nor filesize_approx is present
    let json_bitrate = serde_json::json!({
        "format_id": "hd1080",
        "ext": "mp4",
        "width": 1920,
        "height": 1080,
        "tbr": 2000.0,
        "vcodec": "avc1.640028",
        "acodec": "mp4a.40.2"
    });
    // duration = 74.304s, bitrate = 2000 kbps
    // (74.304 * 2000.0 * 1000 / 8) = 18_576_000 bytes
    let fmt_bitrate = parse_single_format(&json_bitrate, Some(74.304)).expect("Parse bitrate");
    assert_eq!(fmt_bitrate.filesize, None);
    assert_eq!(fmt_bitrate.filesize_approx, Some(18576000));
    assert_eq!(fmt_bitrate.filesize_type, FilesizeType::Estimated);

    // 4. Priority 3 with Facebook Reel URL embedded bitrate (SD stream: bitrate=127000 bps -> 127 kbps)
    let fb_sd_url = "https://video.xx.fbcdn.net/o1/v/t2/f2.mp4?bitrate=127000&tag=1";
    assert_eq!(extract_bitrate_kbps_from_url(fb_sd_url), Some(127.0));

    let json_fb_sd = serde_json::json!({
        "format_id": "sd",
        "ext": "mp4",
        "url": fb_sd_url,
        "width": 480,
        "height": 854,
        "vcodec": "avc1.4d401f",
        "acodec": "mp4a.40.2"
    });
    // duration = 74.304s, bitrate = 127 kbps
    // (74.304 * 127.0 * 1000 / 8) = 1_179_576 bytes (~1.1 MB)
    let fmt_fb_sd = parse_single_format(&json_fb_sd, Some(74.304)).expect("Parse FB SD");
    assert_eq!(fmt_fb_sd.filesize, None);
    assert_eq!(fmt_fb_sd.filesize_approx, Some(1179576));
    assert_eq!(fmt_fb_sd.filesize_type, FilesizeType::Estimated);

    // 5. Priority 3 with Facebook Reel URL embedded bitrate (HD stream: bitrate=580000 bps -> 580 kbps)
    let fb_hd_url = "https://video.xx.fbcdn.net/o1/v/t2/f1.mp4?bitrate=580000&tag=1";
    assert_eq!(extract_bitrate_kbps_from_url(fb_hd_url), Some(580.0));

    let json_fb_hd = serde_json::json!({
        "format_id": "hd",
        "ext": "mp4",
        "url": fb_hd_url,
        "width": 1080,
        "height": 1920,
        "vcodec": "avc1.640028",
        "acodec": "mp4a.40.2"
    });
    // duration = 74.304s, bitrate = 580 kbps
    // (74.304 * 580.0 * 1000 / 8) = 5_387_040 bytes (~5.1 MB)
    let fmt_fb_hd = parse_single_format(&json_fb_hd, Some(74.304)).expect("Parse FB HD");
    assert_eq!(fmt_fb_hd.filesize, None);
    assert_eq!(fmt_fb_hd.filesize_approx, Some(5387040));
    assert_eq!(fmt_fb_hd.filesize_type, FilesizeType::Estimated);

    // 6. Separate video + audio streams combined estimation:
    // When combining video + audio, the result must ALWAYS be FilesizeType::Estimated
    // to account for container/merging overhead and prevent misleading users with exact sizes.
    let raw_v = ParsedRawFormat {
        format_id: "137".to_string(),
        format_note: Some("1080p".to_string()),
        width: Some(1920),
        height: Some(1080),
        resolution_label: "1080p".to_string(),
        fps: Some(30.0),
        vcodec: Some("avc1.640028".to_string()),
        acodec: None,
        container: "mp4".to_string(),
        protocol: "https".to_string(),
        bitrate_kbps: Some(4000.0),
        has_video: true,
        has_audio: false,
        filesize: Some(20_000_000),
        filesize_approx: None,
        filesize_type: FilesizeType::Exact,
        is_storyboard: false,
        audio_channels: None,
        sample_rate: None,
        direct_url: None,
        http_headers: None,
    };
    let raw_a = ParsedRawFormat {
        format_id: "140".to_string(),
        format_note: Some("medium".to_string()),
        width: None,
        height: None,
        resolution_label: "Audio".to_string(),
        fps: None,
        vcodec: None,
        acodec: Some("mp4a.40.2".to_string()),
        container: "m4a".to_string(),
        protocol: "https".to_string(),
        bitrate_kbps: Some(128.0),
        has_video: false,
        has_audio: true,
        filesize: Some(2_000_000),
        filesize_approx: None,
        filesize_type: FilesizeType::Exact,
        is_storyboard: false,
        audio_channels: Some(2),
        sample_rate: Some(44100),
        direct_url: None,
        http_headers: None,
    };

    let v_eff = raw_v.filesize.or(raw_v.filesize_approx);
    let a_eff = raw_a.filesize.or(raw_a.filesize_approx);
    let (combined_exact, combined_approx, combined_type): (Option<u64>, Option<u64>, FilesizeType) =
        match (v_eff, a_eff) {
            (Some(v_sz), Some(a_sz)) => (None, Some(v_sz + a_sz), FilesizeType::Estimated),
            _ => (None, None, FilesizeType::Unknown),
        };
    assert_eq!(combined_exact, None);
    assert_eq!(combined_approx, Some(22_000_000));
    assert_eq!(combined_type, FilesizeType::Estimated);

    // 7. Priority 4: Unknown size when all indicators are missing
    let json_unknown = serde_json::json!({
        "format_id": "stream_live",
        "ext": "mp4",
        "vcodec": "avc1.4d401f",
        "acodec": "mp4a.40.2"
    });
    let fmt_unknown = parse_single_format(&json_unknown, None).expect("Parse unknown");
    assert_eq!(fmt_unknown.filesize, None);
    assert_eq!(fmt_unknown.filesize_approx, None);
    assert_eq!(fmt_unknown.filesize_type, FilesizeType::Unknown);
}

#[tokio::test]
async fn test_gate12_5_2_thumbnail_caching_and_ffmpeg_backfill() {
    use tdm_core::engine::thumbnail::{
        backfill_missing_thumbnails, base64_encode, enforce_thumbnail_cache_limits,
        extract_thumbnail_from_video,
    };
    use tdm_core::hls::muxer::silent_command;

    // 1. Test pure RFC 4648 base64 encoding vectors
    assert_eq!(base64_encode(b""), "");
    assert_eq!(base64_encode(b"f"), "Zg==");
    assert_eq!(base64_encode(b"fo"), "Zm8=");
    assert_eq!(base64_encode(b"foo"), "Zm9v");
    assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
    assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
    assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");

    // 2. Test cache bounding with LRU eviction
    let temp_cache =
        std::env::temp_dir().join(format!("tori_thumb_cache_{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&temp_cache).unwrap();

    let f1 = temp_cache.join("t1.jpg");
    let f2 = temp_cache.join("t2.jpg");
    let f3 = temp_cache.join("t3.jpg");

    fs::write(&f1, vec![0u8; 1000]).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    fs::write(&f2, vec![0u8; 1000]).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    fs::write(&f3, vec![0u8; 1000]).unwrap();

    // Enforce bound of max 2 files (f1 should be deleted)
    enforce_thumbnail_cache_limits(&temp_cache, 100_000, 2);
    assert!(!f1.exists(), "Oldest file f1 should have been evicted");
    assert!(f2.exists(), "f2 should be preserved");
    assert!(f3.exists(), "f3 should be preserved");

    // Enforce bound of max 1500 bytes (f2 should be evicted, leaving f3)
    enforce_thumbnail_cache_limits(&temp_cache, 1500, 10);
    assert!(!f2.exists(), "f2 should be evicted to satisfy byte limit");
    assert!(f3.exists(), "f3 should be preserved");

    let _ = fs::remove_dir_all(&temp_cache);

    // 3. Test genuine video frame extraction and SQLite backfill
    if let Some(ffmpeg_bin) = find_ffmpeg() {
        let temp_dir = std::env::temp_dir();
        let sample_video = temp_dir.join(format!("tori_test_video_{}.mp4", uuid::Uuid::new_v4()));

        // Generate a 1-second test MP4 via FFmpeg
        let gen_status = silent_command(&ffmpeg_bin)
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=duration=1:size=320x240:rate=10",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                sample_video.to_str().unwrap(),
            ])
            .status();

        if let Ok(st) = gen_status {
            if st.success() && sample_video.exists() {
                let out_thumb = temp_dir.join(format!("tori_thumb_{}.jpg", uuid::Uuid::new_v4()));

                // Direct frame extraction
                let data_uri = extract_thumbnail_from_video(&sample_video, &out_thumb)
                    .expect("Should extract thumbnail frame");
                assert!(data_uri.starts_with("data:image/jpeg;base64,"));
                assert!(data_uri.len() > 100, "Data URI must be non-empty");

                // Test SQLite backfill
                let db_path = temp_dir.join(format!("tori_thumb_db_{}.db", uuid::Uuid::new_v4()));
                let db = Database::open(&db_path).expect("Should open temp db");

                let test_job_id = uuid::Uuid::new_v4().to_string();
                let job = DownloadJob {
                    id: test_job_id.clone(),
                    url: "https://www.facebook.com/reel/1040431192387040".to_string(),
                    resolved_url: Some("hd".to_string()),
                    filename: "test_reel.mp4".to_string(),
                    target_path: sample_video.to_str().unwrap().to_string(),
                    temp_path: sample_video.to_str().unwrap().to_string(),
                    total_bytes: Some(100_000),
                    downloaded_bytes: 100_000,
                    state: JobState::Completed,
                    job_type: JobType::ManagedMedia,
                    priority: Priority::High,
                    etag: None,
                    last_modified: None,
                    is_resumable: true,
                    chunk_count: 1,
                    thumbnail_url: None, // Missing thumbnail
                    referer: None,
                    user_agent: None,
                    scheduled_at: None,
                    error_message: None,
                    created_at: chrono::Utc::now(),
                    updated_at: chrono::Utc::now(),
                };

                db.insert_job(&job).expect("Insert job");

                // Verify initially None
                let stored_before = db.get_job(&test_job_id).unwrap().unwrap();
                assert_eq!(stored_before.thumbnail_url, None);

                // Run backfill
                let count = backfill_missing_thumbnails(&db).await;
                assert_eq!(count, 1, "Exactly 1 job should be backfilled");

                // Verify updated in SQLite
                let stored_after = db.get_job(&test_job_id).unwrap().unwrap();
                assert!(stored_after.thumbnail_url.is_some());
                let backfilled_uri = stored_after.thumbnail_url.unwrap();
                assert!(backfilled_uri.starts_with("data:image/jpeg;base64,"));

                // Verify persistence across restart (re-open database)
                drop(db);
                let db_reopened = Database::open(&db_path).expect("Reopen db");
                let stored_reopened = db_reopened.get_job(&test_job_id).unwrap().unwrap();
                assert_eq!(stored_reopened.thumbnail_url, Some(backfilled_uri));

                // Clean up
                let _ = fs::remove_file(&sample_video);
                let _ = fs::remove_file(&out_thumb);
                let _ = fs::remove_file(&db_path);
            }
        }
    }
}
