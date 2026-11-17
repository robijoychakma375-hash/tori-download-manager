use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use tdm_core::resolver::{
    is_definitive_platform_error, is_known_platform_domain, is_valid_cached_metadata,
    normalize_cache_key, redact_url_for_log, sanitize_candidate_urls, validate_safe_media_url,
    DEFAULT_CACHE_TTL_SECS, MAX_DISCOVERY_CANDIDATES,
};
use tdm_core::{
    Database, DiscoveryOrchestrator, DownloadCapability, FilesizeType, MediaMetadata, MediaResolver,
    ResolveRequest, ResolvedMediaFormat,
};

fn env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

struct LoopbackEnvGuard {
    prev: Option<String>,
    _guard: tokio::sync::MutexGuard<'static, ()>,
}

impl LoopbackEnvGuard {
    async fn set(allow: bool) -> Self {
        let _guard = env_lock().lock().await;
        let prev = std::env::var("TORI_ALLOW_LOOPBACK").ok();
        if allow {
            std::env::set_var("TORI_ALLOW_LOOPBACK", "1");
        } else {
            std::env::remove_var("TORI_ALLOW_LOOPBACK");
        }
        Self { prev, _guard }
    }
}

impl Drop for LoopbackEnvGuard {
    fn drop(&mut self) {
        if let Some(ref val) = self.prev {
            std::env::set_var("TORI_ALLOW_LOOPBACK", val);
        } else {
            std::env::remove_var("TORI_ALLOW_LOOPBACK");
        }
    }
}

#[derive(Clone)]
enum RouteBehavior {
    OkMedia {
        content_type: String,
        body: Vec<u8>,
    },
    OkHtml(String),
    Slow {
        delay: Duration,
    },
    Status(u16, String),
}

async fn spawn_mock_http_server(
    routes: Vec<(String, RouteBehavior)>,
) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let hits = Arc::new(AtomicUsize::new(0));
    let hits_clone = hits.clone();
    let routes = Arc::new(routes);

    let handle = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let hits_req = hits_clone.clone();
            let routes_req = routes.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                if n == 0 {
                    return;
                }
                hits_req.fetch_add(1, Ordering::SeqCst);

                let req_str = String::from_utf8_lossy(&buf[..n]);
                let first_line = req_str.lines().next().unwrap_or("");
                let mut parts = first_line.split_whitespace();
                let method = parts.next().unwrap_or("GET");
                let path = parts.next().unwrap_or("/");

                let behavior = routes_req
                    .iter()
                    .find(|(prefix, _)| path == prefix || path.starts_with(prefix))
                    .map(|(_, b)| b.clone())
                    .unwrap_or(RouteBehavior::Status(404, "text/plain".to_string()));

                match behavior {
                    RouteBehavior::Slow { delay } => {
                        tokio::time::sleep(delay).await;
                        let resp = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                        let _ = stream.write_all(resp.as_bytes()).await;
                    }
                    RouteBehavior::Status(code, ctype) => {
                        let resp = format!(
                            "HTTP/1.1 {} Error\r\nContent-Type: {}\r\nContent-Length: 5\r\nConnection: close\r\n\r\nerror",
                            code, ctype
                        );
                        let _ = stream.write_all(resp.as_bytes()).await;
                    }
                    RouteBehavior::OkHtml(html) => {
                        let headers = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            html.len()
                        );
                        let _ = stream.write_all(headers.as_bytes()).await;
                        if method != "HEAD" {
                            let _ = stream.write_all(html.as_bytes()).await;
                        }
                    }
                    RouteBehavior::OkMedia { content_type, body } => {
                        let headers = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                            content_type,
                            body.len()
                        );
                        let _ = stream.write_all(headers.as_bytes()).await;
                        if method != "HEAD" {
                            let _ = stream.write_all(&body).await;
                        }
                    }
                }
            });
        }
    });

    (format!("http://127.0.0.1:{}", addr.port()), hits, handle)
}

