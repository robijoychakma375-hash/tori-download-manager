//! Gate 35.1 — Post-Release Security Hardening & Reliability Regression Tests
//!
//! Deterministically verifies every bounded security and reliability fix introduced in Gate 35.1
//! with zero network dependencies and zero production user-data mutation.

use base64::Engine as _;
use chrono::{Duration as ChronoDuration, Utc};
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use std::collections::HashMap;
use std::sync::Arc;
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use tdm_core::dash::parser::{
    format_segment_template, parse_mpd_manifest, parse_range_spec, resolve_representation_segments,
};
use tdm_core::hls::{parse_playlist, ParsedPlaylist};
use tdm_core::live::recorder::record_live_stream;
use tdm_core::resolver::{
    build_format_selector, escape_ytdlp_output_template, extract_html_media_candidates,
    parse_ytdlp_playlist_metadata, ssrf_safe_redirect_policy, validate_format_id,
    validate_http_url_syntax,
};
use tdm_core::tools::activation::{ActiveToolsManifest, ManagedBinarySlot, ManagedFfmpegBundleSlot};
use tdm_core::tools::providers::fetch_signed_tools_manifest;
use tdm_core::tools::{
    extract_minisign_key_id_hex, ExternalToolsManager, ManifestAntiReplayState,
    ManifestFetchOutcome, SignedManifestToolEntry, SignedToolsManifest, SigningKeyPurpose, ToolId,
    ToolsManagerConfig, TrustedKeyStatus, TrustedSigningKey, TrustedToolsKeyring,
};
use tdm_core::{
    sanitize_filename, Database, DownloadJob, DownloadManager, EventBus, JobState, JobType,
    Priority,
};
use tokio_util::sync::CancellationToken;

struct TestKey {
    keypair: Ed25519KeyPair,
    key_id_bytes: [u8; 8],
    key_id_hex: String,
    pubkey_b64: String,
}

impl TestKey {
    fn generate(seed: u8) -> Self {
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let keypair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let key_id_bytes = [seed, 0x35, 0x11, 0x22, 0x33, 0x44, 0x55, seed.wrapping_add(7)];
        let key_id_hex = format!("{:016X}", u64::from_le_bytes(key_id_bytes));
        let mut pk_raw = Vec::with_capacity(42);
        pk_raw.extend_from_slice(b"Ed");
        pk_raw.extend_from_slice(&key_id_bytes);
        pk_raw.extend_from_slice(keypair.public_key().as_ref());
        let pk_line = base64::engine::general_purpose::STANDARD.encode(&pk_raw);
        let pk_box = format!(
            "untrusted comment: minisign public key: {}\n{}\n",
            key_id_hex, pk_line
        );
        let pubkey_b64 = base64::engine::general_purpose::STANDARD.encode(pk_box.as_bytes());
        assert_eq!(
            extract_minisign_key_id_hex(&pubkey_b64).as_deref(),
            Some(key_id_hex.as_str())
        );
        Self {
            keypair,
            key_id_bytes,
            key_id_hex,
            pubkey_b64,
        }
    }

    fn sign_b64(&self, payload: &[u8]) -> String {
        let sig = self.keypair.sign(payload);
        let mut sig_raw = Vec::with_capacity(74);
        sig_raw.extend_from_slice(b"Ed");
        sig_raw.extend_from_slice(&self.key_id_bytes);
        sig_raw.extend_from_slice(sig.as_ref());
        let sig_line = base64::engine::general_purpose::STANDARD.encode(&sig_raw);
        let trusted_comment = format!(
            "timestamp:{}\tfile:tools-manifest.json",
            Utc::now().timestamp()
        );
        let mut global_msg = Vec::with_capacity(64 + trusted_comment.len());
        global_msg.extend_from_slice(sig.as_ref());
        global_msg.extend_from_slice(trusted_comment.as_bytes());
        let global_sig = self.keypair.sign(&global_msg);
        let global_line = base64::engine::general_purpose::STANDARD.encode(global_sig.as_ref());
        let sig_box = format!(
            "untrusted comment: gate35 test sig\n{}\ntrusted comment: {}\n{}\n",
            sig_line, trusted_comment, global_line
        );
        base64::engine::general_purpose::STANDARD.encode(sig_box.as_bytes())
    }
}

