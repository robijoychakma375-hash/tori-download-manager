use std::time::Duration;
use tdm_core::{
    deduplicate_and_rank_formats, extract_html_media_candidates, find_streamlink, probe_streamlink,
    DiscoveryOrchestrator, DiscoveryStrategy, DownloadCapability, FilesizeType, MediaCandidate,
    MediaResolver, ResolveRequest, ResolvedMediaFormat,
};

#[test]
fn test_html_metadata_extraction_opengraph_and_jsonld() {
    let sample_html = r#"
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>Blender Foundation — Big Buck Bunny</title>
        <meta property="og:title" content="Big Buck Bunny 4K Open Source Film" />
        <meta property="og:image" content="https://example.com/images/bunny_poster.jpg" />
        <meta property="og:video" content="https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4" />
        <meta property="og:video:secure_url" content="https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4" />
        <script type="application/ld+json">
        {
            "@context": "https://schema.org",
            "@type": "VideoObject",
            "name": "Big Buck Bunny HD Stream",
            "contentUrl": "https://example.com/streams/bunny_manifest.m3u8",
            "thumbnailUrl": "https://example.com/thumbnails/jsonld_thumb.jpg"
        }
        </script>
    </head>
    <body>
        <main>
            <h1>Watch Movie</h1>
            <video id="player" poster="/local_poster.png" controls>
                <source src="/media/direct_render.webm" type="video/webm">
                <source src="https://example.com/alternate/fallback.mp4" type="video/mp4">
            </video>
        </main>
    </body>
    </html>
    "#;

    let base_url = "https://example.com/watch/film";
    let scraped = extract_html_media_candidates(sample_html, base_url);

    assert_eq!(
        scraped.title.as_deref(),
        Some("Big Buck Bunny 4K Open Source Film")
    );
    assert_eq!(
        scraped.thumbnail_url.as_deref(),
        Some("https://example.com/images/bunny_poster.jpg")
    );

    // Verify discovered media candidate URLs
    let urls = scraped.media_urls;
    assert!(
        urls.iter().any(|u| u == "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"),
        "Missing og:video candidate"
    );
    assert!(
        urls.iter()
            .any(|u| u == "https://example.com/streams/bunny_manifest.m3u8"),
        "Missing JSON-LD contentUrl candidate"
    );
    assert!(
        urls.iter()
            .any(|u| u == "https://example.com/media/direct_render.webm"),
        "Relative video source URL was not properly resolved against base URL"
    );
    assert!(
        urls.iter()
            .any(|u| u == "https://example.com/alternate/fallback.mp4"),
        "Missing absolute video source URL"
    );
}

#[test]
fn test_deduplicate_and_rank_formats() {
    let f1 = ResolvedMediaFormat {
        format_id: "f_1080".to_string(),
        format_note: Some("1080p".to_string()),
        width: Some(1920),
        height: Some(1080),
        resolution_label: "1080p".to_string(),
        fps: Some(60.0),
        vcodec: Some("h264".to_string()),
        acodec: Some("aac".to_string()),
        container: "mp4".to_string(),
        protocol: "https".to_string(),
        bitrate_kbps: Some(4500.0),
        has_video: true,
        has_audio: true,
        filesize: Some(50_000_000),
        filesize_approx: None,
        filesize_type: FilesizeType::Exact,
        requires_merge: false,
        merge_audio_format_id: None,
        audio_channels: None,
        sample_rate: None,
        download_capability: DownloadCapability::NativeHttp,
        unavailable_reason: None,
        direct_stream_url: Some("https://example.com/1080.mp4".to_string()),
        http_headers: None,
    };

    let f2 = ResolvedMediaFormat {
        format_id: "f_720".to_string(),
        format_note: Some("720p".to_string()),
        width: Some(1280),
        height: Some(720),
        resolution_label: "720p".to_string(),
        fps: Some(30.0),
        vcodec: Some("h264".to_string()),
        acodec: Some("aac".to_string()),
        container: "mp4".to_string(),
        protocol: "https".to_string(),
        bitrate_kbps: Some(2500.0),
        has_video: true,
        has_audio: true,
        filesize: Some(25_000_000),
        filesize_approx: None,
        filesize_type: FilesizeType::Exact,
        requires_merge: false,
        merge_audio_format_id: None,
        audio_channels: None,
        sample_rate: None,
        download_capability: DownloadCapability::NativeHttp,
        unavailable_reason: None,
        direct_stream_url: Some("https://example.com/720.mp4".to_string()),
        http_headers: None,
    };

    let f1_duplicate = f1.clone();

    let ranked = deduplicate_and_rank_formats(vec![f2, f1, f1_duplicate]);
    assert_eq!(ranked.len(), 2, "Duplicate format was not removed");
    assert_eq!(
        ranked[0].height,
        Some(1080),
        "Highest resolution must be ranked first"
    );
    assert_eq!(ranked[1].height, Some(720));
}

