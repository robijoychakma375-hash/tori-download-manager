use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{
    sse::{Event, KeepAlive, Sse},
    IntoResponse, Json, Response,
};
use axum::routing::{get, post};
use axum::Router;
use futures_util::stream::Stream;
use serde::{Deserialize, Serialize};
use tdm_core::{Database, DownloadManager, Priority};
use tokio::net::TcpListener;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

pub const DEFAULT_PORT: u16 = 6800;
pub const SERVER_NAME: &str = "TORI Download Manager";
pub const API_VERSION: &str = "2.0.0";

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub port: u16,
    pub token: String,
    pub allowed_extension_ids: Vec<String>,
}

pub struct ServerState {
    pub manager: Arc<DownloadManager>,
    pub db: Database,
    pub config: RwLock<ServerConfig>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StatusResponse {
    pub status: String,
    pub name: String,
    pub version: String,
    pub authenticated: bool,
    pub port: u16,
    pub engine_active: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PairResponse {
    pub status: String,
    pub paired: bool,
    pub message: String,
    pub version: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateDownloadReq {
    pub url: String,
    pub filename: Option<String>,
    pub destination: Option<String>,
    pub priority: Option<String>,
    pub user_agent: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CreateDownloadResp {
    pub status: String,
    pub job_id: Option<String>,
    pub filename: Option<String>,
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct JobListResp {
    pub status: String,
    pub jobs: Vec<JobSummary>,
}

#[derive(Debug, Serialize)]
pub struct JobSummary {
    pub id: String,
    pub url: String,
    pub filename: String,
    pub total_bytes: Option<u64>,
    pub downloaded_bytes: u64,
    pub state: String,
    pub job_type: String,
    pub priority: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct EventQuery {
    pub token: Option<String>,
}

// ---------------------------------------------------------------------------
// Security Helpers
// ---------------------------------------------------------------------------

pub fn is_valid_host(host_str: &str) -> bool {
    let clean = host_str
        .split(':')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    clean == "127.0.0.1" || clean == "localhost"
}

pub fn is_allowed_origin(origin_str: &str, allowed_ids: &[String]) -> bool {
    let lower = origin_str.trim().to_lowercase();
    // Allow browser extensions (Chrome, Edge, Brave, etc.)
    if lower.starts_with("chrome-extension://") || lower.starts_with("edge-extension://") {
        if allowed_ids.is_empty() {
            return true;
        }
        for id in allowed_ids {
            if lower.contains(id) {
                return true;
            }
        }
        return true;
    }
    // Allow local desktop app / webview
    if lower.starts_with("tauri://")
        || lower.starts_with("http://tauri.localhost")
        || lower.starts_with("https://tauri.localhost")
        || lower == "null"
    {
        return true;
    }

    // Explicitly reject all web page origins (e.g. https://google.com, http://evil.com)
    false
}

fn check_auth(headers: &HeaderMap, query_token: Option<&str>, expected_token: &str) -> bool {
    if expected_token.is_empty() {
        return false;
    }

    // 1. Check X-Tori-Token header
    if let Some(val) = headers.get("x-tori-token") {
        if let Ok(s) = val.to_str() {
            if s.trim() == expected_token {
                return true;
            }
        }
    }

    // 2. Check Authorization: Bearer <token>
    if let Some(val) = headers.get(header::AUTHORIZATION) {
        if let Ok(s) = val.to_str() {
            let s = s.trim();
            if let Some(tok) = s.strip_prefix("Bearer ") {
                if tok.trim() == expected_token {
                    return true;
                }
            }
        }
    }

    // 3. Check query param (for EventSource SSE)
    if let Some(qt) = query_token {
        if qt.trim() == expected_token {
            return true;
        }
    }

    false
}

// ---------------------------------------------------------------------------
// Security Middleware: Host Header Validation & Origin-Scoped CORS
// ---------------------------------------------------------------------------

async fn security_middleware(
    State(state): State<Arc<ServerState>>,
    req: Request,
    next: Next,
) -> Response {
    // 1. DNS Rebinding Defense: Validate Host header strictly
    let host_valid = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .map(is_valid_host)
        .unwrap_or(false);

    if !host_valid {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "status": "error",
                "message": "Invalid Host header. Local integration requires 127.0.0.1 or localhost."
            })),
        )
            .into_response();
    }

    // 2. Origin Validation & Scoped CORS
    let origin_opt = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|o| o.to_str().ok())
        .map(|s| s.to_string());

    let config = state.config.read().await;

    if let Some(ref origin) = origin_opt {
        if !is_allowed_origin(origin, &config.allowed_extension_ids) {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({
                    "status": "error",
                    "message": "Origin not permitted. Web page origins are blocked from TORI local API."
                })),
            )
                .into_response();
        }
    }

    // 3. Handle Preflight OPTIONS request
    if req.method() == Method::OPTIONS {
        let mut resp = StatusCode::NO_CONTENT.into_response();
        if let Some(ref origin) = origin_opt {
            let h = resp.headers_mut();
            if let Ok(val) = HeaderValue::from_str(origin) {
                h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, val);
            }
            h.insert(
                header::ACCESS_CONTROL_ALLOW_METHODS,
                HeaderValue::from_static("GET, POST, OPTIONS"),
            );
            h.insert(
                header::ACCESS_CONTROL_ALLOW_HEADERS,
                HeaderValue::from_static("Content-Type, Authorization, X-Tori-Token"),
            );
            h.insert(
                header::ACCESS_CONTROL_MAX_AGE,
                HeaderValue::from_static("86400"),
            );
        }
        return resp;
    }

    // 4. Execute downstream handler and append CORS headers to allowed origin
    let mut resp = next.run(req).await;
    if let Some(ref origin) = origin_opt {
        if let Ok(val) = HeaderValue::from_str(origin) {
            resp.headers_mut()
                .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, val);
        }
        resp.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("Content-Type, Authorization, X-Tori-Token"),
        );
    }

    resp
}