async fn start_mock_http(routes: Arc<Mutex<HashMap<String, (u16, String, Vec<u8>)>>>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let routes = routes.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                if n == 0 {
                    return;
                }
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .unwrap_or("/")
                    .split('?')
                    .next()
                    .unwrap_or("/");
                let (status, ct, body) = routes.lock().await.get(path).cloned().unwrap_or((
                    404,
                    "text/plain".to_string(),
                    b"not found".to_vec(),
                ));
                let header = format!(
                    "HTTP/1.1 {} OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    status,
                    ct,
                    body.len()
                );
                let _ = stream.write_all(header.as_bytes()).await;
                let _ = stream.write_all(&body).await;
                let _ = stream.shutdown().await;
            });
        }
    });
    port
}

#[test]
fn test_sec35_02_url_and_format_cli_flag_injection_rejected() {
    // Leading '-' CLI option injection must always be rejected
    assert!(validate_http_url_syntax("--exec=calc.exe").is_err());
    assert!(validate_http_url_syntax("-o /tmp/pwn").is_err());
    assert!(validate_http_url_syntax("file:///C:/Windows/win.ini").is_err());
    assert!(validate_http_url_syntax("javascript:alert(1)").is_err());
    assert!(validate_http_url_syntax("https://example.com/a\nb").is_err());
    assert!(validate_http_url_syntax("https://example.com/a b").is_err());
    assert!(validate_http_url_syntax("").is_err());

    // Valid HTTP/HTTPS URLs succeed
    assert!(validate_http_url_syntax("https://www.youtube.com/watch?v=dQw4w9WgXcQ").is_ok());
    assert!(validate_http_url_syntax("http://127.0.0.1:8080/video.mp4").is_ok());

    // yt-dlp output template `%` escaping
    assert_eq!(
        escape_ytdlp_output_template(r"C:\Downloads\100% %(title)s.mp4"),
        r"C:\Downloads\100%% %%(title)s.mp4"
    );

    // Format selector flag injection rejection
    assert!(validate_format_id("--exec=calc").is_err());
    assert!(validate_format_id("-f").is_err());
    assert!(validate_format_id("18\n--exec").is_err());
    assert_eq!(build_format_selector("--exec=calc"), None);
    assert_eq!(build_format_selector("format:--exec=calc"), None);
    assert_eq!(build_format_selector("18").as_deref(), Some("18+bestaudio/18"));
}

#[test]
fn test_sec35_02_playlist_metadata_filters_malicious_entry_urls() {
    let payload = serde_json::json!({
        "title": "Test Playlist",
        "entries": [
            { "id": "abc12345", "title": "Good", "url": "https://www.youtube.com/watch?v=abc12345" },
            { "id": "", "title": "Flag Injection", "url": "--exec=calc.exe" },
            { "id": "", "title": "Local File", "url": "file:///C:/Windows/win.ini" }
        ]
    });
    let parsed =
        parse_ytdlp_playlist_metadata("https://www.youtube.com/playlist?list=PL1", &payload)
            .expect("valid playlist JSON");
    assert_eq!(parsed.items.len(), 1);
    assert_eq!(parsed.items[0].url, "https://www.youtube.com/watch?v=abc12345");
}