#[tokio::test]
async fn test_streamlink_adapter_graceful_degradation() {
    // If streamlink is not installed on the system, probing must gracefully return Ok(empty)
    let res = probe_streamlink(
        "https://example.com/unsupported_live",
        None,
        Duration::from_secs(2),
    )
    .await;
    assert!(
        res.is_ok(),
        "probe_streamlink should gracefully return Ok when binary is not present"
    );
    if find_streamlink().is_none() {
        assert!(res.unwrap().is_empty());
    }
}

#[tokio::test]
async fn test_multi_strategy_orchestrator_candidate_handoff() {
    let resolver = MediaResolver::new();
    let orchestrator = DiscoveryOrchestrator::new();

    let req = ResolveRequest {
        url: "https://example.org/stream-page".to_string(),
        force_refresh: false,
        candidates: vec![
            "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4"
                .to_string(),
        ],
        page_title: Some("For Bigger Blazes Sample Video".to_string()),
        thumbnail_url: Some("https://example.org/poster.jpg".to_string()),
    };

    // The probe should successfully hit Google Cloud Storage sample video via direct probe
    let resolved = orchestrator.resolve_multi_strategy(&resolver, &req).await;
    assert!(
        resolved.is_ok(),
        "Candidate handoff failed: {:?}",
        resolved.err()
    );

    let meta = resolved.unwrap();
    assert_eq!(meta.extractor, "browser_candidate");
    assert_eq!(meta.title, "For Bigger Blazes Sample Video");
    assert!(!meta.formats.is_empty(), "Must have at least one format");
    assert_eq!(
        meta.formats[0].download_capability,
        DownloadCapability::NativeHttp
    );
}

#[test]
fn test_media_candidate_model_serialization() {
    let candidate = MediaCandidate {
        url: "https://example.com/live/master.m3u8".to_string(),
        strategy: DiscoveryStrategy::HlsManifest,
        protocol: "m3u8".to_string(),
        container: "mp4".to_string(),
        resolution_label: Some("1080p".to_string()),
        width: Some(1920),
        height: Some(1080),
        bitrate_kbps: Some(5000.0),
        filesize: None,
        format_note: Some("HLS Master Variant".to_string()),
        vcodec: Some("avc1.64002a".to_string()),
        acodec: Some("mp4a.40.2".to_string()),
        download_capability: DownloadCapability::NativeHls,
        direct_stream_url: Some("https://example.com/live/1080p.m3u8".to_string()),
        http_headers: None,
    };

    let serialized = serde_json::to_string(&candidate).expect("Serialization failed");
    assert!(serialized.contains("\"strategy\":\"hls_manifest\""));
    assert!(serialized.contains("\"download_capability\":\"native_hls\""));

    let deserialized: MediaCandidate =
        serde_json::from_str(&serialized).expect("Deserialization failed");
    assert_eq!(deserialized.strategy, DiscoveryStrategy::HlsManifest);
    assert_eq!(
        deserialized.download_capability,
        DownloadCapability::NativeHls
    );
}
