//! Gate 33.3 Phase 14 — Deterministic Local Media Resolver, Format Parser, Cache & Discovery Suite
//!
//! Strictly separates deterministic local/core media resolution & protocol correctness tests
//! from externally rate-limited live YouTube network tests. Runs 100% locally with zero
//! external internet dependency and zero exposure to YouTube anti-bot challenges.

use std::sync::OnceLock;
use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, MutexGuard};

static LOOPBACK_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

struct LoopbackEnvGuard {
    _lock: MutexGuard<'static, ()>,
    previous: Option<String>,
}

impl LoopbackEnvGuard {
    async fn set(value: Option<&str>) -> Self {
        let lock = LOOPBACK_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().await;
        let previous = std::env::var("TORI_ALLOW_LOOPBACK").ok();
        match value {
            Some(v) => std::env::set_var("TORI_ALLOW_LOOPBACK", v),
            None => std::env::remove_var("TORI_ALLOW_LOOPBACK"),
        }
        Self {
            _lock: lock,
            previous,
        }
    }
}

impl Drop for LoopbackEnvGuard {
    fn drop(&mut self) {
        match &self.previous {
            Some(v) => std::env::set_var("TORI_ALLOW_LOOPBACK", v),
            None => std::env::remove_var("TORI_ALLOW_LOOPBACK"),
        }
    }
}

use tdm_core::resolver::{
    build_format_selector, clean_ytdlp_error, deduplicate_and_rank_formats,
    extract_bitrate_kbps_from_url, extract_html_media_candidates, is_definitive_platform_error,
    is_known_platform_domain, is_valid_cached_metadata, normalize_cache_key,
    normalize_platform_media_url, parse_single_format, parse_ytdlp_playlist_metadata,
    redact_url_for_log, sanitize_candidate_urls, select_compatible_audio_and_container,
    validate_safe_media_url, DEFAULT_CACHE_TTL_SECS, MAX_DISCOVERY_CANDIDATES,
};
use tdm_core::{
    Database, DownloadCapability, FilesizeType, MediaMetadata, MediaResolver, ResolveRequest,
    ResolvedMediaFormat,
};

#[test]
fn test_deterministic_platform_classification_and_url_normalization() {
    assert!(is_known_platform_domain(
        "https://www.youtube.com/watch?v=jNQXAC9IVRw"
    ));
    assert!(is_known_platform_domain("https://youtu.be/jNQXAC9IVRw"));
    assert!(is_known_platform_domain(
        "https://www.instagram.com/reel/ABC123/"
    ));
    assert!(is_known_platform_domain("https://vimeo.com/123456789"));
    assert!(!is_known_platform_domain("https://example.org/video.mp4"));

    let norm = normalize_platform_media_url("https://www.youtube.com/watch?v=jNQXAC9IVRw&feature=share")
        .expect("normalize youtube URL");
    assert!(norm.contains("jNQXAC9IVRw"));

    let k1 = normalize_cache_key("https://www.youtube.com/watch?v=jNQXAC9IVRw&t=12")
        .expect("cache identity 1");
    let k2 = normalize_cache_key("https://www.youtube.com/watch?v=jNQXAC9IVRw")
        .expect("cache identity 2");
    assert_eq!(k1.cache_key, k2.cache_key);

    let redacted = redact_url_for_log("https://cdn.example.com/v.mp4?token=secret_abc123&sig=xyz");
    assert!(!redacted.contains("secret_abc123"));
    assert!(!redacted.contains("sig=xyz"));
}

