//! Cryptographic Verification Test Suite for TORI Download Manager Updater
//! Gate 13.5.1: Signed Updater End-to-End Verification
//!
//! Verifies:
//! 1. Base64-encoded Minisign public key in tauri.conf.json matches out-of-repo public key.
//! 2. Detached signature on TORI Download Manager_1.0.0_x64-setup.exe cryptographically verifies.
//! 3. Tampered payload (any bit flipped) is strictly rejected by Ed25519 Minisign verification.
//! 4. Corrupted signature string is strictly rejected.
//! 5. Trusted comment in Minisign signature contains authentic filename and timestamp.
//! 6. latest.json platform signature matches the standalone .sig file.

use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use std::fs;
use std::path::PathBuf;

fn get_project_root() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}

fn decode_base64_str(input: &str) -> Vec<u8> {
    let cleaned = input.trim().replace("\r\n", "").replace('\n', "");
    base64::engine::general_purpose::STANDARD
        .decode(cleaned)
        .expect("Base64 decode failed")
}

#[test]
fn test_updater_public_key_decoding_and_format() {
    let root = get_project_root();
    let conf_path = root.join("src-tauri").join("tauri.conf.json");
    let conf_text = fs::read_to_string(&conf_path).expect("Failed to read tauri.conf.json");
    let conf: serde_json::Value =
        serde_json::from_str(&conf_text).expect("Failed to parse tauri.conf.json");

    let pubkey_base64 = conf["plugins"]["updater"]["pubkey"]
        .as_str()
        .expect("Missing pubkey in tauri.conf.json");

    let decoded_pubkey_bytes = decode_base64_str(pubkey_base64);
    let decoded_pubkey_str =
        String::from_utf8(decoded_pubkey_bytes).expect("Decoded public key is not UTF-8");

    assert!(
        decoded_pubkey_str.starts_with("untrusted comment: minisign public key"),
        "Public key header is invalid: {}",
        decoded_pubkey_str
    );

    // Parse with minisign_verify
    let public_key = PublicKey::decode(&decoded_pubkey_str)
        .expect("Failed to parse decoded Minisign public key");

    // Also check out-of-repo public key if present in USERPROFILE
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        let out_of_repo_pub = PathBuf::from(home)
            .join(".tori-keys")
            .join("tori-updater.key.pub");
        if out_of_repo_pub.exists() {
            let disk_pub = fs::read_to_string(&out_of_repo_pub)
                .expect("Failed to read out-of-repo public key");
            let disk_pub_clean = disk_pub.trim().replace("\r\n", "\n");
            let conf_pub_clean = pubkey_base64.trim().replace("\r\n", "\n");
            assert_eq!(
                disk_pub_clean, conf_pub_clean,
                "Embedded public key in tauri.conf.json must match %USERPROFILE%\\.tori-keys\\tori-updater.key.pub"
            );
        }
    }

    // Ensure public key has untrusted comment
    assert!(
        public_key.untrusted_comment().is_some(),
        "Public key must contain untrusted comment"
    );
}

#[test]
fn test_installer_signature_cryptographic_verification() {
    let root = get_project_root();
    let installer_path = root
        .join("target")
        .join("release")
        .join("bundle")
        .join("nsis")
        .join("TORI Download Manager_1.0.0_x64-setup.exe");

    let sig_path = root
        .join("target")
        .join("release")
        .join("bundle")
        .join("nsis")
        .join("TORI Download Manager_1.0.0_x64-setup.exe.sig");

    if !installer_path.exists() || !sig_path.exists() {
        // Fall back to target/release/ directly if staged
        let alt_installer = root
            .join("target")
            .join("release")
            .join("TORI Download Manager_1.0.0_x64-setup.exe");
        let alt_sig = root
            .join("target")
            .join("release")
            .join("TORI Download Manager_1.0.0_x64-setup.exe.sig");
        if !alt_installer.exists() || !alt_sig.exists() {
            eprintln!("[SKIP] Installer or sig file not found for direct test; skipping.");
            return;
        }
    }

    let actual_installer_path = if installer_path.exists() {
        installer_path
    } else {
        root.join("target")
            .join("release")
            .join("TORI Download Manager_1.0.0_x64-setup.exe")
    };

    let actual_sig_path = if sig_path.exists() {
        sig_path
    } else {
        root.join("target")
            .join("release")
            .join("TORI Download Manager_1.0.0_x64-setup.exe.sig")
    };

    let installer_bytes =
        fs::read(&actual_installer_path).expect("Failed to read installer executable");
    assert!(
        installer_bytes.starts_with(b"MZ"),
        "Packaged installer must be a valid PE executable starting with MZ header"
    );

    let sig_str = fs::read_to_string(&actual_sig_path).expect("Failed to read .sig file");
    let sig_raw = decode_base64_str(&sig_str);
    let sig_text =
        String::from_utf8(sig_raw).expect("Signature base64 did not decode to UTF-8 text");

    assert!(
        sig_text.starts_with("untrusted comment: signature from tauri secret key")
            || sig_text.starts_with("untrusted comment: signature from minisign secret key"),
        "Invalid signature header: {}",
        sig_text
    );

    let signature =
        Signature::decode(&sig_text).expect("Signature failed to parse as Minisign Signature");

    // Load public key
    let conf_path = root.join("src-tauri").join("tauri.conf.json");
    let conf: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(conf_path).unwrap()).unwrap();
    let pubkey_base64 = conf["plugins"]["updater"]["pubkey"].as_str().unwrap();
    let decoded_pubkey = String::from_utf8(decode_base64_str(pubkey_base64)).unwrap();
    let public_key = PublicKey::decode(&decoded_pubkey).expect("Public key decode failed");

    // Cryptographic verification
    let verify_res = public_key.verify(&installer_bytes, &signature, true);
    assert!(
        verify_res.is_ok(),
        "Ed25519 Minisign signature verification failed for production installer: {:?}",
        verify_res.err()
    );

    // Verify trusted comment structure
    let trusted_comment = signature.trusted_comment();
    assert!(
        trusted_comment.contains("file:TORI Download Manager_1.0.0_x64-setup.exe"),
        "Trusted comment must reference the installer filename: {}",
        trusted_comment
    );
    assert!(
        trusted_comment.contains("timestamp:"),
        "Trusted comment must contain a Unix timestamp: {}",
        trusted_comment
    );
}

