use std::fs;
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use tdm_core::{Database, DownloadManager, EventBus, JobState};

fn sha256_bytes(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

fn sha256_file(path: &std::path::Path) -> String {
    let mut file = fs::File::open(path).expect("open file for sha256");
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = file.read(&mut buf).unwrap();
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    hex::encode(hasher.finalize())
}

fn parse_range_header(req_str: &str) -> Option<(usize, Option<usize>)> {
    let line = req_str
        .lines()
        .find(|l| l.to_ascii_lowercase().starts_with("range:"))?;
    let val = line.split_once(':')?.1.trim();
    let spec = val.strip_prefix("bytes=")?;
    let (s, e) = spec.split_once('-')?;
    let start = s.trim().parse::<usize>().ok()?;
    let end = if e.trim().is_empty() {
        None
    } else {
        Some(e.trim().parse::<usize>().ok()?)
    };
    Some((start, end))
}

async fn wait_for_terminal(
    manager: &DownloadManager,
    job_id: &str,
    timeout: Duration,
) -> Result<JobState, String> {
    let start = std::time::Instant::now();
    loop {
        if start.elapsed() > timeout {
            let state = manager
                .get_download(job_id)
                .ok()
                .flatten()
                .map(|j| format!("{:?} err={:?}", j.state, j.error_message));
            return Err(format!("Timed out waiting for terminal state: {:?}", state));
        }
        if let Ok(Some(job)) = manager.get_download(job_id) {
            if job.state.is_terminal() {
                return Ok(job.state);
            }
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

// =========================================================================
// TEST 1: Standard Correct HTTP 206 Multi-Chunk Download
// =========================================================================
#[tokio::test]
async fn test_01_correct_206_multipart_download() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let data: Arc<Vec<u8>> = Arc::new((0..2 * 1024 * 1024).map(|i| ((i * 7) % 251) as u8).collect());
    let expected_hash = sha256_bytes(&data);

    let cancel = CancellationToken::new();
    let cancel_srv = cancel.clone();
    let srv_data = data.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_srv.cancelled() => break,
                Ok((mut socket, _)) = listener.accept() => {
                    let data = srv_data.clone();
                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 4096];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);
                        let total = data.len();
                        if req.starts_with("HEAD") {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"v1\"\r\nConnection: close\r\n\r\n",
                                total
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if let Some((start, end_opt)) = parse_range_header(&req) {
                            let end = end_opt.unwrap_or(total - 1).min(total - 1);
                            let slice = &data[start..=end];
                            let resp = format!(
                                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nETag: \"v1\"\r\nConnection: close\r\n\r\n",
                                start, end, total, slice.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(slice).await;
                        } else {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nETag: \"v1\"\r\nConnection: close\r\n\r\n",
                                total
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&data).await;
                        }
                    });
                }
            }
        }
    });

    let dir = tempdir().unwrap();
    let db = Database::open(dir.path().join("tdm.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let job = manager
        .create_download(&format!("http://127.0.0.1:{}/ok206.bin", port), dir.path())
        .await
        .unwrap();
    assert!(job.is_resumable, "Valid 206 server should be resumable");
    assert!(job.chunk_count >= 2, "2MB file should use multi-chunk");

    manager.start_download(&job.id).unwrap();
    assert_eq!(
        wait_for_terminal(&manager, &job.id, Duration::from_secs(15))
            .await
            .unwrap(),
        JobState::Completed
    );
    assert_eq!(sha256_file(std::path::Path::new(&job.target_path)), expected_hash);
    cancel.cancel();
}

// =========================================================================
// TEST 2: Probe 206 Returning Full File (bytes 0-(N-1)/N for bytes=0-0)
// Exact reproduction of download.live.ledger.com CDN behavior!
// =========================================================================
#[tokio::test]
async fn test_02_probe_206_full_body_falls_back_to_single_stream() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let data: Arc<Vec<u8>> = Arc::new((0..2 * 1024 * 1024).map(|i| ((i * 13 + 5) % 253) as u8).collect());
    let expected_hash = sha256_bytes(&data);

    let cancel = CancellationToken::new();
    let cancel_srv = cancel.clone();
    let srv_data = data.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_srv.cancelled() => break,
                Ok((mut socket, _)) = listener.accept() => {
                    let data = srv_data.clone();
                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 4096];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);
                        let total = data.len();
                        if req.starts_with("HEAD") {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                                total
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if parse_range_header(&req).is_some() {
                            // Broken CDN: returns 206 with ENTIRE range 0-(total-1)/total regardless of Range requested!
                            let resp = format!(
                                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                total - 1, total, total
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&data).await;
                        } else {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                total
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&data).await;
                        }
                    });
                }
            }
        }
    });

    let dir = tempdir().unwrap();
    let db = Database::open(dir.path().join("tdm.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let job = manager
        .create_download(
            &format!("http://127.0.0.1:{}/ledger-live-desktop-4.23.0-win-x64.exe", port),
            dir.path(),
        )
        .await
        .unwrap();

    assert!(
        !job.is_resumable,
        "Probe MUST detect broken 206 bytes 0-(N-1)/N for bytes=0-0 and mark is_resumable=false"
    );

    manager.start_download(&job.id).unwrap();
    let state = wait_for_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .unwrap();
    let final_job = manager.get_download(&job.id).unwrap().unwrap();
    assert_eq!(
        state,
        JobState::Completed,
        "Expected completion, got err={:?}",
        final_job.error_message
    );
    assert_eq!(sha256_file(std::path::Path::new(&job.target_path)), expected_hash);
    cancel.cancel();
}

// =========================================================================
// TEST 3: Probe Succeeds 206 0-0/N, Then Chunk Worker Gets 206 bytes 0-(N-1)/N
// Exact reproduction of Mismatched Content-Range during multi-chunk -> safe single-stream fallback!
// =========================================================================
#[tokio::test]
async fn test_03_chunk_206_mismatched_offset_0_to_full_recovers_via_single_stream() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let data: Arc<Vec<u8>> = Arc::new((0..2 * 1024 * 1024).map(|i| ((i * 19 + 3) % 251) as u8).collect());
    let expected_hash = sha256_bytes(&data);
    let non_range_hits = Arc::new(AtomicUsize::new(0));

    let cancel = CancellationToken::new();
    let cancel_srv = cancel.clone();
    let srv_data = data.clone();
    let srv_hits = non_range_hits.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_srv.cancelled() => break,
                Ok((mut socket, _)) = listener.accept() => {
                    let data = srv_data.clone();
                    let hits = srv_hits.clone();
                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 4096];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);
                        let total = data.len();
                        if req.starts_with("HEAD") {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"cdn-mismatch\"\r\nConnection: close\r\n\r\n",
                                total
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if let Some((start, end_opt)) = parse_range_header(&req) {
                            if start == 0 && end_opt == Some(0) {
                                // Probe passes cleanly!
                                let resp = format!(
                                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/{}\r\nContent-Length: 1\r\nETag: \"cdn-mismatch\"\r\nConnection: close\r\n\r\n",
                                    total
                                );
                                let _ = socket.write_all(resp.as_bytes()).await;
                                let _ = socket.write_all(&data[0..1]).await;
                            } else {
                                // Real chunk range request triggers CDN bug: responds 206 with bytes 0-(N-1)/N!
                                let resp = format!(
                                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-{}/{}\r\nContent-Length: {}\r\nETag: \"cdn-mismatch\"\r\nConnection: close\r\n\r\n",
                                    total - 1, total, total
                                );
                                let _ = socket.write_all(resp.as_bytes()).await;
                                let _ = socket.write_all(&data).await;
                            }
                        } else {
                            hits.fetch_add(1, Ordering::SeqCst);
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nETag: \"cdn-mismatch\"\r\nConnection: close\r\n\r\n",
                                total
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&data).await;
                        }
                    });
                }
            }
        }
    });

    let dir = tempdir().unwrap();
    let db = Database::open(dir.path().join("tdm.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let job = manager
        .create_download(&format!("http://127.0.0.1:{}/mismatch.exe", port), dir.path())
        .await
        .unwrap();
    assert!(job.is_resumable, "Initial probe passed so multi-chunk starts");
    assert!(job.chunk_count >= 2);

    manager.start_download(&job.id).unwrap();
    let state = wait_for_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .unwrap();
    let final_job = manager.get_download(&job.id).unwrap().unwrap();
    assert_eq!(
        state,
        JobState::Completed,
        "Multi-chunk 206 offset mismatch MUST recover via single-stream fallback; err={:?}",
        final_job.error_message
    );
    assert_eq!(non_range_hits.load(Ordering::SeqCst), 1, "Fallback must issue clean full-body GET once");
    assert_eq!(sha256_file(std::path::Path::new(&job.target_path)), expected_hash);
    cancel.cancel();
}

// =========================================================================
// TEST 4: Server Ignores Range and Sends Unexpected 200 OK During Multi-Chunk
// =========================================================================
#[tokio::test]
async fn test_04_ignored_range_200_ok_during_multichunk_recovers_cleanly() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let data: Arc<Vec<u8>> = Arc::new((0..2 * 1024 * 1024).map(|i| ((i * 29 + 11) % 251) as u8).collect());
    let expected_hash = sha256_bytes(&data);

    let cancel = CancellationToken::new();
    let cancel_srv = cancel.clone();
    let srv_data = data.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_srv.cancelled() => break,
                Ok((mut socket, _)) = listener.accept() => {
                    let data = srv_data.clone();
                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 4096];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);
                        let total = data.len();
                        if req.starts_with("HEAD") {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                                total
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if let Some((0, Some(0))) = parse_range_header(&req) {
                            let resp = format!(
                                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/{}\r\nContent-Length: 1\r\nConnection: close\r\n\r\n",
                                total
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&data[0..1]).await;
                        } else {
                            // Server ignores Range and sends 200 OK full body!
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                total
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&data).await;
                        }
                    });
                }
            }
        }
    });

    let dir = tempdir().unwrap();
    let db = Database::open(dir.path().join("tdm.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let job = manager
        .create_download(&format!("http://127.0.0.1:{}/ignored_range.bin", port), dir.path())
        .await
        .unwrap();
    manager.start_download(&job.id).unwrap();
    let state = wait_for_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .unwrap();
    let final_job = manager.get_download(&job.id).unwrap().unwrap();
    assert_eq!(state, JobState::Completed, "err={:?}", final_job.error_message);
    assert_eq!(sha256_file(std::path::Path::new(&job.target_path)), expected_hash);
    cancel.cancel();
}

// =========================================================================
// TEST 5: Missing or Malformed Content-Range on 206 Strictly Rejected & Recovers
// =========================================================================
#[tokio::test]
async fn test_05_missing_or_invalid_content_range_on_206_rejected_and_recovers() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let data: Arc<Vec<u8>> = Arc::new((0..2 * 1024 * 1024).map(|i| ((i * 31 + 7) % 251) as u8).collect());
    let expected_hash = sha256_bytes(&data);
    let range_req_count = Arc::new(AtomicUsize::new(0));

    let cancel = CancellationToken::new();
    let cancel_srv = cancel.clone();
    let srv_data = data.clone();
    let srv_rc = range_req_count.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_srv.cancelled() => break,
                Ok((mut socket, _)) = listener.accept() => {
                    let data = srv_data.clone();
                    let rc = srv_rc.clone();
                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 4096];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);
                        let total = data.len();
                        if req.starts_with("HEAD") {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                                total
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if let Some((0, Some(0))) = parse_range_header(&req) {
                            let resp = format!(
                                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/{}\r\nContent-Length: 1\r\nConnection: close\r\n\r\n",
                                total
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&data[0..1]).await;
                        } else if parse_range_header(&req).is_some() {
                            let idx = rc.fetch_add(1, Ordering::SeqCst);
                            // Alternate between missing Content-Range and malformed Content-Range
                            // sending WRONG bytes (all 0xFF) to prove worker never trusts it!
                            let poison = vec![0xFFu8; 64 * 1024];
                            let resp = if idx.is_multiple_of(2) {
                                format!(
                                    "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                    poison.len()
                                )
                            } else {
                                format!(
                                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes invalid-range/nope\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                    poison.len()
                                )
                            };
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&poison).await;
                        } else {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                total
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&data).await;
                        }
                    });
                }
            }
        }
    });

    let dir = tempdir().unwrap();
    let db = Database::open(dir.path().join("tdm.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let job = manager
        .create_download(&format!("http://127.0.0.1:{}/badcr.bin", port), dir.path())
        .await
        .unwrap();
    manager.start_download(&job.id).unwrap();
    let state = wait_for_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .unwrap();
    let final_job = manager.get_download(&job.id).unwrap().unwrap();
    assert_eq!(state, JobState::Completed, "err={:?}", final_job.error_message);
    assert_eq!(sha256_file(std::path::Path::new(&job.target_path)), expected_hash);
    cancel.cancel();
}

// =========================================================================
// TEST 6: Redirect Changing Range Support (302 -> non-Range mirror)
// =========================================================================
#[tokio::test]
async fn test_06_redirect_changing_range_support_recovers_cleanly() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let data: Arc<Vec<u8>> = Arc::new((0..2 * 1024 * 1024).map(|i| ((i * 17 + 1) % 251) as u8).collect());
    let expected_hash = sha256_bytes(&data);
    let flip_redirect = Arc::new(AtomicBool::new(false));

    let cancel = CancellationToken::new();
    let cancel_srv = cancel.clone();
    let srv_data = data.clone();
    let srv_flip = flip_redirect.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_srv.cancelled() => break,
                Ok((mut socket, _)) = listener.accept() => {
                    let data = srv_data.clone();
                    let flip = srv_flip.clone();
                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 4096];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);
                        let first_line = req.lines().next().unwrap_or("");
                        let path = first_line.split_whitespace().nth(1).unwrap_or("/");
                        let total = data.len();

                        if path == "/entry.bin" {
                            if req.starts_with("HEAD") {
                                let resp = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                                    total
                                );
                                let _ = socket.write_all(resp.as_bytes()).await;
                            } else if let Some((0, Some(0))) = parse_range_header(&req) {
                                flip.store(true, Ordering::SeqCst);
                                let resp = format!(
                                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/{}\r\nContent-Length: 1\r\nConnection: close\r\n\r\n",
                                    total
                                );
                                let _ = socket.write_all(resp.as_bytes()).await;
                                let _ = socket.write_all(&data[0..1]).await;
                            } else if flip.load(Ordering::SeqCst) {
                                let resp = format!(
                                    "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{}/no-range-mirror.bin\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                                    port
                                );
                                let _ = socket.write_all(resp.as_bytes()).await;
                            }
                        } else {
                            // Mirror does NOT support Range: always serves 200 OK full body
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                total
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&data).await;
                        }
                    });
                }
            }
        }
    });

    let dir = tempdir().unwrap();
    let db = Database::open(dir.path().join("tdm.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let job = manager
        .create_download(&format!("http://127.0.0.1:{}/entry.bin", port), dir.path())
        .await
        .unwrap();
    manager.start_download(&job.id).unwrap();
    let state = wait_for_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .unwrap();
    let final_job = manager.get_download(&job.id).unwrap().unwrap();
    assert_eq!(state, JobState::Completed, "err={:?}", final_job.error_message);
    assert_eq!(sha256_file(std::path::Path::new(&job.target_path)), expected_hash);
    cancel.cancel();
}

// =========================================================================
// TEST 7: Resource Identity Changes Mid-Download (Shorter New File + New ETag)
// Must truncate .tdm-part cleanly with zero leftover bytes from larger old file!
// =========================================================================
#[tokio::test]
async fn test_07_resource_identity_change_shorter_file_truncates_cleanly() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let data_v1: Arc<Vec<u8>> = Arc::new(vec![0xAAu8; 2 * 1024 * 1024]);
    let data_v2: Arc<Vec<u8>> = Arc::new((0..1200 * 1024).map(|i| ((i * 41 + 9) % 251) as u8).collect());
    let expected_v2_hash = sha256_bytes(&data_v2);
    let switched = Arc::new(AtomicBool::new(false));

    let cancel = CancellationToken::new();
    let cancel_srv = cancel.clone();
    let d1 = data_v1.clone();
    let d2 = data_v2.clone();
    let sw = switched.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_srv.cancelled() => break,
                Ok((mut socket, _)) = listener.accept() => {
                    let d1 = d1.clone();
                    let d2 = d2.clone();
                    let sw = sw.clone();
                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 4096];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);
                        let is_v2 = sw.load(Ordering::SeqCst);

                        if req.starts_with("HEAD") {
                            let (len, etag) = if is_v2 { (d2.len(), "\"v2\"") } else { (d1.len(), "\"v1\"") };
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: {}\r\nConnection: close\r\n\r\n",
                                len, etag
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if let Some((0, Some(0))) = parse_range_header(&req) {
                            let resp = format!(
                                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/{}\r\nContent-Length: 1\r\nETag: \"v1\"\r\nConnection: close\r\n\r\n",
                                d1.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&d1[0..1]).await;
                            // Flip resource to shorter v2 right after initial probe!
                            sw.store(true, Ordering::SeqCst);
                        } else if parse_range_header(&req).is_some() {
                            // Server enforces If-Range mismatch -> returns 200 OK with NEW shorter v2!
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nETag: \"v2\"\r\nConnection: close\r\n\r\n",
                                d2.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&d2).await;
                        } else {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nETag: \"v2\"\r\nConnection: close\r\n\r\n",
                                d2.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&d2).await;
                        }
                    });
                }
            }
        }
    });

    let dir = tempdir().unwrap();
    let db = Database::open(dir.path().join("tdm.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let job = manager
        .create_download(&format!("http://127.0.0.1:{}/evolving.bin", port), dir.path())
        .await
        .unwrap();
    assert_eq!(job.total_bytes, Some(2 * 1024 * 1024));

    manager.start_download(&job.id).unwrap();
    let state = wait_for_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .unwrap();
    let final_job = manager.get_download(&job.id).unwrap().unwrap();
    assert_eq!(state, JobState::Completed, "err={:?}", final_job.error_message);
    let target = std::path::Path::new(&job.target_path);
    assert_eq!(fs::metadata(target).unwrap().len(), data_v2.len() as u64);
    assert_eq!(sha256_file(target), expected_v2_hash);
    cancel.cancel();
}

// =========================================================================
// TEST 8: ETag / Last-Modified Mismatch on 206 Chunk Fetch Rejects Mix & Recovers
// =========================================================================
#[tokio::test]
async fn test_08_etag_last_modified_mismatch_on_206_recovers_consistent_file() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let data_v1: Arc<Vec<u8>> = Arc::new(vec![0x11u8; 2 * 1024 * 1024]);
    let data_v2: Arc<Vec<u8>> = Arc::new((0..2 * 1024 * 1024).map(|i| ((i * 53 + 2) % 251) as u8).collect());
    let expected_v2_hash = sha256_bytes(&data_v2);
    let chunk_calls = Arc::new(AtomicUsize::new(0));

    let cancel = CancellationToken::new();
    let cancel_srv = cancel.clone();
    let d1 = data_v1.clone();
    let d2 = data_v2.clone();
    let cc = chunk_calls.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_srv.cancelled() => break,
                Ok((mut socket, _)) = listener.accept() => {
                    let d1 = d1.clone();
                    let d2 = d2.clone();
                    let cc = cc.clone();
                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 4096];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);
                        let total = d1.len();

                        if req.starts_with("HEAD") {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"etag-old\"\r\nLast-Modified: Mon, 01 Jan 2026 00:00:00 GMT\r\nConnection: close\r\n\r\n",
                                total
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if let Some((0, Some(0))) = parse_range_header(&req) {
                            let resp = format!(
                                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/{}\r\nContent-Length: 1\r\nETag: \"etag-old\"\r\nLast-Modified: Mon, 01 Jan 2026 00:00:00 GMT\r\nConnection: close\r\n\r\n",
                                total
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&d1[0..1]).await;
                        } else if let Some((start, end_opt)) = parse_range_header(&req) {
                            let call = cc.fetch_add(1, Ordering::SeqCst);
                            let end = end_opt.unwrap_or(total - 1).min(total - 1);
                            if call == 0 && start == 0 {
                                // First chunk serves old version
                                let slice = &d1[start..=end];
                                let resp = format!(
                                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nETag: \"etag-old\"\r\nLast-Modified: Mon, 01 Jan 2026 00:00:00 GMT\r\nConnection: close\r\n\r\n",
                                    start, end, total, slice.len()
                                );
                                let _ = socket.write_all(resp.as_bytes()).await;
                                let _ = socket.write_all(slice).await;
                            } else {
                                // Server ignores If-Range and sends 206 from NEW ETag/Last-Modified!
                                // Worker MUST detect validator mismatch and NOT mix v1 + v2 bytes!
                                let slice = &d2[start..=end];
                                let resp = format!(
                                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nETag: \"etag-new\"\r\nLast-Modified: Tue, 02 Jan 2026 00:00:00 GMT\r\nConnection: close\r\n\r\n",
                                    start, end, total, slice.len()
                                );
                                let _ = socket.write_all(resp.as_bytes()).await;
                                let _ = socket.write_all(slice).await;
                            }
                        } else {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nETag: \"etag-new\"\r\nLast-Modified: Tue, 02 Jan 2026 00:00:00 GMT\r\nConnection: close\r\n\r\n",
                                d2.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&d2).await;
                        }
                    });
                }
            }
        }
    });

    let dir = tempdir().unwrap();
    let db = Database::open(dir.path().join("tdm.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let job = manager
        .create_download(&format!("http://127.0.0.1:{}/etag_flip.bin", port), dir.path())
        .await
        .unwrap();
    manager.start_download(&job.id).unwrap();
    let state = wait_for_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .unwrap();
    let final_job = manager.get_download(&job.id).unwrap().unwrap();
    assert_eq!(state, JobState::Completed, "err={:?}", final_job.error_message);
    assert_eq!(sha256_file(std::path::Path::new(&job.target_path)), expected_v2_hash);
    cancel.cancel();
}

// =========================================================================
// TEST 9: Connection Interruption Mid-Stream + Retry Completes Accurately
// =========================================================================
#[tokio::test]
async fn test_09_connection_interruption_and_retry_completes_accurately() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let data: Arc<Vec<u8>> = Arc::new((0..1024 * 1024).map(|i| ((i * 23 + 4) % 251) as u8).collect());
    let expected_hash = sha256_bytes(&data);
    let get_attempts = Arc::new(AtomicUsize::new(0));

    let cancel = CancellationToken::new();
    let cancel_srv = cancel.clone();
    let srv_data = data.clone();
    let srv_attempts = get_attempts.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_srv.cancelled() => break,
                Ok((mut socket, _)) = listener.accept() => {
                    let data = srv_data.clone();
                    let attempts = srv_attempts.clone();
                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 4096];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);
                        let total = data.len();
                        if req.starts_with("HEAD") {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: none\r\nConnection: close\r\n\r\n",
                                total
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if let Some((0, Some(0))) = parse_range_header(&req) {
                            // Non-range server returns 200 OK on probe -> single stream mode
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                total
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&data[..1024]).await;
                        } else {
                            let attempt = attempts.fetch_add(1, Ordering::SeqCst);
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                total
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            if attempt == 0 {
                                // Drop TCP connection halfway through!
                                let _ = socket.write_all(&data[..total / 2]).await;
                                let _ = socket.shutdown().await;
                            } else {
                                let _ = socket.write_all(&data).await;
                            }
                        }
                    });
                }
            }
        }
    });

    let dir = tempdir().unwrap();
    let db = Database::open(dir.path().join("tdm.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let job = manager
        .create_download(&format!("http://127.0.0.1:{}/drop_midway.bin", port), dir.path())
        .await
        .unwrap();
    manager.start_download(&job.id).unwrap();
    let state = wait_for_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .unwrap();
    let final_job = manager.get_download(&job.id).unwrap().unwrap();
    assert_eq!(state, JobState::Completed, "err={:?}", final_job.error_message);
    assert!(get_attempts.load(Ordering::SeqCst) >= 2);
    assert_eq!(sha256_file(std::path::Path::new(&job.target_path)), expected_hash);
    cancel.cancel();
}

// =========================================================================
// TEST 10: HTTP 416 Range Not Satisfiable Recovers Once Without Infinite Loop
// =========================================================================
#[tokio::test]
async fn test_10_http_416_range_not_satisfiable_recovers_cleanly() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let data: Arc<Vec<u8>> = Arc::new((0..1536 * 1024).map(|i| ((i * 37 + 6) % 251) as u8).collect());
    let expected_hash = sha256_bytes(&data);

    let cancel = CancellationToken::new();
    let cancel_srv = cancel.clone();
    let srv_data = data.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_srv.cancelled() => break,
                Ok((mut socket, _)) = listener.accept() => {
                    let data = srv_data.clone();
                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 4096];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);
                        let total = data.len();
                        if req.starts_with("HEAD") {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                                total
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if let Some((0, Some(0))) = parse_range_header(&req) {
                            let resp = format!(
                                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/{}\r\nContent-Length: 1\r\nConnection: close\r\n\r\n",
                                total
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&data[0..1]).await;
                        } else if parse_range_header(&req).is_some() {
                            // Server rejects sub-range with 416 Range Not Satisfiable!
                            let resp = format!(
                                "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                                total
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                total
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&data).await;
                        }
                    });
                }
            }
        }
    });

    let dir = tempdir().unwrap();
    let db = Database::open(dir.path().join("tdm.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let job = manager
        .create_download(&format!("http://127.0.0.1:{}/err416.bin", port), dir.path())
        .await
        .unwrap();
    manager.start_download(&job.id).unwrap();
    let state = wait_for_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .unwrap();
    let final_job = manager.get_download(&job.id).unwrap().unwrap();
    assert_eq!(state, JobState::Completed, "err={:?}", final_job.error_message);
    assert_eq!(sha256_file(std::path::Path::new(&job.target_path)), expected_hash);
    cancel.cancel();
}

// =========================================================================
// TEST 11: Preserves Unrelated .tdm-part Files & Bounds Persistent Broken Server
// =========================================================================
#[tokio::test]
async fn test_11_preserves_unrelated_part_files_and_bounds_broken_server_loop() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let total_hits = Arc::new(AtomicUsize::new(0));
    let total_len = 2 * 1024 * 1024usize;

    let cancel = CancellationToken::new();
    let cancel_srv = cancel.clone();
    let srv_hits = total_hits.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_srv.cancelled() => break,
                Ok((mut socket, _)) = listener.accept() => {
                    let hits = srv_hits.clone();
                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 4096];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);
                        hits.fetch_add(1, Ordering::SeqCst);
                        if req.starts_with("HEAD") {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                                total_len
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if let Some((0, Some(0))) = parse_range_header(&req) {
                            let resp = format!(
                                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/{}\r\nContent-Length: 1\r\nConnection: close\r\n\r\n",
                                total_len
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&[0u8; 1]).await;
                        } else {
                            // Permanently broken server: ALWAYS responds 206 with bogus offset 99999!
                            let resp = format!(
                                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 99999-{}/{}\r\nContent-Length: 16\r\nConnection: close\r\n\r\n",
                                99999 + 15, total_len
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&[0xEEu8; 16]).await;
                        }
                    });
                }
            }
        }
    });

    let dir = tempdir().unwrap();
    // Pre-create an unrelated .tdm-part file in the exact same directory!
    let unrelated_part = dir.path().join("unrelated-archive.zip.tdm-part");
    let unrelated_bytes = b"UNRELATED-USER-PARTIAL-DATA-MUST-NEVER-BE-TOUCHED-1234567890";
    fs::write(&unrelated_part, unrelated_bytes).unwrap();

    let db = Database::open(dir.path().join("tdm.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let job = manager
        .create_download(&format!("http://127.0.0.1:{}/always_broken.bin", port), dir.path())
        .await
        .unwrap();
    manager.start_download(&job.id).unwrap();
    let state = wait_for_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .unwrap();
    assert_eq!(state, JobState::Failed, "Permanently broken server must fail cleanly");
    assert!(
        total_hits.load(Ordering::SeqCst) <= 20,
        "Requests must be strictly bounded (no infinite retry/fallback loop), saw {}",
        total_hits.load(Ordering::SeqCst)
    );
    assert_eq!(
        fs::read(&unrelated_part).unwrap(),
        unrelated_bytes,
        "Unrelated .tdm-part file MUST remain 100% preserved"
    );
    cancel.cancel();
}
