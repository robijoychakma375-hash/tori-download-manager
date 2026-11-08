use reqwest::header::HOST;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tempfile::tempdir;
use tokio_util::sync::CancellationToken;

use tdm_core::{Database, DownloadManager, EventBus};
use tdm_native_host::server::start_server;

#[tokio::test]
async fn test_gate15_1_performance_benchmark() {
    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("gate15_1_perf.sqlite");
    let db = Database::open(&db_path).unwrap();
    let event_bus = EventBus::default();
    let manager = Arc::new(DownloadManager::new(db.clone(), event_bus).unwrap());
    let shutdown = CancellationToken::new();

    let (port, token) = start_server(manager.clone(), db.clone(), shutdown.clone())
        .await
        .unwrap();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .unwrap();

    let base_url = format!("http://127.0.0.1:{}", port);
    let test_url = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

    println!("\n=== GATE 15.1 EMPIRICAL PERFORMANCE BENCHMARK ===");

    // 1. Cold Resolution (force_refresh = true)
    println!("[Step 1] Running Cold Resolution on {}...", test_url);
    let t0 = Instant::now();
    let cold_resp = client
        .post(format!("{}/api/v1/media/resolve", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header("X-Tori-Token", &token)
        .json(&serde_json::json!({
            "url": test_url,
            "force_refresh": true
        }))
        .send()
        .await
        .expect("Cold resolution request failed");

    let cold_latency_ms = t0.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(cold_resp.status(), 200);
    let cold_json: serde_json::Value = cold_resp.json().await.unwrap();
    let formats_count = cold_json["formats"]
        .as_array()
        .map(|a| a.len())
        .unwrap_or(0);
    assert!(formats_count > 0, "Formats must be extracted");
    assert_ne!(cold_json["is_cached"], true, "Cold run must not be cached");
    println!(
        "  -> Cold Resolution Latency: {:.1} ms (extracted {} formats)",
        cold_latency_ms, formats_count
    );

    // 2. Repeat Resolution via Cache (10 runs for Median and p95)
    println!("\n[Step 2] Running 10 Repeat Resolution Cache queries via HTTP IPC...");
    let mut repeat_http_latencies: Vec<f64> = Vec::new();
    let mut last_cached_payload: Option<serde_json::Value> = None;

    for i in 0..10 {
        let t_req = Instant::now();
        let resp = client
            .post(format!("{}/api/v1/media/resolve", base_url))
            .header(HOST, format!("127.0.0.1:{}", port))
            .header("X-Tori-Token", &token)
            .json(&serde_json::json!({
                "url": test_url,
                "force_refresh": false
            }))
            .send()
            .await
            .expect("Repeat resolution request failed");

        let lat = t_req.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(resp.status(), 200);
        let json: serde_json::Value = resp.json().await.unwrap();
        assert_eq!(json["is_cached"], true, "Repeat runs must hit format cache");
        repeat_http_latencies.push(lat);
        last_cached_payload = Some(json);
        println!(
            "  Run {:2}: {:.2} ms (status: ok, is_cached: true)",
            i + 1,
            lat
        );
    }

    repeat_http_latencies.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median_http = repeat_http_latencies[repeat_http_latencies.len() / 2];
    let p95_http =
        repeat_http_latencies[(repeat_http_latencies.len() as f64 * 0.95).floor() as usize];

    // 3. Raw SQLite Cache Lookup Latency (10 runs)
    println!("\n[Step 3] Measuring Raw SQLite Cache Lookup Latency (10 runs)...");
    let mut sqlite_latencies: Vec<f64> = Vec::new();
    let cid = tdm_core::resolver::cache::normalize_cache_key(test_url).unwrap();

    for _ in 0..10 {
        let t_sql = Instant::now();
        let cached = db.get_format_cache(&cid.cache_key).unwrap();
        let lat = t_sql.elapsed().as_secs_f64() * 1000.0;
        assert!(cached.is_some());
        sqlite_latencies.push(lat);
    }
    sqlite_latencies.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median_sql = sqlite_latencies[sqlite_latencies.len() / 2];
    let p95_sql = sqlite_latencies[(sqlite_latencies.len() as f64 * 0.95).floor() as usize];
    println!(
        "  -> SQLite Query Latency: Median = {:.3} ms, p95 = {:.3} ms",
        median_sql, p95_sql
    );

    // 4. Popup Rendering Simulation (DOM Construction for format list)
    let payload = last_cached_payload.unwrap();
    let formats = payload["formats"].as_array().unwrap();
    let mut render_latencies: Vec<f64> = Vec::new();
    for _ in 0..10 {
        let t_render = Instant::now();
        let mut html = String::with_capacity(4096);
        for fmt in formats {
            html.push_str("<div class=\"row\">");
            html.push_str(fmt["resolution_label"].as_str().unwrap_or(""));
            html.push_str(" · ");
            html.push_str(fmt["container"].as_str().unwrap_or(""));
            html.push_str("</div>");
        }
        let lat = t_render.elapsed().as_secs_f64() * 1000.0;
        render_latencies.push(lat);
    }
    render_latencies.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median_render = render_latencies[render_latencies.len() / 2];

    // 5. Total time until cached format list is visible
    let total_perceived_visible_ms = median_http + median_render;

    // 6. User Download Click -> Download Job Initiated with Fresh Playable URL Handoff
    println!("\n[Step 6] Measuring Download Handoff Initiation Latency...");
    let t_dl = Instant::now();
    let dl_resp = client
        .post(format!("{}/api/v1/media/download", base_url))
        .header(HOST, format!("127.0.0.1:{}", port))
        .header("X-Tori-Token", &token)
        .json(&serde_json::json!({
            "url": test_url,
            "format_id": "18",
            "filename": "me_at_the_zoo.mp4",
            "priority": "normal"
        }))
        .send()
        .await
        .expect("Download handoff request failed");

    let dl_handoff_ms = t_dl.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(dl_resp.status(), 200);
    let dl_json: serde_json::Value = dl_resp.json().await.unwrap();
    assert_eq!(dl_json["status"], "ok");
    let job_id = dl_json["job_id"].as_str().unwrap();
    println!(
        "  -> Download Job Created: {} ({:.1} ms)",
        job_id, dl_handoff_ms
    );

    println!("\n=== PERFORMANCE MEASUREMENT SUMMARY ===");
    println!(
        "1. Cold Resolution Latency:                  {:.1} ms",
        cold_latency_ms
    );
    println!(
        "2. Repeat Metadata Cache Lookup (SQLite):     Median = {:.3} ms | p95 = {:.3} ms",
        median_sql, p95_sql
    );
    println!(
        "3. Backend-to-Extension Response (HTTP IPC):  Median = {:.2} ms | p95 = {:.2} ms",
        median_http, p95_http
    );
    println!(
        "4. Extension Popup Rendering (Simulated):    Median = {:.3} ms",
        median_render
    );
    println!(
        "5. Actual Time Until Cached Formats Visible:  Median = {:.2} ms | p95 = {:.2} ms",
        total_perceived_visible_ms,
        p95_http + median_render
    );
    println!(
        "6. User Click to Download Job Created:       {:.1} ms",
        dl_handoff_ms
    );
    println!(
        "7. Speedup Factor (Cold -> Cached):          {:.0}x speedup",
        cold_latency_ms / median_http
    );
    println!("========================================\n");

    shutdown.cancel();
}