#[test]
fn test_tampered_payload_strictly_rejected() {
    let root = get_project_root();
    let actual_installer_path = root
        .join("target")
        .join("release")
        .join("TORI Download Manager_1.0.0_x64-setup.exe");

    let actual_sig_path = root
        .join("target")
        .join("release")
        .join("TORI Download Manager_1.0.0_x64-setup.exe.sig");

    if !actual_installer_path.exists() || !actual_sig_path.exists() {
        return;
    }

    let mut installer_bytes = fs::read(&actual_installer_path).unwrap();
    let sig_str = fs::read_to_string(&actual_sig_path).unwrap();
    let sig_raw = decode_base64_str(&sig_str);
    let sig_text = String::from_utf8(sig_raw).unwrap();
    let signature = Signature::decode(&sig_text).unwrap();

    let conf_path = root.join("src-tauri").join("tauri.conf.json");
    let conf: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(conf_path).unwrap()).unwrap();
    let pubkey_base64 = conf["plugins"]["updater"]["pubkey"].as_str().unwrap();
    let decoded_pubkey = String::from_utf8(decode_base64_str(pubkey_base64)).unwrap();
    let public_key = PublicKey::decode(&decoded_pubkey).unwrap();

    // Tamper single byte in the installer binary
    let tamper_offset = installer_bytes.len() / 2;
    installer_bytes[tamper_offset] ^= 0xFF;

    // Cryptographic verification MUST fail
    let verify_res = public_key.verify(&installer_bytes, &signature, true);
    assert!(
        verify_res.is_err(),
        "Tampered payload must NEVER pass signature verification!"
    );
}

#[test]
fn test_corrupted_signature_strictly_rejected() {
    let root = get_project_root();
    let actual_installer_path = root
        .join("target")
        .join("release")
        .join("TORI Download Manager_1.0.0_x64-setup.exe");

    let actual_sig_path = root
        .join("target")
        .join("release")
        .join("TORI Download Manager_1.0.0_x64-setup.exe.sig");

    if !actual_installer_path.exists() || !actual_sig_path.exists() {
        return;
    }

    let installer_bytes = fs::read(&actual_installer_path).unwrap();
    let sig_str = fs::read_to_string(&actual_sig_path).unwrap();
    let mut sig_raw = decode_base64_str(&sig_str);

    // Corrupt signature bytes
    let sig_len = sig_raw.len();
    sig_raw[sig_len - 10] ^= 0xFF;

    let corrupt_text = String::from_utf8_lossy(&sig_raw);

    let conf_path = root.join("src-tauri").join("tauri.conf.json");
    let conf: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(conf_path).unwrap()).unwrap();
    let pubkey_base64 = conf["plugins"]["updater"]["pubkey"].as_str().unwrap();
    let decoded_pubkey = String::from_utf8(decode_base64_str(pubkey_base64)).unwrap();
    let public_key = PublicKey::decode(&decoded_pubkey).unwrap();

    if let Ok(corrupt_sig) = Signature::decode(&corrupt_text) {
        let verify_res = public_key.verify(&installer_bytes, &corrupt_sig, true);
        assert!(
            verify_res.is_err(),
            "Corrupted signature must fail verification!"
        );
    }
    // If Signature::decode fails, the corrupted signature was cleanly rejected at parsing time.
}

#[test]
fn test_latest_json_matches_signature_file() {
    let root = get_project_root();
    let latest_json_path = root.join("target").join("release").join("latest.json");
    let sig_path = root
        .join("target")
        .join("release")
        .join("TORI Download Manager_1.0.0_x64-setup.exe.sig");

    if !latest_json_path.exists() || !sig_path.exists() {
        return;
    }

    let latest_json_str = fs::read_to_string(&latest_json_path).unwrap();
    let latest_json: serde_json::Value = serde_json::from_str(&latest_json_str).unwrap();

    let manifest_sig = latest_json["platforms"]["windows-x86_64"]["signature"]
        .as_str()
        .expect("latest.json must have windows-x86_64 signature");

    let file_sig = fs::read_to_string(&sig_path).unwrap().trim().to_string();

    assert_eq!(
        manifest_sig.trim(),
        file_sig.trim(),
        "latest.json signature must match .sig file contents identically"
    );

    assert_eq!(
        latest_json["version"].as_str().unwrap(),
        "1.0.0",
        "latest.json version must be 1.0.0"
    );

    let download_url = latest_json["platforms"]["windows-x86_64"]["url"]
        .as_str()
        .unwrap();
    assert!(
        download_url.starts_with("https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.0/"),
        "Download URL must point to verified GitHub Releases: {}",
        download_url
    );
}

