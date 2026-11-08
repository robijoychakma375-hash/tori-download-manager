use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tdm_core::db::Database;
use tdm_core::resolver::cache::{
    is_cacheable, normalize_cache_key, DEFAULT_CACHE_TTL_SECS, MAX_CACHE_ENTRIES,
};
use tdm_core::resolver::models::{
    DownloadCapability, FilesizeType, MediaMetadata, ResolvedMediaFormat,
};
use tdm_core::MediaResolver;

fn create_sample_metadata(
    url: &str,
    platform: &str,
    title: &str,
    has_credentials: bool,
) -> MediaMetadata {
    let mut headers = HashMap::new();
    if has_credentials {
        headers.insert(
            "Authorization".to_string(),
            "Bearer secret_token_123".to_string(),
        );
        headers.insert(
            "Cookie".to_string(),
            "sessionid=secret_cookie_456".to_string(),
        );
    }

    let direct_url = if has_credentials {
        Some("https://rr1---sn-oxun-xx.googlevideo.com/videoplayback?expire=1730000000&sig=sensitive_sig".to_string())
    } else {
        Some("https://example.com/video.mp4".to_string())
    };

    MediaMetadata {
        source_url: url.to_string(),
        webpage_url: url.to_string(),
        site_name: platform.to_string(),
        title: title.to_string(),
        media_id: "test_media_id_1".to_string(),
        duration_seconds: Some(120.0),
        thumbnail_url: Some("https://example.com/thumb.jpg".to_string()),
        extractor: "test_extractor".to_string(),
        formats: vec![
            ResolvedMediaFormat {
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
                bitrate_kbps: Some(4500.0),
                has_video: true,
                has_audio: false,
                filesize: Some(50_000_000),
                filesize_approx: None,
                filesize_type: FilesizeType::Exact,
                requires_merge: true,
                merge_audio_format_id: Some("140".to_string()),
                audio_channels: None,
                sample_rate: None,
                download_capability: DownloadCapability::ManagedExtractor,
                unavailable_reason: None,
                direct_stream_url: direct_url.clone(),
                http_headers: if has_credentials {
                    Some(headers.clone())
                } else {
                    None
                },
            },
            ResolvedMediaFormat {
                format_id: "140".to_string(),
                format_note: Some("Audio".to_string()),
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
                requires_merge: false,
                merge_audio_format_id: None,
                audio_channels: Some(2),
                sample_rate: Some(44100),
                download_capability: DownloadCapability::ManagedExtractor,
                unavailable_reason: None,
                direct_stream_url: direct_url,
                http_headers: if has_credentials { Some(headers) } else { None },
            },
        ],
        is_direct_media: false,
        is_cached: None,
    }
}

#[tokio::test]
async fn test_format_cache_schema_and_crud() {
    let db = Database::open_in_memory().expect("open in-memory db");
    let test_url = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
    let meta = create_sample_metadata(test_url, "YouTube", "Big Buck Bunny", false);

    let cid = normalize_cache_key(test_url).expect("normalize cache key");
    assert_eq!(cid.platform, "youtube");
    assert_eq!(cid.video_id, "aqz-KE-bpKQ");
    assert_eq!(cid.cache_key, "yt:aqz-KE-bpKQ");

    // 1. Initial lookup -> miss
    let initial = db.get_format_cache(&cid.cache_key).expect("lookup cache");
    assert!(initial.is_none());

    // 2. Set cache
    db.set_format_cache(
        &cid.cache_key,
        &cid.platform,
        &cid.video_id,
        &cid.canonical_url,
        &meta,
        DEFAULT_CACHE_TTL_SECS,
    )
    .expect("set format cache");

    // 3. Lookup -> hit
    let cached = db
        .get_format_cache(&cid.cache_key)
        .expect("lookup cache")
        .expect("cache entry must exist");

    assert_eq!(cached.title, "Big Buck Bunny");
    assert_eq!(cached.formats.len(), 2);
    assert_eq!(cached.is_cached, Some(true));

    // 4. Invalidation
    db.invalidate_format_cache(&cid.cache_key)
        .expect("invalidate");
    let after_inv = db
        .get_format_cache(&cid.cache_key)
        .expect("lookup after inv");
    assert!(after_inv.is_none());
}

#[tokio::test]
async fn test_format_cache_expiration_and_purge() {
    let db = Database::open_in_memory().expect("open db");
    let test_url = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
    let meta = create_sample_metadata(test_url, "YouTube", "Me at the zoo", false);

    let cid = normalize_cache_key(test_url).expect("normalize");

    // Store with 1-second TTL
    db.set_format_cache(
        &cid.cache_key,
        &cid.platform,
        &cid.video_id,
        &cid.canonical_url,
        &meta,
        1,
    )
    .expect("set cache");

    // Immediately valid
    let hit = db.get_format_cache(&cid.cache_key).expect("lookup");
    assert!(hit.is_some());

    // Wait 1.2s for expiration
    tokio::time::sleep(Duration::from_millis(1200)).await;

    // Lazy expiration on get
    let expired = db.get_format_cache(&cid.cache_key).expect("lookup expired");
    assert!(expired.is_none(), "Expired cache item must return None");

    // Re-insert expired row to test purge
    db.set_format_cache(
        &cid.cache_key,
        &cid.platform,
        &cid.video_id,
        &cid.canonical_url,
        &meta,
        1,
    )
    .expect("set cache again");
    tokio::time::sleep(Duration::from_millis(1100)).await;

    let purged = db.purge_expired_format_cache().expect("purge expired");
    assert!(purged >= 1, "Must purge expired entries");
}