fn sample_youtube_metadata(url: &str, video_id: &str) -> MediaMetadata {
    MediaMetadata {
        source_url: url.to_string(),
        webpage_url: url.to_string(),
        site_name: "Youtube".to_string(),
        title: "Sample YouTube Fixture Video".to_string(),
        media_id: video_id.to_string(),
        duration_seconds: Some(42.0),
        thumbnail_url: Some("https://i.ytimg.com/vi/u9lj-c29dxI/hqdefault.jpg".to_string()),
        extractor: "youtube".to_string(),
        formats: vec![
            ResolvedMediaFormat {
                format_id: "137".to_string(),
                format_note: Some("1080p".to_string()),
                width: Some(1920),
                height: Some(1080),
                resolution_label: "1080p".to_string(),
                fps: Some(30.0),
                vcodec: Some("avc1".to_string()),
                acodec: Some("mp4a".to_string()),
                container: "mp4".to_string(),
                protocol: "https".to_string(),
                bitrate_kbps: Some(4200.0),
                has_video: true,
                has_audio: false,
                filesize: Some(12_345_678),
                filesize_approx: None,
                filesize_type: FilesizeType::Exact,
                requires_merge: true,
                merge_audio_format_id: Some("140".to_string()),
                audio_channels: None,
                sample_rate: None,
                download_capability: DownloadCapability::ManagedExtractor,
                unavailable_reason: None,
                direct_stream_url: None,
                http_headers: None,
            },
            ResolvedMediaFormat {
                format_id: "18".to_string(),
                format_note: Some("360p".to_string()),
                width: Some(640),
                height: Some(360),
                resolution_label: "360p".to_string(),
                fps: Some(30.0),
                vcodec: Some("avc1".to_string()),
                acodec: Some("mp4a".to_string()),
                container: "mp4".to_string(),
                protocol: "https".to_string(),
                bitrate_kbps: Some(600.0),
                has_video: true,
                has_audio: true,
                filesize: Some(3_000_000),
                filesize_approx: None,
                filesize_type: FilesizeType::Exact,
                requires_merge: false,
                merge_audio_format_id: None,
                audio_channels: Some(2),
                sample_rate: Some(44100),
                download_capability: DownloadCapability::NativeHttp,
                unavailable_reason: None,
                direct_stream_url: Some("https://example.com/prog360.mp4".to_string()),
                http_headers: None,
            },
        ],
        is_direct_media: false,
        is_cached: Some(false),
    }
}

#[tokio::test]
async fn test_01_youtube_with_noisy_embed_and_segment_candidates_succeeds_fast() {
    let _env = LoopbackEnvGuard::set(true).await;

    // Trap slow HTTP server simulating hanging CDN/media candidates (would sleep 15s each if touched)
    let (base_url, hits, handle) = spawn_mock_http_server(vec![(
        "/slow.mp4".to_string(),
        RouteBehavior::Slow {
            delay: Duration::from_secs(15),
        },
    )])
    .await;

    let resolver = MediaResolver::new();
    let orchestrator = DiscoveryOrchestrator::new();

    let req = ResolveRequest {
        url: "https://www.youtube.com/watch?v=u9lj-c29dxI&list=PL6B3937A5D230E335".to_string(),
        force_refresh: true,
        candidates: vec![
            "https://www.youtube.com/embed/u9lj-c29dxI?list=PL6B3937A5D230E335".to_string(),
            format!("{}/slow.mp4", base_url),
            "https://rr1---sn-test.googlevideo.com/videoplayback?expire=999999&range=0-1000".to_string(),
            "text/html".to_string(),
            "1280".to_string(),
            "720".to_string(),
        ],
        page_title: Some("YouTube Test Playlist Item".to_string()),
        thumbnail_url: None,
    };

    let t0 = Instant::now();
    let meta = orchestrator
        .resolve_multi_strategy(&resolver, &req)
        .await
        .expect("Cold YouTube watch URL with noisy candidates must resolve within budget");
    let elapsed = t0.elapsed();
    handle.abort();

    assert_eq!(meta.extractor, "youtube");
    assert!(!meta.formats.is_empty());
    assert!(
        elapsed < Duration::from_secs(26),
        "Live YouTube resolve took {:?}, exceeding 26s budget (32s Firefox timeout margin)",
        elapsed
    );
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "Slow/noisy candidate endpoints must NOT be probed before YouTube platform extraction"
    );
}