// ---------------------------------------------------------------------------
// Route Handlers
// ---------------------------------------------------------------------------

async fn handle_status(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
) -> Json<StatusResponse> {
    let config = state.config.read().await;
    let auth = check_auth(&headers, None, &config.token);

    Json(StatusResponse {
        status: "ok".to_string(),
        name: SERVER_NAME.to_string(),
        version: API_VERSION.to_string(),
        authenticated: auth,
        port: config.port,
        engine_active: true,
    })
}

async fn handle_pair(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
) -> Result<Json<PairResponse>, (StatusCode, Json<serde_json::Value>)> {
    let config = state.config.read().await;
    if !check_auth(&headers, None, &config.token) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "status": "error",
                "message": "Invalid pairing token"
            })),
        ));
    }

    Ok(Json(PairResponse {
        status: "ok".to_string(),
        paired: true,
        message: "Extension successfully paired with TORI Download Manager".to_string(),
        version: API_VERSION.to_string(),
    }))
}

async fn handle_create_download(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(payload): Json<CreateDownloadReq>,
) -> Result<Json<CreateDownloadResp>, (StatusCode, Json<serde_json::Value>)> {
    let config = state.config.read().await;
    if !check_auth(&headers, None, &config.token) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "status": "error",
                "message": "Authentication required. Provide X-Tori-Token or Authorization Bearer header."
            })),
        ));
    }

    let raw_url = payload.url.trim();
    if raw_url.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "status": "error",
                "message": "Missing download URL"
            })),
        ));
    }

    // Protocol check
    let lower_url = raw_url.to_lowercase();
    let is_valid_proto = lower_url.starts_with("http://")
        || lower_url.starts_with("https://")
        || lower_url.starts_with("magnet:")
        || lower_url.starts_with("rtsp://")
        || lower_url.starts_with("rtmp://")
        || lower_url.starts_with("rtmps://")
        || lower_url.starts_with("srt://")
        || lower_url.starts_with("rist://")
        || lower_url.starts_with("rtp://")
        || lower_url.starts_with("udp://")
        || lower_url.starts_with("mms://")
        || lower_url.starts_with("mmsh://");

    if !is_valid_proto {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "status": "error",
                "message": "Unsupported URL protocol. Only HTTP, HTTPS, Magnet, and live streams are accepted."
            })),
        ));
    }

    // Video portal watch page rejection: webpage URLs are not direct media downloads
    if (lower_url.contains("youtube.com/watch") || lower_url.contains("youtu.be/"))
        && !lower_url.contains(".mp4")
        && !lower_url.contains(".m3u8")
        && !lower_url.contains(".mpd")
    {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "status": "error",
                "message": "Video watch page URLs cannot be downloaded directly. TORI requires a direct playable media stream, HLS (.m3u8), or DASH (.mpd) URL."
            })),
        ));
    }

    // Duplicate check
    if let Ok(jobs) = state.db.list_jobs() {
        if let Some(existing) = jobs.iter().find(|j| {
            j.url == raw_url
                && (j.state != tdm_core::JobState::Failed
                    && j.state != tdm_core::JobState::Cancelled)
        }) {
            return Ok(Json(CreateDownloadResp {
                status: "already_exists".to_string(),
                job_id: Some(existing.id.clone()),
                filename: Some(existing.filename.clone()),
                state: Some(format!("{:?}", existing.state).to_lowercase()),
                message: Some("Download already exists in TORI".to_string()),
            }));
        }
    }

    // Sanitize destination path if provided
    let dest_path = if let Some(ref d) = payload.destination {
        let clean = d.trim();
        if clean.contains("..") {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "status": "error",
                    "message": "Invalid destination path: directory traversal rejected."
                })),
            ));
        }
        PathBuf::from(clean)
    } else if let Ok(profile) = std::env::var("USERPROFILE") {
        PathBuf::from(profile).join("Downloads")
    } else {
        PathBuf::from(".")
    };

    let prio = match payload.priority.as_deref() {
        Some("high") => Priority::High,
        Some("low") => Priority::Low,
        _ => Priority::Normal,
    };

    match state
        .manager
        .create_download_with_priority(raw_url, &dest_path, prio)
        .await
    {
        Ok(job) => {
            let job_id = job.id.clone();
            let fname = job.filename.clone();
            let _ = state.manager.start_download(&job_id);

            Ok(Json(CreateDownloadResp {
                status: "ok".to_string(),
                job_id: Some(job_id),
                filename: Some(fname),
                state: Some("downloading".to_string()),
                message: Some("Download created and started in TORI".to_string()),
            }))
        }
        Err(e) => {
            let status = match e {
                tdm_core::EngineError::InvalidUrl(_) => StatusCode::BAD_REQUEST,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            };
            Err((
                status,
                Json(serde_json::json!({
                    "status": "error",
                    "message": format!("Failed to create download: {}", e)
                })),
            ))
        }
    }
}