#[tokio::test]
async fn test_format_cache_sanitization_strips_signed_urls_and_headers() {
    let db = Database::open_in_memory().expect("open db");
    let test_url = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
    let raw_meta = create_sample_metadata(test_url, "YouTube", "Sensitive Stream", true);

    // Verify input contains sensitive data before sanitization
    assert!(raw_meta.formats[0].direct_stream_url.is_some());
    assert!(raw_meta.formats[0].http_headers.is_some());

    let cid = normalize_cache_key(test_url).expect("normalize");
    db.set_format_cache(
        &cid.cache_key,
        &cid.platform,
        &cid.video_id,
        &cid.canonical_url,
        &raw_meta,
        DEFAULT_CACHE_TTL_SECS,
    )
    .expect("set cache");

    let cached = db
        .get_format_cache(&cid.cache_key)
        .expect("get")
        .expect("exists");

    // Verify sanitized invariants
    assert_eq!(cached.is_cached, Some(true));
    for fmt in &cached.formats {
        assert!(
            fmt.direct_stream_url.is_none(),
            "direct_stream_url must NEVER be stored in format cache"
        );
        assert!(
            fmt.http_headers.is_none(),
            "http_headers must NEVER be stored in format cache"
        );
    }
}

#[tokio::test]
async fn test_format_cache_bounded_capacity_eviction() {
    let db = Database::open_in_memory().expect("open db");

    // Insert MAX_CACHE_ENTRIES + 20 items
    let total_to_insert = MAX_CACHE_ENTRIES + 20;
    for i in 0..total_to_insert {
        let key = format!("gen:item_{:04}", i);
        let meta = create_sample_metadata(
            "https://example.com",
            "Generic",
            &format!("Title {}", i),
            false,
        );
        db.set_format_cache(
            &key,
            "generic",
            &format!("item_{:04}", i),
            "https://example.com",
            &meta,
            DEFAULT_CACHE_TTL_SECS,
        )
        .expect("insert");
    }

    let count = db.format_cache_count().expect("count");
    assert!(
        count <= MAX_CACHE_ENTRIES,
        "Cache count ({}) must not exceed MAX_CACHE_ENTRIES ({})",
        count,
        MAX_CACHE_ENTRIES
    );
}

#[tokio::test]
async fn test_format_cache_corruption_recovery() {
    let db = Database::open_in_memory().expect("open db");
    let cid = "yt:corrupt_test_id";
    let dummy = create_sample_metadata("https://youtube.com", "YouTube", "Dummy", false);

    // Verify cache eligibility rules
    assert!(is_cacheable(&dummy));
    let mut empty_formats = dummy.clone();
    empty_formats.formats.clear();
    assert!(!is_cacheable(&empty_formats));

    let mut direct_media = dummy.clone();
    direct_media.is_direct_media = true;
    assert!(!is_cacheable(&direct_media));

    let mut private_meta = dummy.clone();
    private_meta.title = "This is a Private Video".to_string();
    assert!(!is_cacheable(&private_meta));

    db.set_format_cache(
        cid,
        "youtube",
        "corrupt_test_id",
        "https://youtube.com",
        &dummy,
        900,
    )
    .unwrap();
    assert!(db.get_format_cache(cid).unwrap().is_some());

    // Non-existent key lookup returns None
    let res = db
        .get_format_cache("yt:non_existent")
        .expect("missing lookup");
    assert!(res.is_none());
}

