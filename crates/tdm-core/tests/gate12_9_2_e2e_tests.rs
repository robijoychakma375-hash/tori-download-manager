use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use tdm_core::{
    find_ffmpeg, find_ffprobe, Database, DownloadManager, EventBus, JobState, JobType, Priority,
};

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

fn probe_media_file(file_path: &Path) -> serde_json::Value {
    let ffprobe = find_ffprobe().expect("FFprobe must be installed for E2E tests");
    let out = Command::new(&ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration,size,bit_rate:stream=codec_name,width,height",
            "-of",
            "json",
            file_path.to_str().unwrap(),
        ])
        .output()
        .expect("Failed to execute ffprobe");

    assert!(out.status.success(), "ffprobe failed on {:?}", file_path);
    serde_json::from_slice(&out.stdout).expect("Failed to parse ffprobe json")
}

fn generate_test_ts_segment(out_path: &Path, duration_sec: u32) -> Vec<u8> {
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

fn generate_fmp4_dash_fixture(out_dir: &Path, duration_sec: u32) -> PathBuf {
    let ffmpeg = find_ffmpeg().expect("FFmpeg must be installed for DASH tests");
    let mpd_path = out_dir.join("manifest.mpd");

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
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg(format!("sine=frequency=440:duration={}", duration_sec))
        .arg("-c:v")
        .arg("libx264")
        .arg("-c:a")
        .arg("aac")
        .arg("-f")
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

#[tokio::test]
async fn test_gate12_9_2_direct_mp4_e2e_download() {
    let temp = tempdir().unwrap();
    let db = Database::open(temp.path().join("mp4_test.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let mp4_url = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";
    let job = manager
        .create_download(mp4_url, temp.path())
        .await
        .expect("Failed to create direct MP4 download job");

    assert_eq!(job.job_type, JobType::HttpFile);
    manager
        .start_download(&job.id)
        .expect("Failed to start MP4 download");

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(30))
        .await
        .expect("MP4 download timed out");
    assert_eq!(state, JobState::Completed);

    let output_file = Path::new(&job.target_path);
    assert!(output_file.exists(), "MP4 file must exist on disk");
    assert_eq!(fs::metadata(output_file).unwrap().len(), 1128375);

    let probe = probe_media_file(output_file);
    let streams = probe["streams"].as_array().unwrap();
    let v_stream = streams.iter().find(|s| s.get("width").is_some()).unwrap();
    assert_eq!(v_stream["codec_name"], "h264");
    assert_eq!(v_stream["width"], 960);
    assert_eq!(v_stream["height"], 540);

    let a_stream = streams.iter().find(|s| s["codec_name"] == "aac").unwrap();
    assert_eq!(a_stream["codec_name"], "aac");

    let dur: f64 = probe["format"]["duration"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        dur > 5.0 && dur < 5.2,
        "Duration should be ~5.05s, got: {}",
        dur
    );
}

#[tokio::test]
async fn test_gate12_9_2_direct_webm_e2e_download() {
    let temp = tempdir().unwrap();
    let db = Database::open(temp.path().join("webm_test.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let webm_url = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.webm";
    let job = manager
        .create_download(webm_url, temp.path())
        .await
        .expect("Failed to create direct WebM download job");

    assert_eq!(job.job_type, JobType::HttpFile);
    manager
        .start_download(&job.id)
        .expect("Failed to start WebM download");

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(30))
        .await
        .expect("WebM download timed out");
    assert_eq!(state, JobState::Completed);

    let output_file = Path::new(&job.target_path);
    assert!(output_file.exists(), "WebM file must exist on disk");
    assert_eq!(fs::metadata(output_file).unwrap().len(), 554058);

    let probe = probe_media_file(output_file);
    let streams = probe["streams"].as_array().unwrap();
    let v_stream = streams.iter().find(|s| s.get("width").is_some()).unwrap();
    assert_eq!(v_stream["codec_name"], "vp8");
    assert_eq!(v_stream["width"], 960);
    assert_eq!(v_stream["height"], 540);

    let a_stream = streams
        .iter()
        .find(|s| s["codec_name"] == "vorbis")
        .unwrap();
    assert_eq!(a_stream["codec_name"], "vorbis");

    let dur: f64 = probe["format"]["duration"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        dur > 5.0 && dur < 5.2,
        "Duration should be ~5.06s, got: {}",
        dur
    );
}

#[tokio::test]
async fn test_gate12_9_2_hls_vod_e2e_download_and_remux() {
    let temp_fixture = tempdir().unwrap();
    let seg0_path = temp_fixture.path().join("seg0.ts");
    let seg1_path = temp_fixture.path().join("seg1.ts");

    let d0 = generate_test_ts_segment(&seg0_path, 1);
    let d1 = generate_test_ts_segment(&seg1_path, 1);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(c) => c,
                        Err(_) => continue,
                    };
                    let d0 = d0.clone();
                    let d1 = d1.clone();

                    tokio::spawn(async move {
                        let mut buf = [0u8; 1024];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);

                        if req.contains("GET /playlist.m3u8") {
                            let m3u8 = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:1.0,\nseg0.ts\n#EXTINF:1.0,\nseg1.ts\n#EXT-X-ENDLIST\n";
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                m3u8.len(),
                                m3u8
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

    let temp_client = tempdir().unwrap();
    let db = Database::open(temp_client.path().join("hls_e2e.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let playlist_url = format!("http://127.0.0.1:{}/playlist.m3u8", port);
    let job = manager
        .create_download(&playlist_url, temp_client.path())
        .await
        .expect("Failed to create HLS download job");

    assert_eq!(job.job_type, JobType::HlsVod);
    assert!(
        job.filename.ends_with(".mp4"),
        "Target filename must end in .mp4"
    );

    manager.start_download(&job.id).unwrap();

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .expect("HLS download timed out");
    assert_eq!(state, JobState::Completed);

    let output_file = Path::new(&job.target_path);
    assert!(output_file.exists(), "Target MP4 must exist");
    assert!(fs::metadata(output_file).unwrap().len() > 1024);

    let probe = probe_media_file(output_file);
    let v_stream = probe["streams"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s.get("width").is_some())
        .unwrap();
    assert_eq!(v_stream["codec_name"], "h264");

    let dur: f64 = probe["format"]["duration"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        dur > 1.5 && dur < 2.5,
        "Duration should be ~2s, got: {}",
        dur
    );

    cancel.cancel();
}

#[tokio::test]
async fn test_gate12_9_2_dash_vod_e2e_download_and_mux() {
    let temp_fixture = tempdir().unwrap();
    let _ = generate_fmp4_dash_fixture(temp_fixture.path(), 2);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();
    let fixture_dir = temp_fixture.path().to_path_buf();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(c) => c,
                        Err(_) => continue,
                    };
                    let dir = fixture_dir.clone();

                    tokio::spawn(async move {
                        let mut buf = [0u8; 1024];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);

                        let req_path = req
                            .lines()
                            .next()
                            .and_then(|l| l.split_whitespace().nth(1))
                            .unwrap_or("");
                        let file_rel = req_path.trim_start_matches('/');
                        let file_path = dir.join(file_rel);

                        if file_path.exists() && file_path.is_file() {
                            let bytes = fs::read(&file_path).unwrap_or_default();
                            let ctype = if file_rel.ends_with(".mpd") {
                                "application/dash+xml"
                            } else {
                                "video/mp4"
                            };
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                ctype,
                                bytes.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            if !req.starts_with("HEAD") {
                                let _ = socket.write_all(&bytes).await;
                            }
                        } else {
                            let resp = "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n";
                            let _ = socket.write_all(resp.as_bytes()).await;
                        }
                    });
                }
            }
        }
    });

    let temp_client = tempdir().unwrap();
    let db = Database::open(temp_client.path().join("dash_e2e.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let manifest_url = format!("http://127.0.0.1:{}/manifest.mpd", port);
    let job = manager
        .create_download(&manifest_url, temp_client.path())
        .await
        .expect("Failed to create DASH download job");

    assert_eq!(job.job_type, JobType::DashVod);
    assert!(
        job.filename.ends_with(".mp4"),
        "Target filename must end in .mp4"
    );

    manager.start_download(&job.id).unwrap();

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .expect("DASH download timed out");
    assert_eq!(state, JobState::Completed);

    let output_file = Path::new(&job.target_path);
    assert!(output_file.exists(), "Target MP4 must exist");
    assert!(fs::metadata(output_file).unwrap().len() > 1024);

    let probe = probe_media_file(output_file);
    let streams = probe["streams"].as_array().unwrap();
    let v_stream = streams.iter().find(|s| s.get("width").is_some()).unwrap();
    assert_eq!(v_stream["codec_name"], "h264");

    let a_stream = streams.iter().find(|s| s["codec_name"] == "aac");
    assert!(
        a_stream.is_some(),
        "DASH output must contain AAC audio track"
    );

    let dur: f64 = probe["format"]["duration"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        dur > 1.5 && dur < 2.5,
        "Duration should be ~2s, got: {}",
        dur
    );

    cancel.cancel();
}

#[tokio::test]
async fn test_gate12_9_2_candidate_handoff_and_managed_download() {
    let temp = tempdir().unwrap();
    let db = Database::open(temp.path().join("candidate_test.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    // Direct stream candidate handoff from HTML5 video player
    let direct_url = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";
    let job = manager
        .create_managed_media_download(
            direct_url,
            "direct",
            "flower_candidate.mp4",
            temp.path(),
            Priority::Normal,
            None,
        )
        .await
        .expect("Failed to create managed media download for candidate stream");

    assert_eq!(job.job_type, JobType::ManagedMedia);
    manager.start_download(&job.id).unwrap();

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(30))
        .await
        .expect("Managed download timed out");
    assert_eq!(state, JobState::Completed);

    let output_file = Path::new(&job.target_path);
    assert!(
        output_file.exists(),
        "Candidate MP4 file must exist on disk"
    );
    assert_eq!(fs::metadata(output_file).unwrap().len(), 1128375);

    let probe = probe_media_file(output_file);
    let v_stream = probe["streams"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s.get("width").is_some())
        .unwrap();
    assert_eq!(v_stream["codec_name"], "h264");
    assert_eq!(v_stream["width"], 960);
    assert_eq!(v_stream["height"], 540);
}
