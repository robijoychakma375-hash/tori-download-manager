use std::fs;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use tdm_core::hls::decrypt::{decrypt_hls_segment, derive_iv_from_sequence};
use tdm_core::hls::muxer::{find_ffmpeg, probe_duration};
use tdm_core::hls::parser::{parse_playlist, select_default_variant, ParsedPlaylist};
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

/// Helper to generate a 1-second real H.264 MPEG-TS video segment using FFmpeg
fn generate_test_ts_segment(out_path: &std::path::Path, duration_sec: u32) -> Vec<u8> {
    let ffmpeg = find_ffmpeg().expect("FFmpeg must be installed for HLS tests");
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

/// Helper to generate a 1-second real AAC audio MPEG-TS segment using FFmpeg
fn generate_test_audio_ts_segment(out_path: &std::path::Path, duration_sec: u32) -> Vec<u8> {
    let ffmpeg = find_ffmpeg().expect("FFmpeg must be installed for HLS tests");
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
        .arg(out_path)
        .output()
        .expect("Failed to run ffmpeg to generate test audio TS");
    assert!(res.status.success(), "ffmpeg sine audio failed");
    fs::read(out_path).expect("Failed to read generated audio TS segment")
}

// =========================================================================
// TEST 1: Master and Media Playlist Parser RFC 8216 Compliance
// =========================================================================
#[test]
fn test_hls_parser_master_and_media_playlist_unit() {
    let master_content = r#"#EXTM3U
#EXT-X-VERSION:4
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-main",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="audio-main"
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="audio-main"
mid/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.4d4028,mp4a.40.2",AUDIO="audio-main"
high/index.m3u8
"#;

    let base_url = "https://cdn.example.com/live/master.m3u8";
    let parsed = parse_playlist(master_content, base_url).expect("Failed to parse master playlist");

    match parsed {
        ParsedPlaylist::Master(master) => {
            assert_eq!(master.variants.len(), 3);
            assert_eq!(master.audio_renditions.len(), 1);

            let best_var = select_default_variant(&master).expect("No default variant selected");
            assert_eq!(best_var.bandwidth, 6000000);
            assert_eq!(best_var.resolution, Some((1920, 1080)));
            assert_eq!(best_var.uri, "https://cdn.example.com/live/high/index.m3u8");
        }
        _ => panic!("Expected Master Playlist"),
    }
}

// =========================================================================
// TEST 2: DRM Encryption Rejection
// =========================================================================
#[test]
fn test_hls_parser_drm_unsupported_error() {
    let drm_content = r#"#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://drm.example.com/key"
#EXTINF:4.0,
seg1.ts
"#;
    let err = parse_playlist(drm_content, "https://cdn.example.com/video.m3u8")
        .unwrap_err()
        .to_string();
    assert!(err.contains("Unsupported protected HLS encryption method 'SAMPLE-AES'"));
}

// =========================================================================
// TEST 3: Cryptographic AES-128-CBC Decryption & IV Derivation
// =========================================================================
#[test]
fn test_hls_aes128_cryptographic_decryption() {
    use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
    use aes::Aes128;
    use cbc::Encryptor;

    type Aes128CbcEnc = Encryptor<Aes128>;

    let key: [u8; 16] = [0x11; 16];
    let iv: [u8; 16] = derive_iv_from_sequence(1234);

    let raw_payload = b"Sample video transport stream payload testing AES-128 decryption.";
    let mut enc_buf = vec![0u8; raw_payload.len() + 32];
    enc_buf[..raw_payload.len()].copy_from_slice(raw_payload);

    let encryptor = Aes128CbcEnc::new(&key.into(), &iv.into());
    let ciphertext = encryptor
        .encrypt_padded_mut::<Pkcs7>(&mut enc_buf, raw_payload.len())
        .unwrap();

    let decrypted = decrypt_hls_segment(ciphertext, &key, &iv).unwrap();
    assert_eq!(decrypted, raw_payload);
}

// =========================================================================
// TEST 4: Real MPEG-TS HLS Stream Download and FFmpeg Remuxing to Playable MP4
// =========================================================================
#[tokio::test]
async fn test_hls_real_mpeg_ts_stream_download_and_muxing() {
    let temp_dir = tempdir().unwrap();

    // 1. Generate real MPEG-TS test segments (2 x 1-sec segments = 2s total duration)
    let seg0_path = temp_dir.path().join("gen_seg0.ts");
    let seg1_path = temp_dir.path().join("gen_seg1.ts");

    let seg0_bytes = generate_test_ts_segment(&seg0_path, 1);
    let seg1_bytes = generate_test_ts_segment(&seg1_path, 1);

    let seg0_arc = Arc::new(seg0_bytes);
    let seg1_arc = Arc::new(seg1_bytes);

    // 2. Start mock HTTP server serving M3U8 playlist and segments
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    let s0_clone = seg0_arc.clone();
    let s1_clone = seg1_arc.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let d0 = s0_clone.clone();
                    let d1 = s1_clone.clone();

                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 2048];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);

                        if req.contains("GET /playlist.m3u8") {
                            let m3u8_body = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1.0,\nseg0.ts\n#EXTINF:1.0,\nseg1.ts\n#EXT-X-ENDLIST\n";
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                m3u8_body.len(),
                                m3u8_body
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if req.contains("GET /seg0.ts") {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                d0.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&d0).await;
                        } else if req.contains("GET /seg1.ts") {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                d1.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&d1).await;
                        } else if req.starts_with("HEAD") {
                            let resp = "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nConnection: close\r\n\r\n";
                            let _ = socket.write_all(resp.as_bytes()).await;
                        }
                    });
                }
            }
        }
    });

    // 3. Create HLS Download in TORI Engine
    let db = Database::open(temp_dir.path().join("hls_test.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let playlist_url = format!("http://127.0.0.1:{}/playlist.m3u8", port);
    let job = manager
        .create_download(&playlist_url, temp_dir.path())
        .await
        .expect("Failed to create HLS download job");

    assert_eq!(job.job_type, JobType::HlsVod);
    assert!(
        job.filename.ends_with(".mp4"),
        "Expected target filename to be .mp4, got {}",
        job.filename
    );

    manager
        .start_download(&job.id)
        .expect("Failed to start HLS download");

    // 4. Wait for download and remuxing completion
    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .expect("HLS download timed out");
    assert_eq!(state, JobState::Completed);

    // 5. Verify the output MP4 file exists and validate with ffprobe
    let output_file = std::path::Path::new(&job.target_path);
    assert!(
        output_file.exists(),
        "Target MP4 file does not exist on disk"
    );
    assert!(
        fs::metadata(output_file).unwrap().len() > 1024,
        "Output file size too small"
    );

    let duration = probe_duration(output_file).expect("FFprobe validation failed on output MP4");
    println!("FFprobe verified duration: {:.2}s", duration);
    assert!(
        (1.5..=2.5).contains(&duration),
        "Duration {:.2}s outside expected 2s range",
        duration
    );

    cancel.cancel();
}

// =========================================================================
// TEST 5: AES-128 Encrypted Stream Download, Decryption, and Muxing
// =========================================================================
#[tokio::test]
async fn test_hls_aes128_encrypted_stream_download_and_muxing() {
    use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
    use aes::Aes128;
    use cbc::Encryptor;

    type Aes128CbcEnc = Encryptor<Aes128>;

    let temp_dir = tempdir().unwrap();

    let seg_path = temp_dir.path().join("raw_seg.ts");
    let raw_ts = generate_test_ts_segment(&seg_path, 1);

    // Encrypt segment with AES-128
    let key: [u8; 16] = [0x42; 16];
    let iv: [u8; 16] = [0x24; 16];

    let mut enc_buf = vec![0u8; raw_ts.len() + 32];
    enc_buf[..raw_ts.len()].copy_from_slice(&raw_ts);
    let encryptor = Aes128CbcEnc::new(&key.into(), &iv.into());
    let encrypted_ts = encryptor
        .encrypt_padded_mut::<Pkcs7>(&mut enc_buf, raw_ts.len())
        .unwrap()
        .to_vec();

    let key_arc = Arc::new(key.to_vec());
    let enc_arc = Arc::new(encrypted_ts);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    let k_clone = key_arc.clone();
    let e_clone = enc_arc.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let k_bytes = k_clone.clone();
                    let e_bytes = e_clone.clone();

                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 2048];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);

                        if req.contains("GET /encrypted.m3u8") {
                            let m3u8 = format!(
                                "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=AES-128,URI=\"http://127.0.0.1:{}/key.bin\",IV=0x24242424242424242424242424242424\n#EXTINF:1.0,\nenc_seg0.ts\n#EXT-X-ENDLIST\n",
                                port
                            );
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                m3u8.len(),
                                m3u8
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if req.contains("GET /key.bin") {
                            let resp = "HTTP/1.1 200 OK\r\nContent-Length: 16\r\nConnection: close\r\n\r\n";
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&k_bytes).await;
                        } else if req.contains("GET /enc_seg0.ts") {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                e_bytes.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&e_bytes).await;
                        } else if req.starts_with("HEAD") {
                            let resp = "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nConnection: close\r\n\r\n";
                            let _ = socket.write_all(resp.as_bytes()).await;
                        }
                    });
                }
            }
        }
    });

    let db = Database::open(temp_dir.path().join("hls_enc_test.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let playlist_url = format!("http://127.0.0.1:{}/encrypted.m3u8", port);
    let job = manager
        .create_download(&playlist_url, temp_dir.path())
        .await
        .unwrap();

    manager.start_download(&job.id).unwrap();

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .unwrap();
    assert_eq!(state, JobState::Completed);

    let output_file = std::path::Path::new(&job.target_path);
    assert!(output_file.exists());
    let dur = probe_duration(output_file).expect("Encrypted stream output probe failed");
    assert!(
        (0.8..=1.5).contains(&dur),
        "Duration {:.2}s outside expected 1s range",
        dur
    );

    cancel.cancel();
}

// =========================================================================
// TEST 6: Master Playlist with Separate Audio Rendition
// =========================================================================
#[tokio::test]
async fn test_hls_master_playlist_with_separate_audio_rendition() {
    let temp_dir = tempdir().unwrap();

    let v_path = temp_dir.path().join("vid.ts");
    let a_path = temp_dir.path().join("aud.ts");

    let v_bytes = Arc::new(generate_test_ts_segment(&v_path, 1));
    let a_bytes = Arc::new(generate_test_audio_ts_segment(&a_path, 1));

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    let vb_clone = v_bytes.clone();
    let ab_clone = a_bytes.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let vb = vb_clone.clone();
                    let ab = ab_clone.clone();

                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 2048];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);

                        if req.contains("GET /master.m3u8") {
                            let master = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio-main\",NAME=\"English\",DEFAULT=YES,URI=\"audio.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=160x120,AUDIO=\"audio-main\"\nvideo.m3u8\n";
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                master.len(),
                                master
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if req.contains("GET /video.m3u8") {
                            let v_m3u8 = "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1.0,\nvid0.ts\n#EXT-X-ENDLIST\n";
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                v_m3u8.len(),
                                v_m3u8
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if req.contains("GET /audio.m3u8") {
                            let a_m3u8 = "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1.0,\naud0.ts\n#EXT-X-ENDLIST\n";
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                a_m3u8.len(),
                                a_m3u8
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if req.contains("GET /vid0.ts") {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                vb.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&vb).await;
                        } else if req.contains("GET /aud0.ts") {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                ab.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&ab).await;
                        } else if req.starts_with("HEAD") {
                            let resp = "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nConnection: close\r\n\r\n";
                            let _ = socket.write_all(resp.as_bytes()).await;
                        }
                    });
                }
            }
        }
    });

    let db = Database::open(temp_dir.path().join("hls_dual_test.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let playlist_url = format!("http://127.0.0.1:{}/master.m3u8", port);
    let job = manager
        .create_download(&playlist_url, temp_dir.path())
        .await
        .unwrap();

    manager.start_download(&job.id).unwrap();

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .unwrap();
    assert_eq!(state, JobState::Completed);

    let output_file = std::path::Path::new(&job.target_path);
    assert!(output_file.exists());
    let dur = probe_duration(output_file).expect("Dual stream output probe failed");
    assert!(
        (0.7..=1.5).contains(&dur),
        "Duration {:.2}s outside expected range",
        dur
    );

    cancel.cancel();
}

// =========================================================================
// TEST 7: Byte-Range Segments (EXT-X-BYTERANGE)
// =========================================================================
#[tokio::test]
async fn test_hls_byterange_segments_download_and_muxing() {
    let temp_dir = tempdir().unwrap();

    let seg0_path = temp_dir.path().join("br_seg0.ts");
    let seg1_path = temp_dir.path().join("br_seg1.ts");

    let seg0_bytes = generate_test_ts_segment(&seg0_path, 1);
    let seg1_bytes = generate_test_ts_segment(&seg1_path, 1);

    let len0 = seg0_bytes.len();
    let len1 = seg1_bytes.len();

    // Concatenate both segments into a single file
    let mut combined_bytes = seg0_bytes;
    combined_bytes.extend_from_slice(&seg1_bytes);
    let combined_arc = Arc::new(combined_bytes);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    let cb_clone = combined_arc.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let cb = cb_clone.clone();

                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 2048];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);

                        if req.contains("GET /byterange.m3u8") {
                            let m3u8 = format!(
                                "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1.0,\n#EXT-X-BYTERANGE:{}@0\ncombined.ts\n#EXTINF:1.0,\n#EXT-X-BYTERANGE:{}\ncombined.ts\n#EXT-X-ENDLIST\n",
                                len0, len1
                            );
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                m3u8.len(),
                                m3u8
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if req.contains("GET /combined.ts") {
                            let range_header = req.lines().find(|l| l.to_lowercase().starts_with("range:"));
                            if let Some(r) = range_header {
                                let val = r.split(':').nth(1).unwrap().trim();
                                if let Some(bytes_spec) = val.strip_prefix("bytes=") {
                                    let parts: Vec<&str> = bytes_spec.split('-').collect();
                                    let start: usize = parts[0].parse().unwrap_or(0);
                                    let end: usize = parts[1].parse().unwrap_or(cb.len() - 1);
                                    let slice = &cb[start..=end.min(cb.len() - 1)];

                                    let resp = format!(
                                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                        start, end, cb.len(), slice.len()
                                    );
                                    let _ = socket.write_all(resp.as_bytes()).await;
                                    let _ = socket.write_all(slice).await;
                                }
                            }
                        } else if req.starts_with("HEAD") {
                            let resp = "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nConnection: close\r\n\r\n";
                            let _ = socket.write_all(resp.as_bytes()).await;
                        }
                    });
                }
            }
        }
    });

    let db = Database::open(temp_dir.path().join("hls_br_test.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let playlist_url = format!("http://127.0.0.1:{}/byterange.m3u8", port);
    let job = manager
        .create_download(&playlist_url, temp_dir.path())
        .await
        .unwrap();

    manager.start_download(&job.id).unwrap();

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .unwrap();
    assert_eq!(state, JobState::Completed);

    let output_file = std::path::Path::new(&job.target_path);
    assert!(output_file.exists());
    let dur = probe_duration(output_file).expect("Byte-range output probe failed");
    assert!(
        (1.5..=2.5).contains(&dur),
        "Duration {:.2}s outside expected 2s range",
        dur
    );

    cancel.cancel();
}

// =========================================================================
// TEST 8: HLS Pause and Resume Continuity Verification
// =========================================================================
#[tokio::test]
async fn test_hls_pause_and_resume_continuity() {
    let temp_dir = tempdir().unwrap();
    let seg_file_path = temp_dir.path().join("source_seg.ts");
    let seg_bytes = Arc::new(generate_test_ts_segment(&seg_file_path, 1));

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    let seg0_requests = Arc::new(AtomicUsize::new(0));
    let seg1_requests = Arc::new(AtomicUsize::new(0));
    let seg2_requests = Arc::new(AtomicUsize::new(0));

    let seg0_cnt = seg0_requests.clone();
    let seg1_cnt = seg1_requests.clone();
    let seg2_cnt = seg2_requests.clone();
    let sb = seg_bytes.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let sb = sb.clone();
                    let s0 = seg0_cnt.clone();
                    let s1 = seg1_cnt.clone();
                    let s2 = seg2_cnt.clone();

                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 2048];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);

                        if req.contains("GET /pause_test.m3u8") {
                            let m3u8 = "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1.0,\nseg0.ts\n#EXTINF:1.0,\nseg1.ts\n#EXTINF:1.0,\nseg2.ts\n#EXT-X-ENDLIST\n";
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                m3u8.len(),
                                m3u8
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if req.contains("GET /seg0.ts") {
                            s0.fetch_add(1, Ordering::SeqCst);
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                sb.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&sb).await;
                        } else if req.contains("GET /seg1.ts") {
                            s1.fetch_add(1, Ordering::SeqCst);
                            tokio::time::sleep(Duration::from_millis(150)).await;
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                sb.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&sb).await;
                        } else if req.contains("GET /seg2.ts") {
                            s2.fetch_add(1, Ordering::SeqCst);
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                sb.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&sb).await;
                        } else if req.starts_with("HEAD") {
                            let resp = "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nConnection: close\r\n\r\n";
                            let _ = socket.write_all(resp.as_bytes()).await;
                        }
                    });
                }
            }
        }
    });

    let db = Database::open(temp_dir.path().join("hls_pause_test.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let playlist_url = format!("http://127.0.0.1:{}/pause_test.m3u8", port);
    let job = manager
        .create_download(&playlist_url, temp_dir.path())
        .await
        .unwrap();

    manager.start_download(&job.id).unwrap();

    // Wait until seg0 is downloaded
    let work_dir = std::path::PathBuf::from(format!("{}.hls_parts", job.temp_path));
    let seg0_file = work_dir.join("seg_000000.ts");
    let mut wait_count = 0;
    while !seg0_file.exists() && wait_count < 100 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        wait_count += 1;
    }
    assert!(
        seg0_file.exists(),
        "seg_000000.ts should have been downloaded"
    );

    // Pause download immediately
    manager.pause_download(&job.id).unwrap();

    // Wait for the state to transition to Paused
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

    // Verify seg0 is preserved in .hls_parts while paused
    assert!(
        seg0_file.exists(),
        "seg0 should be preserved on disk across pause"
    );
    let initial_seg0_requests = seg0_requests.load(Ordering::SeqCst);
    assert!(initial_seg0_requests >= 1);

    // Resume download
    manager.resume_download(&job.id).unwrap();

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .unwrap();
    assert_eq!(state, JobState::Completed);

    // Verify seg0 was NOT downloaded again on resume!
    let final_seg0_requests = seg0_requests.load(Ordering::SeqCst);
    assert_eq!(
        final_seg0_requests, initial_seg0_requests,
        "seg0 should not be re-downloaded after resume"
    );

    // Verify output file exists and has proper duration
    let output_file = std::path::Path::new(&job.target_path);
    assert!(output_file.exists());
    let dur = probe_duration(output_file).expect("Output probe failed");
    assert!(
        (2.5..=3.5).contains(&dur),
        "Duration {:.2}s outside expected 3s range",
        dur
    );

    cancel.cancel();
}