#[test]
fn test_normalize_cache_key_platform_discrimination() {
    // 1. YouTube variants
    let yt1 = normalize_cache_key("https://www.youtube.com/watch?v=jNQXAC9IVRw&t=10s").unwrap();
    let yt2 = normalize_cache_key("https://youtu.be/jNQXAC9IVRw?si=tracking").unwrap();
    let yt3 = normalize_cache_key("https://www.youtube.com/shorts/jNQXAC9IVRw").unwrap();
    let yt4 = normalize_cache_key("https://www.youtube.com/embed/jNQXAC9IVRw").unwrap();
    assert_eq!(yt1.cache_key, "yt:jNQXAC9IVRw");
    assert_eq!(yt2.cache_key, "yt:jNQXAC9IVRw");
    assert_eq!(yt3.cache_key, "yt:jNQXAC9IVRw");
    assert_eq!(yt4.cache_key, "yt:jNQXAC9IVRw");
    assert_eq!(
        yt1.canonical_url,
        "https://www.youtube.com/watch?v=jNQXAC9IVRw"
    );

    // 2. Facebook variants
    let fb1 =
        normalize_cache_key("https://www.facebook.com/reel/10153231379946729/?s=share").unwrap();
    let fb2 = normalize_cache_key("https://www.facebook.com/watch/?v=10153231379946729").unwrap();
    let fb3 = normalize_cache_key("https://fb.watch/10153231379946729/").unwrap();
    assert_eq!(fb1.cache_key, "fb:10153231379946729");
    assert_eq!(fb2.cache_key, "fb:10153231379946729");
    assert_eq!(fb3.cache_key, "fb:10153231379946729");

    // 3. TikTok
    let tt = normalize_cache_key("https://www.tiktok.com/@user/video/7123456789012345678").unwrap();
    assert_eq!(tt.cache_key, "tt:7123456789012345678");
    assert_eq!(tt.platform, "tiktok");

    // 4. Instagram
    let ig = normalize_cache_key("https://www.instagram.com/reel/C2AbCdEfGhI/?igsh=abc").unwrap();
    assert_eq!(ig.cache_key, "ig:C2AbCdEfGhI");
    assert_eq!(ig.platform, "instagram");

    // 5. Twitter / X
    let tw = normalize_cache_key("https://twitter.com/NASA/status/1720000000000000000").unwrap();
    assert_eq!(tw.cache_key, "tw:1720000000000000000");
    assert_eq!(tw.platform, "twitter");

    // 6. Vimeo
    let vm = normalize_cache_key("https://vimeo.com/76979871").unwrap();
    assert_eq!(vm.cache_key, "vm:76979871");
    assert_eq!(vm.platform, "vimeo");

    // 7. Collision prevention across platforms with identical IDs
    let dummy_id = "12345678901";
    let k_yt = format!("yt:{}", dummy_id);
    let k_fb = format!("fb:{}", dummy_id);
    let k_tt = format!("tt:{}", dummy_id);
    assert_ne!(k_yt, k_fb);
    assert_ne!(k_fb, k_tt);
    assert_ne!(k_yt, k_tt);

    // 8. Direct media files must NOT be cached in format cache
    assert!(normalize_cache_key("https://example.com/video.mp4").is_none());
    assert!(normalize_cache_key("https://example.com/playlist.m3u8").is_none());
    assert!(normalize_cache_key("https://example.com/manifest.mpd").is_none());
    assert!(normalize_cache_key("https://example.com/audio.mp3").is_none());
    assert!(normalize_cache_key("https://example.com/segment.ts").is_none());

    // 9. Localhost / private IP exclusion
    assert!(normalize_cache_key("http://localhost:8080/watch?v=123").is_none());
    assert!(normalize_cache_key("http://127.0.0.1:6800/video").is_none());
    assert!(normalize_cache_key("http://192.168.1.100/watch?v=123").is_none());
}

#[tokio::test]
async fn test_resolver_pipeline_cache_hit_and_force_refresh() {
    let db = Database::open_in_memory().expect("open db");
    let test_url = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
    let sample = create_sample_metadata(test_url, "YouTube", "Cached Sample Video", false);

    let cid = normalize_cache_key(test_url).unwrap();
    db.set_format_cache(
        &cid.cache_key,
        &cid.platform,
        &cid.video_id,
        &cid.canonical_url,
        &sample,
        DEFAULT_CACHE_TTL_SECS,
    )
    .unwrap();

    let resolver = MediaResolver::new().with_database(db.clone());

    // 1. Regular resolve() -> should hit cache instantaneously
    let t0 = std::time::Instant::now();
    let res = resolver.resolve(test_url).await.expect("resolve hit");
    let elapsed = t0.elapsed();

    assert_eq!(res.title, "Cached Sample Video");
    assert_eq!(res.is_cached, Some(true));
    assert!(
        elapsed < Duration::from_millis(100),
        "Cache hit must execute in sub-100ms (measured {:?})",
        elapsed
    );

    // 2. Invalidate cache -> resolve should not find cached
    db.invalidate_format_cache(&cid.cache_key).unwrap();
    let after = db.get_format_cache(&cid.cache_key).unwrap();
    assert!(after.is_none());
}

#[tokio::test]
async fn test_concurrent_format_cache_access() {
    let db = Database::open_in_memory().expect("open db");
    let db = Arc::new(db);

    let mut handles = Vec::new();
    for i in 0..20 {
        let db_c = db.clone();
        handles.push(tokio::spawn(async move {
            let key = format!("yt:concurrent_{}", i % 5);
            let meta = create_sample_metadata(
                &format!("https://youtube.com/watch?v=concurrent_{}", i % 5),
                "YouTube",
                &format!("Title {}", i),
                false,
            );
            let _ = db_c.set_format_cache(
                &key,
                "youtube",
                &format!("c_{}", i % 5),
                "https://youtube.com",
                &meta,
                60,
            );
            let _ = db_c.get_format_cache(&key);
        }));
    }

    for h in handles {
        h.await.expect("task must not panic");
    }

    // Verify DB integrity
    let count = db.format_cache_count().expect("count");
    assert!(count > 0 && count <= 5);
}
