use std::sync::Arc;
use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use reqwest::header::{HOST, ORIGIN};
use tdm_core::{Database, DownloadManager, EventBus};
use tdm_native_host::server::start_server;

#[tokio::test]
async fn test_server_bind_and_ping() {
    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("server_test_ping.sqlite");
    let db = Database::open(&db_path).unwrap();
    let event_bus = EventBus::default();
    let manager = Arc::new(DownloadManager::new(db.clone(), event_bus).unwrap());
    let shutdown = CancellationToken::new();

    let (port, token) = start_server(manager, db.clone(), shutdown.clone())
        .await
        .expect("Server failed to start");

    assert!(port > 0);
    assert!(!token.is_empty());

    let client = reqwest::Client::new();
    let base_url = format!("http://127.0.0.1:{}", port);

    // 1. Ping without token
    let resp = client
        .get(format!("{}/api/v1/ping", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .send()
        .await
        .expect("Ping request failed");

    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["status"], "ok");
    assert_eq!(body["name"], "TORI Download Manager");
    assert_eq!(body["version"], "2.0.0");
    assert_eq!(body["authenticated"], false);

    // 2. Ping with valid X-Tori-Token
    let resp_auth = client
        .get(format!("{}/api/v1/ping", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header("X-Tori-Token", &token)
        .send()
        .await
        .expect("Authenticated ping request failed");

    assert_eq!(resp_auth.status(), 200);
    let body_auth: serde_json::Value = resp_auth.json().await.unwrap();
    assert_eq!(body_auth["authenticated"], true);

    shutdown.cancel();
}

#[tokio::test]
async fn test_dns_rebinding_defense() {
    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("server_test_rebind.sqlite");
    let db = Database::open(&db_path).unwrap();
    let event_bus = EventBus::default();
    let manager = Arc::new(DownloadManager::new(db.clone(), event_bus).unwrap());
    let shutdown = CancellationToken::new();

    let (port, _) = start_server(manager, db, shutdown.clone())
        .await
        .expect("Server failed to start");

    let client = reqwest::Client::new();
    let base_url = format!("http://127.0.0.1:{}", port);

    // Request with malicious external Host header (simulating DNS rebinding attacker)
    let resp = client
        .get(format!("{}/api/v1/status", base_url))
        .header(HOST, "attacker-domain.evil.com:6800")
        .send()
        .await
        .expect("Request failed");

    assert_eq!(resp.status(), 400);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["status"], "error");
    assert!(body["message"].as_str().unwrap().contains("Invalid Host"));

    shutdown.cancel();
}

#[tokio::test]
async fn test_origin_validation_and_cors() {
    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("server_test_origin.sqlite");
    let db = Database::open(&db_path).unwrap();
    let event_bus = EventBus::default();
    let manager = Arc::new(DownloadManager::new(db.clone(), event_bus).unwrap());
    let shutdown = CancellationToken::new();

    let (port, token) = start_server(manager, db, shutdown.clone())
        .await
        .expect("Server failed to start");

    let client = reqwest::Client::new();
    let base_url = format!("http://127.0.0.1:{}", port);

    // 1. Arbitrary web page origin must be rejected with 403 Forbidden
    let bad_web_resp = client
        .get(format!("{}/api/v1/ping", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header(ORIGIN, "https://malicious-site.example.com")
        .send()
        .await
        .expect("Request failed");
    assert_eq!(bad_web_resp.status(), 403);

    // 2. Authorized Chrome extension origin must be permitted and return explicit CORS header
    let chrome_origin = "chrome-extension://jfnfgmcbgapcpieaonbaolgebjaejcdm";
    let chrome_resp = client
        .get(format!("{}/api/v1/ping", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header(ORIGIN, chrome_origin)
        .header("X-Tori-Token", &token)
        .send()
        .await
        .expect("Request failed");
    assert_eq!(chrome_resp.status(), 200);
    let allow_origin = chrome_resp
        .headers()
        .get("access-control-allow-origin")
        .expect("Missing Access-Control-Allow-Origin header");
    assert_eq!(allow_origin, chrome_origin);

    // 3. Authorized Edge extension origin must be permitted
    let edge_origin = "edge-extension://bflchfddfgkfglmjapohkjmldepflkbe";
    let edge_resp = client
        .get(format!("{}/api/v1/ping", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header(ORIGIN, edge_origin)
        .header("X-Tori-Token", &token)
        .send()
        .await
        .expect("Request failed");
    assert_eq!(edge_resp.status(), 200);
    assert_eq!(
        edge_resp
            .headers()
            .get("access-control-allow-origin")
            .unwrap(),
        edge_origin
    );

    // 4. Unauthorized extension origin must be rejected with 403 Forbidden
    let unauth_ext_resp = client
        .get(format!("{}/api/v1/ping", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header(ORIGIN, "chrome-extension://unauthorizedextensionid12345678")
        .send()
        .await
        .expect("Request failed");
    assert_eq!(unauth_ext_resp.status(), 403);

    // 5. Spoofed origin containing authorized ID as substring must be rejected with 403
    let spoof_sub_resp = client
        .get(format!("{}/api/v1/ping", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header(
            ORIGIN,
            "chrome-extension://fake_jfnfgmcbgapcpieaonbaolgebjaejcdm",
        )
        .send()
        .await
        .expect("Request failed");
    assert_eq!(spoof_sub_resp.status(), 403);

    // 6. Malformed origin with port must be rejected with 403
    let malformed_resp = client
        .get(format!("{}/api/v1/ping", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header(
            ORIGIN,
            "chrome-extension://jfnfgmcbgapcpieaonbaolgebjaejcdm:8080",
        )
        .send()
        .await
        .expect("Request failed");
    assert_eq!(malformed_resp.status(), 403);

    // 7. Valid token sent with unauthorized browser origin: origin check MUST enforce 403
    let token_with_bad_origin = client
        .get(format!("{}/api/v1/downloads", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header(ORIGIN, "chrome-extension://evilbadextensionorigin12345678")
        .header("X-Tori-Token", &token)
        .send()
        .await
        .expect("Request failed");
    assert_eq!(token_with_bad_origin.status(), 403);

    // 8. Preflight OPTIONS request for authorized origin -> 204 No Content with CORS headers
    let preflight_ok = client
        .request(
            reqwest::Method::OPTIONS,
            format!("{}/api/v1/downloads", base_url),
        )
        .header(HOST, format!("127.0.0.1:{}", port))
        .header(ORIGIN, chrome_origin)
        .send()
        .await
        .expect("OPTIONS failed");
    assert_eq!(preflight_ok.status(), 204);
    assert_eq!(
        preflight_ok
            .headers()
            .get("access-control-allow-origin")
            .unwrap(),
        chrome_origin
    );

    // 9. Preflight OPTIONS request for unauthorized origin -> 403 Forbidden without CORS
    let preflight_bad = client
        .request(
            reqwest::Method::OPTIONS,
            format!("{}/api/v1/downloads", base_url),
        )
        .header(HOST, format!("127.0.0.1:{}", port))
        .header(ORIGIN, "chrome-extension://unauthorizedid12345678901234")
        .send()
        .await
        .expect("OPTIONS failed");
    assert_eq!(preflight_bad.status(), 403);
    assert!(preflight_bad
        .headers()
        .get("access-control-allow-origin")
        .is_none());

    // 10. Trusted desktop Tauri origin -> permitted
    let tauri_origin = "http://tauri.localhost";
    let tauri_resp = client
        .get(format!("{}/api/v1/ping", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header(ORIGIN, tauri_origin)
        .header("X-Tori-Token", &token)
        .send()
        .await
        .expect("Request failed");
    assert_eq!(tauri_resp.status(), 200);

    // 11. Spoofed desktop origin -> rejected
    let spoof_tauri = client
        .get(format!("{}/api/v1/ping", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header(ORIGIN, "http://tauri.localhost.attacker.com")
        .send()
        .await
        .expect("Request failed");
    assert_eq!(spoof_tauri.status(), 403);

    // 12. Direct non-browser request without Origin header with valid token -> permitted
    let no_origin_resp = client
        .get(format!("{}/api/v1/downloads", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header("X-Tori-Token", &token)
        .send()
        .await
        .expect("Request failed");
    assert_eq!(no_origin_resp.status(), 200);

    shutdown.cancel();
}

#[tokio::test]
async fn test_pairing_and_auth_enforcement() {
    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("server_test_auth.sqlite");
    let db = Database::open(&db_path).unwrap();
    let event_bus = EventBus::default();
    let manager = Arc::new(DownloadManager::new(db.clone(), event_bus).unwrap());
    let shutdown = CancellationToken::new();

    let (port, token) = start_server(manager, db, shutdown.clone())
        .await
        .expect("Server failed to start");

    let client = reqwest::Client::new();
    let base_url = format!("http://127.0.0.1:{}", port);

    // 1. Pair with wrong token -> 401
    let pair_bad = client
        .post(format!("{}/api/v1/pair", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header("X-Tori-Token", "wrong_token_123")
        .send()
        .await
        .unwrap();
    assert_eq!(pair_bad.status(), 401);

    // 2. Pair with correct token -> 200
    let pair_good = client
        .post(format!("{}/api/v1/pair", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header("X-Tori-Token", &token)
        .send()
        .await
        .unwrap();
    assert_eq!(pair_good.status(), 200);
    let pair_json: serde_json::Value = pair_good.json().await.unwrap();
    assert_eq!(pair_json["paired"], true);

    // 3. Privileged endpoint without auth -> 401
    let unauth_list = client
        .get(format!("{}/api/v1/downloads", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .send()
        .await
        .unwrap();
    assert_eq!(unauth_list.status(), 401);

    shutdown.cancel();
}

#[tokio::test]
async fn test_server_downloads_crud_lifecycle() {
    // 1. Mock remote HTTP server serving test bytes
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let file_port = listener.local_addr().unwrap().port();
    let srv_cancel = CancellationToken::new();
    let srv_cancel_run = srv_cancel.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = srv_cancel_run.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 1024];
                        let _ = socket.read(&mut buf).await;
                        let payload = vec![0xABu8; 8192];
                        let header = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: video/mp4\r\nConnection: close\r\n\r\n",
                            payload.len()
                        );
                        let _ = socket.write_all(header.as_bytes()).await;
                        let _ = socket.write_all(&payload).await;
                    });
                }
            }
        }
    });

    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("server_test_crud.sqlite");
    let db = Database::open(&db_path).unwrap();
    let event_bus = EventBus::default();
    let manager = Arc::new(DownloadManager::new(db.clone(), event_bus).unwrap());
    let shutdown = CancellationToken::new();

    let (port, token) = start_server(manager, db, shutdown.clone())
        .await
        .expect("Server failed to start");

    let client = reqwest::Client::new();
    let base_url = format!("http://127.0.0.1:{}", port);
    let target_url = format!("http://127.0.0.1:{}/test_video.mp4", file_port);

    // 2. Create download
    let create_body = serde_json::json!({
        "url": target_url,
        "filename": "test_video.mp4",
        "destination": temp_dir.path().to_string_lossy().to_string(),
        "priority": "high"
    });

    let create_resp = client
        .post(format!("{}/api/v1/downloads", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header("X-Tori-Token", &token)
        .json(&create_body)
        .send()
        .await
        .unwrap();

    assert_eq!(create_resp.status(), 200);
    let create_json: serde_json::Value = create_resp.json().await.unwrap();
    assert_eq!(create_json["status"], "ok");
    let job_id = create_json["job_id"].as_str().unwrap().to_string();

    // 3. Duplicate download check
    let dup_resp = client
        .post(format!("{}/api/v1/downloads", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header("X-Tori-Token", &token)
        .json(&create_body)
        .send()
        .await
        .unwrap();

    assert_eq!(dup_resp.status(), 200);
    let dup_json: serde_json::Value = dup_resp.json().await.unwrap();
    assert_eq!(dup_json["status"], "already_exists");
    assert_eq!(dup_json["job_id"], job_id);

    // 4. List downloads
    let list_resp = client
        .get(format!("{}/api/v1/downloads", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header("X-Tori-Token", &token)
        .send()
        .await
        .unwrap();

    assert_eq!(list_resp.status(), 200);
    let list_json: serde_json::Value = list_resp.json().await.unwrap();
    assert_eq!(list_json["status"], "ok");
    assert!(!list_json["jobs"].as_array().unwrap().is_empty());

    // 5. Pause download
    let pause_resp = client
        .post(format!("{}/api/v1/downloads/{}/pause", base_url, job_id))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header("X-Tori-Token", &token)
        .send()
        .await
        .unwrap();
    assert_eq!(pause_resp.status(), 200);

    // 6. Resume download
    let resume_resp = client
        .post(format!("{}/api/v1/downloads/{}/resume", base_url, job_id))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header("X-Tori-Token", &token)
        .send()
        .await
        .unwrap();
    assert_eq!(resume_resp.status(), 200);

    // 7. Show window action
    let win_resp = client
        .post(format!("{}/api/v1/window/show", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header("X-Tori-Token", &token)
        .send()
        .await
        .unwrap();
    assert_eq!(win_resp.status(), 200);

    // 8. Cancel download
    let cancel_resp = client
        .post(format!("{}/api/v1/downloads/{}/cancel", base_url, job_id))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header("X-Tori-Token", &token)
        .send()
        .await
        .unwrap();
    assert_eq!(cancel_resp.status(), 200);

    // 9. Retry download
    let retry_resp = client
        .post(format!("{}/api/v1/downloads/{}/retry", base_url, job_id))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header("X-Tori-Token", &token)
        .send()
        .await
        .unwrap();
    assert_eq!(retry_resp.status(), 200);

    srv_cancel.cancel();
    shutdown.cancel();
}

#[tokio::test]
async fn test_server_rejects_webpage_download_urls() {
    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("server_test_reject_webpage.sqlite");
    let db = Database::open(&db_path).unwrap();
    let event_bus = EventBus::default();
    let manager = Arc::new(DownloadManager::new(db.clone(), event_bus).unwrap());
    let shutdown = CancellationToken::new();

    let (port, token) = start_server(manager, db.clone(), shutdown.clone())
        .await
        .unwrap();

    let client = reqwest::Client::new();
    let base_url = format!("http://127.0.0.1:{}", port);

    let create_body = serde_json::json!({
        "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "filename": "watch.mp4",
    });

    let resp = client
        .post(format!("{}/api/v1/downloads", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header("X-Tori-Token", &token)
        .json(&create_body)
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 400);
    let json: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(json["status"], "error");
    assert!(json["message"]
        .as_str()
        .unwrap()
        .contains("Video watch page URLs cannot be downloaded directly"));

    shutdown.cancel();
}

#[tokio::test]
async fn test_server_media_endpoints() {
    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("server_test_media.sqlite");
    let db = Database::open(&db_path).unwrap();
    let event_bus = EventBus::default();
    let manager = Arc::new(DownloadManager::new(db.clone(), event_bus).unwrap());
    let shutdown = CancellationToken::new();

    let (port, token) = start_server(manager, db.clone(), shutdown.clone())
        .await
        .unwrap();

    let client = reqwest::Client::new();
    let base_url = format!("http://127.0.0.1:{}", port);

    // 1. GET /api/v1/media/status requires authentication
    let unauth_status_resp = client
        .get(format!("{}/api/v1/media/status", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .send()
        .await
        .unwrap();
    assert_eq!(unauth_status_resp.status(), 401);

    let status_resp = client
        .get(format!("{}/api/v1/media/status", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header("X-Tori-Token", &token)
        .send()
        .await
        .unwrap();
    assert_eq!(status_resp.status(), 200);
    let status_json: serde_json::Value = status_resp.json().await.unwrap();
    assert_eq!(status_json["yt_dlp_available"], true);

    // 2. POST /api/v1/media/resolve without token -> 401
    let unauth_resp = client
        .post(format!("{}/api/v1/media/resolve", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .json(&serde_json::json!({ "url": "https://www.youtube.com/watch?v=aqz-KE-bpKQ" }))
        .send()
        .await
        .unwrap();
    assert_eq!(unauth_resp.status(), 401);

    // 3. POST /api/v1/media/resolve with SSRF URL -> 400
    let ssrf_resp = client
        .post(format!("{}/api/v1/media/resolve", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header("X-Tori-Token", &token)
        .json(&serde_json::json!({ "url": "http://127.0.0.1:9999/secret" }))
        .send()
        .await
        .unwrap();
    assert_eq!(ssrf_resp.status(), 400);

    // 4. POST /api/v1/media/download creates managed media job
    let dl_resp = client
        .post(format!("{}/api/v1/media/download", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header("X-Tori-Token", &token)
        .json(&serde_json::json!({
            "url": "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
            "format_id": "18",
            "filename": "test_bunny.mp4",
            "destination": temp_dir.path().to_str().unwrap()
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(dl_resp.status(), 200);
    let dl_json: serde_json::Value = dl_resp.json().await.unwrap();
    assert_eq!(dl_json["status"], "ok");
    assert!(dl_json["job_id"].is_string());

    // 5. POST /api/v1/media/download with duplicate active URL and SAME format -> returns already_exists
    let dup_resp = client
        .post(format!("{}/api/v1/media/download", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header("X-Tori-Token", &token)
        .json(&serde_json::json!({
            "url": "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
            "format_id": "18",
            "filename": "test_bunny.mp4",
            "destination": temp_dir.path().to_str().unwrap()
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(dup_resp.status(), 200);
    let dup_json: serde_json::Value = dup_resp.json().await.unwrap();
    assert_eq!(dup_json["status"], "already_exists");
    assert_eq!(dup_json["job_id"], dl_json["job_id"]);

    // 6. Gate 27 Regression Fix: POST /api/v1/media/download with Audio-only format (e.g. 140)
    // from the SAME media URL must NOT be blocked as duplicate; returns ok with distinct job_id
    let audio_resp = client
        .post(format!("{}/api/v1/media/download", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header("X-Tori-Token", &token)
        .json(&serde_json::json!({
            "url": "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
            "format_id": "140",
            "filename": "test_bunny_audio.m4a",
            "destination": temp_dir.path().to_str().unwrap()
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(audio_resp.status(), 200);
    let audio_json: serde_json::Value = audio_resp.json().await.unwrap();
    assert_eq!(audio_json["status"], "ok");
    assert!(audio_json["job_id"].is_string());
    assert_ne!(audio_json["job_id"], dl_json["job_id"]);

    // 7. Gate 27 Regression Fix: POST /api/v1/media/download with another Video format (e.g. 22 / 720p)
    // from the SAME media URL must also succeed with a distinct job_id
    let v720_resp = client
        .post(format!("{}/api/v1/media/download", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header("X-Tori-Token", &token)
        .json(&serde_json::json!({
            "url": "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
            "format_id": "22",
            "filename": "test_bunny_720p.mp4",
            "destination": temp_dir.path().to_str().unwrap()
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(v720_resp.status(), 200);
    let v720_json: serde_json::Value = v720_resp.json().await.unwrap();
    assert_eq!(v720_json["status"], "ok");
    assert_ne!(v720_json["job_id"], dl_json["job_id"]);
    assert_ne!(v720_json["job_id"], audio_json["job_id"]);

    // 8. Repeated click for Audio format (140) while active -> returns already_exists for audio job
    let dup_audio_resp = client
        .post(format!("{}/api/v1/media/download", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header("X-Tori-Token", &token)
        .json(&serde_json::json!({
            "url": "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
            "format_id": "140",
            "filename": "test_bunny_audio.m4a",
            "destination": temp_dir.path().to_str().unwrap()
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(dup_audio_resp.status(), 200);
    let dup_audio_json: serde_json::Value = dup_audio_resp.json().await.unwrap();
    assert_eq!(dup_audio_json["status"], "already_exists");
    assert_eq!(dup_audio_json["job_id"], audio_json["job_id"]);

    shutdown.cancel();
}

#[tokio::test]
async fn test_gate35_security_hardening_server_and_registry() {
    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("server_test_gate35.sqlite");
    let db = Database::open(&db_path).unwrap();
    let event_bus = EventBus::default();
    let manager = Arc::new(DownloadManager::new(db.clone(), event_bus).unwrap());
    let shutdown = CancellationToken::new();

    let (port, initial_token, token_handle) =
        tdm_native_host::server::start_server_with_handle(manager, db.clone(), shutdown.clone())
            .await
            .unwrap();

    let client = reqwest::Client::new();
    let base_url = format!("http://127.0.0.1:{}", port);

    // 1. SEC-35-06: Origin: null must be rejected with 403 Forbidden
    let null_origin_resp = client
        .get(format!("{}/api/v1/status", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header(ORIGIN, "null")
        .send()
        .await
        .unwrap();
    assert_eq!(null_origin_resp.status(), 403);

    // 2. SEC-35-06: /api/v1/thumbnails/{id} requires authentication
    let unauth_thumb = client
        .get(format!("{}/api/v1/thumbnails/nonexistent-id", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .send()
        .await
        .unwrap();
    assert_eq!(unauth_thumb.status(), 401);

    let auth_thumb = client
        .get(format!("{}/api/v1/thumbnails/nonexistent-id", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header("X-Tori-Token", &initial_token)
        .send()
        .await
        .unwrap();
    assert_eq!(auth_thumb.status(), 404);

    // 3. SEC-35-06: Live token rotation immediately invalidates old token & accepts new token
    let rotated_token = "tori_rotated_gate35_token_0123456789abcdef".to_string();
    token_handle.update_token(rotated_token.clone()).await;

    let old_tok_resp = client
        .get(format!("{}/api/v1/downloads", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header("X-Tori-Token", &initial_token)
        .send()
        .await
        .unwrap();
    assert_eq!(old_tok_resp.status(), 401);

    let new_tok_resp = client
        .get(format!("{}/api/v1/downloads", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header("X-Tori-Token", &rotated_token)
        .send()
        .await
        .unwrap();
    assert_eq!(new_tok_resp.status(), 200);

    // 4. SEC-35-02 & SEC-35-07: Media download rejects flag URL, file:// URL, flag format_id, and UNC dest
    for payload in [
        serde_json::json!({
            "url": "--exec=calc.exe",
            "format_id": "18",
            "destination": temp_dir.path().to_str().unwrap()
        }),
        serde_json::json!({
            "url": "file:///C:/Windows/win.ini",
            "format_id": "18",
            "destination": temp_dir.path().to_str().unwrap()
        }),
        serde_json::json!({
            "url": "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
            "format_id": "--exec=calc",
            "destination": temp_dir.path().to_str().unwrap()
        }),
        serde_json::json!({
            "url": "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
            "format_id": "18",
            "destination": r"\\attacker\share\drop"
        }),
    ] {
        let resp = client
            .post(format!("{}/api/v1/media/download", base_url))
            .header(HOST, format!("127.0.0.1:{}", port))
            .header("X-Tori-Token", &rotated_token)
            .json(&payload)
            .send()
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            400,
            "Malicious media payload should be rejected with 400: {}",
            payload
        );
    }

    // 5. SEC-35-07: Playlist enqueue rejects UNC destination
    let unc_playlist = client
        .post(format!("{}/api/v1/media/playlist/enqueue", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header("X-Tori-Token", &rotated_token)
        .json(&serde_json::json!({
            "items": [{ "url": "https://www.youtube.com/watch?v=aqz-KE-bpKQ", "title": "Test" }],
            "destination": r"\\attacker\share\playlist"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(unc_playlist.status(), 400);

    // 6. SEC-35-11: Native host binary resolution never falls back to tori-download-manager.exe
    let fake_install = temp_dir.path().join("install_layout");
    let res_bin = fake_install.join("resources").join("bin");
    std::fs::create_dir_all(&res_bin).unwrap();
    let gui_exe = fake_install.join("tori-download-manager.exe");
    let host_exe = res_bin.join("tdm-native-host.exe");
    std::fs::write(&gui_exe, b"gui").unwrap();
    // Without host_exe present, must return Err rather than returning gui_exe
    assert!(tdm_native_host::registry::resolve_native_host_binary_from(&gui_exe).is_err());
    // With resources/bin/tdm-native-host.exe present, must resolve to host_exe
    std::fs::write(&host_exe, b"host").unwrap();
    assert_eq!(
        tdm_native_host::registry::resolve_native_host_binary_from(&gui_exe).unwrap(),
        host_exe
    );

    shutdown.cancel();
}
