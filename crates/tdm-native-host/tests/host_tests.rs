use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use tdm_core::{Database, DownloadManager, EventBus};
use tdm_native_host::handle_message;
use tdm_native_host::protocol::NativeMessage;

#[tokio::test]
async fn test_native_host_ping_pong() {
    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("host_test_ping.sqlite");
    let db = Database::open(&db_path).unwrap();
    let manager = DownloadManager::new(db.clone(), EventBus::default()).unwrap();

    let msg = NativeMessage {
        action: "ping".to_string(),
        url: None,
        filename: None,
        destination: None,
        priority: None,
        job_id: None,
    };

    let resp = handle_message(msg, &manager, &db).await;
    assert_eq!(resp.status, "ok");
    assert_eq!(resp.action, "pong");
    assert_eq!(resp.version, Some("2.0.0".to_string()));
    assert!(resp
        .supported
        .as_ref()
        .unwrap()
        .contains(&"http".to_string()));
    assert!(resp
        .supported
        .as_ref()
        .unwrap()
        .contains(&"hls".to_string()));
    assert!(resp
        .supported
        .as_ref()
        .unwrap()
        .contains(&"dash".to_string()));
    assert!(resp
        .supported
        .as_ref()
        .unwrap()
        .contains(&"torrent".to_string()));
    assert!(resp
        .supported
        .as_ref()
        .unwrap()
        .contains(&"magnet".to_string()));
}

#[tokio::test]
async fn test_native_host_start_download_and_deduplication() {
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
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 1024];
                        let _ = socket.read(&mut buf).await;
                        let resp = "HTTP/1.1 200 OK\r\nContent-Length: 2048\r\nAccept-Ranges: bytes\r\n\r\n";
                        let _ = socket.write_all(resp.as_bytes()).await;
                        let body = vec![0x42u8; 2048];
                        let _ = socket.write_all(&body).await;
                    });
                }
            }
        }
    });

    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("host_test_dedup.sqlite");
    let db = Database::open(&db_path).unwrap();
    let manager = DownloadManager::new(db.clone(), EventBus::default()).unwrap();

    let download_url = format!("http://127.0.0.1:{}/media_test.mp4", port);

    // Call 1: start_download
    let msg1 = NativeMessage {
        action: "start_download".to_string(),
        url: Some(download_url.clone()),
        filename: Some("media_test.mp4".to_string()),
        destination: Some(temp_dir.path().to_string_lossy().to_string()),
        priority: Some("high".to_string()),
        job_id: None,
    };

    let resp1 = handle_message(msg1, &manager, &db).await;
    assert_eq!(resp1.status, "ok");
    assert!(resp1.job_id.is_some());
    let job_id = resp1.job_id.unwrap();

    // Call 2: duplicate start_download for same URL
    let msg2 = NativeMessage {
        action: "start_download".to_string(),
        url: Some(download_url.clone()),
        filename: Some("media_test.mp4".to_string()),
        destination: Some(temp_dir.path().to_string_lossy().to_string()),
        priority: Some("normal".to_string()),
        job_id: None,
    };

    let resp2 = handle_message(msg2, &manager, &db).await;
    assert_eq!(resp2.status, "already_exists");
    assert_eq!(resp2.job_id, Some(job_id));

    cancel.cancel();
}

#[tokio::test]
async fn test_native_host_invalid_urls_rejected() {
    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("host_test_invalid.sqlite");
    let db = Database::open(&db_path).unwrap();
    let manager = DownloadManager::new(db.clone(), EventBus::default()).unwrap();

    // Blob URL rejection
    let msg_blob = NativeMessage {
        action: "start_download".to_string(),
        url: Some("blob:https://example.com/a5e2f789".to_string()),
        filename: None,
        destination: None,
        priority: None,
        job_id: None,
    };
    let resp_blob = handle_message(msg_blob, &manager, &db).await;
    assert_eq!(resp_blob.status, "error");
    assert!(resp_blob
        .message
        .unwrap()
        .contains("Only http:// and https://"));

    // JavaScript URL rejection
    let msg_js = NativeMessage {
        action: "start_download".to_string(),
        url: Some("javascript:void(0)".to_string()),
        filename: None,
        destination: None,
        priority: None,
        job_id: None,
    };
    let resp_js = handle_message(msg_js, &manager, &db).await;
    assert_eq!(resp_js.status, "error");
}