#[test]
fn test_v105_release_candidate_signature_cryptographic_verification() {
    let root = get_project_root();
    let installer_path = root
        .join("release")
        .join("v1.0.5-rc")
        .join("TORI Download Manager_1.0.5_x64-setup.exe");
    let sig_path = root
        .join("release")
        .join("v1.0.5-rc")
        .join("TORI Download Manager_1.0.5_x64-setup.exe.sig");

    assert!(
        installer_path.exists(),
        "v1.0.5 RC installer must exist (never skip): {:?}",
        installer_path
    );
    assert!(
        sig_path.exists(),
        "v1.0.5 RC detached .sig must exist (never skip): {:?}",
        sig_path
    );

    let installer_bytes =
        fs::read(&installer_path).expect("Failed to read v1.0.5 RC installer executable");
    assert!(
        installer_bytes.starts_with(b"MZ"),
        "v1.0.5 RC installer must start with MZ PE header"
    );

    let sig_str = fs::read_to_string(&sig_path).expect("Failed to read v1.0.5 RC .sig file");
    let sig_raw = decode_base64_str(&sig_str);
    let sig_text =
        String::from_utf8(sig_raw).expect("v1.0.5 signature base64 did not decode to UTF-8");
    assert!(
        sig_text.starts_with("untrusted comment: signature from tauri secret key")
            || sig_text.starts_with("untrusted comment: signature from minisign secret key"),
        "Invalid v1.0.5 signature header: {}",
        sig_text
    );

    let signature = Signature::decode(&sig_text)
        .expect("v1.0.5 signature failed to parse as Minisign Signature");

    let conf_path = root.join("src-tauri").join("tauri.conf.json");
    let conf: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&conf_path).unwrap()).unwrap();
    let pubkey_base64 = conf["plugins"]["updater"]["pubkey"].as_str().unwrap();
    let decoded_pubkey = String::from_utf8(decode_base64_str(pubkey_base64)).unwrap();
    let public_key = PublicKey::decode(&decoded_pubkey).expect("Public key decode failed");

    let verify_res = public_key.verify(&installer_bytes, &signature, true);
    assert!(
        verify_res.is_ok(),
        "Ed25519 Minisign signature verification failed for v1.0.5 RC installer: {:?}",
        verify_res.err()
    );

    let trusted_comment = signature.trusted_comment();
    assert!(
        trusted_comment.contains("file:TORI Download Manager_1.0.5_x64-setup.exe"),
        "Trusted comment must reference v1.0.5 installer filename: {}",
        trusted_comment
    );
    assert!(
        trusted_comment.contains("timestamp:"),
        "Trusted comment must contain timestamp: {}",
        trusted_comment
    );

    let mut tampered = installer_bytes.clone();
    let mid = tampered.len() / 2;
    tampered[mid] ^= 0x42;
    assert!(
        public_key.verify(&tampered, &signature, true).is_err(),
        "Tampered v1.0.5 RC payload must be rejected by Ed25519 Minisign verification"
    );

    let bad_sig_str = format!("{}A", sig_str.trim());
    if let Ok(bad_raw) = base64::engine::general_purpose::STANDARD.decode(&bad_sig_str) {
        if let Ok(bad_text) = String::from_utf8(bad_raw) {
            if let Ok(bad_sig) = Signature::decode(&bad_text) {
                assert!(
                    public_key.verify(&installer_bytes, &bad_sig, true).is_err(),
                    "Corrupted v1.0.5 signature must be rejected"
                );
            }
        }
    }

    let frozen_root = root.join("release").join("v1.0.5-v1.0.9-final-rc");
    let draft_manifest_path = frozen_root.join("Metadata").join("latest.v1.0.5.draft.json");
    let frozen_installer_path = frozen_root
        .join("Desktop")
        .join("TORI Download Manager_1.0.5_x64-setup.exe");
    assert!(draft_manifest_path.exists(), "Draft v1.0.5 updater manifest must exist");
    assert!(frozen_installer_path.exists(), "Frozen v1.0.5 installer must exist");
    assert_eq!(
        fs::read(&frozen_installer_path).unwrap(),
        installer_bytes,
        "Frozen v1.0.5 installer must be byte-identical to release/v1.0.5-rc installer"
    );

    let draft_json: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&draft_manifest_path).unwrap()).unwrap();
    assert_eq!(draft_json["version"].as_str(), Some("1.0.5"));
    for key in ["windows-x86_64", "windows-x86_64-nsis"] {
        let plat_sig = draft_json["platforms"][key]["signature"]
            .as_str()
            .expect("Draft updater platform signature missing");
        assert_eq!(plat_sig.trim(), sig_str.trim());
        let plat_url = draft_json["platforms"][key]["url"]
            .as_str()
            .expect("Draft updater platform url missing");
        assert!(
            plat_url.starts_with(
                "https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.5/"
            ),
            "Unexpected draft platform url: {}",
            plat_url
        );
    }
}