#[tokio::test]
async fn test_sec35_02_and_07_managed_media_download_rejects_bad_url_format_and_unc() {
    let dir = TempDir::new().unwrap();
    let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
    let mgr = DownloadManager::new(db, EventBus::default()).unwrap();

    // Flag-prefixed URL rejected
    assert!(mgr
        .create_managed_media_download_with_all_options_scheduled_and_start(
            "--exec=calc.exe",
            "best",
            "out.mp4",
            dir.path(),
            Priority::Normal,
            None,
            None,
            None,
            None,
            false,
        )
        .await
        .is_err());

    // file:// URL rejected
    assert!(mgr
        .create_managed_media_download_with_all_options_scheduled_and_start(
            "file:///C:/Windows/win.ini",
            "best",
            "out.mp4",
            dir.path(),
            Priority::Normal,
            None,
            None,
            None,
            None,
            false,
        )
        .await
        .is_err());

    // Flag-prefixed format_id rejected
    assert!(mgr
        .create_managed_media_download_with_all_options_scheduled_and_start(
            "https://example.com/watch?v=1",
            "--exec=calc",
            "out.mp4",
            dir.path(),
            Priority::Normal,
            None,
            None,
            None,
            None,
            false,
        )
        .await
        .is_err());

    // UNC & device destination paths rejected
    assert!(DownloadManager::validate_destination_path(r"\\attacker\share\dir").is_err());
    assert!(DownloadManager::validate_destination_path("//attacker/share/dir").is_err());
    assert!(DownloadManager::validate_destination_path(r"\\.\PhysicalDrive0").is_err());
    assert!(DownloadManager::validate_destination_path(r"\\?\C:\Windows").is_err());
    assert!(DownloadManager::validate_destination_path(r"C:\Downloads\..\Windows").is_err());
    assert!(DownloadManager::validate_destination_path("C:\\Downloads\0evil").is_err());
    assert!(DownloadManager::validate_destination_path(dir.path().to_str().unwrap()).is_ok());
}

