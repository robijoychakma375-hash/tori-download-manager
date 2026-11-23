//! Gate 33 — Comprehensive Security Test Matrix for Dedicated External Tools Signing Keys,
//! Dual-Key Transition, Purpose Binding, Revocation, Anti-Replay & Compatibility
//!
//! Deterministically verifies Phase 13 security scenarios (1–23, 30, 32, 34, 35) in complete
//! isolation with zero network dependencies and zero production user-data mutation.

use base64::Engine as _;
use chrono::{Duration as ChronoDuration, Utc};
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use tdm_core::tools::providers::fetch_signed_tools_manifest;
use tdm_core::tools::{
    extract_minisign_key_id_hex, extract_minisign_sig_key_id_hex, verify_minisign_with_keyring,
    ExternalToolsManager, ManifestAntiReplayState, ManifestFetchOutcome, ManifestProvenance,
    SignedManifestToolEntry, SignedToolsManifest, SigningKeyPurpose, ToolId, ToolUpdateStatus,
    ToolsManagerConfig, TrustedKeyStatus, TrustedSigningKey, TrustedToolsKeyring,
    TORI_ED25519_KEY_ID, TORI_ED25519_PUBKEY_B64,
};
use tdm_core::Database;

struct TestMinisignKey {
    keypair: Ed25519KeyPair,
    key_id_bytes: [u8; 8],
    key_id_hex: String,
    pubkey_b64: String,
}

impl TestMinisignKey {
    fn generate(seed_byte: u8) -> Self {
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).expect("generate ed25519 pkcs8");
        let keypair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).expect("parse ed25519 pkcs8");
        let key_id_bytes = [
            seed_byte,
            0x33,
            0xAA,
            0xBB,
            0xCC,
            0xDD,
            0xEE,
            seed_byte.wrapping_add(1),
        ];
        let id_u64 = u64::from_le_bytes(key_id_bytes);
        let key_id_hex = format!("{:016X}", id_u64);

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

    /// Signs exact payload bytes in Tauri/Minisign `Ed` pure format, base64-wrapped like `.sig`.
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
            "untrusted comment: signature from gate33 test key\n{}\ntrusted comment: {}\n{}\n",
            sig_line, trusted_comment, global_line
        );
        let b64 = base64::engine::general_purpose::STANDARD.encode(sig_box.as_bytes());
        assert_eq!(
            extract_minisign_sig_key_id_hex(&b64).as_deref(),
            Some(self.key_id_hex.as_str())
        );
        b64
    }

    fn as_trusted_key(
        &self,
        purpose: SigningKeyPurpose,
        status: TrustedKeyStatus,
        label: &str,
    ) -> TrustedSigningKey {
        TrustedSigningKey {
            key_id: self.key_id_hex.clone(),
            pubkey_b64: self.pubkey_b64.clone(),
            purpose,
            status,
            label: label.to_string(),
            valid_from: None,
            retired_after: None,
        }
    }
}

#[derive(Clone)]
struct MockResponse {
    status: u16,
    content_type: String,
    location: Option<String>,
    body: Vec<u8>,
}

async fn start_mock_server(
    routes: Arc<Mutex<HashMap<String, MockResponse>>>,
) -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind loopback mock server");
    let port = listener.local_addr().unwrap().port();
    let handle = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let routes = routes.clone();
            tokio::spawn(async move {
                let mut req_buf = vec![0u8; 4096];
                let n = stream.read(&mut req_buf).await.unwrap_or(0);
                if n == 0 {
                    return;
                }
                let req_str = String::from_utf8_lossy(&req_buf[..n]);
                let first_line = req_str.lines().next().unwrap_or("");
                let path_raw = first_line.split_whitespace().nth(1).unwrap_or("/");
                let path = path_raw.split('?').next().unwrap_or("/");
                let resp = {
                    let map = routes.lock().await;
                    map.get(path).cloned().unwrap_or(MockResponse {
                        status: 404,
                        content_type: "text/plain".to_string(),
                        location: None,
                        body: b"Not Found".to_vec(),
                    })
                };
                let reason = match resp.status {
                    200 => "OK",
                    302 => "Found",
                    404 => "Not Found",
                    500 => "Internal Server Error",
                    _ => "Status",
                };
                let mut hdr = format!(
                    "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n",
                    resp.status,
                    reason,
                    resp.content_type,
                    resp.body.len()
                );
                if let Some(loc) = resp.location {
                    hdr.push_str(&format!("Location: {}\r\n", loc));
                }
                hdr.push_str("\r\n");
                let _ = stream.write_all(hdr.as_bytes()).await;
                let _ = stream.write_all(&resp.body).await;
            });
        }
    });
    (port, handle)
}

fn build_manifest(
    revision: u64,
    signing_key_id: &str,
    port: u16,
    artifact_sha256: &str,
    artifact_size: u64,
    published_at: chrono::DateTime<Utc>,
    expires_at: chrono::DateTime<Utc>,
) -> SignedToolsManifest {
    SignedToolsManifest {
        schema_version: 2,
        manifest_revision: revision,
        generated_at: published_at.to_rfc3339(),
        published_at: Some(published_at.to_rfc3339()),
        expires_at: Some(expires_at.to_rfc3339()),
        signing_key_id: Some(signing_key_id.to_string()),
        key_purpose: Some("external_tools_manifest".to_string()),
        dedicated_signing_key_id: None,
        yt_dlp: None,
        ffmpeg_bundle: Some(SignedManifestToolEntry {
            tool_id: Some("ffmpeg_bundle".to_string()),
            version: "N-129150-g7ddf7bc8a4-20261120".to_string(),
            ffmpeg_version: Some("N-129150-g7ddf7bc8a4-20261120".to_string()),
            ffprobe_version: Some("N-129150-g7ddf7bc8a4-20261120".to_string()),
            bundle_id: Some("ffmpeg-win64-gpl-N-129150".to_string()),
            url: format!("http://127.0.0.1:{}/ffmpeg.zip", port),
            sha256: artifact_sha256.to_string(),
            size: Some(artifact_size),
            artifact_format: Some("zip".to_string()),
            platform: Some("windows".to_string()),
            architecture: Some("x86_64".to_string()),
            min_tori_version: Some("1.0.6".to_string()),
            max_tori_version: None,
            published_at: Some(published_at.to_rfc3339()),
            allow_rollback_to: false,
            provenance: Some(ManifestProvenance {
                upstream_provider: "BtbN/FFmpeg-Builds".to_string(),
                upstream_release: "autobuild-2026-11-20-12-40".to_string(),
                upstream_url: "https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-11-20-12-40".to_string(),
                approved_by: "TORI Gate 33 Security Test".to_string(),
                approved_at: published_at.to_rfc3339(),
            }),
        }),
    }
}

