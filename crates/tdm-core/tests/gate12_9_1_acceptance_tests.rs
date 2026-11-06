use std::fs;
use std::process::Command;
use std::time::Duration;
use tdm_core::{
    find_ffprobe, find_streamlink, probe_streamlink, DiscoveryOrchestrator, DownloadCapability,
    FilesizeType, MediaResolver, ResolveRequest,
};

#[tokio::test]
async fn test_gate12_9_1_strategy_a_platforms_youtube_and_facebook() {
    let resolver = MediaResolver::new();

    // 1. YouTube metadata resolution
    let yt_url = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
    let yt_res = resolver.resolve(yt_url).await;
    assert!(
        yt_res.is_ok(),
        "YouTube resolution failed: {:?}",
        yt_res.err()
    );
    let yt_meta = yt_res.unwrap();
    assert!(
        !yt_meta.title.is_empty(),
        "YouTube title should not be empty"
    );
    assert!(
        !yt_meta.formats.is_empty(),
        "YouTube formats should not be empty"
    );
    assert!(
        yt_meta.formats.iter().any(|f| f.has_video),
        "YouTube should have video formats"
    );

    // 2. Facebook video metadata resolution
    let fb_url = "https://www.facebook.com/watch/?v=10153231379946729";
    let fb_res = resolver.resolve(fb_url).await;
    assert!(
        fb_res.is_ok(),
        "Facebook resolution failed: {:?}",
        fb_res.err()
    );
    let fb_meta = fb_res.unwrap();
    assert!(
        !fb_meta.title.is_empty(),
        "Facebook title should not be empty"
    );
    assert!(
        !fb_meta.formats.is_empty(),
        "Facebook formats should not be empty"
    );
    assert!(
        fb_meta.formats.iter().any(|f| f.container == "mp4"),
        "Facebook formats should include MP4"
    );
}

#[tokio::test]
async fn test_gate12_9_1_strategy_b_and_c_direct_media_mp4_and_webm() {
    let resolver = MediaResolver::new();

    // 1. Direct MP4 probe
    let mp4_url = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";
    let mp4_res = resolver.resolve(mp4_url).await;
    assert!(
        mp4_res.is_ok(),
        "Direct MP4 probe failed: {:?}",
        mp4_res.err()
    );
    let mp4_meta = mp4_res.unwrap();
    assert!(mp4_meta.is_direct_media);
    assert_eq!(mp4_meta.formats.len(), 1);
    let f_mp4 = &mp4_meta.formats[0];
    assert_eq!(f_mp4.container, "mp4");
    assert_eq!(f_mp4.download_capability, DownloadCapability::NativeHttp);
    assert_eq!(f_mp4.filesize, Some(1128375));
    assert_eq!(f_mp4.filesize_type, FilesizeType::Exact);

    // 2. Direct WebM probe
    let webm_url = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.webm";
    let webm_res = resolver.resolve(webm_url).await;
    assert!(
        webm_res.is_ok(),
        "Direct WebM probe failed: {:?}",
        webm_res.err()
    );
    let webm_meta = webm_res.unwrap();
    assert!(webm_meta.is_direct_media);
    assert_eq!(webm_meta.formats.len(), 1);
    let f_webm = &webm_meta.formats[0];
    assert_eq!(f_webm.container, "webm");
    assert_eq!(f_webm.download_capability, DownloadCapability::NativeHttp);
    assert_eq!(f_webm.filesize, Some(554058));
    assert_eq!(f_webm.filesize_type, FilesizeType::Exact);
}

#[tokio::test]
async fn test_gate12_9_1_strategy_d_and_e_streaming_hls_and_dash() {
    let resolver = MediaResolver::new();

    // 1. Direct HLS manifest probe
    let hls_url = "https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/bipbop_4x3_variant.m3u8";
    let hls_res = resolver.resolve(hls_url).await;
    assert!(
        hls_res.is_ok(),
        "Direct HLS probe failed: {:?}",
        hls_res.err()
    );
    let hls_meta = hls_res.unwrap();
    assert!(hls_meta.is_direct_media);
    assert!(!hls_meta.formats.is_empty());
    assert!(hls_meta.formats.iter().any(|f| f.protocol == "m3u8"));
    assert!(hls_meta
        .formats
        .iter()
        .all(|f| f.download_capability == DownloadCapability::NativeHls));

    // 2. Direct DASH manifest probe
    let dash_url = "https://dash.akamaized.net/envivio/EnvivioDash3/manifest.mpd";
    let dash_res = resolver.resolve(dash_url).await;
    assert!(
        dash_res.is_ok(),
        "Direct DASH probe failed: {:?}",
        dash_res.err()
    );
    let dash_meta = dash_res.unwrap();
    assert!(dash_meta.is_direct_media);
    assert!(!dash_meta.formats.is_empty());
    assert!(dash_meta.formats.iter().any(|f| f.protocol == "mpd"));
    assert!(dash_meta
        .formats
        .iter()
        .all(|f| f.download_capability == DownloadCapability::NativeDash));
}