#[tokio::test]
async fn test_native_host_detect_capability() {
    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("host_test_cap.sqlite");
    let db = Database::open(&db_path).unwrap();
    let manager = DownloadManager::new(db.clone(), EventBus::default()).unwrap();

    let msg = NativeMessage {
        action: "detect_capability".to_string(),
        url: None,
        filename: None,
        destination: None,
        priority: None,
        job_id: None,
    };

    let resp = handle_message(msg, &manager, &db).await;
    assert_eq!(resp.status, "ok");
    assert_eq!(resp.action, "capability");
    assert!(resp
        .supported
        .as_ref()
        .unwrap()
        .contains(&"http".to_string()));
    assert!(resp
        .supported
        .as_ref()
        .unwrap()
        .contains(&"https".to_string()));
    assert!(resp
        .supported
        .as_ref()
        .unwrap()
        .contains(&"hls".to_string()));
    assert!(resp
        .supported
        .as_ref()
        .unwrap()
        .contains(&"dash".to_string()));
    assert!(resp
        .supported
        .as_ref()
        .unwrap()
        .contains(&"torrent".to_string()));
    assert!(resp
        .supported
        .as_ref()
        .unwrap()
        .contains(&"magnet".to_string()));
}

#[tokio::test]
async fn test_native_host_process_e2e_stdin_stdout_download() {
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::process::Stdio;
    use std::time::Duration;
    use tdm_native_host::protocol::{read_response_async, write_message_async};
    use tokio::process::Command;

    // 1. Mock server serving a real 512KB payload
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    let test_data: Vec<u8> = (0..512 * 1024).map(|i| (i % 251) as u8).collect();
    let expected_hash = {
        let mut hasher = Sha256::new();
        hasher.update(&test_data);
        hex::encode(hasher.finalize())
    };

    let server_data = test_data.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let data = server_data.clone();
                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 2048];
                        let _ = socket.read(&mut buf).await;
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: video/mp4\r\nConnection: close\r\n\r\n",
                            data.len()
                        );
                        let _ = socket.write_all(resp.as_bytes()).await;
                        let _ = socket.write_all(&data).await;
                    });
                }
            }
        }
    });

    // 2. Locate host executable
    let exe_path = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("tdm-native-host.exe");

    let exe_to_run = if exe_path.exists() {
        exe_path
    } else {
        std::path::PathBuf::from(env!("CARGO_BIN_EXE_tdm-native-host"))
    };

    let temp_dir = tempdir().unwrap();
    let test_pipe = format!(r"\\.\pipe\tdm-test-e2e-{}", uuid::Uuid::new_v4());

    let mut child = Command::new(&exe_to_run)
        .env("TORI_DATA_DIR", temp_dir.path())
        .env("TORI_IPC_PIPE", &test_pipe)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("Failed to spawn tdm-native-host child process");

    let mut stdin = child.stdin.take().expect("Child stdin not captured");
    let mut stdout = child.stdout.take().expect("Child stdout not captured");

    // 3. E2E Step 1: Send ping
    let ping_msg = NativeMessage {
        action: "ping".to_string(),
        url: None,
        filename: None,
        destination: None,
        priority: None,
        job_id: None,
    };
    write_message_async(&mut stdin, &ping_msg)
        .await
        .expect("Failed to write ping");

    let ping_resp = read_response_async(&mut stdout)
        .await
        .expect("Failed to read ping response")
        .expect("Empty response for ping");
    assert_eq!(ping_resp.status, "ok");
    assert_eq!(ping_resp.action, "pong");

    // 4. E2E Step 2: Start real download to temp dir
    let download_url = format!("http://127.0.0.1:{}/e2e_video.mp4", port);

    let start_msg = NativeMessage {
        action: "start_download".to_string(),
        url: Some(download_url.clone()),
        filename: Some("e2e_video.mp4".to_string()),
        destination: Some(temp_dir.path().to_string_lossy().to_string()),
        priority: Some("high".to_string()),
        job_id: None,
    };
    write_message_async(&mut stdin, &start_msg)
        .await
        .expect("Failed to write start_download");

    let start_resp = read_response_async(&mut stdout)
        .await
        .expect("Failed to read start_download response")
        .expect("Empty response for start_download");
    assert_eq!(start_resp.status, "ok");
    assert!(start_resp.job_id.is_some());
    let job_id = start_resp.job_id.unwrap();

    // 5. E2E Step 3: Duplicate download detection
    let dup_msg = NativeMessage {
        action: "start_download".to_string(),
        url: Some(download_url.clone()),
        filename: Some("e2e_video.mp4".to_string()),
        destination: Some(temp_dir.path().to_string_lossy().to_string()),
        priority: Some("normal".to_string()),
        job_id: None,
    };
    write_message_async(&mut stdin, &dup_msg)
        .await
        .expect("Failed to write duplicate start_download");

    let dup_resp = read_response_async(&mut stdout)
        .await
        .expect("Failed to read duplicate response")
        .expect("Empty response for duplicate");
    assert_eq!(dup_resp.status, "already_exists");
    assert_eq!(dup_resp.job_id, Some(job_id));

    // 6. E2E Step 4: Capability detection
    let cap_msg = NativeMessage {
        action: "detect_capability".to_string(),
        url: None,
        filename: None,
        destination: None,
        priority: None,
        job_id: None,
    };
    write_message_async(&mut stdin, &cap_msg)
        .await
        .expect("Failed to write detect_capability");

    let cap_resp = read_response_async(&mut stdout)
        .await
        .expect("Failed to read capability response")
        .expect("Empty response for capability");
    assert_eq!(cap_resp.status, "ok");
    assert!(cap_resp.supported.unwrap().contains(&"http".to_string()));

    // 7. Verify file downloaded to disk within 5 seconds
    let target_file = temp_dir.path().join("e2e_video.mp4");
    let start_time = std::time::Instant::now();
    let mut file_done = false;
    while start_time.elapsed() < Duration::from_secs(5) {
        if target_file.exists()
            && fs::metadata(&target_file).map(|m| m.len()).unwrap_or(0) == 512 * 1024
        {
            file_done = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(file_done, "Target file was not fully written to disk");

    let downloaded_bytes = fs::read(&target_file).expect("Failed to read target file");
    let mut hasher = Sha256::new();
    hasher.update(&downloaded_bytes);
    let downloaded_hash = hex::encode(hasher.finalize());
    assert_eq!(downloaded_hash, expected_hash, "File SHA-256 hash mismatch");

    // 8. Gracefully close child process stdin
    drop(stdin);
    let _ = child.wait().await;
    cancel.cancel();
}

#[tokio::test]
async fn test_native_host_ipc_persistent_engine() {
    use std::sync::Arc;
    use std::time::Duration;
    use tdm_native_host::ipc::{forward_to_pipe, run_ipc_server_on_pipe};

    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("host_ipc_test.sqlite");
    let db = Database::open(&db_path).unwrap();
    let manager = Arc::new(DownloadManager::new(db.clone(), EventBus::default()).unwrap());

    // Generate unique test pipe name
    let test_pipe = format!(r"\\.\pipe\tdm-test-ipc-{}", uuid::Uuid::new_v4());
    let shutdown_token = CancellationToken::new();

    let server_pipe = test_pipe.clone();
    let server_mgr = manager.clone();
    let server_db = db.clone();
    let server_token = shutdown_token.clone();

    tokio::spawn(async move {
        run_ipc_server_on_pipe(&server_pipe, server_mgr, server_db, server_token).await;
    });

    // Wait for pipe to be ready
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Test 1: Ping over IPC
    let ping_msg = NativeMessage {
        action: "ping".to_string(),
        url: None,
        filename: None,
        destination: None,
        priority: None,
        job_id: None,
    };
    let ping_resp = forward_to_pipe(&test_pipe, &ping_msg)
        .await
        .expect("Failed to forward ping over IPC pipe");
    assert_eq!(ping_resp.status, "ok");
    assert_eq!(ping_resp.action, "pong");

    // Test 2: Start download through IPC pipe to persistent manager
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
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 1024];
                        let _ = socket.read(&mut buf).await;
                        let resp = "HTTP/1.1 200 OK\r\nContent-Length: 1024\r\nAccept-Ranges: bytes\r\n\r\n";
                        let _ = socket.write_all(resp.as_bytes()).await;
                        let body = vec![0x33u8; 1024];
                        let _ = socket.write_all(&body).await;
                    });
                }
            }
        }
    });

    let download_url = format!("http://127.0.0.1:{}/ipc_download.mp4", port);
    let start_msg = NativeMessage {
        action: "start_download".to_string(),
        url: Some(download_url),
        filename: Some("ipc_download.mp4".to_string()),
        destination: Some(temp_dir.path().to_string_lossy().to_string()),
        priority: Some("high".to_string()),
        job_id: None,
    };

    let start_resp = forward_to_pipe(&test_pipe, &start_msg)
        .await
        .expect("Failed to forward start_download over IPC pipe");
    assert_eq!(start_resp.status, "ok");
    assert!(start_resp.job_id.is_some());

    // Verify job exists in the persistent manager
    let job_id = start_resp.job_id.unwrap();
    let job = manager.get_download(&job_id).unwrap().unwrap();
    assert_eq!(job.filename, "ipc_download.mp4");

    shutdown_token.cancel();
    cancel.cancel();
}