#[test]
fn test_v106_release_candidate_signature_cryptographic_verification() {
    let root = get_project_root();
    let installer_path = root
        .join("release")
        .join("v1.0.6-rc")
        .join("TORI Download Manager_1.0.6_x64-setup.exe");
    let sig_path = root
        .join("release")
        .join("v1.0.6-rc")
        .join("TORI Download Manager_1.0.6_x64-setup.exe.sig");

    assert!(
        installer_path.exists(),
        "v1.0.6 RC installer must exist: {:?}",
        installer_path
    );
    assert!(
        sig_path.exists(),
        "v1.0.6 RC detached .sig must exist: {:?}",
        sig_path
    );

    let installer_bytes =
        fs::read(&installer_path).expect("Failed to read v1.0.6 RC installer executable");
    assert!(
        installer_bytes.starts_with(b"MZ"),
        "v1.0.6 RC installer must start with MZ PE header"
    );

    let sig_str = fs::read_to_string(&sig_path).expect("Failed to read v1.0.6 RC .sig file");
    let sig_raw = decode_base64_str(&sig_str);
    let sig_text =
        String::from_utf8(sig_raw).expect("v1.0.6 signature base64 did not decode to UTF-8");
    let signature = Signature::decode(&sig_text)
        .expect("v1.0.6 signature failed to parse as Minisign Signature");

    let conf_path = root.join("src-tauri").join("tauri.conf.json");
    let conf: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&conf_path).unwrap()).unwrap();
    let pubkey_base64 = conf["plugins"]["updater"]["pubkey"].as_str().unwrap();
    let decoded_pubkey = String::from_utf8(decode_base64_str(pubkey_base64)).unwrap();
    let public_key = PublicKey::decode(&decoded_pubkey).expect("Public key decode failed");

    let verify_res = public_key.verify(&installer_bytes, &signature, true);
    assert!(
        verify_res.is_ok(),
        "Ed25519 Minisign signature verification failed for v1.0.6 RC installer: {:?}",
        verify_res.err()
    );

    let trusted_comment = signature.trusted_comment();
    assert!(
        trusted_comment.contains("file:TORI Download Manager_1.0.6_x64-setup.exe"),
        "Trusted comment must reference v1.0.6 installer filename: {}",
        trusted_comment
    );

    let mut tampered = installer_bytes.clone();
    let mid = tampered.len() / 2;
    tampered[mid] ^= 0x55;
    assert!(
        public_key.verify(&tampered, &signature, true).is_err(),
        "Tampered v1.0.6 RC payload must be rejected by Ed25519 Minisign verification"
    );
}

#[test]
fn test_v107_release_candidate_signature_draft_updater_and_production_tools_manifest() {
    let root = get_project_root();
    let rc_dir = root.join("release").join("v1.0.7-rc");
    let installer_path = rc_dir.join("TORI Download Manager_1.0.7_x64-setup.exe");
    let sig_path = rc_dir.join("TORI Download Manager_1.0.7_x64-setup.exe.sig");
    let draft_latest_path = rc_dir.join("draft_latest.json");
    let prod_manifest_dir = rc_dir.join("tools-manifest-production");
    let prod_manifest_path = prod_manifest_dir.join("tools-manifest.json");
    let prod_manifest_sig_path = prod_manifest_dir.join("tools-manifest.json.sig");

    // 1. Verify Tauri & ToolsManagerConfig production defaults never point to /staging/
    let conf_path = root.join("src-tauri").join("tauri.conf.json");
    let conf: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&conf_path).unwrap()).unwrap();
    let current_ver = conf["version"].as_str().unwrap();
    assert!(
        matches!(
            tdm_core::tools::compare_semver_versions(current_ver, "1.0.7"),
            Some(std::cmp::Ordering::Equal | std::cmp::Ordering::Greater)
        ),
        "Current workspace version ({}) must be >= 1.0.7",
        current_ver
    );
    let pubkey_base64 = conf["plugins"]["updater"]["pubkey"].as_str().unwrap();
    assert_eq!(pubkey_base64, tdm_core::tools::TORI_ED25519_PUBKEY_B64);

    let tools_cfg = tdm_core::tools::ToolsManagerConfig::default();
    assert_eq!(
        tools_cfg.signed_manifest_url.as_deref(),
        Some("https://toridownload.xyz/assets/tools/tools-manifest.json")
    );
    assert!(
        !tools_cfg
            .signed_manifest_url
            .as_deref()
            .unwrap()
            .contains("/staging/"),
        "Production ToolsManagerConfig must never default to /staging/"
    );
    assert_eq!(
        tools_cfg.expected_manifest_key_id.as_deref(),
        Some(tdm_core::tools::TORI_ED25519_KEY_ID)
    );
    assert_eq!(tools_cfg.current_tori_version, current_ver);

    // 2. Verify signed v1.0.7 RC NSIS installer & detached .sig
    assert!(installer_path.exists(), "v1.0.7 RC installer missing: {:?}", installer_path);
    assert!(sig_path.exists(), "v1.0.7 RC .sig missing: {:?}", sig_path);

    let installer_bytes = fs::read(&installer_path).expect("read v1.0.7 installer");
    assert!(installer_bytes.starts_with(b"MZ"), "v1.0.7 installer must be Windows PE");

    let sig_str = fs::read_to_string(&sig_path).expect("read v1.0.7 .sig");
    let sig_text = String::from_utf8(decode_base64_str(&sig_str)).expect("utf8 sig");
    let signature = Signature::decode(&sig_text).expect("minisign signature decode");
    let decoded_pubkey = String::from_utf8(decode_base64_str(pubkey_base64)).unwrap();
    let public_key = PublicKey::decode(&decoded_pubkey).expect("pubkey decode");

    public_key
        .verify(&installer_bytes, &signature, true)
        .expect("v1.0.7 RC installer Ed25519 verification must pass");
    assert!(
        signature
            .trusted_comment()
            .contains("file:TORI Download Manager_1.0.7_x64-setup.exe"),
        "Trusted comment mismatch: {}",
        signature.trusted_comment()
    );

    let mut tampered = installer_bytes.clone();
    let mid = tampered.len() / 2;
    tampered[mid] ^= 0xA5;
    assert!(
        public_key.verify(&tampered, &signature, true).is_err(),
        "Tampered v1.0.7 RC installer must be rejected"
    );

    // 3. Verify local unpublished draft_latest.json schema, SemVer ordering & exact signature parity
    assert!(draft_latest_path.exists(), "draft_latest.json missing");
    let draft: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&draft_latest_path).unwrap()).unwrap();
    assert_eq!(draft["version"].as_str(), Some("1.0.7"));
    assert_eq!(
        tdm_core::tools::compare_semver_versions("1.0.6", draft["version"].as_str().unwrap()),
        Some(std::cmp::Ordering::Less)
    );
    assert_eq!(
        tdm_core::tools::compare_semver_versions("1.0.7", draft["version"].as_str().unwrap()),
        Some(std::cmp::Ordering::Equal)
    );
    assert_eq!(
        tdm_core::tools::compare_semver_versions("1.0.8", draft["version"].as_str().unwrap()),
        Some(std::cmp::Ordering::Greater)
    );
    for key in ["windows-x86_64", "windows-x86_64-nsis"] {
        assert_eq!(
            draft["platforms"][key]["signature"].as_str().map(str::trim),
            Some(sig_str.trim())
        );
        let url = draft["platforms"][key]["url"].as_str().unwrap();
        assert!(
            url.starts_with(
                "https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.7/"
            ),
            "Unexpected draft v1.0.7 URL: {}",
            url
        );
    }

    // 4. Verify staged production tools-manifest.json + .sig (unpublished, ready for Gate 32.3 promotion)
    assert!(prod_manifest_path.exists(), "production tools-manifest.json missing");
    assert!(prod_manifest_sig_path.exists(), "production tools-manifest.json.sig missing");
    let pm_bytes = fs::read(&prod_manifest_path).expect("read prod tools manifest");
    let pm_sig = fs::read_to_string(&prod_manifest_sig_path).expect("read prod tools sig");
    tdm_core::tools::verify_minisign_ed25519(
        tdm_core::tools::TORI_ED25519_PUBKEY_B64,
        &pm_bytes,
        &pm_sig,
    )
    .expect("Production tools manifest Ed25519 signature must verify");
    tdm_core::tools::reject_duplicate_json_keys(&pm_bytes)
        .expect("Production tools manifest must have no duplicate JSON keys");
    let pm: tdm_core::tools::SignedToolsManifest =
        serde_json::from_slice(&pm_bytes).expect("parse prod tools manifest");
    assert_eq!(pm.schema_version, 2);
    assert!(pm.manifest_revision >= 1);
    assert_eq!(
        pm.signing_key_id.as_deref(),
        Some(tdm_core::tools::TORI_ED25519_KEY_ID)
    );
    let ff = pm.ffmpeg_bundle.expect("ffmpeg_bundle required");
    assert_eq!(ff.platform.as_deref(), Some("windows"));
    assert_eq!(ff.architecture.as_deref(), Some("x86_64"));
    assert!(ff.url.starts_with("https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/tools-ffmpeg-"));
    assert!(!ff.url.contains("/latest/"), "Artifact URL must be immutable");
    assert_eq!(
        tdm_core::tools::compare_semver_versions("1.0.7", ff.min_tori_version.as_deref().unwrap()),
        Some(std::cmp::Ordering::Greater)
    );
    let mut pm_tampered = pm_bytes.clone();
    pm_tampered[10] ^= 0x01;
    assert!(tdm_core::tools::verify_minisign_ed25519(
        tdm_core::tools::TORI_ED25519_PUBKEY_B64,
        &pm_tampered,
        &pm_sig,
    )
    .is_err());
}