#[test]
fn test_deterministic_format_parsing_ranking_selector_and_playlist_fixture() {
    let raw_formats = vec![
        serde_json::json!({
            "format_id": "248",
            "ext": "webm",
            "vcodec": "vp9",
            "acodec": "none",
            "height": 1080,
            "width": 1920,
            "fps": 30.0,
            "tbr": 2200.0,
            "filesize": 18500000
        }),
        serde_json::json!({
            "format_id": "137",
            "ext": "mp4",
            "vcodec": "avc1.640028",
            "acodec": "none",
            "height": 1080,
            "width": 1920,
            "fps": 30.0,
            "tbr": 2500.0,
            "filesize": 20100000
        }),
        serde_json::json!({
            "format_id": "136",
            "ext": "mp4",
            "vcodec": "avc1.4d401f",
            "acodec": "none",
            "height": 720,
            "width": 1280,
            "fps": 30.0,
            "tbr": 1100.0,
            "filesize": 9400000
        }),
        serde_json::json!({
            "format_id": "140",
            "ext": "m4a",
            "vcodec": "none",
            "acodec": "mp4a.40.2",
            "abr": 128.0,
            "filesize": 1200000
        }),
        serde_json::json!({
            "format_id": "251",
            "ext": "webm",
            "vcodec": "none",
            "acodec": "opus",
            "abr": 160.0,
            "filesize": 1400000
        }),
    ];

    let parsed: Vec<_> = raw_formats
        .iter()
        .filter_map(|v| parse_single_format(v, Some(120.0)))
        .collect();
    assert_eq!(parsed.len(), 5);

    let video_1080 = parsed.iter().find(|p| p.format_id == "137").unwrap();
    let audios: Vec<_> = parsed
        .iter()
        .filter(|p| !p.has_video && p.has_audio)
        .cloned()
        .collect();
    let (chosen_audio, container) = select_compatible_audio_and_container(video_1080, &audios);
    assert!(chosen_audio.is_some());
    assert!(!container.is_empty());

    let sel = build_format_selector("format:137+140").expect("format selector");
    assert!(sel.contains("137"));
    assert!(build_format_selector("auto").is_none());

    assert_eq!(
        extract_bitrate_kbps_from_url("https://cdn.example.com/hls/index.m3u8?bitrate=2500000"),
        Some(2500.0)
    );
    assert_eq!(
        extract_bitrate_kbps_from_url("https://cdn.example.com/hls/index.m3u8?bitrate=1200"),
        Some(1200.0)
    );

    // Deterministic recorded playlist JSON fixture
    let playlist_json = serde_json::json!({
        "_type": "playlist",
        "id": "PL_DETERMINISTIC_001",
        "title": "TORI Deterministic Fixture Playlist",
        "uploader": "TORI QA",
        "entries": [
            { "id": "vid001", "title": "Clip One", "url": "https://www.youtube.com/watch?v=vid001", "duration": 42.0 },
            { "id": "vid002", "title": "Clip Two", "url": "https://www.youtube.com/watch?v=vid002", "duration": 95.0 }
        ]
    });
    let pl = parse_ytdlp_playlist_metadata(
        "https://www.youtube.com/playlist?list=PL_DETERMINISTIC_001",
        &playlist_json,
    )
    .expect("parse deterministic playlist fixture");
    assert_eq!(pl.items.len(), 2);
    assert_eq!(pl.title, "TORI Deterministic Fixture Playlist");

    // Definitive error & YouTube anti-bot message cleaning
    let bot_err =
        "[youtube] aqz-KE-bpKQ: Sign in to confirm you're not a bot. Use --cookies-from-browser";
    assert!(is_definitive_platform_error(bot_err));
    let cleaned = clean_ytdlp_error(bot_err);
    assert!(!cleaned.is_empty());

    // Format deduplication and ranking
    let mk_fmt = |id: &str, h: Option<u32>, url: &str| ResolvedMediaFormat {
        format_id: id.to_string(),
        format_note: None,
        width: h.map(|v| (v * 16) / 9),
        height: h,
        resolution_label: h.map(|v| format!("{}p", v)).unwrap_or_else(|| "Audio".to_string()),
        fps: Some(30.0),
        vcodec: h.map(|_| "h264".to_string()),
        acodec: Some("aac".to_string()),
        container: "mp4".to_string(),
        protocol: "https".to_string(),
        bitrate_kbps: h.map(|v| v as f64 * 2.0),
        has_video: h.is_some(),
        has_audio: true,
        filesize: Some(4_000_000),
        filesize_approx: None,
        filesize_type: FilesizeType::Exact,
        requires_merge: false,
        merge_audio_format_id: None,
        audio_channels: Some(2),
        sample_rate: Some(48000),
        download_capability: DownloadCapability::NativeHttp,
        unavailable_reason: None,
        direct_stream_url: Some(url.to_string()),
        http_headers: None,
    };
    let ranked = deduplicate_and_rank_formats(vec![
        mk_fmt("360", Some(360), "https://cdn.example.org/360.mp4"),
        mk_fmt("1080a", Some(1080), "https://cdn.example.org/1080.mp4"),
        mk_fmt("1080dup", Some(1080), "https://cdn.example.org/1080.mp4"),
    ]);
    assert_eq!(ranked.len(), 2);
    assert_eq!(ranked[0].height, Some(1080));
}

#[tokio::test]
async fn test_deterministic_ssrf_candidate_sanitization_and_html_scraping() {
    let _guard = LoopbackEnvGuard::set(None).await;
    assert!(validate_safe_media_url("http://169.254.169.254/latest/meta-data/")
        .await
        .is_err());
    assert!(validate_safe_media_url("http://10.0.0.1/internal.mp4")
        .await
        .is_err());
    assert!(validate_safe_media_url("file:///C:/Windows/System32/cmd.exe")
        .await
        .is_err());

    let noisy = vec![
        "https://cdn.example.org/frag-001.m4s".to_string(),
        "https://cdn.example.org/master.m3u8".to_string(),
        "https://cdn.example.org/master.m3u8".to_string(),
        "javascript:void(0)".to_string(),
        "https://cdn.example.org/video.mp4".to_string(),
    ];
    let report = sanitize_candidate_urls(
        &noisy,
        "https://example.org/watch",
        MAX_DISCOVERY_CANDIDATES,
        true,
    );
    assert!(report.kept.iter().any(|u| u.ends_with("master.m3u8")));
    assert!(report.kept.iter().any(|u| u.ends_with("video.mp4")));
    assert!(report.dropped_duplicate >= 1);
    assert!(report.dropped_non_url >= 1);
    assert!(report.dropped_segment_or_embed >= 1);

    let html = r#"<html><head><title>Sample Fixture</title></head><body>
      <video src="https://cdn.example.org/sample.mp4"></video>
      <source src="https://cdn.example.org/manifest.m3u8" type="application/vnd.apple.mpegurl">
    </body></html>"#;
    let scraped = extract_html_media_candidates(html, "https://example.org/watch");
    assert!(scraped.media_urls.iter().any(|u| u.contains("sample.mp4")));
    assert!(scraped.media_urls.iter().any(|u| u.contains("manifest.m3u8")));
}

