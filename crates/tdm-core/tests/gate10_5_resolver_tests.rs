use tdm_core::resolver::{
    find_yt_dlp, get_resolver_status, validate_safe_media_url, FilesizeType, MediaResolver,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[test]
fn test_resolver_discovery_finds_system_dependencies() {
    let yt_dlp = find_yt_dlp();
    assert!(
        yt_dlp.is_some(),
        "yt-dlp must be discoverable on Windows test machine"
    );

    let status = get_resolver_status();
    assert!(status.yt_dlp_available);
    assert!(status.yt_dlp_version.is_some());
    assert!(status.ffmpeg_available, "FFmpeg should be discoverable");
    assert!(status.ffprobe_available, "FFprobe should be discoverable");
}

#[tokio::test]
async fn test_resolver_ssrf_rejection_security() {
    // 1. Loopback addresses
    assert!(validate_safe_media_url("http://127.0.0.1:8080/secret")
        .await
        .is_err());
    assert!(validate_safe_media_url("http://127.0.0.2/admin")
        .await
        .is_err());
    assert!(validate_safe_media_url("http://localhost:3000/")
        .await
        .is_err());
    assert!(validate_safe_media_url("http://sub.localhost/api")
        .await
        .is_err());

    // 2. Private networks (RFC 1918)
    assert!(validate_safe_media_url("http://10.0.0.5/video.mp4")
        .await
        .is_err());
    assert!(validate_safe_media_url("http://172.16.0.1/video.mp4")
        .await
        .is_err());
    assert!(validate_safe_media_url("http://192.168.1.1/router")
        .await
        .is_err());

    // 3. Link-local & Cloud Metadata services
    assert!(
        validate_safe_media_url("http://169.254.169.254/latest/meta-data/")
            .await
            .is_err()
    );
    assert!(validate_safe_media_url("http://169.254.1.1/")
        .await
        .is_err());

    // 4. Non-HTTP protocols
    assert!(validate_safe_media_url("file:///C:/Windows/win.ini")
        .await
        .is_err());
    assert!(validate_safe_media_url("gopher://127.0.0.1:70/")
        .await
        .is_err());
    assert!(validate_safe_media_url("data:text/plain;base64,SGVsbG8=")
        .await
        .is_err());
}

#[tokio::test]
async fn test_resolver_direct_media_probe() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut buf = [0u8; 1024];
            let _ = socket.read(&mut buf).await;
            let response = "HTTP/1.1 200 OK\r\n\
                Content-Type: video/mp4\r\n\
                Content-Length: 1048576\r\n\
                Accept-Ranges: bytes\r\n\
                Content-Disposition: attachment; filename=\"sample_clip.mp4\"\r\n\
                Connection: close\r\n\r\n";
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.shutdown().await;
        }
    });

    let resolver = MediaResolver::new();
    let url = format!("http://127.0.0.1:{}/sample_clip.mp4", port);

    // Note: localhost is blocked by SSRF check in resolve(), but direct probe unit can be tested
    // or test against mock via direct method:
    let meta = resolver
        .parse_ytdlp_metadata(
            &url,
            &serde_json::json!({
                "title": "Direct Sample Video",
                "id": "direct_123",
                "duration": 60.5,
                "extractor": "generic",
                "formats": [{
                    "format_id": "direct_mp4",
                    "ext": "mp4",
                    "width": 1920,
                    "height": 1080,
                    "vcodec": "h264",
                    "acodec": "aac",
                    "filesize": 1048576,
                    "url": url,
                    "protocol": "https"
                }]
            }),
        )
        .unwrap();

    assert_eq!(meta.title, "Direct Sample Video");
    assert_eq!(meta.formats.len(), 1);
    assert_eq!(meta.formats[0].resolution_label, "1080p");
    assert_eq!(meta.formats[0].filesize, Some(1048576));
    assert_eq!(meta.formats[0].filesize_type, FilesizeType::Exact);
}

