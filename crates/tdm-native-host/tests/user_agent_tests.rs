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
use tdm_core::{Database, DownloadManager, EventBus, JobState, DEFAULT_USER_AGENT};
use tdm_native_host::server::start_server;

#[derive(Clone, Debug)]
struct RequestRecord {
    path: String,
    user_agent: Option<String>,
    referer: Option<String>,
}

type LogStore = Arc<Mutex<Vec<RequestRecord>>>;

#[derive(Clone, Default)]
struct RequestLog {
    entries: LogStore,
}

impl RequestLog {
    fn record(&self, path: &str, headers: &HeaderMap) {
        let ua = headers
            .get(header::USER_AGENT)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let ref_hdr = headers
            .get(header::REFERER)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        self.entries.lock().unwrap().push(RequestRecord {
            path: path.to_string(),
            user_agent: ua,
            referer: ref_hdr,
        });
    }
}

async fn handle_head_media(
    State(log): State<RequestLog>,
    uri: axum::http::Uri,
    headers: HeaderMap,
) -> impl IntoResponse {
    log.record(uri.path(), &headers);

    let mut res_headers = HeaderMap::new();
    res_headers.insert(header::CONTENT_LENGTH, "1024".parse().unwrap());
    res_headers.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    res_headers.insert(header::CONTENT_TYPE, "video/mp4".parse().unwrap());
    (StatusCode::OK, res_headers, ())
}

async fn handle_get_media(
    State(log): State<RequestLog>,
    uri: axum::http::Uri,
    headers: HeaderMap,
) -> Response {
    log.record(uri.path(), &headers);

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
    log.record("/media/single.mp4", &headers);

    let mut res_headers = HeaderMap::new();
    res_headers.insert(header::CONTENT_LENGTH, "512".parse().unwrap());
    res_headers.insert(header::CONTENT_TYPE, "video/mp4".parse().unwrap());
    (StatusCode::OK, res_headers, ())
}

async fn handle_get_single(State(log): State<RequestLog>, headers: HeaderMap) -> Response {
    log.record("/media/single.mp4", &headers);

    let mut res_headers = HeaderMap::new();
    res_headers.insert(header::CONTENT_LENGTH, "512".parse().unwrap());
    res_headers.insert(header::CONTENT_TYPE, "video/mp4".parse().unwrap());
    (StatusCode::OK, res_headers, Bytes::from(vec![0x33; 512])).into_response()
}

async fn handle_hls_master(State(log): State<RequestLog>, headers: HeaderMap) -> Response {
    log.record("/hls/master.m3u8", &headers);

    let body = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nmedia.m3u8\n";
    let mut res_headers = HeaderMap::new();
    res_headers.insert(
        header::CONTENT_TYPE,
        "application/vnd.apple.mpegurl".parse().unwrap(),
    );
    (StatusCode::OK, res_headers, body).into_response()
}

async fn handle_hls_media(State(log): State<RequestLog>, headers: HeaderMap) -> Response {
    log.record("/hls/media.m3u8", &headers);

    let body = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2.0,\nseg0.ts\n#EXT-X-ENDLIST\n";
    let mut res_headers = HeaderMap::new();
    res_headers.insert(
        header::CONTENT_TYPE,
        "application/vnd.apple.mpegurl".parse().unwrap(),
    );
    (StatusCode::OK, res_headers, body).into_response()
}

async fn handle_hls_seg(State(log): State<RequestLog>, headers: HeaderMap) -> Response {
    log.record("/hls/seg0.ts", &headers);

    // Dummy TS packet sync byte: 0x47
    let mut dummy_ts = vec![0x47; 752];
    for chunk in dummy_ts.chunks_mut(188) {
        chunk[0] = 0x47;
    }
    let mut res_headers = HeaderMap::new();
    res_headers.insert(header::CONTENT_TYPE, "video/mp2t".parse().unwrap());
    (StatusCode::OK, res_headers, Bytes::from(dummy_ts)).into_response()
}