#[test]
fn test_v108_release_candidate_signature_draft_updater_stage1_keyring_and_rev2_candidate() {
    let root = get_project_root();
    let rc_dir = root.join("release").join("v1.0.8-rc");
    let installer_path = rc_dir.join("TORI Download Manager_1.0.8_x64-setup.exe");
    let sig_path = rc_dir.join("TORI Download Manager_1.0.8_x64-setup.exe.sig");
    let draft_latest_path = rc_dir.join("draft_latest.json");
    let rev2_dir = rc_dir.join("tools-manifest-rev2-candidate");
    let rev2_manifest_path = rev2_dir.join("tools-manifest.json");
    let rev2_sig_path = rev2_dir.join("tools-manifest.json.sig");
    let rev2_tools_sig_path = rev2_dir.join("tools-manifest.json.tools.sig");
    let rev2_race_policy_path = rev2_dir.join("RACE_PRECHECK_POLICY.json");

    // 1. Verify workspace config (>= 1.0.8), production defaults & Stage 1 TrustedToolsKeyring safety
    let conf_path = root.join("src-tauri").join("tauri.conf.json");
    let conf: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&conf_path).unwrap()).unwrap();
    let ws_ver = env!("CARGO_PKG_VERSION");
    assert_eq!(conf["version"].as_str(), Some(ws_ver));
    assert!(matches!(
        tdm_core::tools::compare_semver_versions(ws_ver, "1.0.8"),
        Some(std::cmp::Ordering::Equal | std::cmp::Ordering::Greater)
    ));
    let pubkey_base64 = conf["plugins"]["updater"]["pubkey"].as_str().unwrap();
    assert_eq!(pubkey_base64, tdm_core::tools::TORI_ED25519_PUBKEY_B64);

    let tools_cfg = tdm_core::tools::ToolsManagerConfig::default();
    assert_eq!(tools_cfg.current_tori_version, ws_ver);
    assert_eq!(
        tools_cfg.signed_manifest_url.as_deref(),
        Some("https://toridownload.xyz/assets/tools/tools-manifest.json")
    );
    assert!(
        !tools_cfg.signed_manifest_url.as_deref().unwrap().contains("/staging/"),
        "v1.0.8-rc must never default to /staging/"
    );
    let effective_kr = tools_cfg.effective_tools_keyring();
    effective_kr
        .validate_safety(chrono::Utc::now(), tools_cfg.max_clock_skew_secs)
        .expect("Default Stage 1 transition keyring must pass safety validation");
    assert!(
        effective_kr.allow_legacy_shared_key,
        "Stage 1 v1.0.8 must preserve legacy shared key compatibility for rev 1 / rev 2"
    );

    // 2. Verify signed v1.0.8-rc NSIS installer & detached Ed25519 .sig
    assert!(installer_path.exists(), "v1.0.8-rc installer missing: {:?}", installer_path);
    assert!(sig_path.exists(), "v1.0.8-rc .sig missing: {:?}", sig_path);

    let installer_bytes = fs::read(&installer_path).expect("read v1.0.8 installer");
    assert!(installer_bytes.starts_with(b"MZ"), "v1.0.8 installer must be Windows PE");

    let sig_str = fs::read_to_string(&sig_path).expect("read v1.0.8 .sig");
    let sig_text = String::from_utf8(decode_base64_str(&sig_str)).expect("utf8 sig");
    let signature = Signature::decode(&sig_text).expect("minisign signature decode");
    let decoded_pubkey = String::from_utf8(decode_base64_str(pubkey_base64)).unwrap();
    let public_key = PublicKey::decode(&decoded_pubkey).expect("pubkey decode");

    public_key
        .verify(&installer_bytes, &signature, true)
        .expect("v1.0.8-rc installer Ed25519 verification must pass");
    assert!(
        signature
            .trusted_comment()
            .contains("file:TORI Download Manager_1.0.8_x64-setup.exe"),
        "Trusted comment mismatch: {}",
        signature.trusted_comment()
    );

    let mut tampered = installer_bytes.clone();
    let mid = tampered.len() / 2;
    tampered[mid] ^= 0x5A;
    assert!(
        public_key.verify(&tampered, &signature, true).is_err(),
        "Tampered v1.0.8-rc installer must be rejected"
    );

    // 3. Verify local unpublished draft_latest.json schema, SemVer ordering & exact signature parity
    assert!(draft_latest_path.exists(), "draft_latest.json missing");
    let draft: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&draft_latest_path).unwrap()).unwrap();
    assert_eq!(draft["version"].as_str(), Some("1.0.8"));
    assert_eq!(
        tdm_core::tools::compare_semver_versions("1.0.7", draft["version"].as_str().unwrap()),
        Some(std::cmp::Ordering::Less)
    );
    assert_eq!(
        tdm_core::tools::compare_semver_versions("1.0.8", draft["version"].as_str().unwrap()),
        Some(std::cmp::Ordering::Equal)
    );
    for key in ["windows-x86_64", "windows-x86_64-nsis"] {
        assert_eq!(
            draft["platforms"][key]["signature"].as_str().map(str::trim),
            Some(sig_str.trim())
        );
        let url = draft["platforms"][key]["url"].as_str().unwrap();
        assert!(
            url.starts_with(
                "https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.8/"
            ),
            "Unexpected draft v1.0.8 URL: {}",
            url
        );
    }

    // 4. Verify unpublished UNSIGNED production manifest revision 2 candidate & race guard policy
    assert!(rev2_manifest_path.exists(), "rev 2 candidate tools-manifest.json missing");
    assert!(rev2_race_policy_path.exists(), "rev 2 RACE_PRECHECK_POLICY.json missing");
    assert!(
        !rev2_sig_path.exists() && !rev2_tools_sig_path.exists(),
        "Production manifest rev 2 candidate must remain UNSIGNED during Gate 33.1 (never place test-key signatures in production candidate dir)"
    );

    let rev2_bytes = fs::read(&rev2_manifest_path).expect("read rev 2 candidate");
    tdm_core::tools::reject_duplicate_json_keys(&rev2_bytes)
        .expect("rev 2 candidate must have no duplicate JSON keys");
    let rev2: tdm_core::tools::SignedToolsManifest =
        serde_json::from_slice(&rev2_bytes).expect("parse rev 2 candidate");
    assert_eq!(rev2.schema_version, 2);
    assert_eq!(rev2.manifest_revision, 2);
    assert_eq!(
        rev2.signing_key_id.as_deref(),
        Some(tdm_core::tools::TORI_ED25519_KEY_ID)
    );
    assert_eq!(rev2.key_purpose.as_deref(), Some("external_tools_manifest"));
    let ff = rev2.ffmpeg_bundle.expect("ffmpeg_bundle required");
    assert_eq!(ff.version, "N-129150-g7ddf7bc8a4-20261120");
    assert_eq!(
        ff.sha256,
        "03d33066832e7149a8577bed73713c5d5344aed14199063e521b798cf1b60076"
    );
    assert_eq!(ff.size, Some(205_445_856));
    assert_eq!(ff.platform.as_deref(), Some("windows"));
    assert_eq!(ff.architecture.as_deref(), Some("x86_64"));
    assert_eq!(ff.min_tori_version.as_deref(), Some("1.0.6"));
}

