use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::Path as AxumPath;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use reqwest::header::{HOST, ORIGIN};
use sha2::{Digest, Sha256};
use tempfile::tempdir;
use tokio_util::sync::CancellationToken;

use tdm_core::{Database, DownloadManager, EventBus, JobState};
use tdm_native_host::server::start_server;

#[derive(Clone)]
struct ApiFixture {
    body: Arc<Vec<u8>>,
    content_type: &'static str,
    content_disposition: Option<&'static str>,
}

async fn handle_fixture(
    axum::extract::State(map): axum::extract::State<Arc<HashMap<&'static str, ApiFixture>>>,
    AxumPath(name): AxumPath<String>,
) -> Response {
    let Some(item) = map.get(name.as_str()) else {
        return (StatusCode::NOT_FOUND, "missing").into_response();
    };
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, item.content_type.parse().unwrap());
    headers.insert(
        header::CONTENT_LENGTH,
        item.body.len().to_string().parse().unwrap(),
    );
    headers.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    if let Some(cd) = item.content_disposition {
        headers.insert(header::CONTENT_DISPOSITION, cd.parse().unwrap());
    }
    (StatusCode::OK, headers, Bytes::from(item.body.as_ref().clone())).into_response()
}

fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex::encode(h.finalize())
}

#[tokio::test]
async fn test_gate27_8_native_host_api_post_probe_classification_e2e() {
    let mut fixtures = HashMap::new();
    let cd_bytes = Arc::new(vec![0x1A; 65536]);
    let mp3_bytes = Arc::new(vec![0x49; 16384]);
    let unknown_bytes = Arc::new(vec![0x99; 8192]);

    fixtures.insert(
        "cd_blob",
        ApiFixture {
            body: cd_bytes.clone(),
            content_type: "application/octet-stream",
            content_disposition: Some(
                "attachment; filename=\"Cosmic_Odyssey_1080p_BluRay.mkv\"",
            ),
        },
    );
    fixtures.insert(
        "song.mp3",
        ApiFixture {
            body: mp3_bytes.clone(),
            content_type: "audio/mpeg",
            content_disposition: None,
        },
    );
    fixtures.insert(
        "opaque_blob",
        ApiFixture {
            body: unknown_bytes.clone(),
            content_type: "application/octet-stream",
            content_disposition: None,
        },
    );

    let mock_app = Router::new()
        .route("/dl/{name}", get(handle_fixture))
        .with_state(Arc::new(fixtures));
    let mock_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_port = mock_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(mock_listener, mock_app).await.unwrap();
    });

    let tmp = tempdir().unwrap();
    let default_dl = tmp.path().join("Downloads");
    let custom_dl = tmp.path().join("CustomFolder");
    let db = Database::open(tmp.path().join("api_gate27_8.sqlite")).unwrap();
    let manager = Arc::new(DownloadManager::new(db.clone(), EventBus::default()).unwrap());
    manager.set_default_download_dir(Some(default_dl.to_str().unwrap().to_string()));
    manager.set_use_category_by_default(true);

    let shutdown = CancellationToken::new();
    let (tori_port, token) = start_server(manager.clone(), db.clone(), shutdown.clone())
        .await
        .unwrap();

    let client = reqwest::Client::new();
    let api_url = format!("http://127.0.0.1:{}/api/v1/downloads", tori_port);

    // 1. Extensionless /dl/cd_blob with extensionless browser hint -> lands in Video/
    let resp_cd = client
        .post(&api_url)
        .header(HOST, format!("127.0.0.1:{}", tori_port))
        .header(ORIGIN, "chrome-extension://jfnfgmcbgapcpieaonbaolgebjaejcdm")
        .header("X-Tori-Token", &token)
        .json(&serde_json::json!({
            "url": format!("http://127.0.0.1:{}/dl/cd_blob", mock_port),
            "filename": "cd_blob"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp_cd.status(), 200);
    let body_cd: serde_json::Value = resp_cd.json().await.unwrap();
    let job_cd_id = body_cd["job_id"].as_str().unwrap().to_string();

    // 2. Music regression via API
    let resp_mp3 = client
        .post(&api_url)
        .header(HOST, format!("127.0.0.1:{}", tori_port))
        .header(ORIGIN, "chrome-extension://jfnfgmcbgapcpieaonbaolgebjaejcdm")
        .header("X-Tori-Token", &token)
        .json(&serde_json::json!({
            "url": format!("http://127.0.0.1:{}/dl/song.mp3", mock_port)
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp_mp3.status(), 200);
    let body_mp3: serde_json::Value = resp_mp3.json().await.unwrap();
    let job_mp3_id = body_mp3["job_id"].as_str().unwrap().to_string();

    // 3. Unknown octet-stream -> Other/
    let resp_unk = client
        .post(&api_url)
        .header(HOST, format!("127.0.0.1:{}", tori_port))
        .header(ORIGIN, "chrome-extension://jfnfgmcbgapcpieaonbaolgebjaejcdm")
        .header("X-Tori-Token", &token)
        .json(&serde_json::json!({
            "url": format!("http://127.0.0.1:{}/dl/opaque_blob", mock_port)
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp_unk.status(), 200);
    let body_unk: serde_json::Value = resp_unk.json().await.unwrap();
    let job_unk_id = body_unk["job_id"].as_str().unwrap().to_string();

    // 4. Explicit custom destination overrides category routing
    let resp_custom = client
        .post(&api_url)
        .header(HOST, format!("127.0.0.1:{}", tori_port))
        .header(ORIGIN, "chrome-extension://jfnfgmcbgapcpieaonbaolgebjaejcdm")
        .header("X-Tori-Token", &token)
        .json(&serde_json::json!({
            "url": format!("http://127.0.0.1:{}/dl/cd_blob?variant=custom", mock_port),
            "destination": custom_dl.to_str().unwrap()
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp_custom.status(), 200);
    let body_custom: serde_json::Value = resp_custom.json().await.unwrap();
    let job_custom_id = body_custom["job_id"].as_str().unwrap().to_string();

    // 5. Traversal in destination rejected cleanly with 400
    let resp_bad = client
        .post(&api_url)
        .header(HOST, format!("127.0.0.1:{}", tori_port))
        .header(ORIGIN, "chrome-extension://jfnfgmcbgapcpieaonbaolgebjaejcdm")
        .header("X-Tori-Token", &token)
        .json(&serde_json::json!({
            "url": format!("http://127.0.0.1:{}/dl/cd_blob?variant=bad", mock_port),
            "destination": "../../outside"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp_bad.status(), 400);

    // Wait for completion and verify folders + SHA-256
    for (jid, expected_dir, expected_name, expected_data) in [
        (job_cd_id, default_dl.join("Video"), "Cosmic_Odyssey_1080p_BluRay.mkv", &cd_bytes),
        (job_mp3_id, default_dl.join("Music"), "song.mp3", &mp3_bytes),
        (job_unk_id, default_dl.join("Other"), "opaque_blob", &unknown_bytes),
        (job_custom_id, custom_dl.clone(), "Cosmic_Odyssey_1080p_BluRay.mkv", &cd_bytes),
    ] {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let job = loop {
            let cur = db.get_job(&jid).unwrap().unwrap();
            if cur.state == JobState::Completed {
                break cur;
            }
            assert!(tokio::time::Instant::now() < deadline, "job {} timeout", jid);
            tokio::time::sleep(Duration::from_millis(30)).await;
        };
        assert_eq!(job.filename, expected_name);
        assert_eq!(Path::new(&job.target_path).parent().unwrap(), expected_dir.as_path());
        assert_eq!(sha256_hex(&std::fs::read(&job.target_path).unwrap()), sha256_hex(expected_data));
    }

    shutdown.cancel();
}