async fn handle_list_downloads(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
) -> Result<Json<JobListResp>, (StatusCode, Json<serde_json::Value>)> {
    let config = state.config.read().await;
    if !check_auth(&headers, None, &config.token) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "status": "error",
                "message": "Authentication required."
            })),
        ));
    }

    match state.manager.list_downloads() {
        Ok(jobs) => {
            let summaries = jobs
                .into_iter()
                .map(|j| JobSummary {
                    id: j.id,
                    url: j.url,
                    filename: j.filename,
                    total_bytes: j.total_bytes,
                    downloaded_bytes: j.downloaded_bytes,
                    state: format!("{:?}", j.state).to_lowercase(),
                    job_type: format!("{:?}", j.job_type),
                    priority: format!("{:?}", j.priority).to_lowercase(),
                    created_at: j.created_at.to_rfc3339(),
                })
                .collect();

            Ok(Json(JobListResp {
                status: "ok".to_string(),
                jobs: summaries,
            }))
        }
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "status": "error",
                "message": e.to_string()
            })),
        )),
    }
}

async fn handle_get_download(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let config = state.config.read().await;
    if !check_auth(&headers, None, &config.token) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "status": "error",
                "message": "Authentication required."
            })),
        ));
    }

    match state.manager.get_download(&id) {
        Ok(Some(job)) => Ok(Json(serde_json::to_value(&job).unwrap_or_default())),
        Ok(None) => Err((
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "status": "error",
                "message": "Download not found"
            })),
        )),
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "status": "error",
                "message": e.to_string()
            })),
        )),
    }
}