#[tokio::test]
async fn test_sec35_03_default_transition_config_has_dual_key_keyring_and_accepts_dedicated_primary()
{
    // Verify production default config resolves BOTH legacy shared + dedicated key
    let default_cfg = ToolsManagerConfig::default();
    let default_kr = default_cfg.effective_tools_keyring();
    assert_eq!(
        default_kr.keys.len(),
        2,
        "Default Stage 1 transition keyring must contain legacy + dedicated keys"
    );
    assert!(default_kr
        .keys
        .iter()
        .any(|k| k.key_id == "CDC23D8CC8DA5397"
            && k.purpose == SigningKeyPurpose::ExternalToolsLegacyShared));
    assert!(default_kr
        .keys
        .iter()
        .any(|k| k.key_id == "C3FD6626A3718E63"
            && k.purpose == SigningKeyPurpose::ExternalToolsManifest));

    // Verify fetch_signed_tools_manifest accepts a primary `.sig` signed by the dedicated key
    // even when expected_manifest_key_id still names the legacy key (multi-key transition keyring).
    let legacy_key = TestKey::generate(0x11);
    let dedicated_key = TestKey::generate(0x22);
    let keyring = TrustedToolsKeyring {
        keyring_version: 1,
        keys: vec![
            TrustedSigningKey {
                key_id: legacy_key.key_id_hex.clone(),
                pubkey_b64: legacy_key.pubkey_b64.clone(),
                purpose: SigningKeyPurpose::ExternalToolsLegacyShared,
                status: TrustedKeyStatus::TransitionLegacy,
                label: "Test Legacy".to_string(),
                valid_from: None,
                retired_after: None,
            },
            TrustedSigningKey {
                key_id: dedicated_key.key_id_hex.clone(),
                pubkey_b64: dedicated_key.pubkey_b64.clone(),
                purpose: SigningKeyPurpose::ExternalToolsManifest,
                status: TrustedKeyStatus::Active,
                label: "Test Dedicated".to_string(),
                valid_from: None,
                retired_after: None,
            },
        ],
        revoked_key_ids: vec![],
        allow_legacy_shared_key: true,
    };

    let now = Utc::now();
    let manifest = SignedToolsManifest {
        schema_version: 2,
        manifest_revision: 3,
        generated_at: now.to_rfc3339(),
        published_at: Some(now.to_rfc3339()),
        expires_at: Some((now + ChronoDuration::days(30)).to_rfc3339()),
        signing_key_id: Some(dedicated_key.key_id_hex.clone()),
        dedicated_signing_key_id: None,
        key_purpose: Some("external_tools_manifest".to_string()),
        yt_dlp: Some(SignedManifestToolEntry {
            tool_id: Some("yt-dlp".to_string()),
            version: "2026.11.25".to_string(),
            ffmpeg_version: None,
            ffprobe_version: None,
            bundle_id: Some("yt-dlp".to_string()),
            url: "https://github.com/yt-dlp/yt-dlp/releases/download/2026.11.25/yt-dlp.exe"
                .to_string(),
            sha256: "a".repeat(64),
            size: Some(1024),
            artifact_format: Some("exe".to_string()),
            platform: Some("windows".to_string()),
            architecture: Some("x64".to_string()),
            min_tori_version: Some("1.0.8".to_string()),
            max_tori_version: None,
            published_at: Some(now.to_rfc3339()),
            allow_rollback_to: false,
            provenance: None,
        }),
        ffmpeg_bundle: None,
    };
    let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
    let sig_b64 = dedicated_key.sign_b64(&manifest_bytes);

    let routes = Arc::new(Mutex::new(HashMap::new()));
    routes.lock().await.insert(
        "/tools-manifest.json".to_string(),
        (200, "application/json".to_string(), manifest_bytes),
    );
    routes.lock().await.insert(
        "/tools-manifest.json.sig".to_string(),
        (200, "text/plain".to_string(), sig_b64.into_bytes()),
    );
    let port = start_mock_http(routes).await;

    let cfg = ToolsManagerConfig {
        allow_loopback_http: true,
        signed_manifest_url: Some(format!("http://127.0.0.1:{}/tools-manifest.json", port)),
        tools_keyring: Some(keyring),
        expected_manifest_key_id: Some(legacy_key.key_id_hex.clone()),
        ..Default::default()
    };

    let outcome = fetch_signed_tools_manifest(&cfg, &ManifestAntiReplayState::default(), now).await;
    match outcome {
        ManifestFetchOutcome::Available(valid) => {
            assert_eq!(
                valid.verified_key_id.as_deref(),
                Some(dedicated_key.key_id_hex.as_str())
            );
            assert_eq!(
                valid.verified_key_purpose,
                Some(SigningKeyPurpose::ExternalToolsManifest)
            );
        }
        other => panic!(
            "Expected dedicated key primary .sig acceptance, got {:?}",
            other
        ),
    }
}

#[tokio::test]
async fn test_sec35_05_schema_v1_downgrade_rejected_after_revision_accepted() {
    let key = TestKey::generate(0x33);
    let now = Utc::now();

    // Validly signed Schema v1 manifest with manifest_revision = 0 and no expires_at
    let v1_manifest = SignedToolsManifest {
        schema_version: 1,
        manifest_revision: 0,
        generated_at: now.to_rfc3339(),
        published_at: None,
        expires_at: None,
        signing_key_id: Some(key.key_id_hex.clone()),
        dedicated_signing_key_id: None,
        key_purpose: Some("external_tools_manifest".to_string()),
        yt_dlp: None,
        ffmpeg_bundle: None,
    };
    let manifest_bytes = serde_json::to_vec(&v1_manifest).unwrap();
    let sig_b64 = key.sign_b64(&manifest_bytes);

    let routes = Arc::new(Mutex::new(HashMap::new()));
    routes.lock().await.insert(
        "/tools-manifest.json".to_string(),
        (200, "application/json".to_string(), manifest_bytes),
    );
    routes.lock().await.insert(
        "/tools-manifest.json.sig".to_string(),
        (200, "text/plain".to_string(), sig_b64.into_bytes()),
    );
    let port = start_mock_http(routes).await;

    let cfg = ToolsManagerConfig {
        allow_loopback_http: true,
        signed_manifest_url: Some(format!("http://127.0.0.1:{}/tools-manifest.json", port)),
        tori_manifest_pubkey_b64: key.pubkey_b64.clone(),
        expected_manifest_key_id: Some(key.key_id_hex.clone()),
        tools_keyring: None,
        ..Default::default()
    };

    let prior = ManifestAntiReplayState {
        highest_accepted_revision: 2,
        last_accepted_manifest_sha256: Some("b".repeat(64)),
        ..Default::default()
    };

    let outcome = fetch_signed_tools_manifest(&cfg, &prior, now).await;
    match outcome {
        ManifestFetchOutcome::RejectedSecurity(reason) => {
            assert!(
                reason.to_lowercase().contains("downgrade"),
                "Expected schema downgrade rejection, got: {}",
                reason
            );
        }
        other => panic!(
            "Expected RejectedSecurity on schema v1 downgrade, got {:?}",
            other
        ),
    }
}