#[tokio::test]
async fn test_02_youtube_cache_hit_skips_slow_candidates_and_returns_under_50ms() {
    let _env = LoopbackEnvGuard::set(true).await;

    let tmp = tempdir().unwrap();
    let db = Database::open(&tmp.path().join("test_cache.sqlite")).unwrap();
    let watch_url = "https://www.youtube.com/watch?v=u9lj-c29dxI&list=PL6B3937A5D230E335";
    let cache_id = normalize_cache_key(watch_url).expect("Valid YouTube cache key");
    let seed = sample_youtube_metadata(watch_url, "u9lj-c29dxI");
    db.set_format_cache(
        &cache_id.cache_key,
        &cache_id.platform,
        &cache_id.video_id,
        &cache_id.canonical_url,
        &seed,
        DEFAULT_CACHE_TTL_SECS,
    )
    .unwrap();

    // Trap slow HTTP server simulating hanging CDN/media candidates (would sleep 15s each if touched)
    let (base_url, hits, handle) = spawn_mock_http_server(vec![(
        "/slow.mp4".to_string(),
        RouteBehavior::Slow {
            delay: Duration::from_secs(15),
        },
    )])
    .await;

    let resolver = MediaResolver::new().with_database(db);
    let orchestrator = DiscoveryOrchestrator::new();

    let req = ResolveRequest {
        url: watch_url.to_string(),
        force_refresh: false,
        candidates: vec![
            "https://www.youtube.com/embed/u9lj-c29dxI?list=PL6B3937A5D230E335".to_string(),
            format!("{}/slow.mp4", base_url),
            "https://rr1---sn-test.googlevideo.com/videoplayback?expire=999999&range=0-1000".to_string(),
            "text/html".to_string(),
            "1280".to_string(),
            "720".to_string(),
        ],
        page_title: Some("Firefox Page Title".to_string()),
        thumbnail_url: None,
    };

    let t0 = Instant::now();
    let meta = orchestrator
        .resolve_multi_strategy(&resolver, &req)
        .await
        .expect("Platform cached resolution must succeed immediately");
    let elapsed = t0.elapsed();

    handle.abort();

    assert_eq!(meta.extractor, "youtube");
    assert_eq!(meta.is_cached, Some(true));
    assert!(meta.formats.len() >= 2);
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "Slow candidate endpoints must NOT be probed before cache/platform lookup"
    );
    assert!(
        elapsed < Duration::from_millis(50),
        "Cached YouTube repeat resolve took {:?}, expected < 50ms",
        elapsed
    );
}

#[tokio::test]
async fn test_03_live_youtube_platform_priority_with_slow_and_valid_candidates() {
    let _env = LoopbackEnvGuard::set(true).await;

    // Provide BOTH a trap slow candidate AND a legitimate MP4 candidate to confirm
    // YouTube platform extractor takes strict precedence over candidate fallback.
    let (base_url, hits, handle) = spawn_mock_http_server(vec![
        (
            "/slow_trap.mp4".to_string(),
            RouteBehavior::Slow {
                delay: Duration::from_secs(15),
            },
        ),
        (
            "/decoy.mp4".to_string(),
            RouteBehavior::OkMedia {
                content_type: "video/mp4".to_string(),
                body: vec![0u8; 2048],
            },
        ),
    ])
    .await;

    let resolver = MediaResolver::new();
    let orchestrator = DiscoveryOrchestrator::new();

    let req = ResolveRequest {
        url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ".to_string(),
        force_refresh: true,
        candidates: vec![
            "https://www.youtube.com/embed/aqz-KE-bpKQ".to_string(),
            format!("{}/slow_trap.mp4", base_url),
            format!("{}/decoy.mp4", base_url),
            "text/html".to_string(),
            "1280".to_string(),
        ],
        page_title: Some("Big Buck Bunny".to_string()),
        thumbnail_url: None,
    };

    let t0 = Instant::now();
    let res = orchestrator.resolve_multi_strategy(&resolver, &req).await;
    let elapsed = t0.elapsed();
    handle.abort();

    let meta = res.expect("Live YouTube platform resolution with candidates must succeed");
    assert_eq!(meta.extractor, "youtube");
    assert!(!meta.formats.is_empty());
    assert!(
        elapsed < Duration::from_secs(26),
        "Live YouTube resolve with noisy candidates exceeded 26s budget: {:?}",
        elapsed
    );
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "Candidate HTTP server must never be probed when YouTube platform extractor succeeds"
    );
}

