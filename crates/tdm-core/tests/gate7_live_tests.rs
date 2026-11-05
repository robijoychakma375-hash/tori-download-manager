use std::fs;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use tdm_core::hls::muxer::{find_ffmpeg, probe_duration};
use tdm_core::live::{
    detect_live_protocol, record_live_stream, LiveProtocol, LiveRecordingOptions,
};
use tdm_core::{Database, DownloadJob, DownloadManager, EventBus, JobState, JobType, Priority};

/// Helper to generate a 1-second real H.264 MPEG-TS video segment using FFmpeg
fn generate_test_ts_segment(out_path: &std::path::Path, duration_sec: u32) -> Vec<u8> {
    let ffmpeg = find_ffmpeg().expect("FFmpeg must be installed for Gate 7 tests");
    let res = Command::new(&ffmpeg)
        .arg("-y")
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg(format!(
            "testsrc=duration={}:size=160x120:rate=10",
            duration_sec
        ))
        .arg("-c:v")
        .arg("libx264")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg(out_path)
        .output()
        .expect("Failed to run ffmpeg to generate test TS");
    assert!(res.status.success(), "ffmpeg testsrc failed");
    fs::read(out_path).expect("Failed to read generated TS segment")
}

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

/// Test 1: Protocol detection for all live streaming schemes and FFmpeg flag generation
#[test]
fn test_live_stream_protocol_detection_unit() {
    assert_eq!(
        detect_live_protocol("rtsp://10.0.0.1:554/stream1"),
        Some(LiveProtocol::Rtsp)
    );
    assert_eq!(
        detect_live_protocol("rtmp://live.twitch.tv/app/live_123"),
        Some(LiveProtocol::Rtmp)
    );
    assert_eq!(
        detect_live_protocol("rtmps://live-api-s.facebook.com:443/rtmp/"),
        Some(LiveProtocol::Rtmps)
    );
    assert_eq!(
        detect_live_protocol("srt://192.168.1.100:9998?mode=caller"),
        Some(LiveProtocol::Srt)
    );
    assert_eq!(
        detect_live_protocol("rist://@239.0.0.1:1234"),
        Some(LiveProtocol::Rist)
    );
    assert_eq!(
        detect_live_protocol("rtp://239.255.0.1:5004"),
        Some(LiveProtocol::Rtp)
    );
    assert_eq!(
        detect_live_protocol("udp://@127.0.0.1:12345"),
        Some(LiveProtocol::Udp)
    );
    assert_eq!(
        detect_live_protocol("mms://stream.example.com/live"),
        Some(LiveProtocol::Mms)
    );
    assert_eq!(
        detect_live_protocol("mmsh://stream.example.com/live"),
        Some(LiveProtocol::Mms)
    );
    assert_eq!(detect_live_protocol("https://example.com/video.mp4"), None);

    // Verify input flags for RTSP (TCP transport)
    let rtsp_flags = LiveProtocol::Rtsp.ffmpeg_input_flags();
    assert!(rtsp_flags.contains(&"-rtsp_transport"));
    assert!(rtsp_flags.contains(&"tcp"));

    // Verify input flags for RTMP (live flag)
    let rtmp_flags = LiveProtocol::Rtmp.ffmpeg_input_flags();
    assert!(rtmp_flags.contains(&"-rtmp_live"));
    assert!(rtmp_flags.contains(&"live"));

    // Verify input flags for UDP/RTP (FIFO sizing)
    let udp_flags = LiveProtocol::Udp.ffmpeg_input_flags();
    assert!(udp_flags.contains(&"-fifo_size"));
}

