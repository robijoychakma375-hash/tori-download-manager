//! Gate 32 — Comprehensive Automated Test Suite for Independent External Tools Auto-Update Manager
//!
//! Covers all 30 failure, security, scheduling, deferral, atomic activation, and rollback scenarios
//! using deterministic local loopback HTTP fixtures, real RFC 4880 V4 OpenPGP RSA signatures,
//! real Minisign Ed25519 signatures, real Windows x64 PE binaries, and real FFmpeg/FFprobe media verification.

use base64::Engine as _;
use chrono::{Duration as ChronoDuration, Utc};
use rand::rngs::OsRng;
use ring::signature::{Ed25519KeyPair, KeyPair};
use rsa::traits::PublicKeyParts;
use rsa::{Pkcs1v15Sign, RsaPrivateKey};
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha512};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use tdm_core::tools::{
    compare_tool_versions, compute_file_sha256, extract_ffmpeg_bundle_zip,
    parse_and_pin_openpgp_rsa_pubkey, validate_trusted_url, validate_windows_x64_pe_bytes,
    verify_minisign_ed25519, verify_openpgp_detached_rsa_signature, ExternalToolsEvent,
    ExternalToolsManager, ExternalToolsSettings, SignedManifestToolEntry, SignedToolsManifest,
    ToolId, ToolNotificationKind, ToolUpdateStatus, ToolsManagerConfig, VersionComparison,
    YTDLP_PGP_FINGERPRINT_HEX, YTDLP_PGP_PUBKEY_ASC,
};
use tdm_core::Database;

// ============================================================================
// Test Fixture Helpers: Real Binaries, Ephemeral OpenPGP RSA & Ed25519 Signing
// ============================================================================

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}

fn bundled_resources_bin() -> PathBuf {
    repo_root().join("resources").join("bin")
}

struct CompiledTestFixtures {
    _dir: TempDir,
    ytdlp_old: PathBuf,
    ytdlp_broken: PathBuf,
    ffmpeg_old: PathBuf,
    ffprobe_old: PathBuf,
    ffprobe_mismatch: PathBuf,
}

fn compile_tiny_exe(dir: &Path, name: &str, source: &str) -> PathBuf {
    let rs_path = dir.join(format!("{}.rs", name));
    let exe_path = dir.join(format!("{}.exe", name));
    fs::write(&rs_path, source).expect("write fixture rs");
    let output = Command::new("rustc")
        .args(["-C", "opt-level=0", "-o"])
        .arg(&exe_path)
        .arg(&rs_path)
        .output()
        .expect("invoke rustc for test fixture");
    assert!(
        output.status.success(),
        "Failed compiling test fixture {}: {}",
        name,
        String::from_utf8_lossy(&output.stderr)
    );
    exe_path
}

fn test_exe_fixtures() -> &'static CompiledTestFixtures {
    static FIXTURES: OnceLock<CompiledTestFixtures> = OnceLock::new();
    FIXTURES.get_or_init(|| {
        let dir = TempDir::new().expect("fixture temp dir");
        let ytdlp_old = compile_tiny_exe(
            dir.path(),
            "ytdlp_old",
            r#"fn main() {
                let args: Vec<String> = std::env::args().collect();
                if args.iter().any(|a| a == "--help") { println!("Usage: yt-dlp [OPTIONS] URL"); }
                else { println!("2025.01.01"); }
            }"#,
        );
        let ytdlp_broken = compile_tiny_exe(
            dir.path(),
            "ytdlp_broken",
            r#"fn main() { eprintln!("FATAL: simulated corrupted binary"); std::process::exit(1); }"#,
        );
        let ffmpeg_old = compile_tiny_exe(
            dir.path(),
            "ffmpeg_old",
            r#"fn main() { println!("ffmpeg version N-120000-g1111111111-20250101 Copyright (c) 2000-2025 the FFmpeg developers"); }"#,
        );
        let ffprobe_old = compile_tiny_exe(
            dir.path(),
            "ffprobe_old",
            r#"fn main() { println!("ffprobe version N-120000-g1111111111-20250101 Copyright (c) 2000-2025 the FFmpeg developers"); }"#,
        );
        let ffprobe_mismatch = compile_tiny_exe(
            dir.path(),
            "ffprobe_mismatch",
            r#"fn main() { println!("ffprobe version N-100000-g0000000000-20240101 Copyright (c) 2000-2024 the FFmpeg developers"); }"#,
        );
        CompiledTestFixtures {
            _dir: dir,
            ytdlp_old,
            ytdlp_broken,
            ffmpeg_old,
            ffprobe_old,
            ffprobe_mismatch,
        }
    })
}

fn prepare_old_bundled_dir() -> TempDir {
    let f = test_exe_fixtures();
    let d = TempDir::new().unwrap();
    fs::copy(&f.ytdlp_old, d.path().join("yt-dlp.exe")).unwrap();
    fs::copy(&f.ffmpeg_old, d.path().join("ffmpeg.exe")).unwrap();
    fs::copy(&f.ffprobe_old, d.path().join("ffprobe.exe")).unwrap();
    d
}

// --- Ephemeral Minisign Ed25519 Test Keypair (Legacy Pure Ed25519 "Ed" format verified by minisign-verify) ---

struct EphemeralMinisignKey {
    keypair: Ed25519KeyPair,
    key_id: [u8; 8],
    pubkey_b64: String,
}

impl EphemeralMinisignKey {
    fn generate() -> Self {
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let keypair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let key_id: [u8; 8] = [0x32, 0x32, 0xCA, 0xFE, 0xBA, 0xBE, 0x00, 0x01];

        let mut pk_bytes = Vec::with_capacity(42);
        pk_bytes.extend_from_slice(b"Ed");
        pk_bytes.extend_from_slice(&key_id);
        pk_bytes.extend_from_slice(keypair.public_key().as_ref());

        let pk_line = base64::engine::general_purpose::STANDARD.encode(&pk_bytes);
        let box_str = format!(
            "untrusted comment: minisign public key: TESTGATE32\n{}\n",
            pk_line
        );
        let pubkey_b64 = base64::engine::general_purpose::STANDARD.encode(box_str.as_bytes());
        Self {
            keypair,
            key_id,
            pubkey_b64,
        }
    }

    fn sign(&self, message: &[u8]) -> String {
        let sig = self.keypair.sign(message);
        let mut sig_buf = Vec::with_capacity(74);
        sig_buf.extend_from_slice(b"Ed");
        sig_buf.extend_from_slice(&self.key_id);
        sig_buf.extend_from_slice(sig.as_ref());
        let sig_b64 = base64::engine::general_purpose::STANDARD.encode(&sig_buf);

        let trusted_comment = "timestamp:1763700000\tfile:tools-manifest.json";
        let mut global_input = Vec::with_capacity(64 + trusted_comment.len());
        global_input.extend_from_slice(sig.as_ref());
        global_input.extend_from_slice(trusted_comment.as_bytes());
        let global_sig = self.keypair.sign(&global_input);
        let global_b64 = base64::engine::general_purpose::STANDARD.encode(global_sig.as_ref());

        format!(
            "untrusted comment: signature from gate32 test key\n{}\ntrusted comment: {}\n{}\n",
            sig_b64, trusted_comment, global_b64
        )
    }
}

// --- Ephemeral RFC 4880 V4 OpenPGP RSA Test Keypair (mirrors yt-dlp SHA2-256SUMS.sig format) ---

struct EphemeralOpenPgpRsaKey {
    priv_key: RsaPrivateKey,
    pubkey_asc: String,
    fingerprint_hex: String,
}

fn encode_mpi(bytes: &[u8]) -> Vec<u8> {
    let trimmed = bytes
        .iter()
        .position(|&b| b != 0)
        .map(|i| &bytes[i..])
        .unwrap_or(&[0]);
    let leading_zeros = trimmed[0].leading_zeros() as usize;
    let bit_len = (trimmed.len() * 8 - leading_zeros) as u16;
    let mut out = Vec::with_capacity(2 + trimmed.len());
    out.extend_from_slice(&bit_len.to_be_bytes());
    out.extend_from_slice(trimmed);
    out
}

fn wrap_new_pgp_packet(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(0xC0 | (tag & 0x3F));
    let len = body.len();
    if len < 192 {
        out.push(len as u8);
    } else if len < 8384 {
        let adj = len - 192;
        out.push(((adj >> 8) + 192) as u8);
        out.push((adj & 0xFF) as u8);
    } else {
        out.push(255);
        out.extend_from_slice(&(len as u32).to_be_bytes());
    }
    out.extend_from_slice(body);
    out
}

fn crc24(data: &[u8]) -> [u8; 3] {
    let mut crc: u32 = 0x00B7_04CE;
    for &b in data {
        crc ^= (b as u32) << 16;
        for _ in 0..8 {
            crc <<= 1;
            if (crc & 0x0100_0000) != 0 {
                crc ^= 0x0186_4CFB;
            }
        }
    }
    crc &= 0x00FF_FFFF;
    [(crc >> 16) as u8, (crc >> 8) as u8, crc as u8]
}