#[test]
fn test_v108_final_rc_production_dedicated_key_and_signature_verification() {
    let root = get_project_root();

    // 1. Verify embedded Stage 1 dedicated External Tools public key (C3FD6626A3718E63)
    //    is strictly separated from Desktop Updater key (CDC23D8CC8DA5397).
    let ded_kid = tdm_core::tools::TORI_DEDICATED_TOOLS_ED25519_KEY_ID
        .expect("Dedicated External Tools key ID must be embedded in Gate 33.3");
    let ded_pub = tdm_core::tools::TORI_DEDICATED_TOOLS_ED25519_PUBKEY_B64
        .expect("Dedicated External Tools public key must be embedded in Gate 33.3");
    assert_eq!(ded_kid, "C3FD6626A3718E63");
    assert_ne!(ded_kid, tdm_core::tools::TORI_ED25519_KEY_ID);
    assert_ne!(ded_pub, tdm_core::tools::TORI_ED25519_PUBKEY_B64);
    assert_eq!(
        tdm_core::tools::extract_minisign_key_id_hex(ded_pub).as_deref(),
        Some("C3FD6626A3718E63")
    );

    // Decode Minisign public key box and confirm SHA-256 fingerprint of raw 32-byte Ed25519 key
    let decoded_ded = String::from_utf8(decode_base64_str(ded_pub)).expect("UTF-8 dedicated pubkey");
    let _parsed_ded_pk = PublicKey::decode(&decoded_ded).expect("Valid Minisign dedicated pubkey");
    let key_line = decoded_ded
        .lines()
        .find(|l| !l.trim().is_empty() && !l.trim().starts_with("untrusted comment:"))
        .expect("Minisign key box line");
    let key_raw = decode_base64_str(key_line);
    assert_eq!(key_raw.len(), 42);
    use sha2::{Digest, Sha256};
    let fp = hex::encode(Sha256::digest(&key_raw[10..42]));
    assert_eq!(
        fp,
        "6807e183f56c08eb06fdff95347bbbf7174b4ce5185b0245155db315e87fee39"
    );

    // If operator public key exists out-of-repo, assert bit-for-bit parity
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        let disk_pub_path = PathBuf::from(home).join(".tori-keys").join("tori-tools.key.pub");
        if disk_pub_path.exists() {
            let disk_pub = fs::read_to_string(&disk_pub_path)
                .expect("read tori-tools.key.pub")
                .trim()
                .to_string();
            assert_eq!(
                disk_pub, ded_pub,
                "Embedded TORI_DEDICATED_TOOLS_ED25519_PUBKEY_B64 must match %USERPROFILE%\\.tori-keys\\tori-tools.key.pub"
            );
        }
    }

    // Confirm Desktop Auto-Updater key in tauri.conf.json remains CDC23D8CC8DA5397 (unchanged!)
    let conf_path = root.join("src-tauri").join("tauri.conf.json");
    let conf: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&conf_path).unwrap()).unwrap();
    let ws_ver = env!("CARGO_PKG_VERSION");
    assert_eq!(conf["version"].as_str(), Some(ws_ver));
    assert!(matches!(
        tdm_core::tools::compare_semver_versions(ws_ver, "1.0.8"),
        Some(std::cmp::Ordering::Equal | std::cmp::Ordering::Greater)
    ));
    let updater_pub = conf["plugins"]["updater"]["pubkey"].as_str().unwrap();
    assert_eq!(updater_pub, tdm_core::tools::TORI_ED25519_PUBKEY_B64);
    assert_ne!(updater_pub, ded_pub);

    // Confirm default Stage 1 keyring contains BOTH legacy CDC23D8CC8DA5397 & dedicated C3FD6626A3718E63
    let tools_cfg = tdm_core::tools::ToolsManagerConfig::default();
    let kr = tools_cfg.effective_tools_keyring();
    assert!(kr.allow_legacy_shared_key);
    assert!(kr.has_dedicated_active_key());
    assert_eq!(kr.keys.len(), 2);
    assert!(kr.validate_safety(chrono::Utc::now(), tools_cfg.max_clock_skew_secs).is_ok());

    // 2. Verify release/v1.0.8-final-rc/ if present (after Phase 4 Final RC build)
    let final_rc_dir = root.join("release").join("v1.0.8-final-rc");
    if final_rc_dir.exists() {
        let installer_path = final_rc_dir.join("TORI Download Manager_1.0.8_x64-setup.exe");
        let sig_path = final_rc_dir.join("TORI Download Manager_1.0.8_x64-setup.exe.sig");
        let draft_latest_path = final_rc_dir.join("draft_latest.json");
        let build_meta_path = final_rc_dir.join("BUILD_METADATA.json");

        assert!(installer_path.exists(), "Final RC installer missing");
        assert!(sig_path.exists(), "Final RC .sig missing");
        assert!(draft_latest_path.exists(), "Final RC draft_latest.json missing");
        assert!(build_meta_path.exists(), "Final RC BUILD_METADATA.json missing");

        // Ensure zero private keys or password files leaked into release/v1.0.8-final-rc/
        for entry in fs::read_dir(&final_rc_dir).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            assert!(
                !name.ends_with(".key") && !name.ends_with(".pwd"),
                "Forbidden secret file found in release/v1.0.8-final-rc: {}",
                name
            );
        }

        let installer_bytes = fs::read(&installer_path).expect("read final RC installer");
        assert!(installer_bytes.starts_with(b"MZ"));

        let sig_str = fs::read_to_string(&sig_path).expect("read final RC .sig");
        let sig_text = String::from_utf8(decode_base64_str(&sig_str)).expect("utf8 sig");
        let signature = Signature::decode(&sig_text).expect("minisign signature decode");
        let decoded_upd_pub = String::from_utf8(decode_base64_str(updater_pub)).unwrap();
        let updater_pk = PublicKey::decode(&decoded_upd_pub).expect("updater pubkey decode");

        updater_pk
            .verify(&installer_bytes, &signature, true)
            .expect("Final RC installer Ed25519 signature must verify under Desktop updater key CDC23D8CC8DA5397");
        assert!(
            signature
                .trusted_comment()
                .contains("file:TORI Download Manager_1.0.8_x64-setup.exe")
        );

        let mut tampered = installer_bytes.clone();
        let mid = tampered.len() / 2;
        tampered[mid] ^= 0x3C;
        assert!(
            updater_pk.verify(&tampered, &signature, true).is_err(),
            "Tampered Final RC installer must be rejected"
        );

        // Verify draft_latest.json matches .sig exactly
        let draft: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&draft_latest_path).unwrap()).unwrap();
        assert_eq!(draft["version"].as_str(), Some("1.0.8"));
        for key in ["windows-x86_64", "windows-x86_64-nsis"] {
            assert_eq!(
                draft["platforms"][key]["signature"].as_str().map(str::trim),
                Some(sig_str.trim())
            );
        }

        // Verify BUILD_METADATA.json references embedded dedicated key C3FD6626A3718E63
        let meta: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&build_meta_path).unwrap()).unwrap();
        assert_eq!(
            meta["dedicated_tools_public_key_id"].as_str(),
            Some("C3FD6626A3718E63")
        );
        assert_eq!(
            meta["desktop_updater_signing_key_id"].as_str(),
            Some("CDC23D8CC8DA5397")
        );
        assert_eq!(meta["published"].as_bool(), Some(false));
    }
}