#[tokio::test]
async fn test_gate12_9_1_strategy_f_and_g_candidate_handoff_and_isolation() {
    let resolver = MediaResolver::new();
    let orchestrator = DiscoveryOrchestrator::new();

    // Candidate handoff for an unsupported generic webpage
    let req = ResolveRequest {
        url: "https://example.com/unsupported-video-page".to_string(),
        force_refresh: false,
        candidates: vec![
            "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4".to_string(),
            "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.webm".to_string(),
        ],
        page_title: Some("Community Flower Video".to_string()),
        thumbnail_url: Some("https://example.com/poster.jpg".to_string()),
    };

    let resolved = orchestrator.resolve_multi_strategy(&resolver, &req).await;
    assert!(
        resolved.is_ok(),
        "Multi-strategy resolution failed: {:?}",
        resolved.err()
    );

    let meta = resolved.unwrap();
    assert_eq!(meta.extractor, "browser_candidate");
    assert_eq!(meta.title, "Community Flower Video");
    assert_eq!(
        meta.thumbnail_url.as_deref(),
        Some("https://example.com/poster.jpg")
    );
    assert_eq!(meta.formats.len(), 2);
    assert!(meta.formats.iter().any(|f| f.container == "mp4"));
    assert!(meta.formats.iter().any(|f| f.container == "webm"));
}

#[tokio::test]
async fn test_gate12_9_1_strategy_h_streamlink_fallback() {
    let res = probe_streamlink(
        "https://example.com/stream-live",
        None,
        Duration::from_millis(500),
    )
    .await;
    assert!(res.is_ok(), "probe_streamlink should gracefully return Ok");
    if find_streamlink().is_none() {
        assert!(res.unwrap().is_empty());
    }
}

#[tokio::test]
async fn test_gate12_9_1_real_downloads_and_ffprobe_verification() {
    let ffprobe_bin = find_ffprobe().expect("ffprobe must be available for media verification");
    let temp_dir =
        std::env::temp_dir().join(format!("tori_test_acceptance_{}", std::process::id()));
    let _ = fs::create_dir_all(&temp_dir);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap();

    // 1. Download real MP4
    let mp4_path = temp_dir.join("flower.mp4");
    let mp4_resp = client
        .get("https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4")
        .send()
        .await
        .expect("Failed to fetch MP4");
    let mp4_bytes = mp4_resp.bytes().await.expect("Failed to read MP4 bytes");
    fs::write(&mp4_path, &mp4_bytes).expect("Failed to write MP4 to disk");
    assert_eq!(mp4_bytes.len(), 1128375);

    // Verify MP4 with ffprobe
    let probe_mp4 = Command::new(&ffprobe_bin)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration,size,bit_rate:stream=codec_name,width,height",
            "-of",
            "json",
            mp4_path.to_str().unwrap(),
        ])
        .output()
        .expect("Failed to run ffprobe on MP4");

    assert!(
        probe_mp4.status.success(),
        "ffprobe on MP4 returned non-zero status"
    );
    let mp4_json: serde_json::Value =
        serde_json::from_slice(&probe_mp4.stdout).expect("Failed to parse ffprobe json output");

    let mp4_streams = mp4_json.get("streams").and_then(|v| v.as_array()).unwrap();
    assert!(
        !mp4_streams.is_empty(),
        "MP4 must contain at least one stream"
    );
    let video_stream = mp4_streams
        .iter()
        .find(|s| s.get("width").is_some())
        .unwrap();
    assert_eq!(video_stream["codec_name"], "h264");
    assert_eq!(video_stream["width"], 960);
    assert_eq!(video_stream["height"], 540);

    let audio_stream = mp4_streams
        .iter()
        .find(|s| s["codec_name"] == "aac")
        .unwrap();
    assert_eq!(audio_stream["codec_name"], "aac");

    let mp4_format = &mp4_json["format"];
    let dur_str = mp4_format["duration"].as_str().unwrap();
    let dur: f64 = dur_str.parse().unwrap();
    assert!(
        dur > 5.0 && dur < 5.2,
        "MP4 duration should be ~5.05s, got: {}",
        dur
    );

    // 2. Download real WebM
    let webm_path = temp_dir.join("flower.webm");
    let webm_resp = client
        .get("https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.webm")
        .send()
        .await
        .expect("Failed to fetch WebM");
    let webm_bytes = webm_resp.bytes().await.expect("Failed to read WebM bytes");
    fs::write(&webm_path, &webm_bytes).expect("Failed to write WebM to disk");
    assert_eq!(webm_bytes.len(), 554058);

    // Verify WebM with ffprobe
    let probe_webm = Command::new(&ffprobe_bin)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration,size,bit_rate:stream=codec_name,width,height",
            "-of",
            "json",
            webm_path.to_str().unwrap(),
        ])
        .output()
        .expect("Failed to run ffprobe on WebM");

    assert!(
        probe_webm.status.success(),
        "ffprobe on WebM returned non-zero status"
    );
    let webm_json: serde_json::Value =
        serde_json::from_slice(&probe_webm.stdout).expect("Failed to parse ffprobe json output");

    let webm_streams = webm_json.get("streams").and_then(|v| v.as_array()).unwrap();
    assert!(
        !webm_streams.is_empty(),
        "WebM must contain at least one stream"
    );
    let webm_video = webm_streams
        .iter()
        .find(|s| s.get("width").is_some())
        .unwrap();
    assert_eq!(webm_video["codec_name"], "vp8");
    assert_eq!(webm_video["width"], 960);
    assert_eq!(webm_video["height"], 540);

    let webm_audio = webm_streams
        .iter()
        .find(|s| s["codec_name"] == "vorbis")
        .unwrap();
    assert_eq!(webm_audio["codec_name"], "vorbis");

    let webm_format = &webm_json["format"];
    let webm_dur: f64 = webm_format["duration"].as_str().unwrap().parse().unwrap();
    assert!(
        webm_dur > 5.0 && webm_dur < 5.2,
        "WebM duration should be ~5.05s, got: {}",
        webm_dur
    );

    // Clean up temporary files
    let _ = fs::remove_file(&mp4_path);
    let _ = fs::remove_file(&webm_path);
    let _ = fs::remove_dir(&temp_dir);
}