impl EphemeralOpenPgpRsaKey {
    fn get() -> &'static Self {
        static KEY: OnceLock<EphemeralOpenPgpRsaKey> = OnceLock::new();
        KEY.get_or_init(|| {
            let mut rng = OsRng;
            let priv_key = RsaPrivateKey::new(&mut rng, 2048).expect("generate test RSA-2048");
            let pub_key = priv_key.to_public_key();

            let mut body = Vec::new();
            body.push(4); // V4
            body.extend_from_slice(&1_700_000_000u32.to_be_bytes());
            body.push(1); // RSA Encrypt or Sign
            body.extend_from_slice(&encode_mpi(&pub_key.n().to_bytes_be()));
            body.extend_from_slice(&encode_mpi(&pub_key.e().to_bytes_be()));

            let mut fp_hasher = Sha1::new();
            fp_hasher.update([0x99u8]);
            fp_hasher.update((body.len() as u16).to_be_bytes());
            fp_hasher.update(&body);
            let fingerprint_hex = hex::encode_upper(fp_hasher.finalize());

            let packet = wrap_new_pgp_packet(6, &body);
            let b64 = base64::engine::general_purpose::STANDARD.encode(&packet);
            let crc_b64 = base64::engine::general_purpose::STANDARD.encode(crc24(&packet));
            let pubkey_asc = format!(
                "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n{}\n={}\n-----END PGP PUBLIC KEY BLOCK-----\n",
                b64, crc_b64
            );

            EphemeralOpenPgpRsaKey {
                priv_key,
                pubkey_asc,
                fingerprint_hex,
            }
        })
    }

    fn sign_detached_sha512(&self, data: &[u8]) -> Vec<u8> {
        // V4 binary signature packet (tag 2) with SHA-512 (algo 10)
        let mut hashed_sub = Vec::new();
        // Creation time subpacket (len=5, type=2, 4-byte timestamp)
        hashed_sub.push(5);
        hashed_sub.push(2);
        hashed_sub.extend_from_slice(&1_763_700_000u32.to_be_bytes());

        let mut header = Vec::new();
        header.push(4); // V4
        header.push(0x00); // binary doc
        header.push(1); // RSA
        header.push(10); // SHA-512
        header.extend_from_slice(&(hashed_sub.len() as u16).to_be_bytes());
        header.extend_from_slice(&hashed_sub);

        let mut h = Sha512::new();
        h.update(data);
        h.update(&header);
        h.update([0x04, 0xFF]);
        h.update((header.len() as u32).to_be_bytes());
        let digest = h.finalize();

        let sig_raw = self
            .priv_key
            .sign(Pkcs1v15Sign::new::<Sha512>(), &digest)
            .expect("RSA sign");

        let mut body = header;
        body.extend_from_slice(&0u16.to_be_bytes()); // unhashed len = 0
        body.push(digest[0]);
        body.push(digest[1]);
        body.extend_from_slice(&encode_mpi(&sig_raw));
        wrap_new_pgp_packet(2, &body)
    }
}

// --- Lightweight Async Mock HTTP Server on 127.0.0.1 ---

#[derive(Clone)]
struct MockResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    /// If Some(n), declares Content-Length = body.len() + n and closes early (simulates interrupted download).
    truncate_extra_content_length: Option<usize>,
    /// Optional artificial delay in milliseconds before sending response.
    delay_ms: u64,
}

impl MockResponse {
    fn ok_bytes(body: Vec<u8>) -> Self {
        Self {
            status: 200,
            headers: vec![("Content-Type".into(), "application/octet-stream".into())],
            body,
            truncate_extra_content_length: None,
            delay_ms: 0,
        }
    }

    fn ok_json(json: String) -> Self {
        Self {
            status: 200,
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: json.into_bytes(),
            truncate_extra_content_length: None,
            delay_ms: 0,
        }
    }

    fn status_only(status: u16, extra_headers: Vec<(String, String)>) -> Self {
        Self {
            status,
            headers: extra_headers,
            body: Vec::new(),
            truncate_extra_content_length: None,
            delay_ms: 0,
        }
    }
}

struct MockServer {
    base_url: String,
    hits: Arc<AtomicUsize>,
    _handle: tokio::task::JoinHandle<()>,
}

impl MockServer {
    async fn start(routes: HashMap<String, MockResponse>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base_url = format!("http://127.0.0.1:{}", addr.port());
        let routes = Arc::new(routes);
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_c = Arc::clone(&hits);

        let handle = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let routes_c = Arc::clone(&routes);
                let hits_inner = Arc::clone(&hits_c);
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let Ok(n) = stream.read(&mut buf).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    hits_inner.fetch_add(1, Ordering::SeqCst);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let path = req
                        .lines()
                        .next()
                        .and_then(|l| l.split_whitespace().nth(1))
                        .unwrap_or("/");

                    let resp = routes_c.get(path).cloned().unwrap_or_else(|| {
                        MockResponse::status_only(404, vec![])
                    });

                    if resp.delay_ms > 0 {
                        tokio::time::sleep(std::time::Duration::from_millis(resp.delay_ms)).await;
                    }

                    let reason = match resp.status {
                        200 => "OK",
                        302 => "Found",
                        404 => "Not Found",
                        429 => "Too Many Requests",
                        500 => "Internal Server Error",
                        _ => "Status",
                    };
                    let declared_len =
                        resp.body.len() + resp.truncate_extra_content_length.unwrap_or(0);
                    let mut head = format!(
                        "HTTP/1.1 {} {}\r\nContent-Length: {}\r\nConnection: close\r\n",
                        resp.status, reason, declared_len
                    );
                    for (k, v) in &resp.headers {
                        head.push_str(&format!("{}: {}\r\n", k, v));
                    }
                    head.push_str("\r\n");

                    let _ = stream.write_all(head.as_bytes()).await;
                    let _ = stream.write_all(&resp.body).await;
                    let _ = stream.shutdown().await;
                });
            }
        });

        Self {
            base_url,
            hits,
            _handle: handle,
        }
    }
}

fn create_zip_bundle(entries: &[(&str, &[u8], Option<u32>)]) -> Vec<u8> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut cursor);
        for &(name, data, unix_mode) in entries {
            let mut opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            if let Some(m) = unix_mode {
                opts = opts.unix_permissions(m);
            }
            writer.start_file(name, opts).unwrap();
            writer.write_all(data).unwrap();
        }
        writer.finish().unwrap();
    }
    cursor.into_inner()
}

fn build_real_ffmpeg_zip_bytes() -> Vec<u8> {
    static REAL_ZIP: OnceLock<Vec<u8>> = OnceLock::new();
    REAL_ZIP
        .get_or_init(|| {
            let bin_dir = bundled_resources_bin();
            let ff_bytes = fs::read(bin_dir.join("ffmpeg.exe")).expect("read bundled ffmpeg.exe");
            let fp_bytes = fs::read(bin_dir.join("ffprobe.exe")).expect("read bundled ffprobe.exe");
            create_zip_bundle(&[
                ("ffmpeg-N-126374/bin/ffmpeg.exe", &ff_bytes, None),
                ("ffmpeg-N-126374/bin/ffprobe.exe", &fp_bytes, None),
                ("ffmpeg-N-126374/LICENSE.txt", b"GPLv3", None),
                ("ffmpeg-N-126374/unexpected.bat", b"@echo should not extract", None),
            ])
        })
        .clone()
}

fn build_test_manager(
    data_dir: &Path,
    bundled_dir: &Path,
    mut cfg: ToolsManagerConfig,
) -> Arc<ExternalToolsManager> {
    let db = Database::open(data_dir.join("tdm_storage.sqlite")).unwrap();
    cfg.allow_loopback_http = true;
    cfg.register_globally = false;
    cfg.bundled_override_dir = Some(bundled_dir.to_path_buf());
    Arc::new(ExternalToolsManager::with_config(db, data_dir.to_path_buf(), cfg).unwrap())
}

fn build_ytdlp_github_routes(
    base_url: &str,
    tag_name: &str,
    exe_bytes: Vec<u8>,
    pgp: &EphemeralOpenPgpRsaKey,
    tamper_checksum: bool,
    tamper_sig: bool,
) -> HashMap<String, MockResponse> {
    let actual_sha = hex::encode(Sha256::digest(&exe_bytes));
    let listed_sha = if tamper_checksum {
        "0".repeat(64)
    } else {
        actual_sha.clone()
    };
    let sums_body = format!("{}  yt-dlp.exe\n", listed_sha).into_bytes();
    let mut sig_body = pgp.sign_detached_sha512(&sums_body);
    if tamper_sig {
        let last = sig_body.len() - 4;
        sig_body[last] ^= 0xFF;
    }

    let release_json = serde_json::json!({
        "tag_name": tag_name,
        "published_at": "2026-10-26T12:00:00Z",
        "assets": [
            {
                "name": "yt-dlp.exe",
                "browser_download_url": format!("{}/yt-dlp.exe", base_url),
                "size": exe_bytes.len(),
                "digest": format!("sha256:{}", listed_sha)
            },
            {
                "name": "SHA2-256SUMS",
                "browser_download_url": format!("{}/SHA2-256SUMS", base_url),
                "size": sums_body.len()
            },
            {
                "name": "SHA2-256SUMS.sig",
                "browser_download_url": format!("{}/SHA2-256SUMS.sig", base_url),
                "size": sig_body.len()
            }
        ]
    })
    .to_string();

    let mut routes = HashMap::new();
    routes.insert("/ytdlp/latest".into(), MockResponse::ok_json(release_json));
    routes.insert("/yt-dlp.exe".into(), MockResponse::ok_bytes(exe_bytes));
    routes.insert("/SHA2-256SUMS".into(), MockResponse::ok_bytes(sums_body));
    routes.insert("/SHA2-256SUMS.sig".into(), MockResponse::ok_bytes(sig_body));
    routes.insert(
        "/ffmpeg/latest".into(),
        MockResponse::ok_json(
            serde_json::json!({
                "tag_name": "latest",
                "published_at": "2026-11-20T12:00:00Z",
                "assets": [{
                    "name": "ffmpeg-master-latest-win64-gpl.zip",
                    "browser_download_url": format!("{}/ffmpeg-unsigned.zip", base_url),
                    "size": 1000,
                    "digest": format!("sha256:{}", "a".repeat(64))
                }]
            })
            .to_string(),
        ),
    );
    routes
}