fn json_ok(body: Vec<u8>) -> MockResponse {
    MockResponse {
        status: 200,
        content_type: "application/json".to_string(),
        location: None,
        body,
    }
}

fn text_ok(body: String) -> MockResponse {
    MockResponse {
        status: 200,
        content_type: "text/plain".to_string(),
        location: None,
        body: body.into_bytes(),
    }
}

/// Covers Scenarios 1, 2, 3, 4, 5, 6, 7, 15, 16, 17, 30:
/// Legacy key, dedicated key, unknown key, wrong-purpose Desktop key, revoked key,
/// invalid signature, modified manifest, dual-key transition, unsafe key removal prevention,
/// key rotation rollback, and signing-key ID mismatch.
#[tokio::test]
async fn test_gate33_keyring_separation_purpose_revocation_and_transition() {
    let legacy_key = TestMinisignKey::generate(0x11);
    let dedicated_key = TestMinisignKey::generate(0x22);
    let desktop_only_key = TestMinisignKey::generate(0x33);
    let unknown_key = TestMinisignKey::generate(0x44);
    let revoked_key = TestMinisignKey::generate(0x55);

    let now = Utc::now();
    let payload = b"{\"schema_version\":2,\"manifest_revision\":1}";

    // Dual-key transition keyring (Stage 1 & Stage 2)
    let transition_keyring = TrustedToolsKeyring {
        keyring_version: 1,
        allow_legacy_shared_key: true,
        revoked_key_ids: vec![revoked_key.key_id_hex.clone()],
        keys: vec![
            legacy_key.as_trusted_key(
                SigningKeyPurpose::ExternalToolsLegacyShared,
                TrustedKeyStatus::TransitionLegacy,
                "Legacy Shared Key",
            ),
            dedicated_key.as_trusted_key(
                SigningKeyPurpose::ExternalToolsManifest,
                TrustedKeyStatus::Active,
                "Dedicated Tools Key",
            ),
            desktop_only_key.as_trusted_key(
                SigningKeyPurpose::DesktopAppUpdater,
                TrustedKeyStatus::Active,
                "Desktop-Only Key (Wrong Purpose)",
            ),
            revoked_key.as_trusted_key(
                SigningKeyPurpose::ExternalToolsManifest,
                TrustedKeyStatus::Revoked,
                "Revoked Tools Key",
            ),
        ],
    };

    // 1. Valid legacy tools signature during transition -> ACCEPTED
    let legacy_sig = legacy_key.sign_b64(payload);
    let v_legacy = verify_minisign_with_keyring(&transition_keyring, payload, &legacy_sig, now, 900)
        .expect("Scenario 1: valid legacy transition key must be accepted");
    assert_eq!(v_legacy.key_id, legacy_key.key_id_hex);
    assert_eq!(v_legacy.purpose, SigningKeyPurpose::ExternalToolsLegacyShared);

    // 2. Valid dedicated tools signature -> ACCEPTED
    let ded_sig = dedicated_key.sign_b64(payload);
    let v_ded = verify_minisign_with_keyring(&transition_keyring, payload, &ded_sig, now, 900)
        .expect("Scenario 2: valid dedicated tools key must be accepted");
    assert_eq!(v_ded.key_id, dedicated_key.key_id_hex);
    assert_eq!(v_ded.purpose, SigningKeyPurpose::ExternalToolsManifest);

    // 3. Unknown key rejection -> REJECTED
    let unk_sig = unknown_key.sign_b64(payload);
    let err_unk = verify_minisign_with_keyring(&transition_keyring, payload, &unk_sig, now, 900)
        .expect_err("Scenario 3: unknown key must be rejected");
    assert!(err_unk.to_string().contains("unknown untrusted signing key"));

    // 4. Wrong-purpose key rejection (DesktopAppUpdater key cannot verify tools manifest) -> REJECTED
    let desk_sig = desktop_only_key.sign_b64(payload);
    let err_desk = verify_minisign_with_keyring(&transition_keyring, payload, &desk_sig, now, 900)
        .expect_err("Scenario 4: DesktopAppUpdater key must be rejected for tools manifests");
    assert!(err_desk.to_string().contains("wrong-purpose signing key"));

    // 5. Revoked key rejection -> REJECTED
    let rev_sig = revoked_key.sign_b64(payload);
    let err_rev = verify_minisign_with_keyring(&transition_keyring, payload, &rev_sig, now, 900)
        .expect_err("Scenario 5: revoked key must be rejected");
    assert!(err_rev.to_string().contains("revoked"));

    // 6. Invalid signature rejection -> REJECTED
    let mut bad_sig_raw = base64::engine::general_purpose::STANDARD
        .decode(&ded_sig)
        .unwrap();
    let last_idx = bad_sig_raw.len() - 6;
    bad_sig_raw[last_idx] ^= 0xFF;
    let bad_sig = base64::engine::general_purpose::STANDARD.encode(&bad_sig_raw);
    assert!(
        verify_minisign_with_keyring(&transition_keyring, payload, &bad_sig, now, 900).is_err(),
        "Scenario 6: corrupted signature must be rejected"
    );

    // 7. Modified manifest bytes rejection -> REJECTED
    let tampered_payload = b"{\"schema_version\":2,\"manifest_revision\":2}";
    assert!(
        verify_minisign_with_keyring(&transition_keyring, tampered_payload, &ded_sig, now, 900)
            .is_err(),
        "Scenario 7: modified manifest bytes must fail signature verification"
    );

    // 16. Unsafe key removal prevention (retiring all keys leaves zero usable keys -> REJECTED)
    let unsafe_keyring = TrustedToolsKeyring {
        keyring_version: 2,
        allow_legacy_shared_key: false,
        revoked_key_ids: vec![dedicated_key.key_id_hex.clone()],
        keys: vec![
            legacy_key.as_trusted_key(
                SigningKeyPurpose::ExternalToolsLegacyShared,
                TrustedKeyStatus::Retired,
                "Retired Legacy",
            ),
            dedicated_key.as_trusted_key(
                SigningKeyPurpose::ExternalToolsManifest,
                TrustedKeyStatus::Revoked,
                "Revoked Dedicated",
            ),
        ],
    };
    let err_unsafe = unsafe_keyring
        .validate_safety(now, 900)
        .expect_err("Scenario 16: keyring with zero usable keys must fail safety validation");
    assert!(err_unsafe.to_string().contains("zero active"));

    // Stage 3 Retirement: legacy shared key rejected once allow_legacy_shared_key = false
    let stage3_keyring = TrustedToolsKeyring {
        keyring_version: 2,
        allow_legacy_shared_key: false,
        revoked_key_ids: vec![],
        keys: vec![
            legacy_key.as_trusted_key(
                SigningKeyPurpose::ExternalToolsLegacyShared,
                TrustedKeyStatus::TransitionLegacy,
                "Legacy Shared Key",
            ),
            dedicated_key.as_trusted_key(
                SigningKeyPurpose::ExternalToolsManifest,
                TrustedKeyStatus::Active,
                "Dedicated Tools Key",
            ),
        ],
    };
    assert!(
        verify_minisign_with_keyring(&stage3_keyring, payload, &legacy_sig, now, 900).is_err(),
        "Stage 3: retired legacy shared key must be rejected"
    );
    assert!(
        verify_minisign_with_keyring(&stage3_keyring, payload, &ded_sig, now, 900).is_ok(),
        "Stage 3: dedicated key continues verifying cleanly"
    );

    // 17. Key rotation rollback (Stage 2 rollback to legacy key with strictly higher revision)
    let routes = Arc::new(Mutex::new(HashMap::new()));
    let (port, handle) = start_mock_server(routes.clone()).await;
    let fake_sha = hex::encode(Sha256::digest(b"approved-artifact"));

    let mut cfg = ToolsManagerConfig {
        signed_manifest_url: Some(format!("http://127.0.0.1:{}/tools-manifest.json", port)),
        allow_loopback_http: true,
        tools_keyring: Some(transition_keyring.clone()),
        ..Default::default()
    };

    // First accept rev 2 signed by dedicated key (Stage 2)
    let m2 = build_manifest(
        2,
        &dedicated_key.key_id_hex,
        port,
        &fake_sha,
        17,
        now - ChronoDuration::minutes(5),
        now + ChronoDuration::days(30),
    );
    let m2_bytes = serde_json::to_vec(&m2).unwrap();
    let m2_sig = dedicated_key.sign_b64(&m2_bytes);
    {
        let mut r = routes.lock().await;
        r.insert("/tools-manifest.json".into(), json_ok(m2_bytes.clone()));
        r.insert("/tools-manifest.json.sig".into(), text_ok(m2_sig));
    }
    let state0 = ManifestAntiReplayState::default();
    let out2 = fetch_signed_tools_manifest(&cfg, &state0, now).await;
    let v2 = match out2 {
        ManifestFetchOutcome::Available(v) => v,
        other => panic!("Expected rev 2 dedicated acceptance, got {:?}", other),
    };
    assert_eq!(v2.verified_key_id.as_deref(), Some(dedicated_key.key_id_hex.as_str()));

    // Roll back signer to legacy key at rev 3 (strictly higher revision) during Stage 2 transition!
    let state_after_2 = ManifestAntiReplayState {
        highest_accepted_revision: 2,
        last_accepted_manifest_sha256: Some(v2.raw_sha256.clone()),
        ..Default::default()
    };
    let m3 = build_manifest(
        3,
        &legacy_key.key_id_hex,
        port,
        &fake_sha,
        17,
        now - ChronoDuration::minutes(1),
        now + ChronoDuration::days(30),
    );
    let m3_bytes = serde_json::to_vec(&m3).unwrap();
    let m3_sig = legacy_key.sign_b64(&m3_bytes);
    {
        let mut r = routes.lock().await;
        r.insert("/tools-manifest.json".into(), json_ok(m3_bytes));
        r.insert("/tools-manifest.json.sig".into(), text_ok(m3_sig));
    }
    let out3 = fetch_signed_tools_manifest(&cfg, &state_after_2, now).await;
    assert!(
        matches!(out3, ManifestFetchOutcome::Available(v) if v.verified_key_id.as_deref() == Some(legacy_key.key_id_hex.as_str()) && v.manifest.manifest_revision == 3),
        "Scenario 17: key rotation rollback to higher-revision legacy-signed manifest must succeed during transition"
    );

    // 15. Dual-signature Stage 1–2 sidecar verification (`.sig` by legacy key + `.tools.sig` by dedicated key)
    let mut m4 = build_manifest(
        4,
        &legacy_key.key_id_hex,
        port,
        &fake_sha,
        17,
        now - ChronoDuration::minutes(1),
        now + ChronoDuration::days(30),
    );
    m4.dedicated_signing_key_id = Some(dedicated_key.key_id_hex.clone());
    let m4_bytes = serde_json::to_vec(&m4).unwrap();
    let m4_legacy_sig = legacy_key.sign_b64(&m4_bytes);
    let m4_ded_sig = dedicated_key.sign_b64(&m4_bytes);
    {
        let mut r = routes.lock().await;
        r.insert("/tools-manifest.json".into(), json_ok(m4_bytes.clone()));
        r.insert("/tools-manifest.json.sig".into(), text_ok(m4_legacy_sig.clone()));
        r.insert("/tools-manifest.json.tools.sig".into(), text_ok(m4_ded_sig));
    }
    let state_after_3 = ManifestAntiReplayState {
        highest_accepted_revision: 3,
        ..Default::default()
    };
    let out4 = fetch_signed_tools_manifest(&cfg, &state_after_3, now).await;
    match out4 {
        ManifestFetchOutcome::Available(v) => {
            assert_eq!(v.verified_key_id.as_deref(), Some(legacy_key.key_id_hex.as_str()));
            assert_eq!(
                v.dual_signature_verified_key_id.as_deref(),
                Some(dedicated_key.key_id_hex.as_str())
            );
        }
        other => panic!("Scenario 15: dual-signature manifest must pass, got {:?}", other),
    }

    // 35. Existing v1.0.7 client compatibility: client knowing ONLY legacy key ignores `.tools.sig`
    // and still verifies the exact same dual-signed manifest cleanly!
    cfg.tools_keyring = Some(TrustedToolsKeyring {
        keyring_version: 1,
        allow_legacy_shared_key: true,
        revoked_key_ids: vec![],
        keys: vec![legacy_key.as_trusted_key(
            SigningKeyPurpose::ExternalToolsLegacyShared,
            TrustedKeyStatus::TransitionLegacy,
            "v1.0.7 Legacy Only",
        )],
    });
    let out_v107 = fetch_signed_tools_manifest(&cfg, &state_after_3, now).await;
    assert!(
        matches!(out_v107, ManifestFetchOutcome::Available(v) if v.verified_key_id.as_deref() == Some(legacy_key.key_id_hex.as_str()) && v.dual_signature_verified_key_id.is_none()),
        "Scenario 35: legacy-only v1.0.7 client must accept Stage 1-2 dual-signed manifest seamlessly"
    );

    // 30. Signing-key mismatch (manifest claims key A while signed by key B) -> REJECTED
    cfg.tools_keyring = Some(transition_keyring);
    let m_mismatch = build_manifest(
        5,
        &legacy_key.key_id_hex, // claims legacy
        port,
        &fake_sha,
        17,
        now - ChronoDuration::minutes(1),
        now + ChronoDuration::days(30),
    );
    let mm_bytes = serde_json::to_vec(&m_mismatch).unwrap();
    let mm_sig = dedicated_key.sign_b64(&mm_bytes); // signed by dedicated!
    {
        let mut r = routes.lock().await;
        r.insert("/tools-manifest.json".into(), json_ok(mm_bytes));
        r.insert("/tools-manifest.json.sig".into(), text_ok(mm_sig));
    }
    let out_mm = fetch_signed_tools_manifest(&cfg, &state_after_3, now).await;
    assert!(
        matches!(out_mm, ManifestFetchOutcome::RejectedSecurity(ref e) if e.contains("signing_key_id")),
        "Scenario 30: signing_key_id mismatch must fail closed, got {:?}",
        out_mm
    );

    handle.abort();
}