#[test]
fn test_sec35_12_dash_hls_and_html_parser_hardening() {
    // 1. DASH format width cap prevents OOM
    let expanded =
        format_segment_template("seg_$Number%0999999999d$.m4s", "v1", Some(1), None, None);
    assert!(
        expanded.len() <= 64,
        "Width cap failed: len={}",
        expanded.len()
    );

    // 2. Inverted DASH byte range rejected
    assert_eq!(parse_range_spec("500-100"), None);
    assert_eq!(parse_range_spec("100-500"), Some((100, 500)));

    // 3. DASH SegmentTimeline OOM bomb rejected cleanly
    let bomb_mpd = r#"<?xml version="1.0" encoding="UTF-8"?>
<MPD type="static" mediaPresentationDuration="PT10S">
  <Period duration="PT10S">
    <AdaptationSet mimeType="video/mp4">
      <Representation id="1" bandwidth="1000000">
        <SegmentTemplate timescale="1" media="seg_$Number$.m4s" startNumber="1">
          <SegmentTimeline>
            <S t="0" d="1" r="999999999"/>
          </SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>"#;
    let mpd = parse_mpd_manifest(bomb_mpd, "https://cdn.example.com/manifest.mpd").unwrap();
    let rep = &mpd.periods[0].adaptation_sets[0].representations[0];
    assert!(resolve_representation_segments(
        &mpd,
        &mpd.periods[0],
        &mpd.periods[0].adaptation_sets[0],
        rep,
        "video"
    )
    .is_err());

    // 4. HLS zero-length byte range rejected (no underflow)
    let hls_zero = "#EXTM3U\n#EXT-X-VERSION:4\n#EXTINF:4.0,\n#EXT-X-BYTERANGE:0@100\nseg0.ts\n#EXT-X-ENDLIST\n";
    let parsed_hls = parse_playlist(hls_zero, "https://cdn.example.com/index.m3u8").unwrap();
    match parsed_hls {
        ParsedPlaylist::Media(media) => {
            assert_eq!(media.segments.len(), 1);
            assert_eq!(media.segments[0].byterange, None);
        }
        other => panic!("Expected Media playlist, got {:?}", other),
    }

    // 5. HTML scraper must never panic on non-ASCII case expansion like Turkish `İ` (U+0130)
    let turkish_html = "<html><head><title>İstanbul İİİİİ</title><meta property=\"og:title\" content=\"İzmir Video\"/></head><body><video src=\"https://cdn.example.com/clip.mp4\"></video></body></html>";
    let scraped = extract_html_media_candidates(turkish_html, "https://example.com/page");
    assert_eq!(scraped.title.as_deref(), Some("İzmir Video"));
    assert_eq!(scraped.media_urls.len(), 1);
}