#[tokio::test]
async fn test_deterministic_local_loopback_hls_mp4_discovery_and_sqlite_cache() {
    let _guard = LoopbackEnvGuard::set(Some("1")).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let hls_body = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720\n720p.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360\n360p.m3u8\n";
    let page_html = format!(
        "<!doctype html><html><head><title>Local Fixture</title></head><body><video src=\"http://127.0.0.1:{}/video.mp4\"></video></body></html>",
        port
    );

    let srv = tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = listener.accept().await else {
                break;
            };
            let html = page_html.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                let n = s.read(&mut buf).await.unwrap_or(0);
                if n == 0 {
                    return;
                }
                let line = String::from_utf8_lossy(&buf[..n]);
                let p = line.split_whitespace().nth(1).unwrap_or("/");
                let (ct, body): (&str, Vec<u8>) = if p == "/master.m3u8" {
                    ("application/vnd.apple.mpegurl", hls_body.as_bytes().to_vec())
                } else if p == "/video.mp4" {
                    ("video/mp4", vec![0u8; 4096])
                } else {
                    ("text/html; charset=utf-8", html.into_bytes())
                };
                let hdr = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    ct,
                    body.len()
                );
                let _ = s.write_all(hdr.as_bytes()).await;
                let _ = s.write_all(&body).await;
            });
        }
    });

    let tmp = tempdir().unwrap();
    let db = Database::open(&tmp.path().join("det_resolver.sqlite")).unwrap();
    let resolver = MediaResolver::new().with_database(db.clone());

    let req = ResolveRequest {
        url: format!("http://127.0.0.1:{}/watch", port),
        force_refresh: true,
        candidates: vec![format!("http://127.0.0.1:{}/master.m3u8", port)],
        page_title: Some("Local Fixture".to_string()),
        thumbnail_url: None,
    };
    let meta = resolver
        .resolve_with_request(&req)
        .await
        .expect("Local deterministic HLS + MP4 discovery must succeed");
    assert!(!meta.formats.is_empty());
    assert!(!meta.title.trim().is_empty());
    // Direct HLS/MP4 probes intentionally set is_direct_media=true and bypass platform cache
    assert!(!is_valid_cached_metadata(&meta) || !meta.is_direct_media);

    // Verify SQLite cache persistence & retrieval without hitting external network
    let cached = MediaMetadata {
        source_url: "https://www.youtube.com/watch?v=detFixture01".to_string(),
        webpage_url: "https://www.youtube.com/watch?v=detFixture01".to_string(),
        site_name: "YouTube".to_string(),
        title: "Cached Deterministic Video".to_string(),
        media_id: "detFixture01".to_string(),
        duration_seconds: Some(60.0),
        thumbnail_url: None,
        extractor: "youtube".to_string(),
        formats: vec![ResolvedMediaFormat {
            format_id: "mp4_720".to_string(),
            format_note: Some("720p".to_string()),
            width: Some(1280),
            height: Some(720),
            resolution_label: "720p".to_string(),
            fps: Some(30.0),
            vcodec: Some("h264".to_string()),
            acodec: Some("aac".to_string()),
            container: "mp4".to_string(),
            protocol: "https".to_string(),
            bitrate_kbps: Some(1500.0),
            has_video: true,
            has_audio: true,
            filesize: Some(5_000_000),
            filesize_approx: None,
            filesize_type: FilesizeType::Exact,
            requires_merge: false,
            merge_audio_format_id: None,
            audio_channels: Some(2),
            sample_rate: Some(48000),
            download_capability: DownloadCapability::NativeHttp,
            unavailable_reason: None,
            direct_stream_url: Some("https://cdn.example.org/v.mp4".to_string()),
            http_headers: None,
        }],
        is_direct_media: false,
        is_cached: Some(false),
    };
    assert!(is_valid_cached_metadata(&cached));
    let cid = normalize_cache_key(&cached.webpage_url).expect("cache identity");
    db.set_format_cache(
        &cid.cache_key,
        &cid.platform,
        &cid.video_id,
        &cid.canonical_url,
        &cached,
        DEFAULT_CACHE_TTL_SECS,
    )
    .expect("store cache");
    let got = db
        .get_format_cache(&cid.cache_key)
        .expect("query cache")
        .expect("cache hit required");
    assert!(is_valid_cached_metadata(&got));
    assert_eq!(got.title, "Cached Deterministic Video");
    assert_eq!(got.formats.len(), 1);

    srv.abort();
}