/// Test 2: Local UDP broadcast live stream recording
#[tokio::test]
async fn test_live_stream_udp_transport_real_recording() {
    let tmp = tempdir().unwrap();
    let db = Database::open(tmp.path().join("test.db")).unwrap();
    let event_bus = EventBus::default();

    let ffmpeg_bin = find_ffmpeg().expect("FFmpeg required for test");

    // Bind an ephemeral UDP port
    let sock = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let port = sock.local_addr().unwrap().port();
    drop(sock); // Release so FFmpeg can stream

    let stream_url = format!("udp://127.0.0.1:{}", port);
    let listen_url = format!("udp://127.0.0.1:{}?listen=1", port);
    let target_file = tmp.path().join("recorded_udp.mp4");
    let temp_file = tmp.path().join("recorded_udp.mp4.tdm-part");

    // Spawn an FFmpeg background generator to stream real video frames over UDP
    let mut streamer = Command::new(&ffmpeg_bin)
        .arg("-re")
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg("testsrc=duration=60:size=160x120:rate=10")
        .arg("-c:v")
        .arg("libx264")
        .arg("-preset")
        .arg("ultrafast")
        .arg("-tune")
        .arg("zerolatency")
        .arg("-g")
        .arg("10")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg("-f")
        .arg("mpegts")
        .arg(&stream_url)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("Failed to start UDP live test streamer");

    tokio::time::sleep(Duration::from_millis(300)).await;

    let job = DownloadJob {
        id: "job-live-udp".to_string(),
        url: listen_url.clone(),
        resolved_url: Some(listen_url.clone()),
        filename: "recorded_udp.mp4".to_string(),
        target_path: target_file.to_string_lossy().to_string(),
        temp_path: temp_file.to_string_lossy().to_string(),
        total_bytes: None,
        downloaded_bytes: 0,
        state: JobState::Downloading,
        job_type: JobType::LiveStream,
        priority: Priority::Normal,
        etag: None,
        last_modified: None,
        is_resumable: false,
        chunk_count: 1,
        error_message: None,
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
        thumbnail_url: None,
    };
    db.insert_job(&job).unwrap();

    let cancel = CancellationToken::new();
    let stop = CancellationToken::new();

    let record_fut = record_live_stream(
        &job,
        &db,
        &event_bus,
        &cancel,
        &stop,
        Some(LiveRecordingOptions {
            max_duration: Some(Duration::from_secs(2)),
        }),
    );

    let res = record_fut.await;
    let _ = streamer.kill();
    let _ = streamer.wait();

    assert!(res.is_ok(), "record_live_stream failed: {:?}", res);
    assert!(target_file.exists(), "Target file must exist");
    let size = fs::metadata(&target_file).unwrap().len();
    assert!(size > 1024, "File size {} must exceed 1024 bytes", size);

    // Verify playable duration via ffprobe
    let dur = probe_duration(&target_file).expect("Probe failed on recorded UDP video");
    assert!(
        dur > 0.5,
        "Recorded video duration {:.2}s should exceed 0.5s",
        dur
    );
}

/// Test 3: Local TCP stream recording to Matroska (.mkv) container
#[tokio::test]
async fn test_live_stream_tcp_recording_to_mkv() {
    let tmp = tempdir().unwrap();
    let db = Database::open(tmp.path().join("test.db")).unwrap();
    let event_bus = EventBus::default();

    let ffmpeg_bin = find_ffmpeg().expect("FFmpeg required for test");

    // Bind ephemeral TCP listener
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    let tcp_url = format!("tcp://127.0.0.1:{}?listen", port);
    let client_url = format!("tcp://127.0.0.1:{}", port);

    let target_file = tmp.path().join("recorded_stream.mkv");
    let temp_file = tmp.path().join("recorded_stream.mkv.tdm-part");

    // Start FFmpeg listener streaming MPEG-TS over TCP
    let mut streamer = Command::new(&ffmpeg_bin)
        .arg("-re")
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg("testsrc=duration=5:size=160x120:rate=10")
        .arg("-c:v")
        .arg("libx264")
        .arg("-preset")
        .arg("ultrafast")
        .arg("-tune")
        .arg("zerolatency")
        .arg("-g")
        .arg("10")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg("-f")
        .arg("mpegts")
        .arg(&tcp_url)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("Failed to start TCP live test streamer");

    tokio::time::sleep(Duration::from_millis(400)).await;

    let job = DownloadJob {
        id: "job-live-tcp".to_string(),
        url: client_url.clone(),
        resolved_url: Some(client_url.clone()),
        filename: "recorded_stream.mkv".to_string(),
        target_path: target_file.to_string_lossy().to_string(),
        temp_path: temp_file.to_string_lossy().to_string(),
        total_bytes: None,
        downloaded_bytes: 0,
        state: JobState::Downloading,
        job_type: JobType::LiveStream,
        priority: Priority::Normal,
        etag: None,
        last_modified: None,
        is_resumable: false,
        chunk_count: 1,
        error_message: None,
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
        thumbnail_url: None,
    };
    db.insert_job(&job).unwrap();

    let cancel = CancellationToken::new();
    let stop = CancellationToken::new();

    let res = record_live_stream(
        &job,
        &db,
        &event_bus,
        &cancel,
        &stop,
        Some(LiveRecordingOptions {
            max_duration: Some(Duration::from_secs(2)),
        }),
    )
    .await;

    let _ = streamer.kill();
    let _ = streamer.wait();

    assert!(res.is_ok(), "TCP live recording failed: {:?}", res);
    assert!(target_file.exists());
    let size = fs::metadata(&target_file).unwrap().len();
    assert!(size > 1024);

    let dur = probe_duration(&target_file).expect("Probe failed on recorded MKV");
    assert!(dur > 0.5, "Duration {:.2}s should exceed 0.5s", dur);
}