#[tokio::test]
async fn test_04_platform_failure_propagation_not_masked_by_generic_errors() {
    let _env = LoopbackEnvGuard::set(true).await;
    let resolver = MediaResolver::new();
    let orchestrator = DiscoveryOrchestrator::new();

    // DRM-protected platform URL must return explicit DRM error even if bogus/dead candidates exist
    let drm_req = ResolveRequest {
        url: "https://watch.plex.tv/movie/sample-title".to_string(),
        force_refresh: false,
        candidates: vec!["https://example.com/trailer.mp4".to_string()],
        page_title: None,
        thumbnail_url: None,
    };
    let drm_err = orchestrator
        .resolve_multi_strategy(&resolver, &drm_req)
        .await
        .expect_err("Plex DRM URL must error cleanly");
    let drm_msg = drm_err.to_string();
    assert!(
        drm_msg.contains("DRM") || drm_msg.contains("plex.tv"),
        "Expected DRM error message, got: {}",
        drm_msg
    );
    assert!(!drm_msg.contains("No supported media stream"));

    // Verify definitive error classifier covers auth/private/rate-limit/unavailable/timeout
    assert!(is_definitive_platform_error("Sign in to confirm your age"));
    assert!(is_definitive_platform_error("Private video. Sign in if you've been granted access"));
    assert!(is_definitive_platform_error("HTTP Error 429: Too Many Requests"));
    assert!(is_definitive_platform_error("Video unavailable"));
    assert!(is_definitive_platform_error("yt-dlp resolution timed out after 26 seconds."));
    assert!(!is_definitive_platform_error("Unsupported URL"));

    // Domain matcher verification
    assert!(is_known_platform_domain("https://www.youtube.com/watch?v=dQw4w9WgXcQ"));
    assert!(is_known_platform_domain("https://music.youtube.com/watch?v=dQw4w9WgXcQ"));
    assert!(is_known_platform_domain("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"));
    assert!(!is_known_platform_domain("https://notyoutube.com/watch?v=123"));
}

#[tokio::test]
async fn test_05_generic_html5_page_direct_mp4_webm_candidates_succeed() {
    let _env = LoopbackEnvGuard::set(true).await;

    let (base_url, _hits, handle) = spawn_mock_http_server(vec![
        (
            "/clip_1080.mp4".to_string(),
            RouteBehavior::OkMedia {
                content_type: "video/mp4".to_string(),
                body: vec![1u8; 4096],
            },
        ),
        (
            "/clip_720.webm".to_string(),
            RouteBehavior::OkMedia {
                content_type: "video/webm".to_string(),
                body: vec![2u8; 2048],
            },
        ),
        (
            "/article.html".to_string(),
            RouteBehavior::OkHtml("<html><body><video></video></body></html>".to_string()),
        ),
    ])
    .await;

    let resolver = MediaResolver::new();
    let orchestrator = DiscoveryOrchestrator::new();

    let req = ResolveRequest {
        url: format!("{}/article.html", base_url),
        force_refresh: false,
        candidates: vec![
            format!("{}/clip_1080.mp4", base_url),
            format!("{}/clip_720.webm", base_url),
        ],
        page_title: Some("Generic HTML5 Clip".to_string()),
        thumbnail_url: Some(format!("{}/poster.jpg", base_url)),
    };

    let meta = orchestrator
        .resolve_multi_strategy(&resolver, &req)
        .await
        .expect("Generic HTML5 direct candidates must still resolve");

    handle.abort();

    assert_eq!(meta.extractor, "browser_candidate");
    assert_eq!(meta.title, "Generic HTML5 Clip");
    assert_eq!(meta.formats.len(), 2);
    assert!(meta.formats.iter().any(|f| f.container == "mp4"));
    assert!(meta.formats.iter().any(|f| f.container == "webm"));
    assert!(meta
        .formats
        .iter()
        .all(|f| f.download_capability == DownloadCapability::NativeHttp));
}