// ============================================================================
// SCENARIOS 1 & 2 & SECURITY: Real Valid Updates (yt-dlp OpenPGP + FFmpeg Ed25519),
// No Update Available, Downgrade Rejection, and Untrusted Upstream Blocking
// ============================================================================

#[tokio::test]
async fn test_01_valid_ytdlp_openpgp_and_ffmpeg_ed25519_bundle_updates_and_rollback() {
    let data_dir = TempDir::new().unwrap();
    let bundled = prepare_old_bundled_dir();
    let pgp = EphemeralOpenPgpRsaKey::get();
    let minisign = EphemeralMinisignKey::generate();

    let real_ytdlp_bytes = fs::read(bundled_resources_bin().join("yt-dlp.exe")).unwrap();
    let real_ffmpeg_zip = build_real_ffmpeg_zip_bytes();
    let ffmpeg_zip_sha = hex::encode(Sha256::digest(&real_ffmpeg_zip));

    // Pre-bind listener? Use placeholder route map after learning port
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let _ = port;

    // Start two-step server cleanly by computing routes dynamically via MockServer wrapper
    let mut routes = HashMap::new();
    let ytdlp_sha = hex::encode(Sha256::digest(&real_ytdlp_bytes));
    let sums_body = format!("{}  yt-dlp.exe\n", ytdlp_sha).into_bytes();
    let sig_body = pgp.sign_detached_sha512(&sums_body);
    routes.insert("/yt-dlp.exe".into(), MockResponse::ok_bytes(real_ytdlp_bytes.clone()));
    routes.insert("/SHA2-256SUMS".into(), MockResponse::ok_bytes(sums_body));
    routes.insert("/SHA2-256SUMS.sig".into(), MockResponse::ok_bytes(sig_body));
    routes.insert(
        "/ffmpeg-bundle.zip".into(),
        MockResponse::ok_bytes(real_ffmpeg_zip.clone()),
    );
    let asset_server = MockServer::start(routes).await;

    let release_json = serde_json::json!({
        "tag_name": "2026.08.19",
        "published_at": "2026-08-19T12:00:00Z",
        "assets": [
            {
                "name": "yt-dlp.exe",
                "browser_download_url": format!("{}/yt-dlp.exe", asset_server.base_url),
                "size": real_ytdlp_bytes.len(),
                "digest": format!("sha256:{}", ytdlp_sha)
            },
            {
                "name": "SHA2-256SUMS",
                "browser_download_url": format!("{}/SHA2-256SUMS", asset_server.base_url),
                "size": 90
            },
            {
                "name": "SHA2-256SUMS.sig",
                "browser_download_url": format!("{}/SHA2-256SUMS.sig", asset_server.base_url),
                "size": 300
            }
        ]
    })
    .to_string();

    let signed_manifest = SignedToolsManifest {
        schema_version: 1,
        generated_at: Utc::now().to_rfc3339(),
        yt_dlp: None,
        ffmpeg_bundle: Some(SignedManifestToolEntry {
            version: "N-126374-g089a48eb36-20260831".to_string(),
            url: format!("{}/ffmpeg-bundle.zip", asset_server.base_url),
            sha256: ffmpeg_zip_sha.clone(),
            size: Some(real_ffmpeg_zip.len() as u64),
            platform: Some("windows".to_string()),
            architecture: Some("x86_64".to_string()),
            published_at: Some("2026-08-31T00:00:00Z".to_string()),
        }),
    };
    let manifest_bytes = serde_json::to_vec(&signed_manifest).unwrap();
    let manifest_sig = minisign.sign(&manifest_bytes);

    let mut api_routes = HashMap::new();
    api_routes.insert("/ytdlp/latest".into(), MockResponse::ok_json(release_json));
    api_routes.insert(
        "/tools-manifest.json".into(),
        MockResponse::ok_bytes(manifest_bytes),
    );
    api_routes.insert(
        "/tools-manifest.json.sig".into(),
        MockResponse::ok_bytes(manifest_sig.into_bytes()),
    );
    let api_server = MockServer::start(api_routes).await;

    let mut cfg = ToolsManagerConfig::default();
    cfg.ytdlp_release_api_url = format!("{}/ytdlp/latest", api_server.base_url);
    cfg.signed_manifest_url = Some(format!("{}/tools-manifest.json", api_server.base_url));
    cfg.tori_manifest_pubkey_b64 = minisign.pubkey_b64.clone();
    cfg.ytdlp_pgp_pubkey_asc = pgp.pubkey_asc.clone();
    cfg.ytdlp_pgp_fingerprint_hex = pgp.fingerprint_hex.clone();

    let mgr = build_test_manager(data_dir.path(), bundled.path(), cfg);

    // Subscribe to notifications to verify distinct tool update notifications
    let mut rx = mgr.subscribe();

    // 1. Verify initial defaults & old bundled versions detected
    let initial = mgr.get_status_snapshot().unwrap();
    assert!(initial.settings.auto_update);
    assert_eq!(initial.settings.check_interval_hours, 24);
    assert!(initial.settings.auto_install);
    assert!(initial.settings.notify_on_update);
    assert!(initial.settings.defer_while_in_use);
    assert_eq!(
        initial.tools[0].installed_version.as_deref(),
        Some("2025.01.01")
    );
    assert_eq!(
        initial.tools[1].installed_version.as_deref(),
        Some("N-120000-g1111111111-20250101")
    );

    // 2. Background automatic check (manual=false) should automatically verify, test, and install ALL 3 tools!
    let updated = mgr.check_for_updates(false).await.unwrap();
    let yt = updated.tools.iter().find(|t| t.tool_id == ToolId::YtDlp).unwrap();
    let ff = updated.tools.iter().find(|t| t.tool_id == ToolId::Ffmpeg).unwrap();
    let fp = updated.tools.iter().find(|t| t.tool_id == ToolId::Ffprobe).unwrap();

    assert_eq!(yt.installed_version.as_deref(), Some("2026.08.19"));
    assert_eq!(yt.update_status, ToolUpdateStatus::Updated);
    assert_eq!(yt.source, "managed");
    assert!(yt.rollback_available);

    assert_eq!(
        ff.installed_version.as_deref(),
        Some("N-126374-g089a48eb36-20260831")
    );
    assert_eq!(
        fp.installed_version.as_deref(),
        Some("N-126374-g089a48eb36-20260831")
    );
    assert_eq!(ff.update_status, ToolUpdateStatus::Updated);
    assert_eq!(fp.update_status, ToolUpdateStatus::Updated);
    assert!(ff.rollback_available);
    assert!(fp.rollback_available);

    // Ensure non-allowlisted file `unexpected.bat` from ZIP was NEVER extracted
    let ff_dir = PathBuf::from(ff.active_binary_path.as_ref().unwrap())
        .parent()
        .unwrap()
        .to_path_buf();
    assert!(!ff_dir.join("unexpected.bat").exists());
    assert!(ff_dir.join("ffmpeg.exe").exists());
    assert!(ff_dir.join("ffprobe.exe").exists());

    // Verify notifications were emitted for both yt-dlp and FFmpeg bundle
    let mut saw_yt_notif = false;
    let mut saw_ff_notif = false;
    while let Ok(evt) = rx.try_recv() {
        if let ExternalToolsEvent::Notification(n) = evt {
            if n.kind == ToolNotificationKind::ToolUpdatedYtDlp {
                saw_yt_notif = true;
            }
            if n.kind == ToolNotificationKind::ToolUpdatedFfmpegBundle {
                saw_ff_notif = true;
            }
        }
    }
    assert!(saw_yt_notif, "Expected yt-dlp update notification");
    assert!(saw_ff_notif, "Expected FFmpeg & FFprobe bundle update notification");

    // 3. Scenario 2: Re-checking now must report UpToDate and emit ZERO notifications!
    let recheck = mgr.check_for_updates(false).await.unwrap();
    for t in &recheck.tools {
        assert_eq!(t.update_status, ToolUpdateStatus::UpToDate);
    }
    let mut notif_on_uptodate = 0;
    while let Ok(evt) = rx.try_recv() {
        if matches!(evt, ExternalToolsEvent::Notification(_)) {
            notif_on_uptodate += 1;
        }
    }
    assert_eq!(notif_on_uptodate, 0, "Must never notify on normal up-to-date checks");

    // 4. Verify manual rollback restores yt-dlp and atomic FFmpeg+FFprobe back to bundled versions!
    let rb_yt = mgr.rollback_tool(ToolId::YtDlp).await.unwrap();
    let yt_after = rb_yt.tools.iter().find(|t| t.tool_id == ToolId::YtDlp).unwrap();
    assert_eq!(yt_after.installed_version.as_deref(), Some("2025.01.01"));
    assert_eq!(yt_after.update_status, ToolUpdateStatus::RolledBack);

    let rb_ff = mgr.rollback_tool(ToolId::Ffprobe).await.unwrap();
    let ff_after = rb_ff.tools.iter().find(|t| t.tool_id == ToolId::Ffmpeg).unwrap();
    let fp_after = rb_ff.tools.iter().find(|t| t.tool_id == ToolId::Ffprobe).unwrap();
    assert_eq!(
        ff_after.installed_version.as_deref(),
        Some("N-120000-g1111111111-20250101")
    );
    assert_eq!(
        fp_after.installed_version.as_deref(),
        Some("N-120000-g1111111111-20250101")
    );
    assert_eq!(ff_after.update_status, ToolUpdateStatus::RolledBack);
    assert_eq!(fp_after.update_status, ToolUpdateStatus::RolledBack);

    // 5. Verify update history was recorded accurately in SQLite
    let history = mgr.get_update_history(50).unwrap();
    assert!(history.iter().any(|h| h.tool_id == "yt-dlp" && h.action == "update" && h.status == "updated"));
    assert!(history.iter().any(|h| h.tool_id == "ffmpeg" && h.action == "update" && h.status == "updated"));
    assert!(history.iter().any(|h| h.tool_id == "yt-dlp" && h.action == "rollback"));
    assert!(history.iter().any(|h| h.tool_id == "ffmpeg" && h.action == "rollback"));
}