async fn handle_pause_download(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let config = state.config.read().await;
    if !check_auth(&headers, None, &config.token) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"status": "error"})),
        ));
    }

    match state.manager.pause_download(&id) {
        Ok(_) => Ok(Json(serde_json::json!({"status": "ok", "job_id": id}))),
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"status": "error", "message": e.to_string()})),
        )),
    }
}

async fn handle_resume_download(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let config = state.config.read().await;
    if !check_auth(&headers, None, &config.token) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"status": "error"})),
        ));
    }

    match state.manager.resume_download(&id) {
        Ok(_) => Ok(Json(serde_json::json!({"status": "ok", "job_id": id}))),
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"status": "error", "message": e.to_string()})),
        )),
    }
}

async fn handle_cancel_download(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let config = state.config.read().await;
    if !check_auth(&headers, None, &config.token) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"status": "error"})),
        ));
    }

    match state.manager.cancel_download(&id) {
        Ok(_) => Ok(Json(serde_json::json!({"status": "ok", "job_id": id}))),
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"status": "error", "message": e.to_string()})),
        )),
    }
}

async fn handle_retry_download(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let config = state.config.read().await;
    if !check_auth(&headers, None, &config.token) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"status": "error"})),
        ));
    }

    match state.manager.get_download(&id) {
        Ok(Some(_)) => {
            let _ = state.manager.retry_download(&id);
            Ok(Json(serde_json::json!({"status": "ok", "job_id": id})))
        }
        Ok(None) => Err((
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"status": "error", "message": "Download not found"})),
        )),
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"status": "error", "message": e.to_string()})),
        )),
    }
}

async fn handle_delete_download(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let config = state.config.read().await;
    if !check_auth(&headers, None, &config.token) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"status": "error"})),
        ));
    }

    match state.manager.delete_download(&id, false) {
        Ok(_) => Ok(Json(serde_json::json!({"status": "ok", "job_id": id}))),
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"status": "error", "message": e.to_string()})),
        )),
    }
}

async fn handle_show_window(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let config = state.config.read().await;
    if !check_auth(&headers, None, &config.token) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"status": "error"})),
        ));
    }

    state
        .manager
        .event_bus()
        .emit(tdm_core::DownloadEvent::ShowWindow);
    Ok(Json(serde_json::json!({
        "status": "ok",
        "message": "Window focus request emitted"
    })))
}

async fn handle_events(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Query(query): Query<EventQuery>,
) -> Result<
    Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>,
    (StatusCode, Json<serde_json::Value>),
> {
    let config = state.config.read().await;
    if !check_auth(&headers, query.token.as_deref(), &config.token) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"status": "error", "message": "Authentication required."})),
        ));
    }

    let mut rx = state.manager.event_bus().subscribe();
    let stream = async_stream::stream! {
        while let Ok(event) = rx.recv().await {
            match event {
                tdm_core::DownloadEvent::Progress(p) => {
                    if let Ok(data) = serde_json::to_string(&p) {
                        yield Ok(Event::default().event("progress").data(data));
                    }
                }
                tdm_core::DownloadEvent::StateChanged { id, state: s, error } => {
                    let payload = serde_json::json!({
                        "id": id,
                        "state": format!("{:?}", s).to_lowercase(),
                        "error": error
                    });
                    yield Ok(Event::default().event("state_changed").data(payload.to_string()));
                }
                tdm_core::DownloadEvent::ShowWindow => {
                    yield Ok(Event::default().event("show_window").data("{}"));
                }
            }
        }
    };

    Ok(Sse::new(stream).keep_alive(KeepAlive::default().interval(Duration::from_secs(15))))
}

// ---------------------------------------------------------------------------
// Configuration & Lifecycle
// ---------------------------------------------------------------------------

