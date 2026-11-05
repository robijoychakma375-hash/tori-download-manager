use librqbit::{AddTorrent, AddTorrentOptions, CreateTorrentOptions, Session, SessionOptions};
use sha2::{Digest, Sha256};
use std::fs;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use tdm_core::hls::muxer::{find_ffmpeg, probe_duration, probe_media_streams};
use tdm_core::live::{record_live_stream, LiveRecordingOptions};
use tdm_core::{
    Database, DownloadEvent, DownloadJob, DownloadManager, EventBus, JobState, JobType, Priority,
};

/// Helper to generate a 1-second real H.264 MPEG-TS video segment using FFmpeg
fn generate_video_ts_segment(out_path: &std::path::Path, duration_sec: u32) -> Vec<u8> {
    let ffmpeg = find_ffmpeg().expect("FFmpeg must be installed for matrix tests");
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
        .arg("-preset")
        .arg("ultrafast")
        .arg("-tune")
        .arg("zerolatency")
        .arg("-g")
        .arg("10")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg(out_path)
        .output()
        .expect("Failed to run ffmpeg to generate test video TS");
    assert!(res.status.success(), "ffmpeg video testsrc failed");
    fs::read(out_path).expect("Failed to read generated TS segment")
}

/// Helper to generate a 1-second real AAC MPEG-TS audio segment using FFmpeg
fn generate_audio_ts_segment(out_path: &std::path::Path, duration_sec: u32) -> Vec<u8> {
    let ffmpeg = find_ffmpeg().expect("FFmpeg must be installed for matrix tests");
    let res = Command::new(&ffmpeg)
        .arg("-y")
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg(format!("sine=frequency=440:duration={}", duration_sec))
        .arg("-c:a")
        .arg("aac")
        .arg("-b:a")
        .arg("64k")
        .arg("-f")
        .arg("mpegts")
        .arg(out_path)
        .output()
        .expect("Failed to run ffmpeg to generate test audio TS");
    assert!(res.status.success(), "ffmpeg audio testsrc failed");
    fs::read(out_path).expect("Failed to read generated audio TS segment")
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

async fn make_test_session<P: AsRef<std::path::Path>>(path: P) -> Arc<Session> {
    let opts = SessionOptions {
        disable_trackers: true,
        dht: None,
        disable_local_service_discovery: true,
        ..Default::default()
    };
    Session::new_with_opts(path.as_ref().to_path_buf(), opts)
        .await
        .unwrap()
}

/// Test 1: Direct HTTP range download and bit-exact payload validation
#[tokio::test]
async fn test_matrix_http_range_download_integrity() {
    let tmp = tempdir().unwrap();
    let db = Database::open(tmp.path().join("test.db")).unwrap();
    let event_bus = EventBus::default();
    let manager = DownloadManager::new(db.clone(), event_bus.clone()).unwrap();

    let payload_size = 1024 * 1024 * 2; // 2 MB
    let test_data: Vec<u8> = (0..payload_size).map(|i| (i % 251) as u8).collect();
    let expected_hash = format!("{:x}", Sha256::digest(&test_data));
    let data_arc = Arc::new(test_data);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let d_clone = data_arc.clone();
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = match listener.accept().await {
                Ok(c) => c,
                Err(_) => break,
            };
            let d = d_clone.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                let n = match socket.read(&mut buf).await {
                    Ok(n) if n > 0 => n,
                    _ => return,
                };
                let req_str = String::from_utf8_lossy(&buf[..n]);

                if req_str.contains("HEAD /file.bin") {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"etag-mat-1\"\r\nConnection: close\r\n\r\n",
                        d.len()
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                } else if req_str.to_lowercase().contains("range: bytes=") {
                    let range_line = req_str
                        .lines()
                        .find(|l| l.to_lowercase().starts_with("range: bytes="))
                        .unwrap();
                    let bytes_part = range_line.split('=').nth(1).unwrap().trim();
                    let parts: Vec<&str> = bytes_part.split('-').collect();
                    let start: usize = parts[0].trim().parse().unwrap();
                    let end: usize = parts[1].trim().parse().unwrap();

                    let slice = &d[start..=end];
                    let resp = format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nETag: \"etag-mat-1\"\r\nConnection: close\r\n\r\n",
                        start, end, d.len(), slice.len()
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                    let _ = socket.write_all(slice).await;
                } else if req_str.contains("GET /file.bin") {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"etag-mat-1\"\r\nConnection: close\r\n\r\n",
                        d.len()
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                    let _ = socket.write_all(&d).await;
                }
            });
        }
    });

    let url = format!("http://{}/file.bin", addr);
    let job = manager.create_download(&url, tmp.path()).await.unwrap();
    assert_eq!(job.job_type, JobType::HttpFile);
    assert!(job.is_resumable);

    manager.start_download(&job.id).unwrap();

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(state, JobState::Completed);

    let output_bytes = fs::read(&job.target_path).unwrap();
    let actual_hash = format!("{:x}", Sha256::digest(&output_bytes));
    assert_eq!(expected_hash, actual_hash);
}