/// Test 4: Live HLS sliding window playlist test without #EXT-X-ENDLIST
#[tokio::test]
async fn test_live_stream_sliding_window_hls_recording() {
    let tmp = tempdir().unwrap();
    let db = Database::open(tmp.path().join("test.db")).unwrap();
    let event_bus = EventBus::default();

    // Generate two real TS segments
    let seg0_bytes = generate_test_ts_segment(&tmp.path().join("fixture0.ts"), 1);
    let seg1_bytes = generate_test_ts_segment(&tmp.path().join("fixture1.ts"), 1);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let seg0 = Arc::new(seg0_bytes);
    let seg1 = Arc::new(seg1_bytes);
    let sequence = Arc::new(AtomicUsize::new(100));

    let s0 = seg0.clone();
    let s1 = seg1.clone();
    let seq = sequence.clone();

    tokio::spawn(async move {
        loop {
            let (mut socket, _) = match listener.accept().await {
                Ok(conn) => conn,
                Err(_) => break,
            };

            let s0_clone = s0.clone();
            let s1_clone = s1.clone();
            let seq_clone = seq.clone();

            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                let n = match socket.read(&mut buf).await {
                    Ok(n) if n > 0 => n,
                    _ => return,
                };
                let req_str = String::from_utf8_lossy(&buf[..n]);

                if req_str.contains("GET /live.m3u8") {
                    let current_seq = seq_clone.fetch_add(1, Ordering::SeqCst);
                    // Dynamic live playlist without #EXT-X-ENDLIST
                    let body = format!(
                        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:{}\n#EXTINF:1.0,\n/seg0.ts\n#EXTINF:1.0,\n/seg1.ts\n",
                        current_seq
                    );
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                } else if req_str.contains("GET /seg0.ts") {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: video/MP2T\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        s0_clone.len()
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                    let _ = socket.write_all(&s0_clone).await;
                } else if req_str.contains("GET /seg1.ts") {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: video/MP2T\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        s1_clone.len()
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                    let _ = socket.write_all(&s1_clone).await;
                }
            });
        }
    });

    let live_url = format!("http://{}/live.m3u8", addr);
    let target_file = tmp.path().join("recorded_live_hls.mp4");
    let temp_file = tmp.path().join("recorded_live_hls.mp4.tdm-part");

    let job = DownloadJob {
        id: "job-live-hls".to_string(),
        url: live_url.clone(),
        resolved_url: Some(live_url.clone()),
        filename: "recorded_live_hls.mp4".to_string(),
        target_path: target_file.to_string_lossy().to_string(),
        temp_path: temp_file.to_string_lossy().to_string(),
        total_bytes: None,
        downloaded_bytes: 0,
        state: JobState::Downloading,
        job_type: JobType::LiveStream,
        priority: Priority::Normal,
        etag: None,
        last_modified: None,
        is_resumable: false,
        chunk_count: 1,
        error_message: None,
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
        thumbnail_url: None,
    };
    db.insert_job(&job).unwrap();

    let cancel = CancellationToken::new();
    let stop = CancellationToken::new();

    let res = record_live_stream(
        &job,
        &db,
        &event_bus,
        &cancel,
        &stop,
        Some(LiveRecordingOptions {
            max_duration: Some(Duration::from_secs(2)),
        }),
    )
    .await;

    assert!(res.is_ok(), "Live HLS recording failed: {:?}", res);
    assert!(target_file.exists());
    let dur = probe_duration(&target_file).expect("Probe failed on live HLS recording");
    assert!(dur > 0.5, "Duration {:.2}s should exceed 0.5s", dur);
}