// =========================================================================
// TEST 10: Transient HTTP 429/503 Retries with Backoff Recovery
// =========================================================================
#[tokio::test]
async fn test_hls_transient_429_503_retry_recovery() {
    let temp_fixture_dir = tempdir().unwrap();
    let ts_path = temp_fixture_dir.path().join("source.ts");
    let seg_bytes = generate_test_ts_segment(&ts_path, 1);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    let throttle_count = Arc::new(AtomicUsize::new(0));
    let tc = throttle_count.clone();
    let sb = seg_bytes.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let sb = sb.clone();
                    let t_counter = tc.clone();

                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 2048];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);

                        if req.contains("GET /retry_test.m3u8") {
                            let m3u8 = "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1.0,\nseg0.ts\n#EXTINF:1.0,\nseg1.ts\n#EXT-X-ENDLIST\n";
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                m3u8.len(),
                                m3u8
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if req.contains("GET /seg0.ts") && t_counter.fetch_add(1, Ordering::SeqCst) < 2 {
                            // Inject transient 429 on first 2 attempts
                            let resp = "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 1\r\nConnection: close\r\n\r\n";
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if req.contains("GET /seg0.ts") || req.contains("GET /seg1.ts") {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                sb.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&sb).await;
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
    let db = Database::open(temp_client_dir.path().join("retry_hls.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let manifest_url = format!("http://127.0.0.1:{}/retry_test.m3u8", port);
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
    let dur = probe_duration(output_file).expect("Output probe failed");
    assert!(
        (1.5..=2.5).contains(&dur),
        "Duration {:.2}s outside expected 2s range",
        dur
    );

    cancel.cancel();
}