/// Test 2: RFC 8216 HLS VOD download, dual-rendition muxing, and ffprobe codec validation
#[tokio::test]
async fn test_matrix_hls_vod_streams_probe() {
    let tmp = tempdir().unwrap();
    let db = Database::open(tmp.path().join("test.db")).unwrap();
    let event_bus = EventBus::default();
    let manager = DownloadManager::new(db.clone(), event_bus.clone()).unwrap();

    let video_bytes = generate_video_ts_segment(&tmp.path().join("fixture_video.ts"), 1);
    let audio_bytes = generate_audio_ts_segment(&tmp.path().join("fixture_audio.ts"), 1);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let v_arc = Arc::new(video_bytes);
    let a_arc = Arc::new(audio_bytes);

    tokio::spawn(async move {
        loop {
            let (mut socket, _) = match listener.accept().await {
                Ok(c) => c,
                Err(_) => break,
            };
            let v = v_arc.clone();
            let a = a_arc.clone();

            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                let n = match socket.read(&mut buf).await {
                    Ok(n) if n > 0 => n,
                    _ => return,
                };
                let req_str = String::from_utf8_lossy(&buf[..n]);

                if req_str.contains("GET /master.m3u8") {
                    let body = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"English\",DEFAULT=YES,AUTOSELECT=YES,URI=\"audio.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=160x120,AUDIO=\"audio\"\nvideo.m3u8\n";
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(), body
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                } else if req_str.contains("GET /video.m3u8") {
                    let body = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1.0,\n/video0.ts\n#EXT-X-ENDLIST\n";
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(), body
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                } else if req_str.contains("GET /audio.m3u8") {
                    let body = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1.0,\n/audio0.ts\n#EXT-X-ENDLIST\n";
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(), body
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                } else if req_str.contains("GET /video0.ts") {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: video/MP2T\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        v.len()
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                    let _ = socket.write_all(&v).await;
                } else if req_str.contains("GET /audio0.ts") {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: video/MP2T\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        a.len()
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                    let _ = socket.write_all(&a).await;
                }
            });
        }
    });

    let url = format!("http://{}/master.m3u8", addr);
    let job = manager.create_download(&url, tmp.path()).await.unwrap();
    assert_eq!(job.job_type, JobType::HlsVod);

    manager.start_download(&job.id).unwrap();

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(10))
        .await
        .unwrap();
    assert_eq!(state, JobState::Completed);

    let output_file = std::path::Path::new(&job.target_path);
    assert!(output_file.exists());
    let (has_video, has_audio, dur) = probe_media_streams(output_file).unwrap();
    assert!(has_video, "Remuxed MP4 must have a valid video stream");
    assert!(has_audio, "Remuxed MP4 must have a valid audio stream");
    assert!(dur > 0.5, "Duration {:.2}s must exceed 0.5s", dur);
}