#[tokio::test]
async fn test_02_untrusted_upstream_ffmpeg_blocked_honestly() {
    let data_dir = TempDir::new().unwrap();
    let bundled = prepare_old_bundled_dir();

    let mut routes = HashMap::new();
    routes.insert(
        "/ffmpeg/latest".into(),
        MockResponse::ok_json(
            serde_json::json!({
                "tag_name": "autobuild-2026-11-20-12-55",
                "published_at": "2026-11-20T12:55:00Z",
                "assets": [{
                    "name": "ffmpeg-master-latest-win64-gpl.zip",
                    "browser_download_url": "http://127.0.0.1:9/never-downloaded.zip",
                    "size": 123456,
                    "digest": format!("sha256:{}", "b".repeat(64))
                }]
            })
            .to_string(),
        ),
    );
    routes.insert(
        "/ytdlp/latest".into(),
        MockResponse::status_only(500, vec![]),
    );
    let server = MockServer::start(routes).await;

    let mut cfg = ToolsManagerConfig::default();
    cfg.ytdlp_release_api_url = format!("{}/ytdlp/latest", server.base_url);
    cfg.ffmpeg_release_api_url = format!("{}/ffmpeg/latest", server.base_url);
    cfg.signed_manifest_url = None;

    let mgr = build_test_manager(data_dir.path(), bundled.path(), cfg);
    let snap = mgr.check_for_updates(false).await.unwrap();

    let ff = snap.tools.iter().find(|t| t.tool_id == ToolId::Ffmpeg).unwrap();
    let fp = snap.tools.iter().find(|t| t.tool_id == ToolId::Ffprobe).unwrap();
    assert_eq!(ff.update_status, ToolUpdateStatus::SourceUntrusted);
    assert_eq!(fp.update_status, ToolUpdateStatus::SourceUntrusted);
    assert_eq!(
        ff.available_version.as_deref(),
        Some("autobuild-2026-11-20-12-55")
    );

    // Attempting manual update MUST fail cleanly and keep installed bundled binary untouched
    let err = mgr.update_tool(ToolId::Ffmpeg).await;
    assert!(err.is_err(), "Unsigned upstream FFmpeg must never install");
    assert_eq!(
        mgr.coordinator().resolve_tool(ToolId::Ffmpeg).unwrap().source,
        "bundled"
    );
}

// ============================================================================
// SCENARIOS 3, 4, 5, 6: Offline, Timeout, HTTP 429 Rate Limit, HTTP 500
// ============================================================================

#[tokio::test]
async fn test_03_to_06_network_offline_timeout_rate_limit_and_500() {
    let bundled = prepare_old_bundled_dir();

    // Scenario 3: Network offline (closed loopback port)
    {
        let data_dir = TempDir::new().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dead_port = listener.local_addr().unwrap().port();
        drop(listener);

        let mut cfg = ToolsManagerConfig::default();
        cfg.ytdlp_release_api_url = format!("http://127.0.0.1:{}/ytdlp", dead_port);
        cfg.ffmpeg_release_api_url = format!("http://127.0.0.1:{}/ffmpeg", dead_port);
        cfg.http_timeout_secs = 2;
        let mgr = build_test_manager(data_dir.path(), bundled.path(), cfg);
        let snap = mgr.check_for_updates(true).await.unwrap();
        assert_eq!(snap.scheduler.consecutive_failures, 1);
        assert!(snap.scheduler.next_retry_after.is_some());
        // Bundled tools remain completely usable!
        assert!(mgr.coordinator().resolve_tool(ToolId::YtDlp).is_some());
        assert!(mgr.coordinator().resolve_tool(ToolId::Ffmpeg).is_some());
    }

    // Scenario 4: HTTP timeout
    {
        let data_dir = TempDir::new().unwrap();
        let mut routes = HashMap::new();
        let mut slow = MockResponse::ok_json("{}".into());
        slow.delay_ms = 2500;
        routes.insert("/ytdlp".into(), slow.clone());
        routes.insert("/ffmpeg".into(), slow);
        let srv = MockServer::start(routes).await;

        let mut cfg = ToolsManagerConfig::default();
        cfg.ytdlp_release_api_url = format!("{}/ytdlp", srv.base_url);
        cfg.ffmpeg_release_api_url = format!("{}/ffmpeg", srv.base_url);
        cfg.http_timeout_secs = 1;
        let mgr = build_test_manager(data_dir.path(), bundled.path(), cfg);
        let snap = mgr.check_for_updates(true).await.unwrap();
        assert_eq!(snap.scheduler.consecutive_failures, 1);
        assert_eq!(snap.tools[0].update_status, ToolUpdateStatus::UpdateFailed);
    }

    // Scenario 5: HTTP 429 rate limit with Retry-After: 1800
    {
        let data_dir = TempDir::new().unwrap();
        let mut routes = HashMap::new();
        routes.insert(
            "/ytdlp".into(),
            MockResponse::status_only(429, vec![("Retry-After".into(), "1800".into())]),
        );
        routes.insert(
            "/ffmpeg".into(),
            MockResponse::status_only(429, vec![("Retry-After".into(), "1800".into())]),
        );
        let srv = MockServer::start(routes).await;

        let mut cfg = ToolsManagerConfig::default();
        cfg.ytdlp_release_api_url = format!("{}/ytdlp", srv.base_url);
        cfg.ffmpeg_release_api_url = format!("{}/ffmpeg", srv.base_url);
        let mgr = build_test_manager(data_dir.path(), bundled.path(), cfg);
        let snap = mgr.check_for_updates(true).await.unwrap();
        let retry_after = snap.scheduler.next_retry_after.expect("Retry-After backoff set");
        assert!(
            (retry_after - Utc::now()).num_seconds() >= 1700,
            "Backoff must respect Retry-After >= 1800s"
        );
        assert!(!mgr.is_scheduled_check_due(Utc::now()));
    }

    // Scenario 6: HTTP 500 server error -> exponential backoff increments
    {
        let data_dir = TempDir::new().unwrap();
        let mut routes = HashMap::new();
        routes.insert("/ytdlp".into(), MockResponse::status_only(500, vec![]));
        routes.insert("/ffmpeg".into(), MockResponse::status_only(500, vec![]));
        let srv = MockServer::start(routes).await;

        let mut cfg = ToolsManagerConfig::default();
        cfg.ytdlp_release_api_url = format!("{}/ytdlp", srv.base_url);
        cfg.ffmpeg_release_api_url = format!("{}/ffmpeg", srv.base_url);
        let mgr = build_test_manager(data_dir.path(), bundled.path(), cfg);
        let s1 = mgr.check_for_updates(true).await.unwrap();
        let s2 = mgr.check_for_updates(true).await.unwrap();
        assert_eq!(s1.scheduler.consecutive_failures, 1);
        assert_eq!(s2.scheduler.consecutive_failures, 2);
        assert!(s2.scheduler.next_retry_after.unwrap() > s1.scheduler.next_retry_after.unwrap());
    }
}

// ============================================================================
// SCENARIOS 7, 8, 9, 10, 11: Interrupted Download, Wrong Checksum, Invalid
// OpenPGP & Ed25519 Signatures, Missing Artifact, Malformed Metadata
// ============================================================================