/// Test 5: User-controlled clean Stop Recording flushes trailer and marks Completed
#[tokio::test]
async fn test_live_stream_user_stop_recording_clean_trailer_flush() {
    let tmp = tempdir().unwrap();
    let db = Database::open(tmp.path().join("test.db")).unwrap();
    let event_bus = EventBus::default();
    let manager = DownloadManager::new(db.clone(), event_bus.clone()).unwrap();

    let ffmpeg_bin = find_ffmpeg().expect("FFmpeg required for test");

    // Local UDP port
    let sock = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let port = sock.local_addr().unwrap().port();
    drop(sock);

    let stream_url = format!("udp://127.0.0.1:{}", port);
    let listen_url = format!("udp://127.0.0.1:{}?listen=1", port);

    // Stream generator
    let mut streamer = Command::new(&ffmpeg_bin)
        .arg("-re")
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg("testsrc=duration=60:size=160x120:rate=10")
        .arg("-c:v")
        .arg("libx264")
        .arg("-preset")
        .arg("ultrafast")
        .arg("-tune")
        .arg("zerolatency")
        .arg("-g")
        .arg("10")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg("-f")
        .arg("mpegts")
        .arg(&stream_url)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("Failed to start UDP live test streamer");

    tokio::time::sleep(Duration::from_millis(300)).await;

    let job = manager
        .create_download(&listen_url, tmp.path())
        .await
        .unwrap();
    assert_eq!(job.job_type, JobType::LiveStream);

    // Start recording
    manager.start_download(&job.id).unwrap();

    // Allow 2.0 seconds of recording to accumulate bytes
    tokio::time::sleep(Duration::from_millis(2000)).await;

    // Call user-controlled STOP
    manager.stop_recording(&job.id).unwrap();

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(10))
        .await
        .unwrap();
    let _ = streamer.kill();
    let _ = streamer.wait();
    let _ = streamer.wait();

    assert_eq!(
        state,
        JobState::Completed,
        "Job must transition to Completed after stop_recording"
    );

    let out_file = std::path::Path::new(&job.target_path);
    assert!(out_file.exists(), "Final file must be published on disk");
    let size = fs::metadata(out_file).unwrap().len();
    assert!(size > 1024, "Output size {} must exceed 1024 bytes", size);

    let dur = probe_duration(out_file).expect("Output file must be probeable and playable");
    assert!(
        dur > 0.5,
        "Recorded file duration {:.2}s should exceed 0.5s",
        dur
    );
}

/// Test 6: Recording cancellation cleans up resources with zero orphaned processes
#[tokio::test]
async fn test_live_stream_cancellation_and_no_orphaned_ffmpeg_processes() {
    let tmp = tempdir().unwrap();
    let db = Database::open(tmp.path().join("test.db")).unwrap();
    let event_bus = EventBus::default();
    let manager = DownloadManager::new(db.clone(), event_bus.clone()).unwrap();

    let ffmpeg_bin = find_ffmpeg().expect("FFmpeg required for test");

    let sock = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let port = sock.local_addr().unwrap().port();
    drop(sock);

    let stream_url = format!("udp://127.0.0.1:{}", port);
    let listen_url = format!("udp://127.0.0.1:{}?listen=1", port);

    let mut streamer = Command::new(&ffmpeg_bin)
        .arg("-re")
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg("testsrc=duration=60:size=160x120:rate=10")
        .arg("-c:v")
        .arg("libx264")
        .arg("-preset")
        .arg("ultrafast")
        .arg("-tune")
        .arg("zerolatency")
        .arg("-g")
        .arg("10")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg("-f")
        .arg("mpegts")
        .arg(&stream_url)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("Failed to start UDP live test streamer");

    tokio::time::sleep(Duration::from_millis(300)).await;

    let job = manager
        .create_download(&listen_url, tmp.path())
        .await
        .unwrap();

    manager.start_download(&job.id).unwrap();

    // Let it record briefly
    tokio::time::sleep(Duration::from_millis(800)).await;

    // Trigger cancellation
    manager.cancel_download(&job.id).unwrap();

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(5))
        .await
        .unwrap();
    let _ = streamer.kill();
    let _ = streamer.wait();
    let _ = streamer.wait();

    assert_eq!(state, JobState::Cancelled);

    // Verify temp file cleaned up
    assert!(
        !std::path::Path::new(&job.temp_path).exists(),
        "Temp file should be removed upon cancellation"
    );
}