#[test]
fn test_gate36_1_v109_release_candidate_cryptographic_and_stage1_dual_key_integrity() {
    let root = get_project_root();

    // 1. Verify Desktop workspace & Tauri config metadata consistently match 1.0.9
    let conf_path = root.join("src-tauri").join("tauri.conf.json");
    let conf: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&conf_path).unwrap()).unwrap();
    assert_eq!(conf["version"].as_str(), Some("1.0.9"));
    assert_eq!(env!("CARGO_PKG_VERSION"), "1.0.9");

    let ui_pkg: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(root.join("ui").join("package.json")).unwrap())
            .unwrap();
    assert_eq!(ui_pkg["version"].as_str(), Some("1.0.9"));

    let updater_pub = conf["plugins"]["updater"]["pubkey"].as_str().unwrap();
    assert_eq!(updater_pub, tdm_core::tools::TORI_ED25519_PUBKEY_B64);

    // 2. Verify Stage 1 dual-key External Tools keyring (legacy CDC23D8CC8DA5397 + dedicated C3FD6626A3718E63)
    let tools_cfg = tdm_core::tools::ToolsManagerConfig::default();
    assert_eq!(tools_cfg.current_tori_version, "1.0.9");
    assert_eq!(
        tools_cfg.signed_manifest_url.as_deref(),
        Some("https://toridownload.xyz/assets/tools/tools-manifest.json")
    );
    let kr = tools_cfg.effective_tools_keyring();
    assert!(
        kr.allow_legacy_shared_key,
        "Gate 36.1 must keep Stage 1 dual-key transition active (dedicated-only cutover prohibited)"
    );
    assert!(kr.has_dedicated_active_key());
    assert_eq!(kr.keys.len(), 2);
    kr.validate_safety(chrono::Utc::now(), tools_cfg.max_clock_skew_secs)
        .expect("v1.0.9 Stage 1 keyring must pass safety validation");

    // 3. Verify frozen release/v1.0.9-rc/ once built & signed
    let rc_dir = root.join("release").join("v1.0.9-rc");
    if rc_dir.exists() {
        let installer_path = rc_dir.join("TORI.Download.Manager_1.0.9_x64-setup.exe");
        let sig_path = rc_dir.join("TORI.Download.Manager_1.0.9_x64-setup.exe.sig");
        let draft_latest_path = rc_dir.join("draft_latest.json");
        let build_meta_path = rc_dir.join("BUILD_METADATA.json");

        assert!(installer_path.exists(), "v1.0.9-rc installer missing");
        assert!(sig_path.exists(), "v1.0.9-rc .sig missing");
        assert!(draft_latest_path.exists(), "v1.0.9-rc draft_latest.json missing");
        assert!(build_meta_path.exists(), "v1.0.9-rc BUILD_METADATA.json missing");

        for entry in fs::read_dir(&rc_dir).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            assert!(
                !name.ends_with(".key") && !name.ends_with(".pwd"),
                "Forbidden secret file found in release/v1.0.9-rc: {}",
                name
            );
        }

        let installer_bytes = fs::read(&installer_path).expect("read v1.0.9 installer");
        assert!(installer_bytes.starts_with(b"MZ"), "v1.0.9 installer must be Windows PE");

        let sig_str = fs::read_to_string(&sig_path).expect("read v1.0.9 .sig");
        let sig_text = String::from_utf8(decode_base64_str(&sig_str)).expect("utf8 sig");
        let signature = Signature::decode(&sig_text).expect("minisign signature decode");
        let decoded_upd_pub = String::from_utf8(decode_base64_str(updater_pub)).unwrap();
        let updater_pk = PublicKey::decode(&decoded_upd_pub).expect("updater pubkey decode");

        updater_pk
            .verify(&installer_bytes, &signature, true)
            .expect("v1.0.9-rc installer Ed25519 signature must verify under CDC23D8CC8DA5397");

        let mut tampered = installer_bytes.clone();
        let mid = tampered.len() / 2;
        tampered[mid] ^= 0x55;
        assert!(
            updater_pk.verify(&tampered, &signature, true).is_err(),
            "Tampered v1.0.9-rc installer must be rejected"
        );

        let draft: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&draft_latest_path).unwrap()).unwrap();
        assert_eq!(draft["version"].as_str(), Some("1.0.9"));
        assert_eq!(
            tdm_core::tools::compare_semver_versions("1.0.8", "1.0.9"),
            Some(std::cmp::Ordering::Less)
        );
        for key in ["windows-x86_64", "windows-x86_64-nsis"] {
            assert_eq!(
                draft["platforms"][key]["signature"].as_str().map(str::trim),
                Some(sig_str.trim())
            );
            assert!(
                draft["platforms"][key]["url"]
                    .as_str()
                    .unwrap()
                    .contains("/releases/download/v1.0.9/TORI.Download.Manager_1.0.9_x64-setup.exe")
            );
        }

        let meta: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&build_meta_path).unwrap()).unwrap();
        assert_eq!(meta["version"].as_str(), Some("1.0.9"));
        assert_eq!(meta["published"].as_bool(), Some(false));
        assert_eq!(meta["desktop_updater_signing_key_id"].as_str(), Some("CDC23D8CC8DA5397"));
        assert_eq!(meta["dedicated_tools_public_key_id"].as_str(), Some("C3FD6626A3718E63"));
    }
}