#[tokio::test]
async fn test_sec35_14_live_recorder_rejects_local_file_and_concat_schemes() {
    let dir = TempDir::new().unwrap();
    let db = Database::open(&dir.path().join("live.sqlite")).unwrap();
    let bus = EventBus::default();
    let cancel = CancellationToken::new();
    let stop = CancellationToken::new();

    for bad_url in [
        "file:///C:/Windows/win.ini",
        "concat:a.ts|b.ts",
        "-f lavfi",
        "subfile,,start,0,end,100,,:secret.txt",
    ] {
        let now = Utc::now();
        let job = DownloadJob {
            id: uuid::Uuid::new_v4().to_string(),
            url: bad_url.to_string(),
            resolved_url: None,
            filename: "live.mp4".to_string(),
            target_path: dir.path().join("live.mp4").to_string_lossy().to_string(),
            temp_path: dir
                .path()
                .join("live.mp4.part")
                .to_string_lossy()
                .to_string(),
            total_bytes: None,
            downloaded_bytes: 0,
            state: JobState::Downloading,
            job_type: JobType::LiveStream,
            priority: Priority::Normal,
            etag: None,
            last_modified: None,
            is_resumable: false,
            chunk_count: 1,
            error_message: None,
            created_at: now,
            updated_at: now,
            thumbnail_url: None,
            referer: None,
            user_agent: None,
            scheduled_at: None,
        };
        let res = record_live_stream(&job, &db, &bus, &cancel, &stop, None).await;
        assert!(
            res.is_err(),
            "Live recorder must reject scheme '{}'",
            bad_url
        );
    }
}

#[test]
fn test_sec35_15_bidi_filename_sanitization_and_manager_clamping() {
    // Unicode RLO BiDi spoofing characters stripped
    let spoofed = "invoice_\u{202E}fdp.exe";
    let clean = sanitize_filename(spoofed);
    assert!(!clean.contains('\u{202E}'));
    assert_eq!(clean, "invoice_fdp.exe");

    // DEL control character sanitized & trailing space before dot in reserved Windows device name caught
    assert_eq!(sanitize_filename("CON .txt"), "_CON .txt");
    assert_eq!(sanitize_filename("bad\x7fname.mp4"), "bad_name.mp4");

    // Clamping on DownloadManager setters
    let dir = TempDir::new().unwrap();
    let db = Database::open(&dir.path().join("clamp.sqlite")).unwrap();
    let mgr = DownloadManager::new(db, EventBus::default()).unwrap();
    mgr.set_max_active_jobs(0);
    assert_eq!(mgr.max_active_jobs(), 1);
    mgr.set_max_active_jobs(999);
    assert_eq!(mgr.max_active_jobs(), 16);
    mgr.set_max_retries(999);
    assert_eq!(mgr.max_retries(), 20);
}

#[tokio::test]
async fn test_sec35_16_ssrf_redirect_policy_blocks_loopback_redirect() {
    // Ensure TORI_ALLOW_LOOPBACK is not set in this test process
    let prev = std::env::var("TORI_ALLOW_LOOPBACK").ok();
    std::env::remove_var("TORI_ALLOW_LOOPBACK");

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        if let Ok((mut stream, _)) = listener.accept().await {
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf).await;
            let resp = "HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/latest/meta-data/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            let _ = stream.write_all(resp.as_bytes()).await;
            let _ = stream.shutdown().await;
        }
    });

    let client = reqwest::Client::builder()
        .redirect(ssrf_safe_redirect_policy())
        .build()
        .unwrap();
    let res = client
        .get(format!("http://127.0.0.1:{}/redirect", port))
        .send()
        .await;
    assert!(
        res.is_err(),
        "SSRF redirect policy must reject redirect to 169.254.169.254"
    );

    if let Some(v) = prev {
        std::env::set_var("TORI_ALLOW_LOOPBACK", v);
    }
}