/// Test 7: Fragmented MP4 partial recovery ensures playable output even if interrupted
#[tokio::test]
async fn test_live_stream_fragmented_mp4_partial_recovery() {
    let tmp = tempdir().unwrap();
    let db = Database::open(tmp.path().join("test.db")).unwrap();
    let event_bus = EventBus::default();

    let ffmpeg_bin = find_ffmpeg().expect("FFmpeg required for test");

    let sock = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let port = sock.local_addr().unwrap().port();
    drop(sock);

    let stream_url = format!("udp://127.0.0.1:{}", port);
    let listen_url = format!("udp://127.0.0.1:{}?listen=1", port);
    let target_file = tmp.path().join("interrupted_stream.mp4");
    let temp_file = tmp.path().join("interrupted_stream.mp4.tdm-part");

    let mut streamer = Command::new(&ffmpeg_bin)
        .arg("-re")
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg("testsrc=duration=60:size=160x120:rate=10")
        .arg("-c:v")
        .arg("libx264")
        .arg("-preset")
        .arg("ultrafast")
        .arg("-tune")
        .arg("zerolatency")
        .arg("-g")
        .arg("10")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg("-f")
        .arg("mpegts")
        .arg(&stream_url)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("Failed to start UDP live test streamer");

    tokio::time::sleep(Duration::from_millis(300)).await;

    let job = DownloadJob {
        id: "job-live-fmp4".to_string(),
        url: listen_url.clone(),
        resolved_url: Some(listen_url.clone()),
        filename: "interrupted_stream.mp4".to_string(),
        target_path: target_file.to_string_lossy().to_string(),
        temp_path: temp_file.to_string_lossy().to_string(),
        total_bytes: None,
        downloaded_bytes: 0,
        state: JobState::Downloading,
        job_type: JobType::LiveStream,
        priority: Priority::Normal,
        etag: None,
        last_modified: None,
        is_resumable: false,
        chunk_count: 1,
        error_message: None,
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
        thumbnail_url: None,
    };
    db.insert_job(&job).unwrap();

    let cancel = CancellationToken::new();
    let stop = CancellationToken::new();

    // Stop after 2 seconds
    let _ = record_live_stream(
        &job,
        &db,
        &event_bus,
        &cancel,
        &stop,
        Some(LiveRecordingOptions {
            max_duration: Some(Duration::from_secs(2)),
        }),
    )
    .await;

    let _ = streamer.kill();
    let _ = streamer.wait();

    assert!(target_file.exists());
    let dur = probe_duration(&target_file).expect("Fragmented MP4 must be readable and playable");
    assert!(
        dur > 0.5,
        "Fragmented MP4 duration {:.2}s should exceed 0.5s",
        dur
    );
}

/// Test 8: Recording performance and throughput metrics validation
#[tokio::test]
async fn test_live_stream_bounded_resources_and_throughput() {
    let tmp = tempdir().unwrap();
    let db = Database::open(tmp.path().join("test.db")).unwrap();
    let event_bus = EventBus::default();

    let ffmpeg_bin = find_ffmpeg().expect("FFmpeg required for test");

    let sock = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let port = sock.local_addr().unwrap().port();
    drop(sock);

    let stream_url = format!("udp://127.0.0.1:{}", port);
    let listen_url = format!("udp://127.0.0.1:{}?listen=1", port);
    let target_file = tmp.path().join("benchmark_stream.ts");
    let temp_file = tmp.path().join("benchmark_stream.ts.tdm-part");

    let mut streamer = Command::new(&ffmpeg_bin)
        .arg("-re")
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg("testsrc=duration=60:size=320x240:rate=15")
        .arg("-c:v")
        .arg("libx264")
        .arg("-preset")
        .arg("ultrafast")
        .arg("-tune")
        .arg("zerolatency")
        .arg("-g")
        .arg("10")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg("-f")
        .arg("mpegts")
        .arg(&stream_url)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("Failed to start UDP live test streamer");

    tokio::time::sleep(Duration::from_millis(300)).await;

    let job = DownloadJob {
        id: "job-live-bench".to_string(),
        url: listen_url.clone(),
        resolved_url: Some(listen_url.clone()),
        filename: "benchmark_stream.ts".to_string(),
        target_path: target_file.to_string_lossy().to_string(),
        temp_path: temp_file.to_string_lossy().to_string(),
        total_bytes: None,
        downloaded_bytes: 0,
        state: JobState::Downloading,
        job_type: JobType::LiveStream,
        priority: Priority::Normal,
        etag: None,
        last_modified: None,
        is_resumable: false,
        chunk_count: 1,
        error_message: None,
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
        thumbnail_url: None,
    };
    db.insert_job(&job).unwrap();

    let cancel = CancellationToken::new();
    let stop = CancellationToken::new();

    let start = std::time::Instant::now();
    let res = record_live_stream(
        &job,
        &db,
        &event_bus,
        &cancel,
        &stop,
        Some(LiveRecordingOptions {
            max_duration: Some(Duration::from_secs(2)),
        }),
    )
    .await;
    let elapsed = start.elapsed();

    let _ = streamer.kill();
    let _ = streamer.wait();

    assert!(res.is_ok());
    assert!(target_file.exists());
    let size = fs::metadata(&target_file).unwrap().len();

    let throughput_kbps = (size as f64 / 1024.0) / elapsed.as_secs_f64();
    println!(
        "[Gate 7 Live Benchmark] Recorded {} bytes in {:.2}s ({:.2} KB/s) without transcoding overhead",
        size,
        elapsed.as_secs_f64(),
        throughput_kbps
    );

    assert!(size > 5000, "Output size {} must exceed 5000 bytes", size);
}