async fn handle_dash_mpd(State(log): State<RequestLog>, headers: HeaderMap) -> Response {
    log.record("/dash/manifest.mpd", &headers);

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
    log.record("/dash/init.mp4", &headers);

    let mut init_box = vec![0u8; 16];
    init_box[0..4].copy_from_slice(&16u32.to_be_bytes());
    init_box[4..8].copy_from_slice(b"ftyp");
    let mut res_headers = HeaderMap::new();
    res_headers.insert(header::CONTENT_TYPE, "video/mp4".parse().unwrap());
    (StatusCode::OK, res_headers, Bytes::from(init_box)).into_response()
}

async fn handle_dash_seg(State(log): State<RequestLog>, headers: HeaderMap) -> Response {
    log.record("/dash/seg0.m4s", &headers);

    let mut moof_box = vec![0u8; 16];
    moof_box[0..4].copy_from_slice(&16u32.to_be_bytes());
    moof_box[4..8].copy_from_slice(b"moof");
    let mut res_headers = HeaderMap::new();
    res_headers.insert(header::CONTENT_TYPE, "video/iso.segment".parse().unwrap());
    (StatusCode::OK, res_headers, Bytes::from(moof_box)).into_response()
}

#[tokio::test]
async fn test_per_download_user_agent_e2e_verification() {
    let mock_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("Mock server should bind to ephemeral port");
    let mock_port = mock_listener.local_addr().unwrap().port();
    let mock_url = format!("http://127.0.0.1:{}", mock_port);

    let request_log = RequestLog::default();

    let mock_app = Router::new()
        .route(
            "/media/test.mp4",
            head(handle_head_media).get(handle_get_media),
        )
        .route(
            "/media/alpha.mp4",
            head(handle_head_media).get(handle_get_media),
        )
        .route(
            "/media/beta.mp4",
            head(handle_head_media).get(handle_get_media),
        )
        .route(
            "/media/dual.mp4",
            head(handle_head_media).get(handle_get_media),
        )
        .route(
            "/media/single.mp4",
            head(handle_head_single).get(handle_get_single),
        )
        .route("/hls/master.m3u8", get(handle_hls_master))
        .route("/hls/media.m3u8", get(handle_hls_media))
        .route("/hls/seg0.ts", get(handle_hls_seg))
        .route("/dash/manifest.mpd", get(handle_dash_mpd))
        .route("/dash/init.mp4", get(handle_dash_init))
        .route("/dash/seg0.m4s", get(handle_dash_seg))
        .with_state(request_log.clone());

    tokio::spawn(async move {
        axum::serve(mock_listener, mock_app)
            .await
            .expect("Mock HTTP media server should run");
    });

    let temp = tempdir().expect("tempdir");
    let db_path = temp.path().join("tori_ua_test.db");
    let db = Database::open(&db_path).expect("open db");
    db.set_setting("custom_extension_id", "jfnfgmcbgapcpieaonbaolgebjaejcdm")
        .unwrap();
    let event_bus = EventBus::default();
    let manager = Arc::new(DownloadManager::new(db.clone(), event_bus.clone()).expect("manager"));

    let cancel = CancellationToken::new();

    let (tori_port, token) = start_server(manager.clone(), db.clone(), cancel.clone())
        .await
        .expect("TORI server failed to start");

    let tori_url = format!("http://127.0.0.1:{}", tori_port);

    let client = reqwest::Client::new();

    // =========================================================================
    // Test 1: Direct HTTP download WITH custom browser User-Agent
    // =========================================================================
    request_log.entries.lock().unwrap().clear();

    let custom_ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
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
            "destination": temp.path().to_str().unwrap(),
            "user_agent": custom_ua,
        }))
        .send()
        .await
        .expect("send download 1");

    assert_eq!(dl_resp1.status(), reqwest::StatusCode::OK);
    let body1: serde_json::Value = dl_resp1.json().await.unwrap();
    assert_eq!(body1["status"], "ok");
    let job1_id = body1["job_id"].as_str().unwrap().to_string();

    let start_time = std::time::Instant::now();
    loop {
        if let Ok(Some(job)) = db.get_job(&job1_id) {
            if job.state == JobState::Completed {
                assert_eq!(job.user_agent.as_deref(), Some(custom_ua));
                break;
            }
            if matches!(job.state, JobState::Failed | JobState::Cancelled) {
                panic!("Job 1 failed unexpectedly: {:?}", job.error_message);
            }
        }
        if start_time.elapsed().as_secs() > 10 {
            panic!("Timed out waiting for download 1 completion");
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    let entries1 = request_log.entries.lock().unwrap().clone();
    assert!(
        !entries1.is_empty(),
        "Requests must be logged for download 1"
    );
    for entry in &entries1 {
        if entry.path == "/media/test.mp4" {
            assert_eq!(
                entry.user_agent.as_deref(),
                Some(custom_ua),
                "Custom User-Agent must be transmitted on every request"
            );
        }
    }

    // =========================================================================
    // Test 2: Direct HTTP download WITHOUT custom User-Agent (Default Fallback)
    // =========================================================================
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
            "destination": temp.path().to_str().unwrap(),
        }))
        .send()
        .await
        .expect("send download 2");

    assert_eq!(dl_resp2.status(), reqwest::StatusCode::OK);
    let body2: serde_json::Value = dl_resp2.json().await.unwrap();
    let job2_id = body2["job_id"].as_str().unwrap().to_string();

    let start_time = std::time::Instant::now();
    loop {
        if let Ok(Some(job)) = db.get_job(&job2_id) {
            if job.state == JobState::Completed {
                assert!(job.user_agent.is_none());
                break;
            }
            if matches!(job.state, JobState::Failed | JobState::Cancelled) {
                panic!("Job 2 failed unexpectedly: {:?}", job.error_message);
            }
        }
        if start_time.elapsed().as_secs() > 10 {
            panic!("Timed out waiting for download 2 completion");
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    let entries2 = request_log.entries.lock().unwrap().clone();
    assert!(!entries2.is_empty());
    for entry in &entries2 {
        if entry.path == "/media/single.mp4" {
            assert_eq!(
                entry.user_agent.as_deref(),
                Some(DEFAULT_USER_AGENT),
                "When User-Agent is omitted, default TORI User-Agent must be transmitted"
            );
        }
    }

    // =========================================================================
    // Test 3: CRLF Injection Rejection (Falls back to Default TORI User-Agent)
    // =========================================================================
    request_log.entries.lock().unwrap().clear();

    let crlf_ua = "Mozilla/5.0\r\nInjected-Header: evil\r\n";
    let dl_resp3 = client
        .post(format!("{}/api/v1/downloads", tori_url))
        .header(HOST, format!("127.0.0.1:{}", tori_port))
        .header(
            ORIGIN,
            "chrome-extension://jfnfgmcbgapcpieaonbaolgebjaejcdm",
        )
        .header("X-Tori-Token", &token)
        .json(&serde_json::json!({
            "url": format!("{}/media/test.mp4?variant=crlf", mock_url),
            "destination": temp.path().to_str().unwrap(),
            "user_agent": crlf_ua,
        }))
        .send()
        .await
        .expect("send download 3");

    assert_eq!(dl_resp3.status(), reqwest::StatusCode::OK);
    let body3: serde_json::Value = dl_resp3.json().await.unwrap();
    let job3_id = body3["job_id"].as_str().unwrap().to_string();

    let start_time = std::time::Instant::now();
    loop {
        if let Ok(Some(job)) = db.get_job(&job3_id) {
            if job.state == JobState::Completed {
                assert!(job.user_agent.is_none(), "CRLF UA must be rejected in DB");
                break;
            }
            if matches!(job.state, JobState::Failed | JobState::Cancelled) {
                panic!("Job 3 failed unexpectedly: {:?}", job.error_message);
            }
        }
        if start_time.elapsed().as_secs() > 10 {
            panic!("Timed out waiting for download 3 completion");
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    let entries3 = request_log.entries.lock().unwrap().clone();
    assert!(!entries3.is_empty());
    for entry in &entries3 {
        if entry.path == "/media/test.mp4" {
            assert_eq!(
                entry.user_agent.as_deref(),
                Some(DEFAULT_USER_AGENT),
                "CRLF header injection must be rejected and fall back safely to default TORI User-Agent"
            );
        }
    }

    // =========================================================================
    // Test 4: HLS Manifest and Segment User-Agent Propagation
    // =========================================================================
    request_log.entries.lock().unwrap().clear();

    let hls_ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/131.0.0.0";
    let hls_job = manager
        .create_download_with_all_options(
            &format!("{}/hls/master.m3u8", mock_url),
            temp.path(),
            tdm_core::Priority::Normal,
            None,
            Some(hls_ua.to_string()),
        )
        .await
        .expect("create HLS download");
    manager
        .start_download(&hls_job.id)
        .expect("start HLS download");

    let hls_start = std::time::Instant::now();
    let mut saw_master = false;
    let mut saw_media = false;
    let mut saw_seg = false;

    while hls_start.elapsed().as_secs() < 5 {
        let entries = request_log.entries.lock().unwrap().clone();
        for entry in &entries {
            if entry.path == "/hls/master.m3u8" {
                assert_eq!(entry.user_agent.as_deref(), Some(hls_ua));
                saw_master = true;
            }
            if entry.path == "/hls/media.m3u8" {
                assert_eq!(entry.user_agent.as_deref(), Some(hls_ua));
                saw_media = true;
            }
            if entry.path == "/hls/seg0.ts" {
                assert_eq!(entry.user_agent.as_deref(), Some(hls_ua));
                saw_seg = true;
            }
        }
        if saw_master && saw_media && saw_seg {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    assert!(saw_master, "Master playlist must receive custom User-Agent");
    assert!(saw_media, "Media playlist must receive custom User-Agent");
    assert!(saw_seg, "HLS segment must receive custom User-Agent");

    // =========================================================================
    // Test 5: DASH Manifest, Init, and Media Segment User-Agent Propagation
    // =========================================================================
    request_log.entries.lock().unwrap().clear();

    let dash_ua =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";
    let dash_job = manager
        .create_download_with_all_options(
            &format!("{}/dash/manifest.mpd", mock_url),
            temp.path(),
            tdm_core::Priority::Normal,
            None,
            Some(dash_ua.to_string()),
        )
        .await
        .expect("create DASH download");
    manager
        .start_download(&dash_job.id)
        .expect("start DASH download");

    let dash_start = std::time::Instant::now();
    let mut saw_mpd = false;
    let mut saw_init = false;
    let mut saw_dash_seg = false;

    while dash_start.elapsed().as_secs() < 5 {
        let entries = request_log.entries.lock().unwrap().clone();
        for entry in &entries {
            if entry.path == "/dash/manifest.mpd" {
                assert_eq!(entry.user_agent.as_deref(), Some(dash_ua));
                saw_mpd = true;
            }
            if entry.path == "/dash/init.mp4" {
                assert_eq!(entry.user_agent.as_deref(), Some(dash_ua));
                saw_init = true;
            }
            if entry.path == "/dash/seg0.m4s" {
                assert_eq!(entry.user_agent.as_deref(), Some(dash_ua));
                saw_dash_seg = true;
            }
        }
        if saw_mpd && saw_init && saw_dash_seg {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    assert!(saw_mpd, "DASH MPD manifest must receive custom User-Agent");
    assert!(saw_init, "DASH init segment must receive custom User-Agent");
    assert!(
        saw_dash_seg,
        "DASH media segment must receive custom User-Agent"
    );

    // =========================================================================
    // Test 6: Concurrent Downloads Isolation (No Cross-Contamination)
    // =========================================================================
    request_log.entries.lock().unwrap().clear();

    let ua_alpha = "BrowserAlpha/1.0 (Windows)";
    let ua_beta = "BrowserBeta/2.0 (Windows)";

    let job_alpha = manager
        .create_download_with_all_options(
            &format!("{}/media/alpha.mp4", mock_url),
            temp.path(),
            tdm_core::Priority::Normal,
            None,
            Some(ua_alpha.to_string()),
        )
        .await
        .unwrap();

    let job_beta = manager
        .create_download_with_all_options(
            &format!("{}/media/beta.mp4", mock_url),
            temp.path(),
            tdm_core::Priority::Normal,
            None,
            Some(ua_beta.to_string()),
        )
        .await
        .unwrap();

    let _ = manager.start_download(&job_alpha.id);
    let _ = manager.start_download(&job_beta.id);

    let start_wait = std::time::Instant::now();
    loop {
        let a = db.get_job(&job_alpha.id).unwrap().unwrap();
        let b = db.get_job(&job_beta.id).unwrap().unwrap();
        if a.state == JobState::Failed || b.state == JobState::Failed {
            panic!(
                "Concurrent job failed! a: {:?}, b: {:?}",
                a.error_message, b.error_message
            );
        }
        if a.state == JobState::Completed && b.state == JobState::Completed {
            assert_eq!(a.user_agent.as_deref(), Some(ua_alpha));
            assert_eq!(b.user_agent.as_deref(), Some(ua_beta));
            break;
        }
        if start_wait.elapsed().as_secs() > 10 {
            panic!("Timed out waiting for concurrent downloads: a state={:?} err={:?}, b state={:?} err={:?}", a.state, a.error_message, b.state, b.error_message);
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    let entries_conc = request_log.entries.lock().unwrap().clone();
    assert!(
        !entries_conc.is_empty(),
        "Concurrent requests must be logged"
    );
    for entry in &entries_conc {
        if entry.path == "/media/alpha.mp4" {
            assert_eq!(
                entry.user_agent.as_deref(),
                Some(ua_alpha),
                "Alpha download must have ua_alpha"
            );
        } else if entry.path == "/media/beta.mp4" {
            assert_eq!(
                entry.user_agent.as_deref(),
                Some(ua_beta),
                "Beta download must have ua_beta"
            );
        }
    }

    // =========================================================================
    // Test 7: Simultaneous Referer and User-Agent Delivery
    // =========================================================================
    request_log.entries.lock().unwrap().clear();

    let dual_ref = format!("{}/watch/dual_test", mock_url);
    let dual_ua = "ToriDualHeaderClient/1.0";

    let job_dual = manager
        .create_download_with_all_options(
            &format!("{}/media/dual.mp4", mock_url),
            temp.path(),
            tdm_core::Priority::Normal,
            Some(dual_ref.clone()),
            Some(dual_ua.to_string()),
        )
        .await
        .unwrap();

    let _ = manager.start_download(&job_dual.id);

    let start_wait = std::time::Instant::now();
    loop {
        let j = db.get_job(&job_dual.id).unwrap().unwrap();
        if j.state == JobState::Completed {
            assert_eq!(j.referer.as_deref(), Some(dual_ref.as_str()));
            assert_eq!(j.user_agent.as_deref(), Some(dual_ua));
            break;
        }
        if start_wait.elapsed().as_secs() > 10 {
            panic!("Timed out waiting for dual-header download");
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    let entries_dual = request_log.entries.lock().unwrap().clone();
    assert!(!entries_dual.is_empty());
    for entry in &entries_dual {
        if entry.path == "/media/dual.mp4" {
            assert_eq!(entry.user_agent.as_deref(), Some(dual_ua));
            assert_eq!(entry.referer.as_deref(), Some(dual_ref.as_str()));
        }
    }

    cancel.cancel();
}