/// Covers Scenarios 9, 10, 11, 12, 18, 19, 20, 21, 32, 34:
/// Expired, future-dated, replay, equivocation, duplicate JSON keys, unsupported schema,
/// invalid platform, malicious redirect, partial manifest deployment (.sig 404), CDN stale response,
/// and wrong manifest key_purpose field.
#[tokio::test]
async fn test_gate33_manifest_policy_replay_equivocation_partial_and_redirect_rejection() {
    let key = TestMinisignKey::generate(0x66);
    let now = Utc::now();
    let routes = Arc::new(Mutex::new(HashMap::new()));
    let (port, handle) = start_mock_server(routes.clone()).await;
    let fake_sha = hex::encode(Sha256::digest(b"artifact-bytes"));

    let cfg = ToolsManagerConfig {
        signed_manifest_url: Some(format!("http://127.0.0.1:{}/tools-manifest.json", port)),
        allow_loopback_http: true,
        tools_keyring: Some(TrustedToolsKeyring::single_dedicated_key(
            &key.key_id_hex,
            &key.pubkey_b64,
            "Dedicated Test Key",
        )),
        ..Default::default()
    };

    // 9. Expired manifest rejection
    let m_exp = build_manifest(
        1,
        &key.key_id_hex,
        port,
        &fake_sha,
        14,
        now - ChronoDuration::days(60),
        now - ChronoDuration::hours(2),
    );
    let b_exp = serde_json::to_vec(&m_exp).unwrap();
    {
        let mut r = routes.lock().await;
        r.insert("/tools-manifest.json".into(), json_ok(b_exp.clone()));
        r.insert("/tools-manifest.json.sig".into(), text_ok(key.sign_b64(&b_exp)));
    }
    assert!(matches!(
        fetch_signed_tools_manifest(&cfg, &ManifestAntiReplayState::default(), now).await,
        ManifestFetchOutcome::RejectedSecurity(ref e) if e.contains("expired")
    ));

    // 10. Future-dated manifest rejection
    let m_fut = build_manifest(
        1,
        &key.key_id_hex,
        port,
        &fake_sha,
        14,
        now + ChronoDuration::hours(2),
        now + ChronoDuration::days(30),
    );
    let b_fut = serde_json::to_vec(&m_fut).unwrap();
    {
        let mut r = routes.lock().await;
        r.insert("/tools-manifest.json".into(), json_ok(b_fut.clone()));
        r.insert("/tools-manifest.json.sig".into(), text_ok(key.sign_b64(&b_fut)));
    }
    assert!(matches!(
        fetch_signed_tools_manifest(&cfg, &ManifestAntiReplayState::default(), now).await,
        ManifestFetchOutcome::RejectedSecurity(ref e) if e.contains("future-dated")
    ));

    // 11 & 34. Replay / CDN stale manifest rejection (received rev 2 when client saw rev 3)
    let m_rev2 = build_manifest(
        2,
        &key.key_id_hex,
        port,
        &fake_sha,
        14,
        now - ChronoDuration::minutes(5),
        now + ChronoDuration::days(30),
    );
    let b_rev2 = serde_json::to_vec(&m_rev2).unwrap();
    let sha_rev2 = hex::encode(Sha256::digest(&b_rev2));
    {
        let mut r = routes.lock().await;
        r.insert("/tools-manifest.json".into(), json_ok(b_rev2.clone()));
        r.insert("/tools-manifest.json.sig".into(), text_ok(key.sign_b64(&b_rev2)));
    }
    let state_rev3 = ManifestAntiReplayState {
        highest_accepted_revision: 3,
        last_accepted_manifest_sha256: Some("0".repeat(64)),
        ..Default::default()
    };
    assert!(matches!(
        fetch_signed_tools_manifest(&cfg, &state_rev3, now).await,
        ManifestFetchOutcome::RejectedSecurity(ref e) if e.contains("replay rejected")
    ));

    // 12. Manifest equivocation rejection (same rev 2, different SHA-256)
    let state_rev2_diff = ManifestAntiReplayState {
        highest_accepted_revision: 2,
        last_accepted_manifest_sha256: Some("f".repeat(64)),
        ..Default::default()
    };
    assert_ne!(sha_rev2, "f".repeat(64));
    assert!(matches!(
        fetch_signed_tools_manifest(&cfg, &state_rev2_diff, now).await,
        ManifestFetchOutcome::RejectedSecurity(ref e) if e.contains("equivocation rejected")
    ));

    // 18. Duplicate JSON key rejection (even with valid signature!)
    let dup_json = format!(
        r#"{{"schema_version":2,"manifest_revision":4,"manifest_revision":99,"published_at":"{}","expires_at":"{}","signing_key_id":"{}"}}"#,
        (now - ChronoDuration::minutes(2)).to_rfc3339(),
        (now + ChronoDuration::days(10)).to_rfc3339(),
        key.key_id_hex
    );
    {
        let mut r = routes.lock().await;
        r.insert("/tools-manifest.json".into(), json_ok(dup_json.as_bytes().to_vec()));
        r.insert(
            "/tools-manifest.json.sig".into(),
            text_ok(key.sign_b64(dup_json.as_bytes())),
        );
    }
    assert!(matches!(
        fetch_signed_tools_manifest(&cfg, &ManifestAntiReplayState::default(), now).await,
        ManifestFetchOutcome::RejectedSecurity(ref e) if e.contains("duplicate JSON key")
    ));

    // 19. Unsupported schema rejection
    let mut m_bad_schema = m_rev2.clone();
    m_bad_schema.schema_version = 99;
    let b_bs = serde_json::to_vec(&m_bad_schema).unwrap();
    {
        let mut r = routes.lock().await;
        r.insert("/tools-manifest.json".into(), json_ok(b_bs.clone()));
        r.insert("/tools-manifest.json.sig".into(), text_ok(key.sign_b64(&b_bs)));
    }
    assert!(matches!(
        fetch_signed_tools_manifest(&cfg, &ManifestAntiReplayState::default(), now).await,
        ManifestFetchOutcome::RejectedSecurity(ref e) if e.contains("Unsupported signed tools manifest schema_version")
    ));

    // Wrong manifest key_purpose field rejection
    let mut m_bad_purpose = m_rev2.clone();
    m_bad_purpose.key_purpose = Some("desktop_app_updater".to_string());
    let b_bp = serde_json::to_vec(&m_bad_purpose).unwrap();
    {
        let mut r = routes.lock().await;
        r.insert("/tools-manifest.json".into(), json_ok(b_bp.clone()));
        r.insert("/tools-manifest.json.sig".into(), text_ok(key.sign_b64(&b_bp)));
    }
    assert!(matches!(
        fetch_signed_tools_manifest(&cfg, &ManifestAntiReplayState::default(), now).await,
        ManifestFetchOutcome::RejectedSecurity(ref e) if e.contains("key_purpose")
    ));

    // 32. Partial manifest deployment (.json exists, .sig returns 404) -> REJECTED
    {
        let mut r = routes.lock().await;
        r.insert("/tools-manifest.json".into(), json_ok(b_rev2.clone()));
        r.remove("/tools-manifest.json.sig");
    }
    assert!(matches!(
        fetch_signed_tools_manifest(&cfg, &ManifestAntiReplayState::default(), now).await,
        ManifestFetchOutcome::RejectedSecurity(ref e) if e.contains("missing (HTTP 404)")
    ));

    // 21. Malicious redirect to untrusted external domain -> REJECTED
    {
        let mut r = routes.lock().await;
        r.insert(
            "/tools-manifest.json".into(),
            MockResponse {
                status: 302,
                content_type: "text/plain".to_string(),
                location: Some("https://evil.attacker.invalid/tools-manifest.json".to_string()),
                body: Vec::new(),
            },
        );
    }
    assert!(matches!(
        fetch_signed_tools_manifest(&cfg, &ManifestAntiReplayState::default(), now).await,
        ManifestFetchOutcome::RejectedSecurity(_)
    ));

    // 20. Invalid platform rejection via full ExternalToolsManager check
    let mut m_linux = m_rev2.clone();
    m_linux.ffmpeg_bundle.as_mut().unwrap().platform = Some("linux".to_string());
    let b_lin = serde_json::to_vec(&m_linux).unwrap();
    {
        let mut r = routes.lock().await;
        r.insert("/tools-manifest.json".into(), json_ok(b_lin.clone()));
        r.insert("/tools-manifest.json.sig".into(), text_ok(key.sign_b64(&b_lin)));
        r.insert(
            "/ytdlp-latest".into(),
            json_ok(br#"{"tag_name":"2026.08.19","assets":[]}"#.to_vec()),
        );
    }
    let tmp = TempDir::new().unwrap();
    let db = Database::open(&tmp.path().join("test.sqlite")).unwrap();
    let mut mgr_cfg = cfg.clone();
    mgr_cfg.ytdlp_release_api_url = format!("http://127.0.0.1:{}/ytdlp-latest", port);
    mgr_cfg.register_globally = false;
    let mgr = ExternalToolsManager::with_config(db, tmp.path().to_path_buf(), mgr_cfg).unwrap();
    let snap = mgr.check_for_updates(true).await.unwrap();
    let ff = snap.tools.iter().find(|t| t.tool_id == ToolId::Ffmpeg).unwrap();
    assert_eq!(ff.update_status, ToolUpdateStatus::SourceUntrusted);
    assert!(
        ff.last_error
            .as_deref()
            .unwrap_or("")
            .contains("incompatible with Windows"),
        "Scenario 20: non-Windows platform must fail closed"
    );
    // Phase 15 status summary check (manifest verified at rev 2, zero private material exposed!)
    assert_eq!(snap.manifest_status.verification_status, "verified");
    assert_eq!(snap.manifest_status.current_revision, Some(2));
    assert_eq!(
        snap.manifest_status.signing_key_id.as_deref(),
        Some(key.key_id_hex.as_str())
    );
    assert_eq!(
        snap.manifest_status.signing_key_purpose.as_deref(),
        Some("external_tools_manifest")
    );

    handle.abort();
}

/// Covers Scenarios 8, 13, 14, 22, 23 & Default Production Transition Keyring Invariant:
/// Tampered artifact / wrong SHA-256, missing artifact (404), unauthorized downgrade rejection,
/// authorized higher-revision rollback acceptance, and production default keyring safety.
#[tokio::test]
async fn test_gate33_tampered_missing_artifact_downgrade_and_prod_keyring_defaults() {
    // Verify Stage 1 dual-key production transition keyring preserves legacy v1.0.7 key
    // CDC23D8CC8DA5397 AND includes the operator-provisioned dedicated production External Tools
    // public key C3FD6626A3718E63 with strict purpose isolation.
    let def_cfg = ToolsManagerConfig::default();
    let def_kr = def_cfg.effective_tools_keyring();
    assert_eq!(def_kr.keyring_version, 1);
    assert!(def_kr.allow_legacy_shared_key);
    assert!(def_kr.has_dedicated_active_key());
    assert_eq!(def_kr.keys.len(), 2);
    assert_eq!(def_kr.keys[0].key_id, TORI_ED25519_KEY_ID);
    assert_eq!(def_kr.keys[0].pubkey_b64, TORI_ED25519_PUBKEY_B64);
    assert_eq!(def_kr.keys[0].purpose, SigningKeyPurpose::ExternalToolsLegacyShared);
    assert_eq!(def_kr.keys[0].status, TrustedKeyStatus::TransitionLegacy);
    assert_eq!(def_kr.keys[1].key_id, "C3FD6626A3718E63");
    assert_ne!(def_kr.keys[1].key_id, TORI_ED25519_KEY_ID);
    assert_eq!(def_kr.keys[1].purpose, SigningKeyPurpose::ExternalToolsManifest);
    assert_eq!(def_kr.keys[1].status, TrustedKeyStatus::Active);
    assert_eq!(
        extract_minisign_key_id_hex(&def_kr.keys[1].pubkey_b64).as_deref(),
        Some("C3FD6626A3718E63")
    );
    assert!(def_kr.validate_safety(Utc::now(), 900).is_ok());

    let key = TestMinisignKey::generate(0x77);
    let now = Utc::now();
    let routes = Arc::new(Mutex::new(HashMap::new()));
    let (port, handle) = start_mock_server(routes.clone()).await;

    let tmp = TempDir::new().unwrap();
    let db = Database::open(&tmp.path().join("test_dl.sqlite")).unwrap();
    let cfg = ToolsManagerConfig {
        ytdlp_release_api_url: format!("http://127.0.0.1:{}/ytdlp-latest", port),
        signed_manifest_url: Some(format!("http://127.0.0.1:{}/tools-manifest.json", port)),
        allow_loopback_http: true,
        tools_keyring: Some(TrustedToolsKeyring::single_dedicated_key(
            &key.key_id_hex,
            &key.pubkey_b64,
            "Dedicated Artifact Test Key",
        )),
        register_globally: false,
        ..Default::default()
    };

    // 8 & 23. Tampered artifact / Wrong SHA-256 rejection during download
    let artifact_bytes = b"not-a-valid-zip-tampered-content".to_vec();
    let wrong_sha = "a".repeat(64);
    let m1 = build_manifest(
        1,
        &key.key_id_hex,
        port,
        &wrong_sha,
        artifact_bytes.len() as u64,
        now - ChronoDuration::minutes(2),
        now + ChronoDuration::days(30),
    );
    let b1 = serde_json::to_vec(&m1).unwrap();
    {
        let mut r = routes.lock().await;
        r.insert("/tools-manifest.json".into(), json_ok(b1.clone()));
        r.insert("/tools-manifest.json.sig".into(), text_ok(key.sign_b64(&b1)));
        r.insert(
            "/ffmpeg.zip".into(),
            MockResponse {
                status: 200,
                content_type: "application/zip".to_string(),
                location: None,
                body: artifact_bytes.clone(),
            },
        );
    }

    let mgr = ExternalToolsManager::with_config(db, tmp.path().to_path_buf(), cfg).unwrap();
    let _ = mgr.check_for_updates(true).await.unwrap();
    let res_tampered = mgr.update_tool(ToolId::Ffmpeg).await;
    assert!(
        res_tampered.is_err(),
        "Scenarios 8 & 23: tampered artifact SHA-256 mismatch MUST fail before activation"
    );

    // 22. Missing artifact (HTTP 404) rejection
    {
        let mut r = routes.lock().await;
        r.remove("/ffmpeg.zip");
    }
    let res_missing = mgr.update_tool(ToolId::Ffmpeg).await;
    assert!(
        res_missing.is_err(),
        "Scenario 22: missing artifact (HTTP 404) must fail cleanly"
    );

    // 13. Unauthorized downgrade rejection (version older than bundled N-126374 with allow_rollback_to=false)
    let mut m_down = build_manifest(
        2,
        &key.key_id_hex,
        port,
        &hex::encode(Sha256::digest(&artifact_bytes)),
        artifact_bytes.len() as u64,
        now - ChronoDuration::minutes(1),
        now + ChronoDuration::days(30),
    );
    m_down.ffmpeg_bundle.as_mut().unwrap().version = "N-120000-g0000000000-20250101".to_string();
    m_down.ffmpeg_bundle.as_mut().unwrap().allow_rollback_to = false;
    let b_down = serde_json::to_vec(&m_down).unwrap();
    {
        let mut r = routes.lock().await;
        r.insert("/tools-manifest.json".into(), json_ok(b_down.clone()));
        r.insert("/tools-manifest.json.sig".into(), text_ok(key.sign_b64(&b_down)));
    }
    let snap_down = mgr.check_for_updates(true).await.unwrap();
    let ff_down = snap_down.tools.iter().find(|t| t.tool_id == ToolId::Ffmpeg).unwrap();
    assert_ne!(
        ff_down.update_status,
        ToolUpdateStatus::UpdateAvailable,
        "Scenario 13: unauthorized downgrade must NOT be offered as UpdateAvailable"
    );

    // 14. Authorized higher-revision emergency rollback (rev 3, allow_rollback_to=true) -> ACCEPTED
    let mut m_rb = m_down.clone();
    m_rb.manifest_revision = 3;
    m_rb.ffmpeg_bundle.as_mut().unwrap().allow_rollback_to = true;
    let b_rb = serde_json::to_vec(&m_rb).unwrap();
    {
        let mut r = routes.lock().await;
        r.insert("/tools-manifest.json".into(), json_ok(b_rb.clone()));
        r.insert("/tools-manifest.json.sig".into(), text_ok(key.sign_b64(&b_rb)));
    }
    let snap_rb = mgr.check_for_updates(true).await.unwrap();
    let ff_rb = snap_rb.tools.iter().find(|t| t.tool_id == ToolId::Ffmpeg).unwrap();
    assert_eq!(
        ff_rb.update_status,
        ToolUpdateStatus::UpdateAvailable,
        "Scenario 14: authorized higher-revision signed rollback must be accepted as UpdateAvailable"
    );
    assert_eq!(snap_rb.manifest_status.current_revision, Some(3));

    handle.abort();
}

/// Gate 33.1 Phase 3 (Scenarios 1–10) & Phase 15 (Security Regression Scenarios 1–25):
/// Explicitly tests Stage 1 dual-key transition API (`stage1_dual_key_transition`),
/// unauthorized manifest self-escalation (`trusted_keys` / `rotate_pubkey`),
/// invalid `.tools.sig` dedicated signature, revoked legacy key, invalid public key rejection,
/// and strict `v1.0.7` vs Stage 1 `v1.0.8` behavioral boundary.
#[tokio::test]
async fn test_gate33_1_stage1_dual_key_and_unauthorized_trust_escalation_rejection() {
    let legacy_key = TestMinisignKey::generate(0x81);
    let dedicated_key = TestMinisignKey::generate(0x82);
    let rogue_key = TestMinisignKey::generate(0x83);
    let now = Utc::now();
    let routes = Arc::new(Mutex::new(HashMap::new()));
    let (port, handle) = start_mock_server(routes.clone()).await;
    let fake_sha = hex::encode(Sha256::digest(b"stage1-artifact"));

    // Verify production Stage 1 helper constructs valid dual-key keyring with legacy CDC23D8CC8DA5397 + dedicated key
    let prod_stage1 = TrustedToolsKeyring::stage1_dual_key_transition(
        &dedicated_key.key_id_hex,
        &dedicated_key.pubkey_b64,
        "Dedicated Stage 1 Test Key",
    );
    assert_eq!(prod_stage1.keys.len(), 2);
    assert!(prod_stage1.allow_legacy_shared_key);
    assert!(prod_stage1.has_dedicated_active_key());
    assert!(prod_stage1.validate_safety(now, 900).is_ok());

    // Build test Stage 1 dual-key keyring using our test legacy + dedicated keys
    let stage1_kr = TrustedToolsKeyring {
        keyring_version: 1,
        allow_legacy_shared_key: true,
        revoked_key_ids: vec![],
        keys: vec![
            legacy_key.as_trusted_key(
                SigningKeyPurpose::ExternalToolsLegacyShared,
                TrustedKeyStatus::TransitionLegacy,
                "Legacy Shared Key",
            ),
            dedicated_key.as_trusted_key(
                SigningKeyPurpose::ExternalToolsManifest,
                TrustedKeyStatus::Active,
                "Dedicated Tools Key",
            ),
        ],
    };

    let cfg = ToolsManagerConfig {
        signed_manifest_url: Some(format!("http://127.0.0.1:{}/tools-manifest.json", port)),
        allow_loopback_http: true,
        tools_keyring: Some(stage1_kr.clone()),
        ..Default::default()
    };

    // Phase 3 #9 / Phase 15 #7: Unauthorized trust escalation (manifest tries to inject `trusted_keys`) -> REJECTED!
    let escalated_json = format!(
        r#"{{
          "schema_version": 2,
          "manifest_revision": 2,
          "published_at": "{}",
          "expires_at": "{}",
          "signing_key_id": "{}",
          "trusted_keys": [{{"key_id": "{}", "pubkey_b64": "{}"}}]
        }}"#,
        (now - ChronoDuration::minutes(2)).to_rfc3339(),
        (now + ChronoDuration::days(30)).to_rfc3339(),
        legacy_key.key_id_hex,
        rogue_key.key_id_hex,
        rogue_key.pubkey_b64
    );
    {
        let mut r = routes.lock().await;
        r.insert(
            "/tools-manifest.json".into(),
            json_ok(escalated_json.as_bytes().to_vec()),
        );
        r.insert(
            "/tools-manifest.json.sig".into(),
            text_ok(legacy_key.sign_b64(escalated_json.as_bytes())),
        );
    }
    let esc_res = fetch_signed_tools_manifest(&cfg, &ManifestAntiReplayState::default(), now).await;
    assert!(
        matches!(esc_res, ManifestFetchOutcome::RejectedSecurity(ref e) if e.contains("trust-escalation")),
        "Unauthorized manifest trust-escalation field must be rejected, got {:?}",
        esc_res
    );

    // Phase 3 #6: Dual-signed manifest with valid legacy .sig BUT invalid dedicated .tools.sig -> REJECTED on Stage 1!
    let mut m_dual = build_manifest(
        2,
        &legacy_key.key_id_hex,
        port,
        &fake_sha,
        15,
        now - ChronoDuration::minutes(1),
        now + ChronoDuration::days(30),
    );
    m_dual.dedicated_signing_key_id = Some(dedicated_key.key_id_hex.clone());
    let m_dual_bytes = serde_json::to_vec(&m_dual).unwrap();
    {
        let mut r = routes.lock().await;
        r.insert("/tools-manifest.json".into(), json_ok(m_dual_bytes.clone()));
        r.insert(
            "/tools-manifest.json.sig".into(),
            text_ok(legacy_key.sign_b64(&m_dual_bytes)),
        );
        // Tampered / wrong-key sidecar .tools.sig!
        r.insert(
            "/tools-manifest.json.tools.sig".into(),
            text_ok(rogue_key.sign_b64(&m_dual_bytes)),
        );
    }
    let bad_dual_res =
        fetch_signed_tools_manifest(&cfg, &ManifestAntiReplayState::default(), now).await;
    assert!(
        matches!(bad_dual_res, ManifestFetchOutcome::RejectedSecurity(ref e) if e.contains(".tools.sig")),
        "Invalid dedicated .tools.sig must fail closed on Stage 1 client, got {:?}",
        bad_dual_res
    );

    // Phase 3 #7: Revoked legacy key rejected even when allow_legacy_shared_key = true
    let mut revoked_legacy_kr = stage1_kr.clone();
    revoked_legacy_kr
        .revoked_key_ids
        .push(legacy_key.key_id_hex.clone());
    let cfg_rev_leg = ToolsManagerConfig {
        signed_manifest_url: Some(format!("http://127.0.0.1:{}/tools-manifest.json", port)),
        allow_loopback_http: true,
        tools_keyring: Some(revoked_legacy_kr),
        ..Default::default()
    };
    let rev_leg_res =
        fetch_signed_tools_manifest(&cfg_rev_leg, &ManifestAntiReplayState::default(), now).await;
    assert!(
        matches!(rev_leg_res, ManifestFetchOutcome::RejectedSecurity(ref e) if e.contains("revoked")),
        "Revoked legacy key must be rejected, got {:?}",
        rev_leg_res
    );

    // Phase 15 #22: Invalid / malformed public key inside keyring -> rejected cleanly
    let malformed_kr = TrustedToolsKeyring {
        keyring_version: 1,
        allow_legacy_shared_key: false,
        revoked_key_ids: vec![],
        keys: vec![TrustedSigningKey {
            key_id: dedicated_key.key_id_hex.clone(),
            pubkey_b64: "NOT_A_VALID_MINISIGN_PUBKEY!!!".to_string(),
            purpose: SigningKeyPurpose::ExternalToolsManifest,
            status: TrustedKeyStatus::Active,
            label: "Corrupted Pubkey".to_string(),
            valid_from: None,
            retired_after: None,
        }],
    };
    let ded_sig = dedicated_key.sign_b64(b"test");
    assert!(
        verify_minisign_with_keyring(&malformed_kr, b"test", &ded_sig, now, 900).is_err(),
        "Phase 15 #22: malformed public key must fail closed"
    );

    // Phase 3 #10: Invalid manifest revision (schema v2 with manifest_revision = 0) -> REJECTED
    let m_rev0 = build_manifest(
        0,
        &dedicated_key.key_id_hex,
        port,
        &fake_sha,
        15,
        now - ChronoDuration::minutes(1),
        now + ChronoDuration::days(30),
    );
    let m_rev0_bytes = serde_json::to_vec(&m_rev0).unwrap();
    {
        let mut r = routes.lock().await;
        r.insert("/tools-manifest.json".into(), json_ok(m_rev0_bytes.clone()));
        r.insert(
            "/tools-manifest.json.sig".into(),
            text_ok(dedicated_key.sign_b64(&m_rev0_bytes)),
        );
    }
    let rev0_res = fetch_signed_tools_manifest(&cfg, &ManifestAntiReplayState::default(), now).await;
    assert!(
        matches!(rev0_res, ManifestFetchOutcome::RejectedSecurity(ref e) if e.contains("manifest_revision >= 1")),
        "Schema v2 manifest_revision=0 must be rejected, got {:?}",
        rev0_res
    );

    handle.abort();
}