#[tokio::test]
async fn test_07_to_11_integrity_signature_missing_and_malformed_failures() {
    let bundled = prepare_old_bundled_dir();
    let pgp = EphemeralOpenPgpRsaKey::get();
    let real_ytdlp = fs::read(bundled_resources_bin().join("yt-dlp.exe")).unwrap();

    // Scenario 7: Interrupted download (truncated stream)
    {
        let data_dir = TempDir::new().unwrap();
        let truncated_body = real_ytdlp[..4096].to_vec();
        let actual_sha = hex::encode(Sha256::digest(&real_ytdlp));
        let sums = format!("{}  yt-dlp.exe\n", actual_sha).into_bytes();
        let sig = pgp.sign_detached_sha512(&sums);

        let mut dl_resp = MockResponse::ok_bytes(truncated_body);
        dl_resp.truncate_extra_content_length = Some(real_ytdlp.len() - 4096);
        let mut r = HashMap::new();
        r.insert("/yt-dlp.exe".into(), dl_resp);
        r.insert("/SHA2-256SUMS".into(), MockResponse::ok_bytes(sums));
        r.insert("/SHA2-256SUMS.sig".into(), MockResponse::ok_bytes(sig));
        let asset_srv = MockServer::start(r).await;

        let mut api_r = HashMap::new();
        api_r.insert(
            "/ytdlp".into(),
            MockResponse::ok_json(
                serde_json::json!({
                    "tag_name": "2026.08.19",
                    "assets": [
                        {"name": "yt-dlp.exe", "browser_download_url": format!("{}/yt-dlp.exe", asset_srv.base_url), "size": real_ytdlp.len()},
                        {"name": "SHA2-256SUMS", "browser_download_url": format!("{}/SHA2-256SUMS", asset_srv.base_url)},
                        {"name": "SHA2-256SUMS.sig", "browser_download_url": format!("{}/SHA2-256SUMS.sig", asset_srv.base_url)}
                    ]
                })
                .to_string(),
            ),
        );
        let api_srv = MockServer::start(api_r).await;

        let mut cfg = ToolsManagerConfig::default();
        cfg.ytdlp_release_api_url = format!("{}/ytdlp", api_srv.base_url);
        cfg.ytdlp_pgp_pubkey_asc = pgp.pubkey_asc.clone();
        cfg.ytdlp_pgp_fingerprint_hex = pgp.fingerprint_hex.clone();
        let mgr = build_test_manager(data_dir.path(), bundled.path(), cfg);
        assert!(mgr.update_tool(ToolId::YtDlp).await.is_err());
        assert_eq!(mgr.coordinator().resolve_tool(ToolId::YtDlp).unwrap().source, "bundled");
    }

    // Scenario 8: Incorrect SHA-256 checksum
    {
        let data_dir = TempDir::new().unwrap();
        let asset_srv = MockServer::start(HashMap::new()).await;
        let routes = build_ytdlp_github_routes(
            &asset_srv.base_url,
            "2026.08.19",
            real_ytdlp.clone(),
            pgp,
            true,  // tamper_checksum!
            false,
        );
        drop(asset_srv);
        // Bind with matching self URL using two servers
        let mut ar = HashMap::new();
        ar.insert("/yt-dlp.exe".into(), routes["/yt-dlp.exe"].clone());
        ar.insert("/SHA2-256SUMS".into(), routes["/SHA2-256SUMS"].clone());
        ar.insert("/SHA2-256SUMS.sig".into(), routes["/SHA2-256SUMS.sig"].clone());
        let a_srv = MockServer::start(ar).await;
        let mut api_r = HashMap::new();
        api_r.insert(
            "/ytdlp".into(),
            MockResponse::ok_json(
                serde_json::json!({
                    "tag_name": "2026.08.19",
                    "assets": [
                        {"name": "yt-dlp.exe", "browser_download_url": format!("{}/yt-dlp.exe", a_srv.base_url), "size": real_ytdlp.len()},
                        {"name": "SHA2-256SUMS", "browser_download_url": format!("{}/SHA2-256SUMS", a_srv.base_url)},
                        {"name": "SHA2-256SUMS.sig", "browser_download_url": format!("{}/SHA2-256SUMS.sig", a_srv.base_url)}
                    ]
                })
                .to_string(),
            ),
        );
        let api_srv = MockServer::start(api_r).await;

        let mut cfg = ToolsManagerConfig::default();
        cfg.ytdlp_release_api_url = format!("{}/ytdlp", api_srv.base_url);
        cfg.ytdlp_pgp_pubkey_asc = pgp.pubkey_asc.clone();
        cfg.ytdlp_pgp_fingerprint_hex = pgp.fingerprint_hex.clone();
        let mgr = build_test_manager(data_dir.path(), bundled.path(), cfg);
        let err = mgr.update_tool(ToolId::YtDlp).await.unwrap_err();
        assert!(err.to_string().contains("SHA-256"), "Expected SHA-256 mismatch error: {}", err);
    }

    // Scenario 9: Invalid OpenPGP signature AND invalid Ed25519 signature
    {
        // OpenPGP tamper
        let msg = b"deadbeef  yt-dlp.exe\n";
        let mut sig = pgp.sign_detached_sha512(msg);
        assert!(verify_openpgp_detached_rsa_signature(
            &pgp.pubkey_asc,
            &pgp.fingerprint_hex,
            msg,
            &sig
        )
        .is_ok());
        let len = sig.len();
        sig[len - 5] ^= 0xFF;
        assert!(verify_openpgp_detached_rsa_signature(
            &pgp.pubkey_asc,
            &pgp.fingerprint_hex,
            msg,
            &sig
        )
        .is_err());

        // Ed25519 tamper & wrong key
        let k1 = EphemeralMinisignKey::generate();
        let k2 = EphemeralMinisignKey::generate();
        let payload = br#"{"schema_version":1}"#;
        let valid_sig = k1.sign(payload);
        assert!(verify_minisign_ed25519(&k1.pubkey_b64, payload, &valid_sig).is_ok());
        assert!(verify_minisign_ed25519(&k1.pubkey_b64, b"tampered", &valid_sig).is_err());
        assert!(verify_minisign_ed25519(&k2.pubkey_b64, payload, &valid_sig).is_err());
    }

    // Scenario 10 & 11: Missing artifact (404) & malformed metadata JSON
    {
        let data_dir = TempDir::new().unwrap();
        let mut routes = HashMap::new();
        routes.insert("/malformed".into(), MockResponse::ok_bytes(b"{not valid json".to_vec()));
        routes.insert(
            "/missing-asset".into(),
            MockResponse::ok_json(r#"{"tag_name":"2026.10.26","assets":[]}"#.into()),
        );
        let srv = MockServer::start(routes).await;

        let mut cfg = ToolsManagerConfig::default();
        cfg.ytdlp_release_api_url = format!("{}/malformed", srv.base_url);
        cfg.ffmpeg_release_api_url = format!("{}/missing-asset", srv.base_url);
        let mgr = build_test_manager(data_dir.path(), bundled.path(), cfg);
        let snap = mgr.check_for_updates(true).await.unwrap();
        assert_eq!(snap.tools[0].update_status, ToolUpdateStatus::UpdateFailed);
        assert_eq!(snap.tools[1].update_status, ToolUpdateStatus::UpdateFailed);
    }
}

// ============================================================================
// SCENARIOS 12, 13, 14, 15, 24: Wrong Arch, Unsupported Exe, Failed Health
// Check, Disk/Size Limit, FFmpeg/FFprobe Version Mismatch, & ZIP Security
// ============================================================================

#[tokio::test]
async fn test_12_to_15_and_24_validation_health_limits_mismatch_and_zip_security() {
    let bundled = prepare_old_bundled_dir();
    let f = test_exe_fixtures();
    let pgp = EphemeralOpenPgpRsaKey::get();
    let minisign = EphemeralMinisignKey::generate();

    // Scenario 12 & 13: Wrong Windows arch (ARM64 / x86) and non-PE executable rejected
    let mut arm64_pe = vec![0u8; 1024];
    arm64_pe[0..2].copy_from_slice(b"MZ");
    arm64_pe[0x3C..0x40].copy_from_slice(&0x80u32.to_le_bytes());
    arm64_pe[0x80..0x84].copy_from_slice(b"PE\0\0");
    arm64_pe[0x84..0x86].copy_from_slice(&0xAA64u16.to_le_bytes());
    arm64_pe[0x98..0x9A].copy_from_slice(&0x020Bu16.to_le_bytes());
    assert!(validate_windows_x64_pe_bytes(&arm64_pe).is_err());
    assert!(validate_windows_x64_pe_bytes(b"\x7fELF\x02\x01\x01\x00").is_err());

    // Security: Zip-Slip (../), absolute path, drive letter, symlink, and zip bomb strictly rejected!
    let td = TempDir::new().unwrap();
    let slip_zip = td.path().join("slip.zip");
    fs::write(&slip_zip, create_zip_bundle(&[("../evil.exe", b"MZ...", None)])).unwrap();
    assert!(extract_ffmpeg_bundle_zip(&slip_zip, &td.path().join("out1"), 1024 * 1024).is_err());

    let drive_zip = td.path().join("drive.zip");
    fs::write(&drive_zip, create_zip_bundle(&[("C:/Windows/ffmpeg.exe", b"MZ...", None)])).unwrap();
    assert!(extract_ffmpeg_bundle_zip(&drive_zip, &td.path().join("out2"), 1024 * 1024).is_err());

    let sym_zip = td.path().join("sym.zip");
    fs::write(
        &sym_zip,
        create_zip_bundle(&[("bin/ffmpeg.exe", b"/etc/passwd", Some(0o120777))]),
    )
    .unwrap();
    assert!(extract_ffmpeg_bundle_zip(&sym_zip, &td.path().join("out3"), 1024 * 1024).is_err());

    let bomb_zip = td.path().join("bomb.zip");
    fs::write(
        &bomb_zip,
        create_zip_bundle(&[("bin/ffmpeg.exe", &vec![0u8; 4096], None)]),
    )
    .unwrap();
    assert!(extract_ffmpeg_bundle_zip(&bomb_zip, &td.path().join("out4"), 1024).is_err());

    // Scenario 14: Broken yt-dlp binary fails health check BEFORE activation
    {
        let data_dir = TempDir::new().unwrap();
        let broken_bytes = fs::read(&f.ytdlp_broken).unwrap();
        let sha = hex::encode(Sha256::digest(&broken_bytes));
        let sums = format!("{}  yt-dlp.exe\n", sha).into_bytes();
        let sig = pgp.sign_detached_sha512(&sums);

        let mut ar = HashMap::new();
        ar.insert("/yt-dlp.exe".into(), MockResponse::ok_bytes(broken_bytes.clone()));
        ar.insert("/SHA2-256SUMS".into(), MockResponse::ok_bytes(sums));
        ar.insert("/SHA2-256SUMS.sig".into(), MockResponse::ok_bytes(sig));
        let a_srv = MockServer::start(ar).await;

        let mut api_r = HashMap::new();
        api_r.insert(
            "/ytdlp".into(),
            MockResponse::ok_json(
                serde_json::json!({
                    "tag_name": "2026.09.01",
                    "assets": [
                        {"name": "yt-dlp.exe", "browser_download_url": format!("{}/yt-dlp.exe", a_srv.base_url), "size": broken_bytes.len()},
                        {"name": "SHA2-256SUMS", "browser_download_url": format!("{}/SHA2-256SUMS", a_srv.base_url)},
                        {"name": "SHA2-256SUMS.sig", "browser_download_url": format!("{}/SHA2-256SUMS.sig", a_srv.base_url)}
                    ]
                })
                .to_string(),
            ),
        );
        let api_srv = MockServer::start(api_r).await;

        let mut cfg = ToolsManagerConfig::default();
        cfg.ytdlp_release_api_url = format!("{}/ytdlp", api_srv.base_url);
        cfg.ytdlp_pgp_pubkey_asc = pgp.pubkey_asc.clone();
        cfg.ytdlp_pgp_fingerprint_hex = pgp.fingerprint_hex.clone();
        let mgr = build_test_manager(data_dir.path(), bundled.path(), cfg);
        assert!(mgr.update_tool(ToolId::YtDlp).await.is_err());
        // Old bundled tool remained active untouched!
        assert_eq!(
            mgr.get_status_snapshot().unwrap().tools[0]
                .installed_version
                .as_deref(),
            Some("2025.01.01")
        );
    }

    // Scenario 15: Artifact size exceeds configured quota / disk safety cap
    {
        let data_dir = TempDir::new().unwrap();
        let broken_bytes = fs::read(&f.ytdlp_broken).unwrap();
        let sha = hex::encode(Sha256::digest(&broken_bytes));
        let sums = format!("{}  yt-dlp.exe\n", sha).into_bytes();
        let sig = pgp.sign_detached_sha512(&sums);

        let mut ar = HashMap::new();
        ar.insert("/yt-dlp.exe".into(), MockResponse::ok_bytes(broken_bytes.clone()));
        ar.insert("/SHA2-256SUMS".into(), MockResponse::ok_bytes(sums));
        ar.insert("/SHA2-256SUMS.sig".into(), MockResponse::ok_bytes(sig));
        let a_srv = MockServer::start(ar).await;

        let mut api_r = HashMap::new();
        api_r.insert(
            "/ytdlp".into(),
            MockResponse::ok_json(
                serde_json::json!({
                    "tag_name": "2026.09.02",
                    "assets": [
                        {"name": "yt-dlp.exe", "browser_download_url": format!("{}/yt-dlp.exe", a_srv.base_url), "size": broken_bytes.len()},
                        {"name": "SHA2-256SUMS", "browser_download_url": format!("{}/SHA2-256SUMS", a_srv.base_url)},
                        {"name": "SHA2-256SUMS.sig", "browser_download_url": format!("{}/SHA2-256SUMS.sig", a_srv.base_url)}
                    ]
                })
                .to_string(),
            ),
        );
        let api_srv = MockServer::start(api_r).await;

        let mut cfg = ToolsManagerConfig::default();
        cfg.ytdlp_release_api_url = format!("{}/ytdlp", api_srv.base_url);
        cfg.ytdlp_pgp_pubkey_asc = pgp.pubkey_asc.clone();
        cfg.ytdlp_pgp_fingerprint_hex = pgp.fingerprint_hex.clone();
        cfg.max_ytdlp_bytes = 1024; // Tight quota triggers rejection!
        let mgr = build_test_manager(data_dir.path(), bundled.path(), cfg);
        let err = mgr.update_tool(ToolId::YtDlp).await.unwrap_err();
        assert!(err.to_string().contains("exceeds maximum allowed limit"));
    }

    // Scenario 24: FFmpeg/FFprobe version mismatch in a signed bundle strictly rejected!
    {
        let data_dir = TempDir::new().unwrap();
        let real_ff = fs::read(bundled_resources_bin().join("ffmpeg.exe")).unwrap();
        let mismatch_fp = fs::read(&f.ffprobe_mismatch).unwrap();
        let bad_zip = create_zip_bundle(&[
            ("bin/ffmpeg.exe", &real_ff, None),
            ("bin/ffprobe.exe", &mismatch_fp, None),
        ]);
        let bad_sha = hex::encode(Sha256::digest(&bad_zip));

        let mut ar = HashMap::new();
        ar.insert("/mismatch.zip".into(), MockResponse::ok_bytes(bad_zip.clone()));
        let a_srv = MockServer::start(ar).await;

        let manifest = SignedToolsManifest {
            schema_version: 1,
            generated_at: Utc::now().to_rfc3339(),
            yt_dlp: None,
            ffmpeg_bundle: Some(SignedManifestToolEntry {
                version: "N-126374-g089a48eb36-20260831".into(),
                url: format!("{}/mismatch.zip", a_srv.base_url),
                sha256: bad_sha,
                size: Some(bad_zip.len() as u64),
                platform: Some("windows".into()),
                architecture: Some("x86_64".into()),
                published_at: None,
            }),
        };
        let mb = serde_json::to_vec(&manifest).unwrap();
        let msig = minisign.sign(&mb);
        let mut api_r = HashMap::new();
        api_r.insert("/manifest.json".into(), MockResponse::ok_bytes(mb));
        api_r.insert("/manifest.json.sig".into(), MockResponse::ok_bytes(msig.into_bytes()));
        let api_srv = MockServer::start(api_r).await;

        let mut cfg = ToolsManagerConfig::default();
        cfg.signed_manifest_url = Some(format!("{}/manifest.json", api_srv.base_url));
        cfg.tori_manifest_pubkey_b64 = minisign.pubkey_b64.clone();
        let mgr = build_test_manager(data_dir.path(), bundled.path(), cfg);
        let err = mgr.update_tool(ToolId::Ffmpeg).await.unwrap_err();
        assert!(
            err.to_string().contains("mismatch"),
            "Expected FFmpeg/FFprobe version mismatch rejection: {}",
            err
        );
    }
}

// ============================================================================
// SCENARIOS 16, 17, 18, 19, 27, 28: Access Denied, Locked Exe, Restart During
// Staging, Power-Loss / Corrupt active-tools.json Recovery, Bundled Fallback
// ============================================================================

#[tokio::test]
async fn test_16_to_19_and_27_28_crash_recovery_locks_and_fallback() {
    let bundled = prepare_old_bundled_dir();

    // Scenario 18 & 19 & 27: Leftover staging files + corrupted active-tools.json with backup recovery
    {
        let data_dir = TempDir::new().unwrap();
        let tools_root = data_dir.path().join("tools");
        let staging_leftover = tools_root.join("staging").join("interrupted_tx");
        fs::create_dir_all(&staging_leftover).unwrap();
        fs::write(staging_leftover.join("yt-dlp.part"), b"partial bytes").unwrap();

        let manifests_dir = tools_root.join("manifests");
        fs::create_dir_all(&manifests_dir).unwrap();
        // Write valid backup manifest AND corrupted truncated active-tools.json (power loss simulation)
        let active_dir = tools_root.join("versions").join("yt-dlp").join("2026.08.19");
        fs::create_dir_all(&active_dir).unwrap();
        let active_bin = active_dir.join("yt-dlp.exe");
        fs::copy(bundled_resources_bin().join("yt-dlp.exe"), &active_bin).unwrap();

        let valid_backup = serde_json::json!({
            "schema_version": 1,
            "yt_dlp_active": {
                "version": "2026.08.19",
                "binary_path": active_bin,
                "sha256": compute_file_sha256(&active_bin).unwrap(),
                "source": "github:yt-dlp/yt-dlp",
                "activated_at": Utc::now().to_rfc3339()
            }
        });
        fs::write(
            manifests_dir.join("active-tools.json.bak"),
            serde_json::to_vec_pretty(&valid_backup).unwrap(),
        )
        .unwrap();
        fs::write(manifests_dir.join("active-tools.json"), b"{corrupted truncated").unwrap();

        let mgr = build_test_manager(data_dir.path(), bundled.path(), ToolsManagerConfig::default());
        // Staging cleaned on startup!
        assert!(!staging_leftover.exists(), "Interrupted staging dir must be cleaned on startup");
        // Backup recovered seamlessly!
        let resolved = mgr.coordinator().resolve_tool(ToolId::YtDlp).unwrap();
        assert_eq!(resolved.source, "managed");
        assert_eq!(resolved.path, active_bin);

        // Scenario 28: Simulate antivirus deleting active managed binary -> bundled fallback activates automatically!
        fs::remove_file(&active_bin).unwrap();
        let resolved_after_av = mgr.coordinator().resolve_tool(ToolId::YtDlp).unwrap();
        assert_eq!(resolved_after_av.source, "bundled");
        assert!(resolved_after_av.path.exists());
    }

    // Scenario 17: Locked executable on Windows (open handle on old binary does NOT break versioned install!)
    {
        let data_dir = TempDir::new().unwrap();
        let _locked_old_handle = File::open(bundled.path().join("yt-dlp.exe")).unwrap();
        let pgp = EphemeralOpenPgpRsaKey::get();
        let real_ytdlp = fs::read(bundled_resources_bin().join("yt-dlp.exe")).unwrap();
        let sha = hex::encode(Sha256::digest(&real_ytdlp));
        let sums = format!("{}  yt-dlp.exe\n", sha).into_bytes();
        let sig = pgp.sign_detached_sha512(&sums);

        let mut ar = HashMap::new();
        ar.insert("/yt-dlp.exe".into(), MockResponse::ok_bytes(real_ytdlp.clone()));
        ar.insert("/SHA2-256SUMS".into(), MockResponse::ok_bytes(sums));
        ar.insert("/SHA2-256SUMS.sig".into(), MockResponse::ok_bytes(sig));
        let a_srv = MockServer::start(ar).await;

        let mut api_r = HashMap::new();
        api_r.insert(
            "/ytdlp".into(),
            MockResponse::ok_json(
                serde_json::json!({
                    "tag_name": "2026.08.19",
                    "assets": [
                        {"name": "yt-dlp.exe", "browser_download_url": format!("{}/yt-dlp.exe", a_srv.base_url), "size": real_ytdlp.len()},
                        {"name": "SHA2-256SUMS", "browser_download_url": format!("{}/SHA2-256SUMS", a_srv.base_url)},
                        {"name": "SHA2-256SUMS.sig", "browser_download_url": format!("{}/SHA2-256SUMS.sig", a_srv.base_url)}
                    ]
                })
                .to_string(),
            ),
        );
        let api_srv = MockServer::start(api_r).await;

        let mut cfg = ToolsManagerConfig::default();
        cfg.ytdlp_release_api_url = format!("{}/ytdlp", api_srv.base_url);
        cfg.ytdlp_pgp_pubkey_asc = pgp.pubkey_asc.clone();
        cfg.ytdlp_pgp_fingerprint_hex = pgp.fingerprint_hex.clone();
        let mgr = build_test_manager(data_dir.path(), bundled.path(), cfg);

        // Because TORI installs into side-by-side versioned directories, an open handle on old exe never causes lock failure!
        let snap = mgr.update_tool(ToolId::YtDlp).await.unwrap();
        assert_eq!(snap.tools[0].installed_version.as_deref(), Some("2026.08.19"));
    }

    // Scenario 16: Access denied / read-only target version file fails cleanly & preserves existing tool
    {
        let data_dir = TempDir::new().unwrap();
        let target_dir = data_dir
            .path()
            .join("tools")
            .join("versions")
            .join("yt-dlp")
            .join("2026.08.19");
        fs::create_dir_all(&target_dir).unwrap();
        // Place a DIRECTORY at the exact path where `yt-dlp.exe` file would be written (causes OS permission/is-dir error)
        fs::create_dir_all(target_dir.join("yt-dlp.exe")).unwrap();

        let pgp = EphemeralOpenPgpRsaKey::get();
        let real_ytdlp = fs::read(bundled_resources_bin().join("yt-dlp.exe")).unwrap();
        let sha = hex::encode(Sha256::digest(&real_ytdlp));
        let sums = format!("{}  yt-dlp.exe\n", sha).into_bytes();
        let sig = pgp.sign_detached_sha512(&sums);

        let mut ar = HashMap::new();
        ar.insert("/yt-dlp.exe".into(), MockResponse::ok_bytes(real_ytdlp.clone()));
        ar.insert("/SHA2-256SUMS".into(), MockResponse::ok_bytes(sums));
        ar.insert("/SHA2-256SUMS.sig".into(), MockResponse::ok_bytes(sig));
        let a_srv = MockServer::start(ar).await;

        let mut api_r = HashMap::new();
        api_r.insert(
            "/ytdlp".into(),
            MockResponse::ok_json(
                serde_json::json!({
                    "tag_name": "2026.08.19",
                    "assets": [
                        {"name": "yt-dlp.exe", "browser_download_url": format!("{}/yt-dlp.exe", a_srv.base_url), "size": real_ytdlp.len()},
                        {"name": "SHA2-256SUMS", "browser_download_url": format!("{}/SHA2-256SUMS", a_srv.base_url)},
                        {"name": "SHA2-256SUMS.sig", "browser_download_url": format!("{}/SHA2-256SUMS.sig", a_srv.base_url)}
                    ]
                })
                .to_string(),
            ),
        );
        let api_srv = MockServer::start(api_r).await;

        let mut cfg = ToolsManagerConfig::default();
        cfg.ytdlp_release_api_url = format!("{}/ytdlp", api_srv.base_url);
        cfg.ytdlp_pgp_pubkey_asc = pgp.pubkey_asc.clone();
        cfg.ytdlp_pgp_fingerprint_hex = pgp.fingerprint_hex.clone();
        let mgr = build_test_manager(data_dir.path(), bundled.path(), cfg);

        assert!(mgr.update_tool(ToolId::YtDlp).await.is_err());
        assert_eq!(mgr.coordinator().resolve_tool(ToolId::YtDlp).unwrap().source, "bundled");
    }
}

// ============================================================================
// SCENARIOS 20, 21, 22, 23: Active FFmpeg & yt-dlp Deferral, Concurrent Update
// Serialization, and Duplicate Scheduled Check Suppression
// ============================================================================

#[tokio::test]
async fn test_20_to_23_active_usage_deferral_and_concurrency_guards() {
    let data_dir = TempDir::new().unwrap();
    let bundled = prepare_old_bundled_dir();
    let pgp = EphemeralOpenPgpRsaKey::get();
    let minisign = EphemeralMinisignKey::generate();

    let real_ytdlp = fs::read(bundled_resources_bin().join("yt-dlp.exe")).unwrap();
    let ytdlp_sha = hex::encode(Sha256::digest(&real_ytdlp));
    let sums = format!("{}  yt-dlp.exe\n", ytdlp_sha).into_bytes();
    let sig = pgp.sign_detached_sha512(&sums);

    let real_ffmpeg_zip = build_real_ffmpeg_zip_bytes();
    let ff_sha = hex::encode(Sha256::digest(&real_ffmpeg_zip));

    let mut ar = HashMap::new();
    ar.insert("/yt-dlp.exe".into(), MockResponse::ok_bytes(real_ytdlp.clone()));
    ar.insert("/SHA2-256SUMS".into(), MockResponse::ok_bytes(sums));
    ar.insert("/SHA2-256SUMS.sig".into(), MockResponse::ok_bytes(sig));
    ar.insert("/ffmpeg.zip".into(), MockResponse::ok_bytes(real_ffmpeg_zip.clone()));
    let a_srv = MockServer::start(ar).await;

    let manifest = SignedToolsManifest {
        schema_version: 1,
        generated_at: Utc::now().to_rfc3339(),
        yt_dlp: None,
        ffmpeg_bundle: Some(SignedManifestToolEntry {
            version: "N-126374-g089a48eb36-20260831".into(),
            url: format!("{}/ffmpeg.zip", a_srv.base_url),
            sha256: ff_sha,
            size: Some(real_ffmpeg_zip.len() as u64),
            platform: Some("windows".into()),
            architecture: Some("x86_64".into()),
            published_at: None,
        }),
    };
    let mb = serde_json::to_vec(&manifest).unwrap();
    let msig = minisign.sign(&mb);

    let mut ytdlp_api_resp = MockResponse::ok_json(
        serde_json::json!({
            "tag_name": "2026.08.19",
            "assets": [
                {"name": "yt-dlp.exe", "browser_download_url": format!("{}/yt-dlp.exe", a_srv.base_url), "size": real_ytdlp.len()},
                {"name": "SHA2-256SUMS", "browser_download_url": format!("{}/SHA2-256SUMS", a_srv.base_url)},
                {"name": "SHA2-256SUMS.sig", "browser_download_url": format!("{}/SHA2-256SUMS.sig", a_srv.base_url)}
            ]
        })
        .to_string(),
    );
    ytdlp_api_resp.delay_ms = 120;

    let mut api_r = HashMap::new();
    api_r.insert("/ytdlp".into(), ytdlp_api_resp);
    api_r.insert("/manifest.json".into(), MockResponse::ok_bytes(mb));
    api_r.insert("/manifest.json.sig".into(), MockResponse::ok_bytes(msig.into_bytes()));
    let api_srv = MockServer::start(api_r).await;

    let mut cfg = ToolsManagerConfig::default();
    cfg.ytdlp_release_api_url = format!("{}/ytdlp", api_srv.base_url);
    cfg.signed_manifest_url = Some(format!("{}/manifest.json", api_srv.base_url));
    cfg.tori_manifest_pubkey_b64 = minisign.pubkey_b64.clone();
    cfg.ytdlp_pgp_pubkey_asc = pgp.pubkey_asc.clone();
    cfg.ytdlp_pgp_fingerprint_hex = pgp.fingerprint_hex.clone();
    let mgr = build_test_manager(data_dir.path(), bundled.path(), cfg);

    // Scenario 23: Duplicate overlapping scheduled checks -> second call deduplicated!
    let hits_before = api_srv.hits.load(Ordering::SeqCst);
    let (c1, c2) = tokio::join!(mgr.check_for_updates(true), mgr.check_for_updates(true));
    assert!(c1.is_ok() && c2.is_ok());
    let hits_delta = api_srv.hits.load(Ordering::SeqCst) - hits_before;
    // Only ONE set of API requests (manifest + sig + ytdlp = 3 hits), NOT 6!
    assert!(
        hits_delta <= 4,
        "Overlapping checks must be deduplicated (got {} hits)",
        hits_delta
    );

    // Scenario 20 & 21: Acquire active tool leases simulating live yt-dlp extraction & FFmpeg muxing!
    let yt_lease = mgr.coordinator().acquire_lease(ToolId::YtDlp).unwrap();
    let ff_lease = mgr.coordinator().acquire_lease(ToolId::Ffmpeg).unwrap();
    assert_eq!(mgr.coordinator().active_leases(ToolId::YtDlp), 1);
    assert_eq!(mgr.coordinator().active_leases(ToolId::Ffmpeg), 1);

    // Scenario 22: Concurrent manual updates while tools are active -> safely serialized and DEFERRED!
    let (u1, u2, u3) = tokio::join!(
        mgr.update_tool(ToolId::YtDlp),
        mgr.update_tool(ToolId::Ffmpeg),
        mgr.update_tool(ToolId::Ffprobe)
    );
    assert!(u1.is_ok() && u2.is_ok() && u3.is_ok());

    let deferred_snap = mgr.get_status_snapshot().unwrap();
    assert_eq!(
        deferred_snap.tools[0].update_status,
        ToolUpdateStatus::PendingActivation
    );
    assert_eq!(
        deferred_snap.tools[1].update_status,
        ToolUpdateStatus::PendingActivation
    );
    assert_eq!(
        deferred_snap.tools[2].update_status,
        ToolUpdateStatus::PendingActivation
    );
    // Active paths MUST remain the old bundled versions while leases are held!
    assert_eq!(mgr.coordinator().resolve_tool(ToolId::YtDlp).unwrap().source, "bundled");
    assert_eq!(mgr.coordinator().resolve_tool(ToolId::Ffmpeg).unwrap().source, "bundled");

    // Release active leases (simulating download/mux completion) -> pending updates activate automatically!
    drop(yt_lease);
    drop(ff_lease);
    let activated = mgr.try_activate_pending_updates().await.unwrap();
    assert!(activated, "Pending updates must activate automatically once leases drop to 0");

    let final_snap = mgr.get_status_snapshot().unwrap();
    assert_eq!(final_snap.tools[0].installed_version.as_deref(), Some("2026.08.19"));
    assert_eq!(final_snap.tools[0].update_status, ToolUpdateStatus::Updated);
    assert_eq!(
        final_snap.tools[1].installed_version.as_deref(),
        Some("N-126374-g089a48eb36-20260831")
    );
    assert_eq!(final_snap.tools[1].update_status, ToolUpdateStatus::Updated);
    assert_eq!(final_snap.tools[2].update_status, ToolUpdateStatus::Updated);
}

// ============================================================================
// SCENARIOS 25 & 26: Automatic Rollback After Failed Activation + Quarantined
// Broken Version Skipped on Subsequent Auto Checks
// ============================================================================

#[tokio::test]
async fn test_25_and_26_auto_rollback_and_quarantined_broken_version_skip() {
    let data_dir = TempDir::new().unwrap();
    let bundled = prepare_old_bundled_dir();
    let pgp = EphemeralOpenPgpRsaKey::get();

    let real_ytdlp = fs::read(bundled_resources_bin().join("yt-dlp.exe")).unwrap();
    let sha = hex::encode(Sha256::digest(&real_ytdlp));
    let sums = format!("{}  yt-dlp.exe\n", sha).into_bytes();
    let sig = pgp.sign_detached_sha512(&sums);

    let mut ar = HashMap::new();
    ar.insert("/yt-dlp.exe".into(), MockResponse::ok_bytes(real_ytdlp.clone()));
    ar.insert("/SHA2-256SUMS".into(), MockResponse::ok_bytes(sums));
    ar.insert("/SHA2-256SUMS.sig".into(), MockResponse::ok_bytes(sig));
    let a_srv = MockServer::start(ar).await;

    let mut api_r = HashMap::new();
    api_r.insert(
        "/ytdlp".into(),
        MockResponse::ok_json(
            serde_json::json!({
                "tag_name": "2026.08.19",
                "assets": [
                    {"name": "yt-dlp.exe", "browser_download_url": format!("{}/yt-dlp.exe", a_srv.base_url), "size": real_ytdlp.len()},
                    {"name": "SHA2-256SUMS", "browser_download_url": format!("{}/SHA2-256SUMS", a_srv.base_url)},
                    {"name": "SHA2-256SUMS.sig", "browser_download_url": format!("{}/SHA2-256SUMS.sig", a_srv.base_url)}
                ]
            })
            .to_string(),
        ),
    );
    let api_srv = MockServer::start(api_r).await;

    let mut cfg = ToolsManagerConfig::default();
    cfg.ytdlp_release_api_url = format!("{}/ytdlp", api_srv.base_url);
    cfg.ffmpeg_release_api_url = format!("{}/404", api_srv.base_url);
    cfg.ytdlp_pgp_pubkey_asc = pgp.pubkey_asc.clone();
    cfg.ytdlp_pgp_fingerprint_hex = pgp.fingerprint_hex.clone();
    let mgr = build_test_manager(data_dir.path(), bundled.path(), cfg);

    // Arm simulated post-switch health failure -> must auto-rollback and quarantine "2026.08.19"!
    mgr.arm_simulated_post_switch_failure();
    let res = mgr.update_tool(ToolId::YtDlp).await;
    assert!(res.is_err());

    let after_rb = mgr.get_status_snapshot().unwrap();
    let yt = &after_rb.tools[0];
    assert_eq!(yt.update_status, ToolUpdateStatus::RolledBack);
    assert_eq!(yt.installed_version.as_deref(), Some("2025.01.01"));
    assert!(yt.failed_versions.contains(&"2026.08.19".to_string()));
    assert_eq!(mgr.coordinator().resolve_tool(ToolId::YtDlp).unwrap().source, "bundled");

    // Scenario 26: Next automatic check (manual=false) MUST NOT reinstall quarantined "2026.08.19"!
    let dl_hits_before = a_srv.hits.load(Ordering::SeqCst);
    let after_auto = mgr.check_for_updates(false).await.unwrap();
    assert_eq!(
        after_auto.tools[0].installed_version.as_deref(),
        Some("2025.01.01"),
        "Quarantined broken version must not auto-reinstall"
    );
    // Download endpoint `/yt-dlp.exe` was NOT re-fetched (only SUMS/sig during discovery)
    let dl_hits_after = a_srv.hits.load(Ordering::SeqCst);
    assert!(dl_hits_after - dl_hits_before <= 2);

    // Manual retry clears quarantine and installs cleanly!
    let after_manual = mgr.update_tool(ToolId::YtDlp).await.unwrap();
    assert_eq!(
        after_manual.tools[0].installed_version.as_deref(),
        Some("2026.08.19")
    );
    assert_eq!(after_manual.tools[0].update_status, ToolUpdateStatus::Updated);
}

// ============================================================================
// SCENARIOS 29 & 30 + SECURITY: Daily 24h UTC Schedule, Clock Skew,
// Disabled Auto-Update Policy, Allowlist & Pinned Production Keys
// ============================================================================

#[tokio::test]
async fn test_29_and_30_scheduling_policy_and_security_boundaries() {
    let data_dir = TempDir::new().unwrap();
    let bundled = prepare_old_bundled_dir();
    let mgr = build_test_manager(data_dir.path(), bundled.path(), ToolsManagerConfig::default());

    let now = Utc::now();
    // Fresh install has no last_successful_check_at -> immediately due on startup!
    assert!(mgr.is_scheduled_check_due(now));

    // Persist a recent successful check 2 hours ago -> NOT due yet under 24h default
    let db = Database::open(data_dir.path().join("tdm_storage.sqlite")).unwrap();
    let mut sched = tdm_core::tools::store::load_scheduler_state(&db);
    sched.last_successful_check_at = Some(now - ChronoDuration::hours(2));
    tdm_core::tools::store::save_scheduler_state(&db, &sched).unwrap();
    assert!(!mgr.is_scheduled_check_due(now));

    // Advance 24h + 1m -> due!
    assert!(mgr.is_scheduled_check_due(now + ChronoDuration::hours(23)));

    // Clock skew protection: if persisted timestamp is 2 hours in the future, reset to due
    sched.last_successful_check_at = Some(now + ChronoDuration::hours(2));
    tdm_core::tools::store::save_scheduler_state(&db, &sched).unwrap();
    assert!(mgr.is_scheduled_check_due(now));

    // 7-day cadence check
    let mut s7 = ExternalToolsSettings::default();
    s7.check_interval_hours = 168;
    mgr.save_settings(&s7).unwrap();
    sched.last_successful_check_at = Some(now - ChronoDuration::hours(48));
    tdm_core::tools::store::save_scheduler_state(&db, &sched).unwrap();
    assert!(!mgr.is_scheduled_check_due(now));
    assert!(mgr.is_scheduled_check_due(now + ChronoDuration::days(6)));

    // Scenario 30: Disabling auto-update stops background checks cleanly
    let mut disabled = ExternalToolsSettings::default();
    disabled.auto_update = false;
    mgr.save_settings(&disabled).unwrap();
    assert!(!mgr.is_scheduled_check_due(now + ChronoDuration::days(30)));

    // Manual-only interval also stops background checks cleanly
    let mut manual_only = ExternalToolsSettings::default();
    manual_only.auto_update = true;
    manual_only.check_interval_hours = 0;
    mgr.save_settings(&manual_only).unwrap();
    assert!(!mgr.is_scheduled_check_due(now + ChronoDuration::days(30)));

    // Security boundary assertions: ToolId allowlist, URL allowlist, pinned production keys
    assert!("../../cmd.exe".parse::<ToolId>().is_err());
    assert!("https://evil.com/yt-dlp.exe".parse::<ToolId>().is_err());
    assert!(validate_trusted_url("http://github.com/yt-dlp/yt-dlp", false).is_err());
    assert!(validate_trusted_url("https://untrusted-mirror.org/yt-dlp.exe", false).is_err());
    assert!(validate_trusted_url("https://user:pass@github.com/a", false).is_err());
    assert!(parse_and_pin_openpgp_rsa_pubkey(YTDLP_PGP_PUBKEY_ASC, YTDLP_PGP_FINGERPRINT_HEX).is_ok());
    assert_eq!(
        compare_tool_versions(ToolId::YtDlp, "2026.10.26", "2026.08.19"),
        VersionComparison::Older
    );
}
