use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use tdm_core::dash::downloader::validate_dash_segment;
use tdm_core::dash::muxer::{find_ffmpeg, probe_duration, probe_media_streams};
use tdm_core::dash::parser::{
    format_segment_template, parse_iso8601_duration, parse_mpd_manifest,
    resolve_representation_segments, select_best_representations,
};
use tdm_core::{Database, DownloadManager, EventBus, JobState, JobType};

/// Helper to wait for a job to reach a terminal state
async fn wait_for_job_terminal(
    manager: &DownloadManager,
    job_id: &str,
    timeout: Duration,
) -> Result<JobState, String> {
    let start = std::time::Instant::now();
    loop {
        if start.elapsed() > timeout {
            return Err("Timed out waiting for terminal state".to_string());
        }
        if let Ok(Some(job)) = manager.get_download(job_id) {
            if job.state.is_terminal() {
                return Ok(job.state);
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Helper to generate a real, standard fMP4 DASH fixture using FFmpeg
fn generate_fmp4_dash_fixture(out_dir: &Path, duration_sec: u32, with_audio: bool) -> PathBuf {
    let ffmpeg = find_ffmpeg().expect("FFmpeg must be installed for DASH tests");
    let mpd_path = out_dir.join("manifest.mpd");

    let mut cmd = Command::new(&ffmpeg);
    cmd.current_dir(out_dir);
    cmd.arg("-y").arg("-f").arg("lavfi").arg("-i").arg(format!(
        "testsrc=duration={}:size=160x120:rate=10",
        duration_sec
    ));

    if with_audio {
        cmd.arg("-f")
            .arg("lavfi")
            .arg("-i")
            .arg(format!("sine=frequency=440:duration={}", duration_sec))
            .arg("-c:v")
            .arg("libx264")
            .arg("-c:a")
            .arg("aac");
    } else {
        cmd.arg("-c:v").arg("libx264");
    }

    cmd.arg("-f")
        .arg("dash")
        .arg("-seg_duration")
        .arg("1")
        .arg("-use_timeline")
        .arg("1")
        .arg("-use_template")
        .arg("1")
        .arg("manifest.mpd");

    let res = cmd
        .output()
        .expect("Failed to execute FFmpeg for DASH test");
    assert!(res.status.success(), "FFmpeg DASH generation failed");
    assert!(mpd_path.exists());
    mpd_path
}

/// Helper to generate a real WebM DASH fixture using FFmpeg
fn generate_webm_dash_fixture(out_dir: &Path, duration_sec: u32) -> PathBuf {
    let ffmpeg = find_ffmpeg().expect("FFmpeg must be installed for DASH tests");
    let mpd_path = out_dir.join("manifest_webm.mpd");

    let mut cmd = Command::new(&ffmpeg);
    cmd.current_dir(out_dir);
    cmd.arg("-y")
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg(format!(
            "testsrc=duration={}:size=160x120:rate=10",
            duration_sec
        ))
        .arg("-c:v")
        .arg("libvpx-vp9")
        .arg("-f")
        .arg("dash")
        .arg("-seg_duration")
        .arg("1")
        .arg("manifest_webm.mpd");

    let res = cmd
        .output()
        .expect("Failed to run FFmpeg for WebM DASH fixture");
    assert!(res.status.success(), "FFmpeg WebM DASH generation failed");
    assert!(mpd_path.exists());
    mpd_path
}

// =========================================================================
// TEST 1: ISO 8601 Duration Parser & Template Formatting Unit Verification
// =========================================================================
#[test]
fn test_dash_parser_duration_and_template_formatting() {
    // 1. Duration parsing
    assert_eq!(parse_iso8601_duration("PT30S"), Some(30.0));
    assert_eq!(parse_iso8601_duration("PT1M15.5S"), Some(75.5));
    assert_eq!(parse_iso8601_duration("PT1H2M3S"), Some(3723.0));
    assert_eq!(parse_iso8601_duration("P0Y0M0DT0H0M2.000S"), Some(2.0));
    assert_eq!(parse_iso8601_duration("INVALID"), None);

    // 2. Template formatting
    let pattern1 = "chunk-stream$RepresentationID$-$Number%05d$.m4s";
    let formatted1 = format_segment_template(pattern1, "video_1", Some(42), None, None);
    assert_eq!(formatted1, "chunk-streamvideo_1-00042.m4s");

    let pattern2 = "media-$Time$-$Bandwidth%08d$.m4s";
    let formatted2 = format_segment_template(pattern2, "rep", None, Some(96000), Some(2500000));
    assert_eq!(formatted2, "media-96000-02500000.m4s");

    let pattern3 = "segment-$$escaped$$-$Number$.m4s";
    let formatted3 = format_segment_template(pattern3, "rep", Some(7), None, None);
    assert_eq!(formatted3, "segment-$escaped$-7.m4s");
}

// =========================================================================
// TEST 2: Dynamic Live Manifest & DRM ContentProtection Rejection
// =========================================================================
#[test]
fn test_dash_parser_rejects_dynamic_live_and_drm() {
    let live_mpd = r#"<?xml version="1.0"?>
    <MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic">
        <Period id="0">
            <AdaptationSet id="0" contentType="video">
                <Representation id="v0" bandwidth="1000000">
                    <SegmentTemplate media="chunk-$Number$.m4s" duration="1" timescale="1"/>
                </Representation>
            </AdaptationSet>
        </Period>
    </MPD>"#;

    let parsed_live = parse_mpd_manifest(live_mpd, "http://example.com/manifest.mpd").unwrap();
    let res = select_best_representations(&parsed_live);
    assert!(res.is_err());
    assert!(res
        .unwrap_err()
        .to_string()
        .contains("Live MPEG-DASH streaming is not supported"));

    // Widevine DRM ContentProtection rejection
    let drm_mpd = r#"<?xml version="1.0"?>
    <MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">
        <Period id="0">
            <AdaptationSet id="0" contentType="video">
                <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
                <Representation id="v0" bandwidth="1000000">
                    <SegmentTemplate media="chunk-$Number$.m4s" duration="1" timescale="1"/>
                </Representation>
            </AdaptationSet>
        </Period>
    </MPD>"#;

    let parsed_drm = parse_mpd_manifest(drm_mpd, "http://example.com/manifest.mpd").unwrap();
    let drm_res = select_best_representations(&parsed_drm);
    assert!(drm_res.is_err());
    assert!(drm_res
        .unwrap_err()
        .to_string()
        .contains("Unsupported protected MPEG-DASH DRM scheme"));

    // Malformed XML rejection
    let malformed = "NOT XML <MPD <>>>";
    assert!(parse_mpd_manifest(malformed, "http://example.com/manifest.mpd").is_err());
}

// =========================================================================
// TEST 3: Nested BaseURL Resolution & Multi-Period Timeline Parsing
// =========================================================================
#[test]
fn test_dash_nested_base_url_and_multi_period_resolution() {
    let multi_period_mpd = r#"<?xml version="1.0"?>
    <MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT4.0S">
        <BaseURL>https://cdn.tori.io/dash/</BaseURL>
        <Period id="p1" duration="PT2.0S">
            <BaseURL>period1/</BaseURL>
            <AdaptationSet id="0" contentType="video">
                <BaseURL>video/</BaseURL>
                <Representation id="v1080" bandwidth="5000000" width="1920" height="1080">
                    <SegmentTemplate initialization="init-$RepresentationID$.mp4"
                                     media="chunk-$Number%04d$.m4s"
                                     timescale="1000"
                                     duration="1000"
                                     startNumber="1"/>
                </Representation>
                <Representation id="v720" bandwidth="2500000" width="1280" height="720">
                    <SegmentTemplate initialization="init-$RepresentationID$.mp4"
                                     media="chunk-$Number%04d$.m4s"
                                     timescale="1000"
                                     duration="1000"
                                     startNumber="1"/>
                </Representation>
            </AdaptationSet>
        </Period>
        <Period id="p2" duration="PT2.0S">
            <BaseURL>period2/</BaseURL>
            <AdaptationSet id="0" contentType="video">
                <Representation id="v1080_p2" bandwidth="5000000" width="1920" height="1080">
                    <SegmentTemplate initialization="init.mp4"
                                     media="seg-$Time$.m4s"
                                     timescale="1000">
                        <SegmentTimeline>
                            <S t="0" d="1000" r="1"/>
                        </SegmentTimeline>
                    </SegmentTemplate>
                </Representation>
            </AdaptationSet>
        </Period>
    </MPD>"#;

    let manifest =
        parse_mpd_manifest(multi_period_mpd, "https://cdn.tori.io/dash/manifest.mpd").unwrap();
    assert_eq!(manifest.periods.len(), 2);

    let tracks = select_best_representations(&manifest).unwrap();
    assert_eq!(tracks.video_representation.id, "v1080");
    assert_eq!(tracks.video_representation.bandwidth, 5000000);

    let resolved = resolve_representation_segments(
        &manifest,
        tracks.period,
        tracks.video_adaptation,
        tracks.video_representation,
        "video",
    )
    .unwrap();
    assert_eq!(
        resolved.init_segment.unwrap().uri,
        "https://cdn.tori.io/dash/period1/video/init-v1080.mp4"
    );
    assert_eq!(resolved.media_segments.len(), 2);
    assert_eq!(
        resolved.media_segments[0].uri,
        "https://cdn.tori.io/dash/period1/video/chunk-0001.m4s"
    );
    assert_eq!(
        resolved.media_segments[1].uri,
        "https://cdn.tori.io/dash/period1/video/chunk-0002.m4s"
    );

    // Verify Period 2 with SegmentTimeline & Repeated segments (r=1 means 2 segments)
    let p2 = &manifest.periods[1];
    let p2_ad = &p2.adaptation_sets[0];
    let p2_rep = &p2_ad.representations[0];
    let p2_resolved =
        resolve_representation_segments(&manifest, p2, p2_ad, p2_rep, "video").unwrap();
    assert_eq!(p2_resolved.media_segments.len(), 2);
    assert_eq!(
        p2_resolved.media_segments[0].uri,
        "https://cdn.tori.io/dash/period2/seg-0.m4s"
    );
    assert_eq!(
        p2_resolved.media_segments[1].uri,
        "https://cdn.tori.io/dash/period2/seg-1000.m4s"
    );
}

// =========================================================================
// TEST 4: Real Single-Period Video-Only DASH Download & Validated Muxing
// =========================================================================
#[tokio::test]
async fn test_dash_single_period_video_only_download_and_muxing() {
    let temp_fixture_dir = tempdir().unwrap();
    let _mpd_path = generate_fmp4_dash_fixture(temp_fixture_dir.path(), 2, false);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    let fixture_dir = temp_fixture_dir.path().to_path_buf();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let f_dir = fixture_dir.clone();

                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 4096];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);

                        let path_part = req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/");
                        let clean_filename = path_part.trim_start_matches('/');

                        if clean_filename == "manifest.mpd" {
                            let content = fs::read_to_string(f_dir.join("manifest.mpd")).unwrap_or_default();
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/dash+xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                content.len(), content
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if let Ok(bytes) = fs::read(f_dir.join(clean_filename)) {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: video/iso.segment\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                bytes.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&bytes).await;
                        } else {
                            let resp = "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n";
                            let _ = socket.write_all(resp.as_bytes()).await;
                        }
                    });
                }
            }
        }
    });

    let temp_client_dir = tempdir().unwrap();
    let db = Database::open(temp_client_dir.path().join("dash_test.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let manifest_url = format!("http://127.0.0.1:{}/manifest.mpd", port);
    let job = manager
        .create_download(&manifest_url, temp_client_dir.path())
        .await
        .unwrap();

    assert_eq!(job.job_type, JobType::DashVod);
    manager.start_download(&job.id).unwrap();

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .unwrap();
    assert_eq!(state, JobState::Completed);

    let output_file = std::path::Path::new(&job.target_path);
    assert!(output_file.exists());
    assert!(fs::metadata(output_file).unwrap().len() > 1024);

    let dur = probe_duration(output_file).expect("Duration probe failed");
    assert!(
        (1.5..=2.5).contains(&dur),
        "Duration {:.2}s outside expected 2s range",
        dur
    );

    cancel.cancel();
}

// =========================================================================
// TEST 5: Real Dual Audio & Video DASH Download with Multi-Stream FFprobe Validation
// =========================================================================
#[tokio::test]
async fn test_dash_separate_audio_and_video_download_and_muxing() {
    let temp_fixture_dir = tempdir().unwrap();
    let _ = generate_fmp4_dash_fixture(temp_fixture_dir.path(), 2, true);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    let fixture_dir = temp_fixture_dir.path().to_path_buf();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let f_dir = fixture_dir.clone();

                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 4096];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);

                        let path_part = req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/");
                        let clean_filename = path_part.trim_start_matches('/');

                        if clean_filename == "manifest.mpd" {
                            let content = fs::read_to_string(f_dir.join("manifest.mpd")).unwrap_or_default();
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/dash+xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                content.len(), content
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if let Ok(bytes) = fs::read(f_dir.join(clean_filename)) {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                bytes.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&bytes).await;
                        } else {
                            let resp = "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n";
                            let _ = socket.write_all(resp.as_bytes()).await;
                        }
                    });
                }
            }
        }
    });

    let temp_client_dir = tempdir().unwrap();
    let db = Database::open(temp_client_dir.path().join("dual_dash.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let manifest_url = format!("http://127.0.0.1:{}/manifest.mpd", port);
    let job = manager
        .create_download(&manifest_url, temp_client_dir.path())
        .await
        .unwrap();

    manager.start_download(&job.id).unwrap();

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .unwrap();
    assert_eq!(state, JobState::Completed);

    let output_file = std::path::Path::new(&job.target_path);
    assert!(output_file.exists());

    // Verify with detailed probe that BOTH audio and video streams exist in final MP4
    let (has_video, has_audio, dur) =
        probe_media_streams(output_file).expect("Detailed probe failed");
    assert!(has_video, "Output MP4 must contain video stream");
    assert!(has_audio, "Output MP4 must contain separate audio stream");
    assert!(
        (1.5..=2.5).contains(&dur),
        "Duration {:.2}s outside expected 2s range",
        dur
    );

    cancel.cancel();
}

// =========================================================================
// TEST 6: Compatible WebM MPEG-DASH Output Verification
// =========================================================================
#[tokio::test]
async fn test_dash_webm_stream_download_and_muxing() {
    let temp_fixture_dir = tempdir().unwrap();
    let _ = generate_webm_dash_fixture(temp_fixture_dir.path(), 2);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    let fixture_dir = temp_fixture_dir.path().to_path_buf();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let f_dir = fixture_dir.clone();

                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 4096];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);

                        let path_part = req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/");
                        let clean_filename = path_part.trim_start_matches('/');

                        if clean_filename == "manifest_webm.mpd" {
                            let content = fs::read_to_string(f_dir.join("manifest_webm.mpd")).unwrap_or_default();
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/dash+xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                content.len(), content
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if let Ok(bytes) = fs::read(f_dir.join(clean_filename)) {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                bytes.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&bytes).await;
                        } else {
                            let resp = "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n";
                            let _ = socket.write_all(resp.as_bytes()).await;
                        }
                    });
                }
            }
        }
    });

    let temp_client_dir = tempdir().unwrap();
    let db = Database::open(temp_client_dir.path().join("webm_dash.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let manifest_url = format!("http://127.0.0.1:{}/manifest_webm.mpd", port);
    let job = manager
        .create_download(&manifest_url, temp_client_dir.path())
        .await
        .unwrap();

    manager.start_download(&job.id).unwrap();

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .unwrap();
    assert_eq!(state, JobState::Completed);

    let output_file = std::path::Path::new(&job.target_path);
    assert!(output_file.exists());
    let dur = probe_duration(output_file).expect("WebM probe failed");
    assert!(
        (1.5..=2.5).contains(&dur),
        "Duration {:.2}s outside expected 2s range",
        dur
    );

    cancel.cancel();
}

// =========================================================================
// TEST 7: SegmentList and Byte-Range Subsegments
// =========================================================================
#[tokio::test]
async fn test_dash_segment_list_and_byterange_download() {
    let temp_fixture_dir = tempdir().unwrap();
    let _ = generate_fmp4_dash_fixture(temp_fixture_dir.path(), 2, false);

    // Read the generated init and chunk files to serve as byte ranges
    let init_bytes = fs::read(temp_fixture_dir.path().join("init-stream0.m4s")).unwrap();
    let init_len = init_bytes.len();
    let seg1_bytes = fs::read(temp_fixture_dir.path().join("chunk-stream0-00001.m4s")).unwrap();

    let mut combined_payload = init_bytes;
    let seg1_offset = combined_payload.len();
    combined_payload.extend_from_slice(&seg1_bytes);
    let seg1_end = combined_payload.len() - 1;

    let payload_arc = Arc::new(combined_payload);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    let pl = payload_arc.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let pl_clone = pl.clone();

                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 4096];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);

                        if req.contains("GET /seglist.mpd") {
                            let mpd = format!(
                                r#"<?xml version="1.0"?>
                                <MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT2.0S">
                                    <Period id="0">
                                        <AdaptationSet id="0" contentType="video">
                                            <Representation id="0" mimeType="video/mp4" codecs="avc1.64001f" bandwidth="50000">
                                                <SegmentList timescale="1000">
                                                    <Initialization sourceURL="combined.mp4" range="0-{}"/>
                                                    <SegmentURL media="combined.mp4" mediaRange="{}-{}"/>
                                                </SegmentList>
                                            </Representation>
                                        </AdaptationSet>
                                    </Period>
                                </MPD>"#,
                                init_len - 1,
                                seg1_offset,
                                seg1_end
                            );
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/dash+xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                mpd.len(), mpd
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if req.contains("GET /combined.mp4") {
                            let range_header = req.lines().find(|l| l.to_lowercase().starts_with("range:"));
                            if let Some(r) = range_header {
                                let val = r.split(':').nth(1).unwrap().trim();
                                if let Some(bytes_spec) = val.strip_prefix("bytes=") {
                                    let parts: Vec<&str> = bytes_spec.split('-').collect();
                                    let start: usize = parts[0].parse().unwrap_or(0);
                                    let end: usize = parts[1].parse().unwrap_or(pl_clone.len() - 1);
                                    let slice = &pl_clone[start..=end.min(pl_clone.len() - 1)];

                                    let resp = format!(
                                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                        start, end, pl_clone.len(), slice.len()
                                    );
                                    let _ = socket.write_all(resp.as_bytes()).await;
                                    let _ = socket.write_all(slice).await;
                                }
                            }
                        }
                    });
                }
            }
        }
    });

    let temp_client_dir = tempdir().unwrap();
    let db = Database::open(temp_client_dir.path().join("seglist_dash.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let manifest_url = format!("http://127.0.0.1:{}/seglist.mpd", port);
    let job = manager
        .create_download(&manifest_url, temp_client_dir.path())
        .await
        .unwrap();

    manager.start_download(&job.id).unwrap();

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .unwrap();
    assert_eq!(state, JobState::Completed);

    let output_file = std::path::Path::new(&job.target_path);
    assert!(output_file.exists());
    let dur = probe_duration(output_file).expect("SegList output probe failed");
    assert!(
        (1.5..=2.5).contains(&dur),
        "Duration {:.2}s outside expected 2s range",
        dur
    );

    cancel.cancel();
}

// =========================================================================
// TEST 8: Transient HTTP 429/503 Retries with Backoff Recovery
// =========================================================================
#[tokio::test]
async fn test_dash_transient_429_503_retry_recovery() {
    let temp_fixture_dir = tempdir().unwrap();
    let _ = generate_fmp4_dash_fixture(temp_fixture_dir.path(), 2, false);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    let fixture_dir = temp_fixture_dir.path().to_path_buf();
    let throttle_count = Arc::new(AtomicUsize::new(0));
    let tc = throttle_count.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let f_dir = fixture_dir.clone();
                    let t_counter = tc.clone();

                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 4096];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);

                        let path_part = req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/");
                        let clean_filename = path_part.trim_start_matches('/');

                        if clean_filename == "manifest.mpd" {
                            let content = fs::read_to_string(f_dir.join("manifest.mpd")).unwrap_or_default();
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/dash+xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                content.len(), content
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if clean_filename.contains("chunk-stream0") && t_counter.fetch_add(1, Ordering::SeqCst) < 2 {
                            // First 2 segment requests return HTTP 429 Too Many Requests to simulate rate limiting
                            let resp = "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 1\r\nConnection: close\r\n\r\n";
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if let Ok(bytes) = fs::read(f_dir.join(clean_filename)) {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                bytes.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&bytes).await;
                        } else {
                            let resp = "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n";
                            let _ = socket.write_all(resp.as_bytes()).await;
                        }
                    });
                }
            }
        }
    });

    let temp_client_dir = tempdir().unwrap();
    let db = Database::open(temp_client_dir.path().join("retry_dash.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let manifest_url = format!("http://127.0.0.1:{}/manifest.mpd", port);
    let job = manager
        .create_download(&manifest_url, temp_client_dir.path())
        .await
        .unwrap();

    manager.start_download(&job.id).unwrap();

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .unwrap();
    assert_eq!(state, JobState::Completed);

    // Verify that throttle was encountered and retried successfully
    assert!(
        throttle_count.load(Ordering::SeqCst) >= 2,
        "Expected 429 retries were not observed"
    );

    let output_file = std::path::Path::new(&job.target_path);
    assert!(output_file.exists());
    let dur = probe_duration(output_file).expect("Duration probe failed");
    assert!(
        (1.5..=2.5).contains(&dur),
        "Duration {:.2}s outside expected 2s range",
        dur
    );

    cancel.cancel();
}

// =========================================================================
// TEST 9: Pause, Resume and Segment Recovery Continuity
// =========================================================================
#[tokio::test]
async fn test_dash_pause_resume_and_recovery_continuity() {
    let temp_fixture_dir = tempdir().unwrap();
    let _ = generate_fmp4_dash_fixture(temp_fixture_dir.path(), 2, false);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    let fixture_dir = temp_fixture_dir.path().to_path_buf();
    let init_requests = Arc::new(AtomicUsize::new(0));
    let ir = init_requests.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let f_dir = fixture_dir.clone();
                    let ir_clone = ir.clone();

                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 4096];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);

                        let path_part = req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/");
                        let clean_filename = path_part.trim_start_matches('/');

                        if clean_filename == "manifest.mpd" {
                            let content = fs::read_to_string(f_dir.join("manifest.mpd")).unwrap_or_default();
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/dash+xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                content.len(), content
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if clean_filename.contains("init-stream0") {
                            ir_clone.fetch_add(1, Ordering::SeqCst);
                            let bytes = fs::read(f_dir.join(clean_filename)).unwrap();
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                bytes.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&bytes).await;
                        } else if clean_filename.contains("chunk-stream0-00001") {
                            // Delay segment 1 slightly to catch pause
                            tokio::time::sleep(Duration::from_millis(150)).await;
                            let bytes = fs::read(f_dir.join(clean_filename)).unwrap();
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                bytes.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&bytes).await;
                        } else if let Ok(bytes) = fs::read(f_dir.join(clean_filename)) {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                bytes.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&bytes).await;
                        }
                    });
                }
            }
        }
    });

    let temp_client_dir = tempdir().unwrap();
    let db = Database::open(temp_client_dir.path().join("pause_dash.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let manifest_url = format!("http://127.0.0.1:{}/manifest.mpd", port);
    let job = manager
        .create_download(&manifest_url, temp_client_dir.path())
        .await
        .unwrap();

    manager.start_download(&job.id).unwrap();

    // Wait until video_init is downloaded
    let work_dir = std::path::PathBuf::from(format!("{}.dash_parts", job.temp_path));
    let init_file = work_dir.join("video_init.mp4");
    let mut wait_count = 0;
    while !init_file.exists() && wait_count < 100 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        wait_count += 1;
    }
    assert!(init_file.exists());
    assert!(validate_dash_segment(&init_file, None, false));

    // Pause download
    manager.pause_download(&job.id).unwrap();

    let mut paused = false;
    for _ in 0..60 {
        if let Ok(Some(j)) = manager.get_download(&job.id) {
            if j.state == JobState::Paused {
                paused = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(paused, "Download should transition to Paused state");

    let initial_init_requests = init_requests.load(Ordering::SeqCst);
    assert!(initial_init_requests >= 1);

    // Resume download
    manager.resume_download(&job.id).unwrap();

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .unwrap();
    assert_eq!(state, JobState::Completed);

    // Verify init segment was NOT requested again upon resume
    let final_init_requests = init_requests.load(Ordering::SeqCst);
    assert_eq!(
        final_init_requests, initial_init_requests,
        "init segment was re-requested on resume despite valid cached file"
    );

    let output_file = std::path::Path::new(&job.target_path);
    assert!(output_file.exists());
    let dur = probe_duration(output_file).expect("Duration probe failed");
    assert!(
        (1.5..=2.5).contains(&dur),
        "Duration {:.2}s outside expected 2s range",
        dur
    );

    cancel.cancel();
}