#[tokio::test]
async fn test_sec35_10_tools_pending_rollback_preserves_other_bundle_and_clears_pending() {
    let dir = TempDir::new().unwrap();
    let data_dir = dir.path().join("data");
    let bundled_dir = dir.path().join("bundled");
    std::fs::create_dir_all(&data_dir).unwrap();
    std::fs::create_dir_all(&bundled_dir).unwrap();

    let db = Database::open(&data_dir.join("tdm_storage.sqlite")).unwrap();
    let cfg = ToolsManagerConfig {
        bundled_override_dir: Some(bundled_dir),
        register_globally: false,
        ..Default::default()
    };
    let mgr = ExternalToolsManager::with_config(db, data_dir.clone(), cfg).unwrap();

    // Seed active-tools.json with an active FFmpeg bundle + a broken pending yt-dlp slot
    let fake_ffmpeg = data_dir.join("fake_ffmpeg.exe");
    let fake_ffprobe = data_dir.join("fake_ffprobe.exe");
    let fake_pending_yt = data_dir.join("broken_ytdlp.exe");
    std::fs::write(&fake_ffmpeg, b"MZ-ffmpeg").unwrap();
    std::fs::write(&fake_ffprobe, b"MZ-ffprobe").unwrap();
    std::fs::write(&fake_pending_yt, b"not-a-valid-binary").unwrap();

    let manifest_path = data_dir
        .join("tools")
        .join("manifests")
        .join("active-tools.json");
    let now = Utc::now();
    let seeded = ActiveToolsManifest {
        schema_version: 1,
        updated_at: Some(now),
        yt_dlp_active: None,
        yt_dlp_rollback: None,
        yt_dlp_pending: Some(ManagedBinarySlot {
            version: "2026.99.99-broken".to_string(),
            binary_path: fake_pending_yt,
            sha256: Some("c".repeat(64)),
            source: "tori_signed_manifest".to_string(),
            activated_at: now,
        }),
        ffmpeg_bundle_active: Some(ManagedFfmpegBundleSlot {
            version: "N-999999".to_string(),
            ffmpeg_version: "N-999999".to_string(),
            ffprobe_version: "N-999999".to_string(),
            ffmpeg_path: fake_ffmpeg.clone(),
            ffprobe_path: fake_ffprobe.clone(),
            sha256: Some("d".repeat(64)),
            source: "tori_signed_manifest".to_string(),
            activated_at: now,
        }),
        ffmpeg_bundle_rollback: None,
        ffmpeg_bundle_pending: None,
    };
    std::fs::create_dir_all(manifest_path.parent().unwrap()).unwrap();
    std::fs::write(&manifest_path, serde_json::to_vec_pretty(&seeded).unwrap()).unwrap();

    // Re-open manager so coordinator reads seeded manifest, then attempt deferred activation
    let db2 = Database::open(&data_dir.join("tdm_storage.sqlite")).unwrap();
    let cfg2 = ToolsManagerConfig {
        bundled_override_dir: Some(dir.path().join("bundled")),
        register_globally: false,
        ..Default::default()
    };
    let mgr2 = ExternalToolsManager::with_config(db2, data_dir.clone(), cfg2).unwrap();
    mgr2.arm_simulated_post_switch_failure();

    // Activation of broken pending yt-dlp must roll back cleanly without looping or clobbering FFmpeg
    let _ = mgr2.try_activate_pending_updates().await;
    drop(mgr);

    let after_bytes = std::fs::read(&manifest_path).unwrap();
    let after: ActiveToolsManifest = serde_json::from_slice(&after_bytes).unwrap();
    assert!(
        after.yt_dlp_pending.is_none(),
        "Broken pending yt-dlp slot must be cleared on rollback to prevent 30s infinite rollback loop"
    );
    assert_eq!(
        after
            .ffmpeg_bundle_active
            .as_ref()
            .map(|f| f.version.as_str()),
        Some("N-999999"),
        "Unrelated FFmpeg active slot must be preserved during yt-dlp rollback"
    );
    let snap = mgr2.get_status_snapshot().unwrap();
    let yt = snap.tools.iter().find(|t| t.tool_id == ToolId::YtDlp).unwrap();
    assert!(yt.pending_version.is_none());
}
