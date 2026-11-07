use std::sync::{Arc, Mutex};
use tempfile::tempdir;
use tokio_util::sync::CancellationToken;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, head};
use axum::Router;

use reqwest::header::{HOST, ORIGIN};
use tdm_core::{Database, DownloadManager, EventBus, JobState};
use tdm_native_host::server::start_server;

type LogEntry = (String, Option<String>);
type LogStore = Arc<Mutex<Vec<LogEntry>>>;

#[derive(Clone, Default)]
struct RequestLog {
    entries: LogStore, // (path, referer_header)
}

async fn handle_head_media(State(log): State<RequestLog>, headers: HeaderMap) -> impl IntoResponse {
    let referer = headers
        .get(header::REFERER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    log.entries
        .lock()
        .unwrap()
        .push(("/media/test.mp4".to_string(), referer));

    let mut res_headers = HeaderMap::new();
    res_headers.insert(header::CONTENT_LENGTH, "1024".parse().unwrap());
    res_headers.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    res_headers.insert(header::CONTENT_TYPE, "video/mp4".parse().unwrap());
    (StatusCode::OK, res_headers, ())
}

async fn handle_get_media(State(log): State<RequestLog>, headers: HeaderMap) -> Response {
    let referer = headers
        .get(header::REFERER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    log.entries
        .lock()
        .unwrap()
        .push(("/media/test.mp4".to_string(), referer));

    if let Some(range_header) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
        if range_header == "bytes=0-0" {
            let mut res_headers = HeaderMap::new();
            res_headers.insert(header::CONTENT_RANGE, "bytes 0-0/1024".parse().unwrap());
            res_headers.insert(header::CONTENT_LENGTH, "1".parse().unwrap());
            res_headers.insert(header::CONTENT_TYPE, "video/mp4".parse().unwrap());
            return (
                StatusCode::PARTIAL_CONTENT,
                res_headers,
                Bytes::from(vec![0xAA]),
            )
                .into_response();
        }
        if range_header.starts_with("bytes=") {
            let part = range_header.trim_start_matches("bytes=");
            let parts: Vec<&str> = part.split('-').collect();
            let start: u64 = parts[0].parse().unwrap_or(0);
            let end: u64 = if parts.len() > 1 && !parts[1].is_empty() {
                parts[1].parse().unwrap_or(1023)
            } else {
                1023
            };
            let len = (end - start + 1) as usize;
            let mut res_headers = HeaderMap::new();
            res_headers.insert(
                header::CONTENT_RANGE,
                format!("bytes {}-{}/1024", start, end).parse().unwrap(),
            );
            res_headers.insert(header::CONTENT_LENGTH, len.to_string().parse().unwrap());
            res_headers.insert(header::CONTENT_TYPE, "video/mp4".parse().unwrap());
            return (
                StatusCode::PARTIAL_CONTENT,
                res_headers,
                Bytes::from(vec![0x55; len]),
            )
                .into_response();
        }
    }

    let mut res_headers = HeaderMap::new();
    res_headers.insert(header::CONTENT_LENGTH, "1024".parse().unwrap());
    res_headers.insert(header::CONTENT_TYPE, "video/mp4".parse().unwrap());
    (StatusCode::OK, res_headers, Bytes::from(vec![0x55; 1024])).into_response()
}

async fn handle_head_single(
    State(log): State<RequestLog>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let referer = headers
        .get(header::REFERER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    log.entries
        .lock()
        .unwrap()
        .push(("/media/single.mp4".to_string(), referer));

    let mut res_headers = HeaderMap::new();
    res_headers.insert(header::CONTENT_LENGTH, "512".parse().unwrap());
    res_headers.insert(header::ACCEPT_RANGES, "none".parse().unwrap());
    res_headers.insert(header::CONTENT_TYPE, "video/mp4".parse().unwrap());
    (StatusCode::OK, res_headers, ())
}

async fn handle_get_single(State(log): State<RequestLog>, headers: HeaderMap) -> Response {
    let referer = headers
        .get(header::REFERER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    log.entries
        .lock()
        .unwrap()
        .push(("/media/single.mp4".to_string(), referer));

    let mut res_headers = HeaderMap::new();
    res_headers.insert(header::CONTENT_LENGTH, "512".parse().unwrap());
    res_headers.insert(header::CONTENT_TYPE, "video/mp4".parse().unwrap());
    (StatusCode::OK, res_headers, Bytes::from(vec![0x33; 512])).into_response()
}

async fn handle_hls_master(State(log): State<RequestLog>, headers: HeaderMap) -> Response {
    let referer = headers
        .get(header::REFERER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    log.entries
        .lock()
        .unwrap()
        .push(("/hls/master.m3u8".to_string(), referer));

    let body = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nmedia.m3u8\n";
    let mut res_headers = HeaderMap::new();
    res_headers.insert(
        header::CONTENT_TYPE,
        "application/vnd.apple.mpegurl".parse().unwrap(),
    );
    (StatusCode::OK, res_headers, body).into_response()
}

async fn handle_hls_media(State(log): State<RequestLog>, headers: HeaderMap) -> Response {
    let referer = headers
        .get(header::REFERER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    log.entries
        .lock()
        .unwrap()
        .push(("/hls/media.m3u8".to_string(), referer));

    let body = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2.0,\nseg0.ts\n#EXT-X-ENDLIST\n";
    let mut res_headers = HeaderMap::new();
    res_headers.insert(
        header::CONTENT_TYPE,
        "application/vnd.apple.mpegurl".parse().unwrap(),
    );
    (StatusCode::OK, res_headers, body).into_response()
}

async fn handle_hls_seg(State(log): State<RequestLog>, headers: HeaderMap) -> Response {
    let referer = headers
        .get(header::REFERER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    log.entries
        .lock()
        .unwrap()
        .push(("/hls/seg0.ts".to_string(), referer));

    // Valid TS packet starting with sync byte 0x47, 188 * 4 = 752 bytes
    let mut ts_data = vec![0x47; 752];
    for chunk in ts_data.chunks_mut(188) {
        chunk[0] = 0x47;
    }
    let mut res_headers = HeaderMap::new();
    res_headers.insert(header::CONTENT_TYPE, "video/mp2t".parse().unwrap());
    (StatusCode::OK, res_headers, Bytes::from(ts_data)).into_response()
}

async fn handle_dash_manifest(State(log): State<RequestLog>, headers: HeaderMap) -> Response {
    let referer = headers
        .get(header::REFERER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    log.entries
        .lock()
        .unwrap()
        .push(("/dash/manifest.mpd".to_string(), referer));

    let body = r#"<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" minBufferTime="PT1.5S" type="static" mediaPresentationDuration="PT2S">
  <Period duration="PT2S">
    <AdaptationSet mimeType="video/mp4" contentType="video">
      <Representation id="1" bandwidth="800000" width="640" height="360">
        <SegmentList duration="2">
          <Initialization sourceURL="init.mp4"/>
          <SegmentURL media="seg0.m4s"/>
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>"#;
    let mut res_headers = HeaderMap::new();
    res_headers.insert(
        header::CONTENT_TYPE,
        "application/dash+xml".parse().unwrap(),
    );
    (StatusCode::OK, res_headers, body).into_response()
}

async fn handle_dash_init(State(log): State<RequestLog>, headers: HeaderMap) -> Response {
    let referer = headers
        .get(header::REFERER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    log.entries
        .lock()
        .unwrap()
        .push(("/dash/init.mp4".to_string(), referer));

    // Valid fMP4 box atom type: 8 bytes total, length 8, box type "ftyp"
    let mut init_box = vec![0u8; 16];
    init_box[0..4].copy_from_slice(&16u32.to_be_bytes());
    init_box[4..8].copy_from_slice(b"ftyp");
    let mut res_headers = HeaderMap::new();
    res_headers.insert(header::CONTENT_TYPE, "video/mp4".parse().unwrap());
    (StatusCode::OK, res_headers, Bytes::from(init_box)).into_response()
}

async fn handle_dash_seg(State(log): State<RequestLog>, headers: HeaderMap) -> Response {
    let referer = headers
        .get(header::REFERER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    log.entries
        .lock()
        .unwrap()
        .push(("/dash/seg0.m4s".to_string(), referer));

    // Valid fMP4 moof box: length 16, box type "moof"
    let mut seg_box = vec![0u8; 16];
    seg_box[0..4].copy_from_slice(&16u32.to_be_bytes());
    seg_box[4..8].copy_from_slice(b"moof");
    let mut res_headers = HeaderMap::new();
    res_headers.insert(header::CONTENT_TYPE, "video/iso.segment".parse().unwrap());
    (StatusCode::OK, res_headers, Bytes::from(seg_box)).into_response()
}

fn build_mock_server(log: RequestLog) -> Router {
    Router::new()
        .route(
            "/media/test.mp4",
            head(handle_head_media).get(handle_get_media),
        )
        .route(
            "/media/single.mp4",
            head(handle_head_single).get(handle_get_single),
        )
        .route("/hls/master.m3u8", get(handle_hls_master))
        .route("/hls/media.m3u8", get(handle_hls_media))
        .route("/hls/seg0.ts", get(handle_hls_seg))
        .route("/dash/manifest.mpd", get(handle_dash_manifest))
        .route("/dash/init.mp4", get(handle_dash_init))
        .route("/dash/seg0.m4s", get(handle_dash_seg))
        .with_state(log)
}

#[tokio::test]
async fn test_per_download_referer_e2e_verification() {
    let request_log = RequestLog::default();

    // 1. Bind mock HTTP media server
    let mock_app = build_mock_server(request_log.clone());
    let mock_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_port = mock_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(mock_listener, mock_app).await.unwrap();
    });

    // 2. Start TORI desktop engine REST server
    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("referer_test.sqlite");
    let db = Database::open(&db_path).unwrap();
    let event_bus = EventBus::default();
    let manager = Arc::new(DownloadManager::new(db.clone(), event_bus).unwrap());
    let shutdown = CancellationToken::new();

    let (tori_port, token) = start_server(manager.clone(), db.clone(), shutdown.clone())
        .await
        .expect("TORI server failed to start");

    let client = reqwest::Client::new();
    let tori_url = format!("http://127.0.0.1:{}", tori_port);
    let mock_url = format!("http://127.0.0.1:{}", mock_port);

    // -------------------------------------------------------------
    // SCENARIO 1: Direct HTTP download with valid same-origin Referer
    // -------------------------------------------------------------
    request_log.entries.lock().unwrap().clear();

    let dl_resp1 = client
        .post(format!("{}/api/v1/downloads", tori_url))
        .header(HOST, format!("127.0.0.1:{}", tori_port))
        .header(
            ORIGIN,
            "chrome-extension://jfnfgmcbgapcpieaonbaolgebjaejcdm",
        )
        .header("X-Tori-Token", &token)
        .json(&serde_json::json!({
            "url": format!("{}/media/test.mp4", mock_url),
            "filename": "test_video1.mp4",
            "destination": temp_dir.path().to_str().unwrap(),
            "referer": format!("{}/watch/video123?token=secret123#frag", mock_url)
        }))
        .send()
        .await
        .expect("Create download 1 failed");

    assert_eq!(dl_resp1.status(), 200);
    let body1: serde_json::Value = dl_resp1.json().await.unwrap();
    assert_eq!(body1["status"], "ok");
    let job1_id = body1["job_id"].as_str().unwrap();

    // Await download completion
    let start_wait = std::time::Instant::now();
    loop {
        if let Ok(Some(job)) = db.get_job(job1_id) {
            if job.state == JobState::Completed {
                break;
            }
        }
        if start_wait.elapsed() > std::time::Duration::from_secs(5) {
            panic!("Download 1 timed out");
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    // Inspect recorded requests for test 1:
    let entries1 = request_log.entries.lock().unwrap().clone();
    assert!(
        !entries1.is_empty(),
        "Requests must be logged for download 1"
    );
    let expected_same_origin_ref = format!("{}/watch/video123", mock_url);
    for (path, ref_hdr) in &entries1 {
        if path == "/media/test.mp4" {
            assert_eq!(
                ref_hdr.as_deref(),
                Some(expected_same_origin_ref.as_str()),
                "Path and origin preserved, query (?token=secret123) and fragment (#frag) stripped"
            );
        }
    }

    // Verify database saved referer
    let stored_job1 = db.get_job(job1_id).unwrap().unwrap();
    assert_eq!(stored_job1.referer, Some(expected_same_origin_ref));

    // -------------------------------------------------------------
    // SCENARIO 2: Direct HTTP download without Referer
    // -------------------------------------------------------------
    request_log.entries.lock().unwrap().clear();

    let dl_resp2 = client
        .post(format!("{}/api/v1/downloads", tori_url))
        .header(HOST, format!("127.0.0.1:{}", tori_port))
        .header(
            ORIGIN,
            "chrome-extension://jfnfgmcbgapcpieaonbaolgebjaejcdm",
        )
        .header("X-Tori-Token", &token)
        .json(&serde_json::json!({
            "url": format!("{}/media/single.mp4", mock_url),
            "filename": "test_single.mp4",
            "destination": temp_dir.path().to_str().unwrap()
        }))
        .send()
        .await
        .expect("Create download 2 failed");

    assert_eq!(dl_resp2.status(), 200);
    let body2: serde_json::Value = dl_resp2.json().await.unwrap();
    let job2_id = body2["job_id"].as_str().unwrap();

    let start_wait = std::time::Instant::now();
    loop {
        if let Ok(Some(job)) = db.get_job(job2_id) {
            if job.state == JobState::Completed {
                break;
            }
        }
        if start_wait.elapsed() > std::time::Duration::from_secs(5) {
            panic!("Download 2 timed out");
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    // Inspect recorded requests for test 2: zero referer
    let entries2 = request_log.entries.lock().unwrap().clone();
    assert!(!entries2.is_empty());
    for (path, ref_hdr) in &entries2 {
        if path == "/media/single.mp4" {
            assert!(
                ref_hdr.is_none(),
                "Downloads created without Referer must NOT send any Referer header"
            );
        }
    }

    let stored_job2 = db.get_job(job2_id).unwrap().unwrap();
    assert_eq!(stored_job2.referer, None);

    // -------------------------------------------------------------
    // SCENARIO 3: Cross-origin Referer truncated to origin only
    // -------------------------------------------------------------
    request_log.entries.lock().unwrap().clear();

    let dl_resp3 = client
        .post(format!("{}/api/v1/downloads", tori_url))
        .header(HOST, format!("127.0.0.1:{}", tori_port))
        .header(
            ORIGIN,
            "chrome-extension://jfnfgmcbgapcpieaonbaolgebjaejcdm",
        )
        .header("X-Tori-Token", &token)
        .json(&serde_json::json!({
            "url": format!("{}/media/test.mp4?variant=3", mock_url),
            "filename": "test_cross_origin.mp4",
            "destination": temp_dir.path().to_str().unwrap(),
            "referer": "http://other-domain.org:9999/secret/path?token=supersecret#frag"
        }))
        .send()
        .await
        .expect("Create download 3 failed");

    assert_eq!(dl_resp3.status(), 200);
    let body3: serde_json::Value = dl_resp3.json().await.unwrap();
    let job3_id = body3["job_id"].as_str().unwrap();

    let start_wait = std::time::Instant::now();
    loop {
        if let Ok(Some(job)) = db.get_job(job3_id) {
            if job.state == JobState::Completed {
                break;
            }
        }
        if start_wait.elapsed() > std::time::Duration::from_secs(5) {
            panic!("Download 3 timed out");
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    let entries3 = request_log.entries.lock().unwrap().clone();
    assert!(!entries3.is_empty());
    for (path, ref_hdr) in &entries3 {
        if path == "/media/test.mp4" {
            assert_eq!(
                ref_hdr.as_deref(),
                Some("http://other-domain.org:9999/"),
                "Cross-origin referer must be strictly truncated to origin only"
            );
        }
    }

    // -------------------------------------------------------------
    // SCENARIO 4: HTTPS to HTTP downgrade omitted
    // -------------------------------------------------------------
    request_log.entries.lock().unwrap().clear();

    let dl_resp4 = client
        .post(format!("{}/api/v1/downloads", tori_url))
        .header(HOST, format!("127.0.0.1:{}", tori_port))
        .header(
            ORIGIN,
            "chrome-extension://jfnfgmcbgapcpieaonbaolgebjaejcdm",
        )
        .header("X-Tori-Token", &token)
        .json(&serde_json::json!({
            "url": format!("{}/media/test.mp4?variant=4", mock_url),
            "filename": "test_downgrade.mp4",
            "destination": temp_dir.path().to_str().unwrap(),
            "referer": "https://secure-portal.com/watch/video"
        }))
        .send()
        .await
        .expect("Create download 4 failed");

    assert_eq!(dl_resp4.status(), 200);
    let body4: serde_json::Value = dl_resp4.json().await.unwrap();
    let job4_id = body4["job_id"].as_str().unwrap();

    let start_wait = std::time::Instant::now();
    loop {
        if let Ok(Some(job)) = db.get_job(job4_id) {
            if job.state == JobState::Completed {
                break;
            }
        }
        if start_wait.elapsed() > std::time::Duration::from_secs(5) {
            panic!("Download 4 timed out");
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    let entries4 = request_log.entries.lock().unwrap().clone();
    assert!(!entries4.is_empty());
    for (path, ref_hdr) in &entries4 {
        if path == "/media/test.mp4" {
            assert!(
                ref_hdr.is_none(),
                "HTTPS to HTTP downgrade must NOT leak Referer"
            );
        }
    }

    // -------------------------------------------------------------
    // SCENARIO 5: CRLF injection and control characters rejected
    // -------------------------------------------------------------
    request_log.entries.lock().unwrap().clear();

    let dl_resp5 = client
        .post(format!("{}/api/v1/downloads", tori_url))
        .header(HOST, format!("127.0.0.1:{}", tori_port))
        .header(
            ORIGIN,
            "chrome-extension://jfnfgmcbgapcpieaonbaolgebjaejcdm",
        )
        .header("X-Tori-Token", &token)
        .json(&serde_json::json!({
            "url": format!("{}/media/test.mp4?variant=5", mock_url),
            "filename": "test_crlf.mp4",
            "destination": temp_dir.path().to_str().unwrap(),
            "referer": format!("{}/page\r\nEvil-Header: injected\r\n", mock_url)
        }))
        .send()
        .await
        .expect("Create download 5 failed");

    assert_eq!(dl_resp5.status(), 200);
    let body5: serde_json::Value = dl_resp5.json().await.unwrap();
    let job5_id = body5["job_id"].as_str().unwrap();

    let start_wait = std::time::Instant::now();
    loop {
        if let Ok(Some(job)) = db.get_job(job5_id) {
            if job.state == JobState::Completed {
                break;
            }
        }
        if start_wait.elapsed() > std::time::Duration::from_secs(5) {
            panic!("Download 5 timed out");
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    let entries5 = request_log.entries.lock().unwrap().clone();
    assert!(!entries5.is_empty());
    for (path, ref_hdr) in &entries5 {
        if path == "/media/test.mp4" {
            assert!(
                ref_hdr.is_none(),
                "CRLF header injection must be completely rejected"
            );
        }
    }

    // -------------------------------------------------------------
    // SCENARIO 6: Invalid schemes rejected (javascript, file, blob)
    // -------------------------------------------------------------
    request_log.entries.lock().unwrap().clear();

    let dl_resp6 = client
        .post(format!("{}/api/v1/downloads", tori_url))
        .header(HOST, format!("127.0.0.1:{}", tori_port))
        .header(
            ORIGIN,
            "chrome-extension://jfnfgmcbgapcpieaonbaolgebjaejcdm",
        )
        .header("X-Tori-Token", &token)
        .json(&serde_json::json!({
            "url": format!("{}/media/test.mp4?variant=6", mock_url),
            "filename": "test_invalidscheme.mp4",
            "destination": temp_dir.path().to_str().unwrap(),
            "referer": "javascript:alert(1)"
        }))
        .send()
        .await
        .expect("Create download 6 failed");

    assert_eq!(dl_resp6.status(), 200);
    let body6: serde_json::Value = dl_resp6.json().await.unwrap();
    let job6_id = body6["job_id"].as_str().unwrap();

    let start_wait = std::time::Instant::now();
    loop {
        if let Ok(Some(job)) = db.get_job(job6_id) {
            if job.state == JobState::Completed {
                break;
            }
        }
        if start_wait.elapsed() > std::time::Duration::from_secs(5) {
            panic!("Download 6 timed out");
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    let entries6 = request_log.entries.lock().unwrap().clone();
    assert!(!entries6.is_empty());
    for (path, ref_hdr) in &entries6 {
        if path == "/media/test.mp4" {
            assert!(ref_hdr.is_none(), "Non-HTTP/HTTPS schemes must be rejected");
        }
    }

    // -------------------------------------------------------------
    // SCENARIO 7: HLS manifest and segments receive appropriate Referer
    // -------------------------------------------------------------
    request_log.entries.lock().unwrap().clear();

    let hls_job = manager
        .create_download_with_options(
            &format!("{}/hls/master.m3u8", mock_url),
            temp_dir.path(),
            tdm_core::Priority::Normal,
            Some(format!("{}/watch/hls_video", mock_url)),
        )
        .await
        .expect("Create HLS download failed");

    let _ = manager.start_download(&hls_job.id);

    let expected_hls_ref = format!("{}/watch/hls_video", mock_url);
    let start_wait = std::time::Instant::now();
    loop {
        let entries = request_log.entries.lock().unwrap().clone();
        let master_seen = entries
            .iter()
            .any(|(p, r)| p == "/hls/master.m3u8" && r.as_deref() == Some(&expected_hls_ref));
        let media_seen = entries
            .iter()
            .any(|(p, r)| p == "/hls/media.m3u8" && r.as_deref() == Some(&expected_hls_ref));
        let seg_seen = entries
            .iter()
            .any(|(p, r)| p == "/hls/seg0.ts" && r.as_deref() == Some(&expected_hls_ref));

        if master_seen && media_seen && seg_seen {
            break;
        }

        if start_wait.elapsed() > std::time::Duration::from_secs(5) {
            panic!(
                "HLS outgoing requests timed out or did not receive expected Referer. Logged: {:?}",
                entries
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    // -------------------------------------------------------------
    // SCENARIO 8: DASH manifest and segments receive appropriate Referer
    // -------------------------------------------------------------
    request_log.entries.lock().unwrap().clear();

    let dash_job = manager
        .create_download_with_options(
            &format!("{}/dash/manifest.mpd", mock_url),
            temp_dir.path(),
            tdm_core::Priority::Normal,
            Some(format!("{}/watch/dash_video", mock_url)),
        )
        .await
        .expect("Create DASH download failed");

    let _ = manager.start_download(&dash_job.id);

    let expected_dash_ref = format!("{}/watch/dash_video", mock_url);
    let start_wait = std::time::Instant::now();
    loop {
        let entries = request_log.entries.lock().unwrap().clone();
        let mpd_seen = entries
            .iter()
            .any(|(p, r)| p == "/dash/manifest.mpd" && r.as_deref() == Some(&expected_dash_ref));
        let init_seen = entries
            .iter()
            .any(|(p, r)| p == "/dash/init.mp4" && r.as_deref() == Some(&expected_dash_ref));
        let seg_dash_seen = entries
            .iter()
            .any(|(p, r)| p == "/dash/seg0.m4s" && r.as_deref() == Some(&expected_dash_ref));

        if mpd_seen && init_seen && seg_dash_seen {
            break;
        }

        if start_wait.elapsed() > std::time::Duration::from_secs(5) {
            panic!(
                "DASH outgoing requests timed out or did not receive expected Referer. Logged: {:?}",
                entries
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    shutdown.cancel();
}