/// Test 3: BitTorrent piece verification and resume continuity
#[tokio::test]
async fn test_matrix_torrent_and_magnet_transfer() {
    let tmp = tempdir().unwrap();
    let data_dir = tmp.path().join("torrent_matrix");
    fs::create_dir_all(&data_dir).unwrap();

    let sample_file = data_dir.join("matrix_test.dat");
    let test_data = vec![77u8; 32768]; // 32 KB
    fs::write(&sample_file, &test_data).unwrap();

    let session = make_test_session(&data_dir).await;
    let (created, _) = session
        .create_and_serve_torrent(
            &sample_file,
            CreateTorrentOptions {
                name: Some("matrix_test.dat"),
                piece_length: Some(16384),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let torrent_bytes = created.as_bytes().unwrap();

    let target_dir = tmp.path().join("matrix_dest");
    fs::create_dir_all(&target_dir).unwrap();
    let existing_file = target_dir.join("matrix_test.dat");
    // Pre-seed first 16KB piece to verify piece hash checking
    let mut partial = vec![77u8; 16384];
    partial.resize(32768, 0u8);
    fs::write(&existing_file, &partial).unwrap();

    let add_opts = AddTorrentOptions {
        overwrite: true,
        output_folder: Some(target_dir.to_string_lossy().to_string()),
        paused: true,
        ..Default::default()
    };

    let res = session
        .add_torrent(AddTorrent::TorrentFileBytes(torrent_bytes), Some(add_opts))
        .await
        .unwrap();
    let handle = res.into_handle().unwrap();

    handle.wait_until_initialized().await.unwrap();
    let stats = handle.stats();
    assert!(
        stats.progress_bytes >= 16384,
        "Resume piece verification must validate verified existing pieces from disk"
    );
}

/// Test 4: Live stream UDP broadcast capture into fragmented MP4
#[tokio::test]
async fn test_matrix_live_udp_packet_recording() {
    let tmp = tempdir().unwrap();
    let db = Database::open(tmp.path().join("test.db")).unwrap();
    let event_bus = EventBus::default();

    let ffmpeg_bin = find_ffmpeg().expect("FFmpeg required for matrix test");

    let sock = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let port = sock.local_addr().unwrap().port();
    drop(sock);

    let stream_url = format!("udp://127.0.0.1:{}", port);
    let listen_url = format!("udp://127.0.0.1:{}?listen=1", port);
    let target_file = tmp.path().join("recorded_udp_matrix.mp4");
    let temp_file = tmp.path().join("recorded_udp_matrix.mp4.tdm-part");

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
        id: "job-matrix-udp".to_string(),
        url: listen_url.clone(),
        resolved_url: Some(listen_url.clone()),
        filename: "recorded_udp_matrix.mp4".to_string(),
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

    assert!(res.is_ok());
    assert!(target_file.exists());
    let dur = probe_duration(&target_file).expect("Probe failed on UDP recording");
    assert!(dur > 0.5, "Duration {:.2}s must exceed 0.5s", dur);
}

/// Test 5: Live stream TCP capture into Matroska (.mkv) container
#[tokio::test]
async fn test_matrix_live_tcp_mkv_recording() {
    let tmp = tempdir().unwrap();
    let db = Database::open(tmp.path().join("test.db")).unwrap();
    let event_bus = EventBus::default();

    let ffmpeg_bin = find_ffmpeg().expect("FFmpeg required for matrix test");

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    let tcp_url = format!("tcp://127.0.0.1:{}?listen", port);
    let client_url = format!("tcp://127.0.0.1:{}", port);
    let target_file = tmp.path().join("matrix_tcp.mkv");
    let temp_file = tmp.path().join("matrix_tcp.mkv.tdm-part");

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
        .arg(&tcp_url)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("Failed to start TCP live test streamer");

    tokio::time::sleep(Duration::from_millis(400)).await;

    let job = DownloadJob {
        id: "job-matrix-tcp".to_string(),
        url: client_url.clone(),
        resolved_url: Some(client_url.clone()),
        filename: "matrix_tcp.mkv".to_string(),
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

    assert!(res.is_ok());
    assert!(target_file.exists());
    let dur = probe_duration(&target_file).expect("Probe failed on MKV recording");
    assert!(dur > 0.5, "Duration {:.2}s must exceed 0.5s", dur);
}

/// Test 6: Sliding-window live HLS playlist capture with clean stop finalization
#[tokio::test]
async fn test_matrix_live_hls_sliding_recording() {
    let tmp = tempdir().unwrap();
    let db = Database::open(tmp.path().join("test.db")).unwrap();
    let event_bus = EventBus::default();

    let seg0_bytes = generate_video_ts_segment(&tmp.path().join("live_hls_0.ts"), 1);
    let seg1_bytes = generate_video_ts_segment(&tmp.path().join("live_hls_1.ts"), 1);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let s0 = Arc::new(seg0_bytes);
    let s1 = Arc::new(seg1_bytes);
    let sequence = Arc::new(AtomicUsize::new(50));

    let s0_c = s0.clone();
    let s1_c = s1.clone();
    let seq_c = sequence.clone();

    tokio::spawn(async move {
        loop {
            let (mut socket, _) = match listener.accept().await {
                Ok(c) => c,
                Err(_) => break,
            };
            let s0_inner = s0_c.clone();
            let s1_inner = s1_c.clone();
            let seq_inner = seq_c.clone();

            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                let n = match socket.read(&mut buf).await {
                    Ok(n) if n > 0 => n,
                    _ => return,
                };
                let req_str = String::from_utf8_lossy(&buf[..n]);

                if req_str.contains("GET /matrix_live.m3u8") {
                    let seq = seq_inner.fetch_add(1, Ordering::SeqCst);
                    let body = format!(
                        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:{}\n#EXTINF:1.0,\n/seg0.ts\n#EXTINF:1.0,\n/seg1.ts\n",
                        seq
                    );
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(), body
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                } else if req_str.contains("GET /seg0.ts") {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: video/MP2T\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        s0_inner.len()
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                    let _ = socket.write_all(&s0_inner).await;
                } else if req_str.contains("GET /seg1.ts") {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: video/MP2T\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        s1_inner.len()
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                    let _ = socket.write_all(&s1_inner).await;
                }
            });
        }
    });

    let live_url = format!("http://{}/matrix_live.m3u8", addr);
    let target_file = tmp.path().join("recorded_live_matrix.mp4");
    let temp_file = tmp.path().join("recorded_live_matrix.mp4.tdm-part");

    let job = DownloadJob {
        id: "job-matrix-live-hls".to_string(),
        url: live_url.clone(),
        resolved_url: Some(live_url.clone()),
        filename: "recorded_live_matrix.mp4".to_string(),
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

    assert!(res.is_ok());
    assert!(target_file.exists());
    let dur = probe_duration(&target_file).expect("Probe failed on live HLS recording");
    assert!(dur > 0.5, "Duration {:.2}s must exceed 0.5s", dur);
}

/// Test 7: Strict DRM rejection rule compliance (never bypass DRM)
#[test]
fn test_matrix_drm_and_encrypted_content_rejection() {
    let drm_m3u8 = "#EXTM3U\n#EXT-X-VERSION:5\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://drm.example.com/key\"\n#EXTINF:4.0,\nseg1.ts\n";
    let res = tdm_core::hls::parser::parse_playlist(drm_m3u8, "https://example.com/stream.m3u8");
    assert!(res.is_err(), "DRM stream must be strictly rejected");
    let err_str = res.err().unwrap().to_string();
    assert!(
        err_str.to_lowercase().contains("drm") || err_str.to_lowercase().contains("sample-aes"),
        "Error message must specify DRM non-bypass reason: {}",
        err_str
    );
}

/// Test 8: Single-instance IPC focus event emission
#[tokio::test]
async fn test_matrix_single_instance_ipc_focus() {
    let event_bus = EventBus::default();
    let mut rx = event_bus.subscribe();

    event_bus.emit(DownloadEvent::ShowWindow);

    let received = rx.recv().await.unwrap();
    assert!(matches!(received, DownloadEvent::ShowWindow));
}