#[tokio::test]
async fn test_06_generic_page_hls_and_dash_candidates_succeed() {
    let _env = LoopbackEnvGuard::set(true).await;

    let hls_master = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720\n720p.m3u8\n";
    let dash_mpd = r#"<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT30S" minBufferTime="PT2S">
  <Period>
    <AdaptationSet mimeType="video/mp4" contentType="video">
      <Representation id="1" bandwidth="4500000" width="1920" height="1080" codecs="avc1.640028"><BaseURL>1080p.mp4</BaseURL></Representation>
    </AdaptationSet>
  </Period>
</MPD>"#;

    let (base_url, _hits, handle) = spawn_mock_http_server(vec![
        (
            "/master.m3u8".to_string(),
            RouteBehavior::OkMedia {
                content_type: "application/vnd.apple.mpegurl".to_string(),
                body: hls_master.as_bytes().to_vec(),
            },
        ),
        (
            "/manifest.mpd".to_string(),
            RouteBehavior::OkMedia {
                content_type: "application/dash+xml".to_string(),
                body: dash_mpd.as_bytes().to_vec(),
            },
        ),
        (
            "/player".to_string(),
            RouteBehavior::OkHtml("<html><body>Generic player</body></html>".to_string()),
        ),
    ])
    .await;

    let resolver = MediaResolver::new();
    let orchestrator = DiscoveryOrchestrator::new();

    let hls_req = ResolveRequest {
        url: format!("{}/player", base_url),
        force_refresh: false,
        candidates: vec![format!("{}/master.m3u8", base_url)],
        page_title: Some("HLS Stream Page".to_string()),
        thumbnail_url: None,
    };
    let hls_meta = orchestrator
        .resolve_multi_strategy(&resolver, &hls_req)
        .await
        .expect("HLS candidate must resolve");
    assert_eq!(hls_meta.extractor, "browser_candidate");
    assert!(hls_meta
        .formats
        .iter()
        .any(|f| f.download_capability == DownloadCapability::NativeHls && f.height == Some(720)));

    let dash_req = ResolveRequest {
        url: format!("{}/player", base_url),
        force_refresh: false,
        candidates: vec![format!("{}/manifest.mpd", base_url)],
        page_title: Some("DASH Stream Page".to_string()),
        thumbnail_url: None,
    };
    let dash_meta = orchestrator
        .resolve_multi_strategy(&resolver, &dash_req)
        .await
        .expect("DASH candidate must resolve");
    handle.abort();

    assert_eq!(dash_meta.extractor, "browser_candidate");
    assert!(dash_meta
        .formats
        .iter()
        .any(|f| f.download_capability == DownloadCapability::NativeDash && f.height == Some(1080)));
}

