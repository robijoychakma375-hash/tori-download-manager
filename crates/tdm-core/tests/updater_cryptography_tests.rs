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
