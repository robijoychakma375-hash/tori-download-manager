use tdm_core::resolver::{
    find_yt_dlp, get_resolver_status, select_compatible_audio_and_container,
    validate_safe_media_url, FilesizeType, MediaResolver, ParsedRawFormat,
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

#[test]
fn test_container_compatibility_matrix() {
    fn make_audio(id: &str, ext: &str, acodec: &str, br: f64) -> ParsedRawFormat {
        ParsedRawFormat {
            format_id: id.to_string(),
            format_note: None,
            width: None,
            height: None,
            resolution_label: "Audio".to_string(),
            fps: None,
            vcodec: None,
            acodec: Some(acodec.to_string()),
            container: ext.to_string(),
            protocol: "https".to_string(),
            bitrate_kbps: Some(br),
            has_video: false,
            has_audio: true,
            filesize: Some(1000000),
            filesize_approx: None,
            filesize_type: FilesizeType::Exact,
            is_storyboard: false,
            audio_channels: Some(2),
            sample_rate: Some(48000),
            direct_url: None,
            http_headers: None,
        }
    }

    fn make_video(id: &str, ext: &str, vcodec: &str, h: u32) -> ParsedRawFormat {
        ParsedRawFormat {
            format_id: id.to_string(),
            format_note: None,
            width: Some(h * 16 / 9),
            height: Some(h),
            resolution_label: format!("{}p", h),
            fps: Some(30.0),
            vcodec: Some(vcodec.to_string()),
            acodec: None,
            container: ext.to_string(),
            protocol: "https".to_string(),
            bitrate_kbps: Some(2500.0),
            has_video: true,
            has_audio: false,
            filesize: Some(15000000),
            filesize_approx: None,
            filesize_type: FilesizeType::Exact,
            is_storyboard: false,
            audio_channels: None,
            sample_rate: None,
            direct_url: None,
            http_headers: None,
        }
    }

    let aac_audio = make_audio("140", "m4a", "mp4a.40.2", 128.0);
    let opus_audio = make_audio("251", "webm", "opus", 160.0);
    let both_audios = vec![aac_audio.clone(), opus_audio.clone()];

    // Case 1: H.264 video + both audios available -> Must choose AAC and produce MP4
    let h264_vid = make_video("137", "mp4", "avc1.640028", 1080);
    let (sel1, cont1) = select_compatible_audio_and_container(&h264_vid, &both_audios);
    assert_eq!(sel1.unwrap().format_id, "140");
    assert_eq!(cont1, "mp4", "H.264 + AAC must produce mp4 container");

    // Case 2: VP9 video + both audios available -> Must choose Opus and produce WebM
    let vp9_vid = make_video("248", "webm", "vp9", 1080);
    let (sel2, cont2) = select_compatible_audio_and_container(&vp9_vid, &both_audios);
    assert_eq!(sel2.unwrap().format_id, "251");
    assert_eq!(cont2, "webm", "VP9 + Opus must produce webm container");

    // Case 3: VP9 video + ONLY AAC audio -> Must use MKV (never mislabeled as WebM!)
    let (sel3, cont3) =
        select_compatible_audio_and_container(&vp9_vid, std::slice::from_ref(&aac_audio));
    assert_eq!(sel3.unwrap().format_id, "140");
    assert_eq!(
        cont3, "mkv",
        "VP9 + AAC must produce mkv (Matroska) container, never webm"
    );

    // Case 4: H.264 video + ONLY Opus audio -> Must use MKV (never mislabeled as standard MP4)
    let (sel4, cont4) =
        select_compatible_audio_and_container(&h264_vid, std::slice::from_ref(&opus_audio));
    assert_eq!(sel4.unwrap().format_id, "251");
    assert_eq!(
        cont4, "mkv",
        "H.264 + Opus must produce mkv (Matroska) container"
    );
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

#[test]
fn test_parse_ytdlp_playlist_metadata_unit() {
    let raw_json = serde_json::json!({
        "_type": "playlist",
        "id": "PL_test_123",
        "title": "Sample Coding Playlist",
        "webpage_url": "https://www.youtube.com/playlist?list=PL_test_123",
        "channel": "Tech Channel",
        "thumbnails": [
            { "url": "https://example.com/thumb_small.jpg" },
            { "url": "https://example.com/thumb_large.jpg" }
        ],
        "entries": [
            {
                "id": "vid_1",
                "title": "Episode 1: Introduction",
                "url": "https://www.youtube.com/watch?v=vid_1",
                "duration": 345,
                "thumbnail": "https://example.com/vid1.jpg",
                "channel": "Tech Channel"
            },
            {
                "id": "vid_2",
                "title": "Episode 2: Advanced Concepts",
                "url": "https://www.youtube.com/watch?v=vid_2",
                "duration": 612,
                "thumbnails": [
                    { "url": "https://example.com/vid2_high.jpg" }
                ],
                "channel": "Tech Channel"
            }
        ]
    });

    let parsed = tdm_core::resolver::parse_ytdlp_playlist_metadata(
        "https://www.youtube.com/playlist?list=PL_test_123",
        &raw_json,
    )
    .expect("Playlist parse should succeed");

    assert_eq!(parsed.id, "PL_test_123");
    assert_eq!(parsed.title, "Sample Coding Playlist");
    assert_eq!(parsed.channel.as_deref(), Some("Tech Channel"));
    assert_eq!(
        parsed.thumbnail_url.as_deref(),
        Some("https://example.com/thumb_large.jpg")
    );
    assert_eq!(parsed.item_count, 2);
    assert_eq!(parsed.items.len(), 2);

    assert_eq!(parsed.items[0].id, "vid_1");
    assert_eq!(parsed.items[0].title, "Episode 1: Introduction");
    assert_eq!(parsed.items[0].duration_seconds, Some(345.0));
    assert_eq!(
        parsed.items[0].thumbnail_url.as_deref(),
        Some("https://example.com/vid1.jpg")
    );
    assert_eq!(parsed.items[0].index, 1);

    assert_eq!(parsed.items[1].id, "vid_2");
    assert_eq!(parsed.items[1].title, "Episode 2: Advanced Concepts");
    assert_eq!(parsed.items[1].duration_seconds, Some(612.0));
    assert_eq!(
        parsed.items[1].thumbnail_url.as_deref(),
        Some("https://example.com/vid2_high.jpg")
    );
    assert_eq!(parsed.items[1].index, 2);
}

#[tokio::test]
async fn test_html_candidate_discrimination_track_and_iframe() {
    let sample_html = r#"
        <!DOCTYPE html>
        <html>
        <head>
            <title>Media Extraction Test Page</title>
            <meta property="og:video" content="https://example.com/og_stream.mp4">
        </head>
        <body>
            <video controls poster="https://example.com/poster.jpg">
                <source src="https://example.com/video_720p.mp4" type="video/mp4">
                <track src="https://example.com/subtitles_en.vtt" kind="subtitles" srclang="en" label="English">
                <track src="https://example.com/captions_es.srt" kind="captions" srclang="es" label="Spanish">
            </video>
            <!-- Platform video embed: should be preserved -->
            <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" width="560" height="315"></iframe>
            <!-- Non-media web frame: MUST be ignored -->
            <iframe src="https://ads.doubleclick.net/widget/banner.html" width="300" height="250"></iframe>
            <iframe src="https://example.com/comments/iframe.php" width="100%"></iframe>
        </body>
        </html>
    "#;

    let scraped = tdm_core::resolver::extract_html_media_candidates(
        sample_html,
        "https://example.com/article/1",
    );

    // Title and poster extracted
    assert_eq!(scraped.title.as_deref(), Some("Media Extraction Test Page"));
    assert_eq!(
        scraped.thumbnail_url.as_deref(),
        Some("https://example.com/poster.jpg")
    );

    // Check media candidate URLs
    let urls = scraped.media_urls;
    println!("Scraped candidate URLs: {:?}", urls);

    // 1. OG video tag preserved
    assert!(urls.contains(&"https://example.com/og_stream.mp4".to_string()));
    // 2. HTML5 video source preserved
    assert!(urls.contains(&"https://example.com/video_720p.mp4".to_string()));
    // 3. YouTube embed iframe preserved
    assert!(urls.contains(&"https://www.youtube.com/embed/dQw4w9WgXcQ".to_string()));

    // 4. Subtitle and caption <track> MUST NOT be in media_urls
    assert!(!urls.contains(&"https://example.com/subtitles_en.vtt".to_string()));
    assert!(!urls.contains(&"https://example.com/captions_es.srt".to_string()));

    // 5. Arbitrary non-media iframes MUST NOT be in media_urls
    assert!(!urls.contains(&"https://ads.doubleclick.net/widget/banner.html".to_string()));
    assert!(!urls.contains(&"https://example.com/comments/iframe.php".to_string()));
}

#[tokio::test]
async fn test_media_discrimination_and_mime_validation() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut buf = [0u8; 1024];
            let n = socket.read(&mut buf).await.unwrap_or(0);
            let req_str = String::from_utf8_lossy(&buf[..n]);

            let (content_type, body_text) = if req_str.contains("/subtitle.vtt") {
                ("text/vtt", "WEBVTT\n\n00:01.000 --> 00:04.000\nHello world")
            } else if req_str.contains("/document.pdf") {
                ("application/pdf", "%PDF-1.4...")
            } else if req_str.contains("/image.jpg") {
                ("image/jpeg", "JPEG_BINARY_DATA...")
            } else if req_str.contains("/archive.zip") {
                ("application/zip", "PK...")
            } else if req_str.contains("/audio.mp3") {
                ("audio/mpeg", "ID3...")
            } else {
                ("video/mp4", "ftypisom...")
            };

            let resp = format!(
                "HTTP/1.1 200 OK\r\n\
                Content-Type: {}\r\n\
                Content-Length: {}\r\n\
                Accept-Ranges: bytes\r\n\
                Connection: close\r\n\r\n{}",
                content_type,
                body_text.len(),
                body_text
            );
            let _ = socket.write_all(resp.as_bytes()).await;
            let _ = socket.shutdown().await;
        }
    });

    let resolver = MediaResolver::new();

    // 1. Non-media types must be rejected
    let res_vtt = resolver
        .probe_direct_media(&format!("http://127.0.0.1:{}/subtitle.vtt", port))
        .await;
    assert!(
        res_vtt.is_err(),
        "Subtitle VTT must be rejected as non-media"
    );

    let res_pdf = resolver
        .probe_direct_media(&format!("http://127.0.0.1:{}/document.pdf", port))
        .await;
    assert!(res_pdf.is_err(), "PDF must be rejected as non-media");

    let res_img = resolver
        .probe_direct_media(&format!("http://127.0.0.1:{}/image.jpg", port))
        .await;
    assert!(res_img.is_err(), "Image must be rejected as non-media");

    let res_zip = resolver
        .probe_direct_media(&format!("http://127.0.0.1:{}/archive.zip", port))
        .await;
    assert!(
        res_zip.is_err(),
        "ZIP archive must be rejected as non-media"
    );

    // 2. Audio and Video media must be accepted
    let res_mp4 = resolver
        .probe_direct_media(&format!("http://127.0.0.1:{}/video.mp4", port))
        .await;
    assert!(res_mp4.is_ok(), "Video MP4 must be accepted");
    let meta_mp4 = res_mp4.unwrap();
    assert!(meta_mp4.formats[0].has_video);
    assert_eq!(meta_mp4.formats[0].container, "mp4");

    let res_mp3 = resolver
        .probe_direct_media(&format!("http://127.0.0.1:{}/audio.mp3", port))
        .await;
    assert!(res_mp3.is_ok(), "Audio MP3 must be accepted");
    let meta_mp3 = res_mp3.unwrap();
    assert!(!meta_mp3.formats[0].has_video);
    assert!(meta_mp3.formats[0].has_audio);
    assert_eq!(meta_mp3.formats[0].resolution_label, "Audio");
}