#[tokio::test]
async fn test_07_slow_candidate_endpoint_obeys_bounded_timeout_and_never_hangs() {
    let _env = LoopbackEnvGuard::set(true).await;

    let (base_url, hits, handle) = spawn_mock_http_server(vec![
        (
            "/page.html".to_string(),
            RouteBehavior::OkHtml("<html><body>Empty page</body></html>".to_string()),
        ),
        (
            "/hang_1.mp4".to_string(),
            RouteBehavior::Slow {
                delay: Duration::from_secs(30),
            },
        ),
        (
            "/hang_2.mp4".to_string(),
            RouteBehavior::Slow {
                delay: Duration::from_secs(30),
            },
        ),
    ])
    .await;

    let resolver = MediaResolver::new();
    let orchestrator = DiscoveryOrchestrator::new();

    let req = ResolveRequest {
        url: format!("{}/page.html", base_url),
        force_refresh: true,
        candidates: vec![
            format!("{}/hang_1.mp4", base_url),
            format!("{}/hang_2.mp4", base_url),
        ],
        page_title: None,
        thumbnail_url: None,
    };

    let t0 = Instant::now();
    let res = orchestrator
        .resolve_multi_strategy_with_budget(&resolver, &req, Some(Duration::from_secs(2)))
        .await;
    let elapsed = t0.elapsed();
    handle.abort();

    assert!(res.is_err(), "Hanging page with no valid streams should error cleanly");
    assert!(
        hits.load(Ordering::SeqCst) >= 2,
        "Generic candidates should actually be probed before budget timeout"
    );
    assert!(
        elapsed < Duration::from_secs(4),
        "Bounded candidate probe hung for {:?}, expected < 4s",
        elapsed
    );
}

#[test]
fn test_08_candidate_filtering_dedup_segments_non_urls_cap_and_redaction() {
    let primary = "https://www.youtube.com/watch?v=u9lj-c29dxI&list=PL123";
    let mut raw = vec![
        "".to_string(),
        "blob:https://www.youtube.com/12345".to_string(),
        "data:video/mp4;base64,AAAA".to_string(),
        "javascript:void(0)".to_string(),
        "text/html".to_string(),
        "1280".to_string(),
        "720".to_string(),
        primary.to_string(),
        "https://www.youtube.com/embed/u9lj-c29dxI?list=PL123".to_string(),
        "https://rr1---sn-abcd.googlevideo.com/videoplayback?expire=9999&sig=SECRET_TOKEN&mime=video/mp4".to_string(),
        "https://cdn.example.com/video/seg-1.m4s".to_string(),
        "https://cdn.example.com/video/frag-3.mp4".to_string(),
        "https://cdn.example.com/media/stream.mp4?range=0-65535".to_string(),
        "https://cdn.example.com/poster.jpg".to_string(),
    ];

    // Add duplicate + 15 valid unique MP4 URLs to test bounded cap
    raw.push("https://cdn.example.com/valid/clip0.mp4".to_string());
    for i in 0..15 {
        raw.push(format!("https://cdn.example.com/valid/clip{}.mp4", i));
    }

    let report = sanitize_candidate_urls(&raw, primary, MAX_DISCOVERY_CANDIDATES, true);
    assert_eq!(report.kept.len(), MAX_DISCOVERY_CANDIDATES);
    assert_eq!(report.dropped_non_url, 7);
    assert_eq!(report.dropped_duplicate, 2);
    assert_eq!(report.dropped_segment_or_embed, 6);
    assert_eq!(report.dropped_over_limit, 7);

    // Ensure token/query redaction hides secrets cleanly
    let redacted = redact_url_for_log(
        "https://rr1---sn-abcd.googlevideo.com/videoplayback?sig=TOP_SECRET_VALUE&expire=9999",
    );
    assert!(!redacted.contains("TOP_SECRET_VALUE"));
    assert!(redacted.contains("googlevideo.com/videoplayback?[2q]"));
    assert_eq!(redact_url_for_log("text/html"), "<non-url:len=9>");
}