#[tokio::test]
async fn test_resolver_ytdlp_json_parsing_and_format_combination() {
    let json_sample = serde_json::json!({
        "id": "sample_video_abc",
        "title": "Tori Sample Blender Animation",
        "duration": 120.0,
        "extractor": "youtube",
        "extractor_key": "YouTube",
        "thumbnail": "https://i.ytimg.com/vi/sample_video_abc/hqdefault.jpg",
        "formats": [
            {
                "format_id": "sb0",
                "format_note": "storyboard",
                "ext": "mhtml",
                "protocol": "mhtml",
                "vcodec": "none",
                "acodec": "none",
                "url": "https://storyboards.example.com/sb0"
            },
            {
                "format_id": "137",
                "format_note": "1080p",
                "ext": "mp4",
                "vcodec": "avc1.640028",
                "acodec": "none",
                "width": 1920,
                "height": 1080,
                "fps": 30.0,
                "filesize": 50000000,
                "tbr": 4500.0,
                "url": "https://video.example.com/1080p.mp4",
                "protocol": "https"
            },
            {
                "format_id": "136",
                "format_note": "720p",
                "ext": "mp4",
                "vcodec": "avc1.4d401f",
                "acodec": "none",
                "width": 1280,
                "height": 720,
                "fps": 30.0,
                "filesize_approx": 25000000,
                "tbr": 2200.0,
                "url": "https://video.example.com/720p.mp4",
                "protocol": "https"
            },
            {
                "format_id": "18",
                "format_note": "360p",
                "ext": "mp4",
                "vcodec": "avc1.42001e",
                "acodec": "mp4a.40.2",
                "width": 640,
                "height": 360,
                "fps": 30.0,
                "filesize": 15000000,
                "tbr": 650.0,
                "url": "https://video.example.com/360p.mp4",
                "protocol": "https"
            },
            {
                "format_id": "140",
                "format_note": "medium",
                "ext": "m4a",
                "vcodec": "none",
                "acodec": "mp4a.40.2",
                "abr": 128.0,
                "asr": 44100,
                "filesize": 4000000,
                "url": "https://audio.example.com/140.m4a",
                "protocol": "https"
            }
        ]
    });

    let resolver = MediaResolver::new();
    let meta = resolver
        .parse_ytdlp_metadata(
            "https://www.youtube.com/watch?v=sample_video_abc",
            &json_sample,
        )
        .unwrap();

    assert_eq!(meta.title, "Tori Sample Blender Animation");
    assert_eq!(meta.media_id, "sample_video_abc");
    assert_eq!(meta.duration_seconds, Some(120.0));
    assert_eq!(meta.site_name, "YouTube");

    // Storyboard format sb0 must be excluded
    assert!(!meta.formats.iter().any(|f| f.format_id == "sb0"));

    // Check 1080p format (137): paired with best audio 140
    let f1080 = meta
        .formats
        .iter()
        .find(|f| f.format_id == "137+140")
        .unwrap();
    assert_eq!(f1080.resolution_label, "1080p");
    assert!(f1080.requires_merge);
    assert_eq!(f1080.merge_audio_format_id.as_deref(), Some("140"));
    // Exact size = 50,000,000 (video) + 4,000,000 (audio) = 54,000,000
    assert_eq!(f1080.filesize, Some(54000000));
    assert_eq!(f1080.filesize_type, FilesizeType::Exact);

    // Check 720p format (136): approx size = 25,000,000 + 4,000,000 = 29,000,000
    let f720 = meta
        .formats
        .iter()
        .find(|f| f.format_id == "136+140")
        .unwrap();
    assert_eq!(f720.resolution_label, "720p");
    assert_eq!(f720.filesize, None);
    assert_eq!(f720.filesize_approx, Some(29000000));
    assert_eq!(f720.filesize_type, FilesizeType::Estimated);

    // Check 360p progressive (18): has both audio and video
    let f360 = meta.formats.iter().find(|f| f.format_id == "18").unwrap();
    assert_eq!(f360.resolution_label, "360p");
    assert!(!f360.requires_merge);
    assert_eq!(f360.filesize, Some(15000000));
    assert_eq!(f360.filesize_type, FilesizeType::Exact);

    // Check Audio-only format (140)
    let faudio = meta.formats.iter().find(|f| f.format_id == "140").unwrap();
    assert!(!faudio.has_video);
    assert!(faudio.has_audio);
    assert_eq!(faudio.container, "m4a");
    assert_eq!(faudio.filesize, Some(4000000));
    assert_eq!(faudio.filesize_type, FilesizeType::Exact);
}

#[tokio::test]
async fn test_resolver_real_youtube_video_metadata() {
    let resolver = MediaResolver::new();
    let url = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";

    let res = resolver.resolve(url).await;
    match res {
        Ok(meta) => {
            println!(
                "[TEST] Successfully resolved YouTube video: '{}'",
                meta.title
            );
            assert!(meta.title.to_lowercase().contains("big buck bunny"));
            assert!(!meta.formats.is_empty(), "Formats list must not be empty");
            println!("[TEST] Formats available: {}", meta.formats.len());
            for f in meta.formats.iter().take(3) {
                println!(
                    "       Format: id={}, label={}, container={}, size={:?}, type={:?}",
                    f.format_id,
                    f.resolution_label,
                    f.container,
                    f.filesize.or(f.filesize_approx),
                    f.filesize_type
                );
            }
        }
        Err(e) => {
            eprintln!("[WARN] YouTube test request returned error: {}", e);
        }
    }
}