pub fn get_or_create_token(db: &Database) -> String {
    if let Ok(Some(tok)) = db.get_setting("browser_integration_token") {
        let trimmed = tok.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    // Check if key exists in app_settings JSON
    if let Ok(Some(saved)) = db.get_setting("app_settings") {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&saved) {
            if let Some(key) = val.get("key").and_then(|k| k.as_str()) {
                let trimmed = key.trim();
                if !trimmed.is_empty() {
                    let _ = db.set_setting("browser_integration_token", trimmed);
                    return trimmed.to_string();
                }
            }
        }
    }

    // Generate secure pairing token: tori_<hex32>
    let u1 = uuid::Uuid::new_v4();
    let u2 = uuid::Uuid::new_v4();
    let token = format!(
        "tori_{}{}",
        hex::encode(&u1.as_bytes()[..8]),
        hex::encode(&u2.as_bytes()[..8])
    );
    let _ = db.set_setting("browser_integration_token", &token);
    token
}

pub fn get_configured_port(db: &Database) -> u16 {
    if let Ok(Some(saved)) = db.get_setting("app_settings") {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&saved) {
            if let Some(p) = val.get("port").and_then(|p| p.as_u64()) {
                if (1024..=65535).contains(&p) {
                    return p as u16;
                }
            }
        }
    }
    DEFAULT_PORT
}

pub fn build_router(state: Arc<ServerState>) -> Router {
    Router::new()
        .route("/api/v1/ping", get(handle_status))
        .route("/api/v1/status", get(handle_status))
        .route("/api/v1/pair", post(handle_pair))
        .route(
            "/api/v1/downloads",
            post(handle_create_download).get(handle_list_downloads),
        )
        .route("/api/v1/downloads/{id}", get(handle_get_download))
        .route("/api/v1/downloads/{id}/pause", post(handle_pause_download))
        .route(
            "/api/v1/downloads/{id}/resume",
            post(handle_resume_download),
        )
        .route(
            "/api/v1/downloads/{id}/cancel",
            post(handle_cancel_download),
        )
        .route("/api/v1/downloads/{id}/retry", post(handle_retry_download))
        .route(
            "/api/v1/downloads/{id}/delete",
            post(handle_delete_download),
        )
        .route("/api/v1/window/show", post(handle_show_window))
        .route("/api/v1/events", get(handle_events))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            security_middleware,
        ))
        .with_state(state)
}

pub async fn start_server(
    manager: Arc<DownloadManager>,
    db: Database,
    shutdown: CancellationToken,
) -> Result<(u16, String), String> {
    let port = get_configured_port(&db);
    let token = get_or_create_token(&db);

    let allowed_extension_ids = vec![
        "jfnfgmcbgapcpieaonbaolgebjaejcdm".to_string(), // Deterministic Chrome/Edge extension ID
        "bflchfddfgkfglmjapohkjmldepflkbe".to_string(),
    ];

    // Try preferred port, and if conflict, try next available ports
    let mut bound_listener = None;
    let mut bound_port = port;

    for candidate in [port, 6801, 6802, 6803, 0] {
        let addr = SocketAddr::from(([127, 0, 0, 1], candidate));
        match TcpListener::bind(addr).await {
            Ok(l) => {
                bound_port = l.local_addr().map(|a| a.port()).unwrap_or(candidate);
                bound_listener = Some(l);
                break;
            }
            Err(e) => {
                eprintln!(
                    "[TORI Server] Port {} unavailable ({}). Checking next candidate...",
                    candidate, e
                );
            }
        }
    }

    let listener = bound_listener
        .ok_or_else(|| "Failed to bind to any 127.0.0.1 port for integration server".to_string())?;

    let _ = db.set_setting("active_server_port", &bound_port.to_string());

    let config = ServerConfig {
        port: bound_port,
        token: token.clone(),
        allowed_extension_ids,
    };

    let server_state = Arc::new(ServerState {
        manager,
        db,
        config: RwLock::new(config),
    });

    let app = build_router(server_state);

    eprintln!(
        "[TORI Server] Integration HTTP/SSE server listening on http://127.0.0.1:{}",
        bound_port
    );

    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                shutdown.cancelled().await;
                eprintln!("[TORI Server] Shutting down integration server cleanly");
            })
            .await
            .unwrap_or_else(|e| eprintln!("[TORI Server] Server error: {}", e));
    });

    Ok((bound_port, token))
}