#[tokio::test]
async fn test_09_ssrf_protection_blocks_private_loopback_and_metadata_candidates() {
    // Explicitly enforce production SSRF policy inside this locked test section
    let _env = LoopbackEnvGuard::set(false).await;

    let (base_url, hits, handle) = spawn_mock_http_server(vec![(
        "/secret.mp4".to_string(),
        RouteBehavior::OkMedia {
            content_type: "video/mp4".to_string(),
            body: vec![9u8; 1024],
        },
    )])
    .await;

    // 1. Validate direct SSRF targets reject before any socket connect
    for blocked in [
        "http://169.254.169.254/latest/meta-data/video.mp4",
        "http://10.0.0.12/internal.mp4",
        "http://192.168.1.50/nas.mp4",
        "http://localhost/local.mp4",
        "file:///C:/Windows/System32/drivers/etc/hosts",
        &format!("{}/secret.mp4", base_url),
    ] {
        assert!(
            validate_safe_media_url(blocked).await.is_err(),
            "SSRF validator must reject unsafe URL: {}",
            blocked
        );
    }

    // 2. Verify candidate sweep never touches loopback server when SSRF protection is active
    let resolver = MediaResolver::new();
    let orchestrator = DiscoveryOrchestrator::new();
    let req = ResolveRequest {
        url: "https://example.com/generic-ssrf-check".to_string(),
        force_refresh: false,
        candidates: vec![
            "http://169.254.169.254/latest/meta-data/video.mp4".to_string(),
            format!("{}/secret.mp4", base_url),
        ],
        page_title: None,
        thumbnail_url: None,
    };

    let _ = orchestrator
        .resolve_multi_strategy_with_budget(&resolver, &req, Some(Duration::from_secs(2)))
        .await;
    handle.abort();

    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "Blocked loopback/private candidate must NEVER receive an HTTP request"
    );
}

#[tokio::test]
async fn test_10_stale_incomplete_cache_invalidated_and_request_cancellation_safe() {
    let _env = LoopbackEnvGuard::set(true).await;

    // 10A. Incomplete/corrupt cached entry must fail validity check, evict, and re-resolve live
    let tmp = tempdir().unwrap();
    let db = Database::open(&tmp.path().join("test_invalid_cache.sqlite")).unwrap();
    let watch_url = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
    let cache_id = normalize_cache_key(watch_url).unwrap();

    let mut corrupt_meta = sample_youtube_metadata(watch_url, "aqz-KE-bpKQ");
    corrupt_meta.formats.clear(); // Simulate incompatible/empty format list in old cache
    assert!(!is_valid_cached_metadata(&corrupt_meta));

    db.set_format_cache(
        &cache_id.cache_key,
        &cache_id.platform,
        &cache_id.video_id,
        &cache_id.canonical_url,
        &corrupt_meta,
        DEFAULT_CACHE_TTL_SECS,
    )
    .unwrap();
    assert_eq!(db.format_cache_count().unwrap(), 1);

    let resolver = MediaResolver::new().with_database(db.clone());
    let orchestrator = DiscoveryOrchestrator::new();
    let req = ResolveRequest {
        url: watch_url.to_string(),
        force_refresh: false,
        candidates: vec![],
        page_title: None,
        thumbnail_url: None,
    };

    let refreshed = orchestrator
        .resolve_multi_strategy(&resolver, &req)
        .await
        .expect("Incomplete cache entry must fall through cleanly to live extraction");
    assert_eq!(refreshed.extractor, "youtube");
    assert!(!refreshed.formats.is_empty());
    assert!(is_valid_cached_metadata(&refreshed));

    // 10B. Request cancellation mid-probe drops cleanly with no hang/panic
    let (base_url, _hits, handle) = spawn_mock_http_server(vec![(
        "/never_finishes.mp4".to_string(),
        RouteBehavior::Slow {
            delay: Duration::from_secs(30),
        },
    )])
    .await;

    let cancel_req = ResolveRequest {
        url: format!("{}/never_finishes.mp4", base_url),
        force_refresh: false,
        candidates: vec![format!("{}/never_finishes.mp4", base_url)],
        page_title: None,
        thumbnail_url: None,
    };
    let cancel_start = Instant::now();
    let cancel_res = tokio::time::timeout(
        Duration::from_millis(120),
        orchestrator.resolve_multi_strategy(&resolver, &cancel_req),
    )
    .await;
    handle.abort();

    assert!(
        cancel_res.is_err(),
        "External caller timeout should cancel in-flight resolution cleanly"
    );
    assert!(
        cancel_start.elapsed() < Duration::from_millis(500),
        "Cancellation must return immediately without waiting for child/socket timeouts"
    );
}