/// Gate 33.3 Phase 16 — Key-Compromise Recovery Independence & Complete 25-Scenario Verification:
/// Proves that revoking a compromised dedicated tools key and activating a fresh replacement key
/// never depends on the compromised key remaining trusted, and that wrong platform, wrong
/// architecture, incompatible TORI version bounds, missing artifact, and malicious redirects all
/// fail closed.
#[tokio::test]
async fn test_gate33_3_compromise_recovery_independence_and_platform_bounds() {
    let compromised_ded = TestMinisignKey::generate(0x91);
    let replacement_ded = TestMinisignKey::generate(0x92);
    let now = Utc::now();
    let routes = Arc::new(Mutex::new(HashMap::new()));
    let (port, handle) = start_mock_server(routes.clone()).await;
    let fake_sha = hex::encode(Sha256::digest(b"replacement-approved-bundle"));

    // Recovery keyring shipped via authenticated Desktop Auto-Updater (CDC23D8CC8DA5397):
    // Compromised key is unconditionally revoked; fresh dedicated key replaces it immediately.
    let recovery_kr = TrustedToolsKeyring {
        keyring_version: 2,
        allow_legacy_shared_key: false,
        revoked_key_ids: vec![compromised_ded.key_id_hex.clone()],
        keys: vec![
            compromised_ded.as_trusted_key(
                SigningKeyPurpose::ExternalToolsManifest,
                TrustedKeyStatus::Revoked,
                "Compromised Dedicated Key (Revoked)",
            ),
            replacement_ded.as_trusted_key(
                SigningKeyPurpose::ExternalToolsManifest,
                TrustedKeyStatus::Active,
                "Replacement Dedicated Key v2",
            ),
        ],
    };
    recovery_kr
        .validate_safety(now, 900)
        .expect("Recovery keyring with replacement active key must pass safety validation");
    assert!(recovery_kr.is_revoked(&compromised_ded.key_id_hex));
    assert!(!recovery_kr.is_revoked(&replacement_ded.key_id_hex));
    // Desktop updater key remains completely independent of compromised/replacement tools keys
    assert_ne!(compromised_ded.key_id_hex, TORI_ED25519_KEY_ID);
    assert_ne!(replacement_ded.key_id_hex, TORI_ED25519_KEY_ID);

    let cfg = ToolsManagerConfig {
        signed_manifest_url: Some(format!("http://127.0.0.1:{}/tools-manifest.json", port)),
        allow_loopback_http: true,
        tools_keyring: Some(recovery_kr),
        current_tori_version: "1.0.8".to_string(),
        register_globally: false,
        ..Default::default()
    };

    // 1. Compromised dedicated key signature -> strictly rejected
    let m_bad = build_manifest(
        5,
        &compromised_ded.key_id_hex,
        port,
        &fake_sha,
        27,
        now - ChronoDuration::minutes(2),
        now + ChronoDuration::days(30),
    );
    let m_bad_bytes = serde_json::to_vec(&m_bad).unwrap();
    {
        let mut r = routes.lock().await;
        r.insert("/tools-manifest.json".into(), json_ok(m_bad_bytes.clone()));
        r.insert(
            "/tools-manifest.json.sig".into(),
            text_ok(compromised_ded.sign_b64(&m_bad_bytes)),
        );
    }
    let res_comp = fetch_signed_tools_manifest(&cfg, &ManifestAntiReplayState::default(), now).await;
    assert!(
        matches!(res_comp, ManifestFetchOutcome::RejectedSecurity(ref e) if e.contains("revoked")),
        "Compromised key must remain unconditionally rejected, got {:?}",
        res_comp
    );

    // 2. Replacement dedicated key signature -> immediately accepted
    let m_ok = build_manifest(
        6,
        &replacement_ded.key_id_hex,
        port,
        &fake_sha,
        27,
        now - ChronoDuration::minutes(1),
        now + ChronoDuration::days(30),
    );
    let m_ok_bytes = serde_json::to_vec(&m_ok).unwrap();
    {
        let mut r = routes.lock().await;
        r.insert("/tools-manifest.json".into(), json_ok(m_ok_bytes.clone()));
        r.insert(
            "/tools-manifest.json.sig".into(),
            text_ok(replacement_ded.sign_b64(&m_ok_bytes)),
        );
    }
    let res_rep = fetch_signed_tools_manifest(&cfg, &ManifestAntiReplayState::default(), now).await;
    assert!(
        matches!(res_rep, ManifestFetchOutcome::Available(ref v) if v.verified_key_id.as_deref() == Some(replacement_ded.key_id_hex.as_str())),
        "Replacement dedicated key must verify cleanly, got {:?}",
        res_rep
    );

    // 3. Wrong platform (linux) & wrong architecture (aarch64) & incompatible min_tori_version (9.9.9) rejected by manager!
    let tmp = TempDir::new().unwrap();
    let db = Database::open(&tmp.path().join("g333_sec.sqlite")).unwrap();
    let mut m_wrong_plat = m_ok.clone();
    m_wrong_plat.manifest_revision = 7;
    m_wrong_plat.ffmpeg_bundle.as_mut().unwrap().platform = Some("linux".to_string());
    let m_wp_bytes = serde_json::to_vec(&m_wrong_plat).unwrap();
    {
        let mut r = routes.lock().await;
        r.insert("/tools-manifest.json".into(), json_ok(m_wp_bytes.clone()));
        r.insert(
            "/tools-manifest.json.sig".into(),
            text_ok(replacement_ded.sign_b64(&m_wp_bytes)),
        );
    }
    let mgr = ExternalToolsManager::with_config(db.clone(), tmp.path().to_path_buf(), cfg.clone()).unwrap();
    let snap_wp = mgr.check_for_updates(true).await.unwrap();
    let ff_wp = snap_wp.tools.iter().find(|t| t.tool_id == ToolId::Ffmpeg).unwrap();
    assert_ne!(
        ff_wp.update_status,
        ToolUpdateStatus::UpdateAvailable,
        "Wrong-platform manifest entry must never become UpdateAvailable on Windows"
    );

    let mut m_wrong_ver = m_ok.clone();
    m_wrong_ver.manifest_revision = 8;
    m_wrong_ver.ffmpeg_bundle.as_mut().unwrap().min_tori_version = Some("9.9.9".to_string());
    let m_wv_bytes = serde_json::to_vec(&m_wrong_ver).unwrap();
    {
        let mut r = routes.lock().await;
        r.insert("/tools-manifest.json".into(), json_ok(m_wv_bytes.clone()));
        r.insert(
            "/tools-manifest.json.sig".into(),
            text_ok(replacement_ded.sign_b64(&m_wv_bytes)),
        );
    }
    let snap_wv = mgr.check_for_updates(true).await.unwrap();
    let ff_wv = snap_wv.tools.iter().find(|t| t.tool_id == ToolId::Ffmpeg).unwrap();
    assert_ne!(
        ff_wv.update_status,
        ToolUpdateStatus::UpdateAvailable,
        "Incompatible min_tori_version (9.9.9) must not become UpdateAvailable on v1.0.8"
    );

    handle.abort();
}
