use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::Duration;

use crate::error::{EngineError, Result};
use crate::tools::trust::{
    build_trusted_http_client, compare_semver_versions, reject_duplicate_json_keys,
    validate_trusted_url, verify_minisign_with_keyring, verify_openpgp_detached_rsa_signature,
};
use crate::tools::types::{
    ManifestAntiReplayState, SigningKeyPurpose, ToolBundleId, ToolsManagerConfig, TrustLevel,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactKind {
    SingleExe,
    FfmpegZip,
}

#[derive(Debug, Clone)]
pub struct UpdateCandidate {
    pub bundle: ToolBundleId,
    pub version: String,
    pub download_url: String,
    pub expected_sha256: Option<String>,
    pub expected_size: Option<u64>,
    pub source_name: String,
    pub trust_level: TrustLevel,
    pub untrusted_reason: Option<String>,
    pub published_at: Option<String>,
    pub artifact_kind: ArtifactKind,
    pub allow_rollback_to: bool,
    pub manifest_revision: Option<u64>,
    pub is_higher_manifest_revision: bool,
    pub expected_ffmpeg_version: Option<String>,
    pub expected_ffprobe_version: Option<String>,
}

#[derive(Debug, Clone)]
pub enum ProviderFetchError {
    RateLimited {
        retry_after_secs: u64,
        message: String,
    },
    Network(String),
    Untrusted(String),
    Other(String),
}

impl std::fmt::Display for ProviderFetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProviderFetchError::RateLimited {
                retry_after_secs,
                message,
            } => write!(f, "{} (retry after {}s)", message, retry_after_secs),
            ProviderFetchError::Network(m)
            | ProviderFetchError::Untrusted(m)
            | ProviderFetchError::Other(m) => f.write_str(m),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestProvenance {
    pub upstream_provider: String,
    pub upstream_release: String,
    pub upstream_url: String,
    pub approved_by: String,
    pub approved_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedManifestToolEntry {
    #[serde(default)]
    pub tool_id: Option<String>,
    pub version: String,
    #[serde(default)]
    pub ffmpeg_version: Option<String>,
    #[serde(default)]
    pub ffprobe_version: Option<String>,
    #[serde(default)]
    pub bundle_id: Option<String>,
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub artifact_format: Option<String>,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub architecture: Option<String>,
    #[serde(default)]
    pub min_tori_version: Option<String>,
    #[serde(default)]
    pub max_tori_version: Option<String>,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub allow_rollback_to: bool,
    #[serde(default)]
    pub provenance: Option<ManifestProvenance>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedToolsManifest {
    pub schema_version: u32,
    #[serde(default)]
    pub manifest_revision: u64,
    #[serde(default)]
    pub generated_at: String,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub signing_key_id: Option<String>,
    /// Optional explicit domain binding (must be "external_tools_manifest" if supplied).
    #[serde(default)]
    pub key_purpose: Option<String>,
    /// Optional Stage 1–2 dual-signature transition key ID for `.tools.sig` sidecar verification.
    #[serde(default)]
    pub dedicated_signing_key_id: Option<String>,
    #[serde(default)]
    pub yt_dlp: Option<SignedManifestToolEntry>,
    #[serde(default)]
    pub ffmpeg_bundle: Option<SignedManifestToolEntry>,
}

#[derive(Debug, Clone)]
pub struct ValidatedSignedManifest {
    pub manifest: SignedToolsManifest,
    pub raw_sha256: String,
    pub verified_key_id: Option<String>,
    pub verified_key_purpose: Option<SigningKeyPurpose>,
    pub dual_signature_verified_key_id: Option<String>,
    pub published_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
    pub is_higher_revision: bool,
}

#[derive(Debug, Clone)]
pub enum ManifestFetchOutcome {
    Available(ValidatedSignedManifest),
    NotConfigured,
    NotPublishedYet,
    NetworkUnavailable(String),
    RejectedSecurity(String),
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    digest: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

fn check_response_status(
    resp: &reqwest::Response,
    label: &str,
) -> std::result::Result<(), ProviderFetchError> {
    let status = resp.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || (status == reqwest::StatusCode::FORBIDDEN
            && resp
                .headers()
                .get("x-ratelimit-remaining")
                .and_then(|v| v.to_str().ok())
                == Some("0"))
    {
        let retry_after_secs = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(900)
            .clamp(30, 86400);
        return Err(ProviderFetchError::RateLimited {
            retry_after_secs,
            message: format!("{} rate limited (HTTP {})", label, status.as_u16()),
        });
    }

    if !status.is_success() {
        return Err(ProviderFetchError::Network(format!(
            "{} returned HTTP {}",
            label,
            status.as_u16()
        )));
    }
    Ok(())
}

/// Parses a `SHA2-256SUMS` / `checksums.sha256` file into `filename -> lowercase_hex_sha256`.
pub fn parse_sha256_sums_file(text: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        let Some(hash) = parts.next() else {
            continue;
        };
        let Some(fname_raw) = parts.next() else {
            continue;
        };
        let hash_lc = hash.trim().to_ascii_lowercase();
        if hash_lc.len() != 64 || !hash_lc.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        let fname = fname_raw.trim().trim_start_matches('*').trim_start_matches("./");
        if !fname.is_empty() {
            map.insert(fname.to_string(), hash_lc);
        }
    }
    map
}

fn normalize_github_digest(digest: Option<&str>) -> Option<String> {
    let raw = digest?.trim();
    let hex_part = raw.strip_prefix("sha256:").unwrap_or(raw).trim().to_ascii_lowercase();
    if hex_part.len() == 64 && hex_part.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(hex_part)
    } else {
        None
    }
}

fn parse_rfc3339_utc(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s.trim())
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

/// Fetches and cryptographically verifies TORI's Ed25519-signed tools manifest
/// (`tools-manifest.json` + `tools-manifest.json.sig`).
///
/// Verification order (fail-closed):
/// 1. HTTPS allowlist check for manifest & `.sig` URLs
/// 2. Download exact raw manifest bytes (HTTP 404 => `NotPublishedYet`; 5xx/offline => `NetworkUnavailable`)
/// 3. Download `.sig` (HTTP 404 when manifest exists => `RejectedSecurity`)
/// 4. Verify Minisign Ed25519 signature over exact raw bytes BEFORE any JSON parsing
/// 5. Reject duplicate JSON keys & trailing garbage
/// 6. Parse schema (`1` or `2`), verify `signing_key_id`, `published_at`, `expires_at`,
///    and enforce strictly monotonic anti-replay `manifest_revision` + SHA-256 equivocation check.
pub async fn fetch_signed_tools_manifest(
    config: &ToolsManagerConfig,
    prior_state: &ManifestAntiReplayState,
    now: DateTime<Utc>,
) -> ManifestFetchOutcome {
    let Some(ref raw_url) = config.signed_manifest_url else {
        return ManifestFetchOutcome::NotConfigured;
    };

    let manifest_url = match validate_trusted_url(raw_url, config.allow_loopback_http) {
        Ok(u) => u,
        Err(e) => return ManifestFetchOutcome::RejectedSecurity(e.to_string()),
    };
    let sig_url_str = format!("{}.sig", manifest_url.as_str());
    let sig_url = match validate_trusted_url(&sig_url_str, config.allow_loopback_http) {
        Ok(u) => u,
        Err(e) => return ManifestFetchOutcome::RejectedSecurity(e.to_string()),
    };

    let client = match build_trusted_http_client(config.http_timeout_secs, config.allow_loopback_http) {
        Ok(c) => c,
        Err(e) => return ManifestFetchOutcome::NetworkUnavailable(e.to_string()),
    };

    let resp = match client.get(manifest_url.as_str()).send().await {
        Ok(r) => r,
        Err(e) => {
            let msg = format!("Signed manifest fetch failed: {}", e);
            if msg.contains("Untrusted") || msg.contains("redirect") {
                return ManifestFetchOutcome::RejectedSecurity(msg);
            }
            return ManifestFetchOutcome::NetworkUnavailable(msg);
        }
    };

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return ManifestFetchOutcome::NotPublishedYet;
    }
    if let Err(e) = check_response_status(&resp, "TORI signed tools manifest") {
        return ManifestFetchOutcome::NetworkUnavailable(e.to_string());
    }
    let manifest_is_html = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|ct| ct.to_ascii_lowercase().contains("text/html"))
        .unwrap_or(false);

    let manifest_bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            return ManifestFetchOutcome::NetworkUnavailable(format!(
                "Failed reading signed manifest: {}",
                e
            ))
        }
    };
    if manifest_bytes.is_empty() {
        return ManifestFetchOutcome::RejectedSecurity(
            "Signed tools manifest is empty (0 bytes)".to_string(),
        );
    }
    if manifest_bytes.len() > 2 * 1024 * 1024 {
        return ManifestFetchOutcome::RejectedSecurity(
            "Signed tools manifest exceeds 2 MiB safety limit".to_string(),
        );
    }

    // Cloudflare Pages SPA fallback returns HTTP 200 text/html (index.html) for unpublished paths.
    // Treat HTML fallback as NotPublishedYet ONLY when manifest itself is HTML (never JSON).
    if manifest_is_html {
        let head = String::from_utf8_lossy(&manifest_bytes[..manifest_bytes.len().min(64)])
            .trim_start()
            .to_ascii_lowercase();
        if head.starts_with("<!doctype html") || head.starts_with("<html") {
            return ManifestFetchOutcome::NotPublishedYet;
        }
    }

    let sig_resp = match client.get(sig_url.as_str()).send().await {
        Ok(r) => r,
        Err(e) => {
            let msg = format!("Signed manifest signature fetch failed: {}", e);
            if msg.contains("Untrusted") || msg.contains("redirect") {
                return ManifestFetchOutcome::RejectedSecurity(msg);
            }
            return ManifestFetchOutcome::NetworkUnavailable(msg);
        }
    };
    if sig_resp.status() == reqwest::StatusCode::NOT_FOUND {
        return ManifestFetchOutcome::RejectedSecurity(
            "Signed tools manifest signature (.sig) is missing (HTTP 404)".to_string(),
        );
    }
    if let Err(e) = check_response_status(&sig_resp, "TORI signed tools manifest signature") {
        return ManifestFetchOutcome::NetworkUnavailable(e.to_string());
    }
    let sig_text = match sig_resp.text().await {
        Ok(t) => t,
        Err(e) => {
            return ManifestFetchOutcome::NetworkUnavailable(format!(
                "Failed reading manifest signature: {}",
                e
            ))
        }
    };

    // 1. Cryptographic Ed25519 keyring verification over exact serialized bytes BEFORE parsing JSON
    let keyring = config.effective_tools_keyring();
    let verified_sig = match verify_minisign_with_keyring(
        &keyring,
        &manifest_bytes,
        &sig_text,
        now,
        config.max_clock_skew_secs,
    ) {
        Ok(v) => v,
        Err(e) => return ManifestFetchOutcome::RejectedSecurity(e.to_string()),
    };

    let raw_sha256 = hex::encode(Sha256::digest(&manifest_bytes));

    // 2. Reject duplicate JSON keys & trailing garbage to prevent parser ambiguity attacks
    if let Err(e) = reject_duplicate_json_keys(&manifest_bytes) {
        return ManifestFetchOutcome::RejectedSecurity(e.to_string());
    }

    // 2b. Reject unauthorized manifest self-escalation / inline trust-root injection fields
    if let Ok(raw_val) = serde_json::from_slice::<serde_json::Value>(&manifest_bytes) {
        if let Some(obj) = raw_val.as_object() {
            for forbidden in [
                "trusted_keys",
                "add_trusted_key",
                "authorize_new_key",
                "replace_keyring",
                "rotate_pubkey",
                "new_trusted_pubkey",
            ] {
                if obj.contains_key(forbidden) {
                    return ManifestFetchOutcome::RejectedSecurity(format!(
                        "Unauthorized manifest trust-escalation field '{}' rejected: manifests cannot self-authorize signing keys",
                        forbidden
                    ));
                }
            }
        }
    }

    // 3. Parse verified JSON manifest
    let manifest: SignedToolsManifest = match serde_json::from_slice(&manifest_bytes) {
        Ok(m) => m,
        Err(e) => {
            return ManifestFetchOutcome::RejectedSecurity(format!(
                "Malformed signed tools manifest JSON: {}",
                e
            ))
        }
    };

    // 4. Schema version enforcement (supports v2 production and v1 backward compatibility)
    if manifest.schema_version != 1 && manifest.schema_version != 2 {
        return ManifestFetchOutcome::RejectedSecurity(format!(
            "Unsupported signed tools manifest schema_version {}",
            manifest.schema_version
        ));
    }

    // 5. Signing Key ID & Key-Purpose domain enforcement
    let actual_key_id = Some(verified_sig.key_id.clone());
    if config.tools_keyring.is_none() {
        if let Some(ref expected_kid) = config.expected_manifest_key_id {
            let exp_norm = expected_kid.trim().to_ascii_uppercase();
            if actual_key_id.as_deref() != Some(exp_norm.as_str()) {
                return ManifestFetchOutcome::RejectedSecurity(format!(
                    "Verified public key ID ({:?}) does not match expected TORI key ID {}",
                    actual_key_id, exp_norm
                ));
            }
        }
    }
    if let Some(ref declared_kid) = manifest.signing_key_id {
        let decl_norm = declared_kid.trim().to_ascii_uppercase();
        if decl_norm.is_empty() || actual_key_id.as_deref() != Some(decl_norm.as_str()) {
            return ManifestFetchOutcome::RejectedSecurity(format!(
                "Manifest signing_key_id '{}' does not match verified Ed25519 key ID {:?}",
                declared_kid, actual_key_id
            ));
        }
    } else if manifest.schema_version >= 2 {
        return ManifestFetchOutcome::RejectedSecurity(
            "Schema v2 signed manifest missing required signing_key_id".to_string(),
        );
    }
    if let Some(ref kp) = manifest.key_purpose {
        if !kp.trim().eq_ignore_ascii_case("external_tools_manifest") {
            return ManifestFetchOutcome::RejectedSecurity(format!(
                "Manifest key_purpose '{}' is invalid for External Tools (expected 'external_tools_manifest')",
                kp
            ));
        }
    }

    // Optional Stage 1–2 dual-signature sidecar verification (`.tools.sig`):
    // If the manifest declares `dedicated_signing_key_id` AND our keyring trusts an active
    // dedicated `ExternalToolsManifest` key with that ID, verify `{manifest_url}.tools.sig`
    // over the exact same raw manifest bytes!
    let mut dual_signature_verified_key_id: Option<String> = None;
    if let Some(ref ded_kid_raw) = manifest.dedicated_signing_key_id {
        let ded_kid = ded_kid_raw.trim().to_ascii_uppercase();
        if !ded_kid.is_empty() && Some(ded_kid.as_str()) != actual_key_id.as_deref() {
            let client_trusts_dedicated = keyring.keys.iter().any(|k| {
                k.key_id.trim().eq_ignore_ascii_case(&ded_kid)
                    && k.purpose == SigningKeyPurpose::ExternalToolsManifest
                    && keyring.key_is_currently_usable(k, now, config.max_clock_skew_secs)
            });
            if client_trusts_dedicated {
                let sidecar_url_str = format!("{}.tools.sig", manifest_url.as_str());
                let sidecar_url = match validate_trusted_url(&sidecar_url_str, config.allow_loopback_http) {
                    Ok(u) => u,
                    Err(e) => return ManifestFetchOutcome::RejectedSecurity(e.to_string()),
                };
                let sidecar_resp = match client.get(sidecar_url.as_str()).send().await {
                    Ok(r) => r,
                    Err(e) => {
                        return ManifestFetchOutcome::NetworkUnavailable(format!(
                            "Failed fetching dual-signature sidecar .tools.sig: {}",
                            e
                        ))
                    }
                };
                if sidecar_resp.status() == reqwest::StatusCode::NOT_FOUND {
                    return ManifestFetchOutcome::RejectedSecurity(
                        "Dual-signed manifest declared dedicated_signing_key_id but .tools.sig is missing (HTTP 404)"
                            .to_string(),
                    );
                }
                if let Err(e) = check_response_status(&sidecar_resp, "TORI dedicated tools manifest signature") {
                    return ManifestFetchOutcome::NetworkUnavailable(e.to_string());
                }
                let sidecar_text = match sidecar_resp.text().await {
                    Ok(t) => t,
                    Err(e) => {
                        return ManifestFetchOutcome::NetworkUnavailable(format!(
                            "Failed reading .tools.sig: {}",
                            e
                        ))
                    }
                };
                let ded_verified = match verify_minisign_with_keyring(
                    &keyring,
                    &manifest_bytes,
                    &sidecar_text,
                    now,
                    config.max_clock_skew_secs,
                ) {
                    Ok(v) => v,
                    Err(e) => {
                        return ManifestFetchOutcome::RejectedSecurity(format!(
                            "Dedicated dual-signature (.tools.sig) verification failed: {}",
                            e
                        ))
                    }
                };
                if ded_verified.purpose != SigningKeyPurpose::ExternalToolsManifest
                    || !ded_verified.key_id.eq_ignore_ascii_case(&ded_kid)
                {
                    return ManifestFetchOutcome::RejectedSecurity(format!(
                        "Dedicated .tools.sig signer ({}/{:?}) does not match declared dedicated_signing_key_id {}",
                        ded_verified.key_id, ded_verified.purpose, ded_kid
                    ));
                }
                dual_signature_verified_key_id = Some(ded_verified.key_id);
            }
        }
    }

    // 6. Freshness, expiry, future-date & monotonic anti-replay checks
    let skew = ChronoDuration::seconds(config.max_clock_skew_secs.max(0));
    let published_raw = manifest
        .published_at
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            if !manifest.generated_at.trim().is_empty() {
                Some(manifest.generated_at.as_str())
            } else {
                None
            }
        });
    let published_dt = published_raw.and_then(parse_rfc3339_utc);
    let mut expires_dt: Option<DateTime<Utc>> = None;

    if manifest.schema_version >= 2 {
        if manifest.manifest_revision < 1 {
            return ManifestFetchOutcome::RejectedSecurity(
                "Schema v2 signed manifest requires manifest_revision >= 1".to_string(),
            );
        }
        let Some(pub_dt) = published_dt else {
            return ManifestFetchOutcome::RejectedSecurity(
                "Schema v2 signed manifest missing valid RFC 3339 published_at timestamp"
                    .to_string(),
            );
        };
        if pub_dt > now + skew {
            return ManifestFetchOutcome::RejectedSecurity(format!(
                "Rejected future-dated tools manifest (published_at {} exceeds current UTC + {}s skew)",
                pub_dt.to_rfc3339(),
                config.max_clock_skew_secs
            ));
        }
        let Some(exp_str) = manifest.expires_at.as_deref() else {
            return ManifestFetchOutcome::RejectedSecurity(
                "Schema v2 signed manifest missing required expires_at timestamp".to_string(),
            );
        };
        let Some(exp_dt) = parse_rfc3339_utc(exp_str) else {
            return ManifestFetchOutcome::RejectedSecurity(format!(
                "Schema v2 signed manifest has invalid RFC 3339 expires_at '{}'",
                exp_str
            ));
        };
        if exp_dt <= pub_dt {
            return ManifestFetchOutcome::RejectedSecurity(
                "Rejected signed tools manifest where expires_at <= published_at".to_string(),
            );
        }
        if now > exp_dt + skew {
            return ManifestFetchOutcome::RejectedSecurity(format!(
                "Rejected expired signed tools manifest (expired at {})",
                exp_dt.to_rfc3339()
            ));
        }
        expires_dt = Some(exp_dt);
    } else if let Some(exp_str) = manifest.expires_at.as_deref() {
        let Some(exp_dt) = parse_rfc3339_utc(exp_str) else {
            return ManifestFetchOutcome::RejectedSecurity(format!(
                "Signed tools manifest has invalid RFC 3339 expires_at '{}'",
                exp_str
            ));
        };
        if now > exp_dt + skew {
            return ManifestFetchOutcome::RejectedSecurity(format!(
                "Rejected expired signed tools manifest (expired at {})",
                exp_dt.to_rfc3339()
            ));
        }
        expires_dt = Some(exp_dt);
    }

    // Anti-replay monotonicity check (enforced whenever manifest_revision > 0 or schema_version >= 2)
    let is_higher_revision = if manifest.manifest_revision > 0 || manifest.schema_version >= 2 {
        if prior_state.highest_accepted_revision > 0 {
            if manifest.manifest_revision < prior_state.highest_accepted_revision {
                return ManifestFetchOutcome::RejectedSecurity(format!(
                    "Manifest replay rejected: received manifest_revision {} < highest accepted revision {}",
                    manifest.manifest_revision, prior_state.highest_accepted_revision
                ));
            }
            if manifest.manifest_revision == prior_state.highest_accepted_revision {
                if let Some(ref prev_sha) = prior_state.last_accepted_manifest_sha256 {
                    if prev_sha != &raw_sha256 {
                        return ManifestFetchOutcome::RejectedSecurity(format!(
                            "Manifest equivocation rejected: manifest_revision {} bytes changed without incrementing revision",
                            manifest.manifest_revision
                        ));
                    }
                }
            }
        }
        manifest.manifest_revision > prior_state.highest_accepted_revision
    } else {
        false
    };

    ManifestFetchOutcome::Available(ValidatedSignedManifest {
        manifest,
        raw_sha256,
        verified_key_id: actual_key_id,
        verified_key_purpose: Some(verified_sig.purpose),
        dual_signature_verified_key_id,
        published_at: published_dt,
        expires_at: expires_dt,
        is_higher_revision,
    })
}

fn validate_manifest_entry(
    validated: &ValidatedSignedManifest,
    entry: &SignedManifestToolEntry,
    bundle: ToolBundleId,
    config: &ToolsManagerConfig,
) -> std::result::Result<UpdateCandidate, ProviderFetchError> {
    let schema_v2 = validated.manifest.schema_version >= 2;

    if entry.version.trim().is_empty() {
        return Err(ProviderFetchError::Untrusted(
            "Signed manifest entry missing version".to_string(),
        ));
    }

    if let Some(ref plat) = entry.platform {
        if !plat.eq_ignore_ascii_case("windows") {
            return Err(ProviderFetchError::Untrusted(format!(
                "Manifest entry platform '{}' is incompatible with Windows",
                plat
            )));
        }
    } else if schema_v2 {
        return Err(ProviderFetchError::Untrusted(
            "Schema v2 manifest entry missing required platform field".to_string(),
        ));
    }

    if let Some(ref arch) = entry.architecture {
        if !matches!(arch.to_ascii_lowercase().as_str(), "x86_64" | "amd64" | "x64") {
            return Err(ProviderFetchError::Untrusted(format!(
                "Manifest entry architecture '{}' is incompatible with Windows x86_64",
                arch
            )));
        }
    } else if schema_v2 {
        return Err(ProviderFetchError::Untrusted(
            "Schema v2 manifest entry missing required architecture field".to_string(),
        ));
    }

    if let Some(ref fmt) = entry.artifact_format {
        let fmt_lc = fmt.trim().to_ascii_lowercase();
        let ok = match bundle {
            ToolBundleId::YtDlp => matches!(fmt_lc.as_str(), "exe" | "single_exe"),
            ToolBundleId::FfmpegBundle => matches!(fmt_lc.as_str(), "zip" | "ffmpeg_zip"),
        };
        if !ok {
            return Err(ProviderFetchError::Untrusted(format!(
                "Manifest entry artifact_format '{}' is unsupported for {}",
                fmt,
                bundle.display_name()
            )));
        }
    }

    if let Some(ref min_ver) = entry.min_tori_version {
        let Some(ord) = compare_semver_versions(&config.current_tori_version, min_ver) else {
            return Err(ProviderFetchError::Untrusted(format!(
                "Manifest entry has invalid min_tori_version '{}'",
                min_ver
            )));
        };
        if ord == std::cmp::Ordering::Less {
            return Err(ProviderFetchError::Untrusted(format!(
                "Manifest entry requires TORI Desktop >= {} (current version is {})",
                min_ver, config.current_tori_version
            )));
        }
    }

    if let Some(ref max_ver) = entry.max_tori_version {
        let Some(ord) = compare_semver_versions(&config.current_tori_version, max_ver) else {
            return Err(ProviderFetchError::Untrusted(format!(
                "Manifest entry has invalid max_tori_version '{}'",
                max_ver
            )));
        };
        if ord == std::cmp::Ordering::Greater {
            return Err(ProviderFetchError::Untrusted(format!(
                "Manifest entry supports up to TORI Desktop {} (current version is {})",
                max_ver, config.current_tori_version
            )));
        }
    }

    validate_trusted_url(&entry.url, config.allow_loopback_http)
        .map_err(|e| ProviderFetchError::Untrusted(e.to_string()))?;

    let sha = entry.sha256.trim().to_ascii_lowercase();
    if sha.len() != 64 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ProviderFetchError::Untrusted(
            "Signed manifest entry has invalid SHA-256 digest".to_string(),
        ));
    }

    if schema_v2 && entry.size.unwrap_or(0) == 0 {
        return Err(ProviderFetchError::Untrusted(
            "Schema v2 signed manifest entry missing positive artifact byte size".to_string(),
        ));
    }

    Ok(UpdateCandidate {
        bundle,
        version: entry.version.trim().to_string(),
        download_url: entry.url.trim().to_string(),
        expected_sha256: Some(sha),
        expected_size: entry.size,
        source_name: "tori-signed-manifest".to_string(),
        trust_level: TrustLevel::ToriEd25519ManifestVerified,
        untrusted_reason: None,
        published_at: entry.published_at.clone(),
        artifact_kind: match bundle {
            ToolBundleId::YtDlp => ArtifactKind::SingleExe,
            ToolBundleId::FfmpegBundle => ArtifactKind::FfmpegZip,
        },
        allow_rollback_to: entry.allow_rollback_to,
        manifest_revision: (validated.manifest.manifest_revision > 0)
            .then_some(validated.manifest.manifest_revision),
        is_higher_manifest_revision: validated.is_higher_revision,
        expected_ffmpeg_version: entry.ffmpeg_version.clone(),
        expected_ffprobe_version: entry.ffprobe_version.clone(),
    })
}

/// Fetches the latest official `yt-dlp` release from `github.com/yt-dlp/yt-dlp`
/// and cryptographically verifies `SHA2-256SUMS` against `SHA2-256SUMS.sig` using yt-dlp's pinned RSA-4096 OpenPGP key.
pub async fn fetch_ytdlp_candidate(
    config: &ToolsManagerConfig,
    signed_manifest: Option<&ValidatedSignedManifest>,
) -> std::result::Result<UpdateCandidate, ProviderFetchError> {
    if let Some(validated) = signed_manifest {
        if let Some(ref entry) = validated.manifest.yt_dlp {
            return validate_manifest_entry(validated, entry, ToolBundleId::YtDlp, config);
        }
    }

    let api_url = validate_trusted_url(&config.ytdlp_release_api_url, config.allow_loopback_http)
        .map_err(|e| ProviderFetchError::Untrusted(e.to_string()))?;

    let client = build_trusted_http_client(config.http_timeout_secs, config.allow_loopback_http)
        .map_err(|e| ProviderFetchError::Other(e.to_string()))?;

    let resp = client
        .get(api_url.as_str())
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| ProviderFetchError::Network(format!("yt-dlp release check failed: {}", e)))?;
    check_response_status(&resp, "yt-dlp GitHub release API")?;

    let release: GithubRelease = resp
        .json()
        .await
        .map_err(|e| ProviderFetchError::Other(format!("Malformed yt-dlp release metadata: {}", e)))?;

    let version = release.tag_name.trim().to_string();
    if version.is_empty() {
        return Err(ProviderFetchError::Other(
            "yt-dlp release metadata missing tag_name".to_string(),
        ));
    }

    let exe_asset = release
        .assets
        .iter()
        .find(|a| a.name == "yt-dlp.exe")
        .ok_or_else(|| {
            ProviderFetchError::Other("Official yt-dlp release missing Windows x64 'yt-dlp.exe' asset".to_string())
        })?;
    let sums_asset = release
        .assets
        .iter()
        .find(|a| a.name == "SHA2-256SUMS")
        .ok_or_else(|| {
            ProviderFetchError::Untrusted(
                "Official yt-dlp release missing SHA2-256SUMS checksum manifest".to_string(),
            )
        })?;
    let sig_asset = release
        .assets
        .iter()
        .find(|a| a.name == "SHA2-256SUMS.sig")
        .ok_or_else(|| {
            ProviderFetchError::Untrusted(
                "Official yt-dlp release missing SHA2-256SUMS.sig OpenPGP publisher signature"
                    .to_string(),
            )
        })?;

    validate_trusted_url(&exe_asset.browser_download_url, config.allow_loopback_http)
        .map_err(|e| ProviderFetchError::Untrusted(e.to_string()))?;
    validate_trusted_url(&sums_asset.browser_download_url, config.allow_loopback_http)
        .map_err(|e| ProviderFetchError::Untrusted(e.to_string()))?;
    validate_trusted_url(&sig_asset.browser_download_url, config.allow_loopback_http)
        .map_err(|e| ProviderFetchError::Untrusted(e.to_string()))?;

    let sums_resp = client
        .get(&sums_asset.browser_download_url)
        .send()
        .await
        .map_err(|e| ProviderFetchError::Network(format!("Failed fetching yt-dlp SHA2-256SUMS: {}", e)))?;
    check_response_status(&sums_resp, "yt-dlp SHA2-256SUMS")?;
    let sums_bytes = sums_resp
        .bytes()
        .await
        .map_err(|e| ProviderFetchError::Network(format!("Failed reading yt-dlp SHA2-256SUMS: {}", e)))?;

    let sig_resp = client
        .get(&sig_asset.browser_download_url)
        .send()
        .await
        .map_err(|e| {
            ProviderFetchError::Network(format!("Failed fetching yt-dlp SHA2-256SUMS.sig: {}", e))
        })?;
    check_response_status(&sig_resp, "yt-dlp SHA2-256SUMS.sig")?;
    let sig_bytes = sig_resp
        .bytes()
        .await
        .map_err(|e| {
            ProviderFetchError::Network(format!("Failed reading yt-dlp SHA2-256SUMS.sig: {}", e))
        })?;

    // Cryptographic publisher authenticity verification (RFC 4880 V4 OpenPGP RSA-4096)
    verify_openpgp_detached_rsa_signature(
        &config.ytdlp_pgp_pubkey_asc,
        &config.ytdlp_pgp_fingerprint_hex,
        &sums_bytes,
        &sig_bytes,
    )
    .map_err(|e| {
        ProviderFetchError::Untrusted(format!(
            "yt-dlp OpenPGP publisher signature verification failed: {}",
            e
        ))
    })?;

    let sums_text = String::from_utf8_lossy(&sums_bytes);
    let checksums = parse_sha256_sums_file(&sums_text);
    let expected_sha256 = checksums.get("yt-dlp.exe").cloned().ok_or_else(|| {
        ProviderFetchError::Other(
            "Verified SHA2-256SUMS file does not contain an entry for yt-dlp.exe".to_string(),
        )
    })?;

    // Cross-check GitHub asset digest metadata if supplied by GitHub API
    if let Some(gh_digest) = normalize_github_digest(exe_asset.digest.as_deref()) {
        if gh_digest != expected_sha256 {
            return Err(ProviderFetchError::Untrusted(format!(
                "yt-dlp SHA-256 mismatch between signed SHA2-256SUMS ({}) and GitHub asset digest ({})",
                expected_sha256, gh_digest
            )));
        }
    }

    Ok(UpdateCandidate {
        bundle: ToolBundleId::YtDlp,
        version,
        download_url: exe_asset.browser_download_url.clone(),
        expected_sha256: Some(expected_sha256),
        expected_size: exe_asset.size,
        source_name: "github:yt-dlp/yt-dlp".to_string(),
        trust_level: TrustLevel::PublisherOpenPgpVerified,
        untrusted_reason: None,
        published_at: release.published_at,
        artifact_kind: ArtifactKind::SingleExe,
        allow_rollback_to: false,
        manifest_revision: None,
        is_higher_manifest_revision: false,
        expected_ffmpeg_version: None,
        expected_ffprobe_version: None,
    })
}

/// Fetches the latest FFmpeg + FFprobe Windows x64 candidate.
/// - When a TORI Ed25519-signed tools manifest is configured and verified, returns `TrustLevel::ToriEd25519ManifestVerified`.
/// - When querying upstream `BtbN/FFmpeg-Builds` directly without a signed manifest, honestly reports availability
///   as `TrustLevel::ChecksumOnlyUntrusted`, which strictly blocks unattended installation (`Source Untrusted`).
pub async fn fetch_ffmpeg_bundle_candidate(
    config: &ToolsManagerConfig,
    signed_manifest: Option<&ValidatedSignedManifest>,
) -> std::result::Result<UpdateCandidate, ProviderFetchError> {
    if let Some(validated) = signed_manifest {
        if let Some(ref entry) = validated.manifest.ffmpeg_bundle {
            return validate_manifest_entry(validated, entry, ToolBundleId::FfmpegBundle, config);
        }
    }

    let api_url = validate_trusted_url(&config.ffmpeg_release_api_url, config.allow_loopback_http)
        .map_err(|e| ProviderFetchError::Untrusted(e.to_string()))?;

    let client = build_trusted_http_client(config.http_timeout_secs, config.allow_loopback_http)
        .map_err(|e| ProviderFetchError::Other(e.to_string()))?;

    let resp = client
        .get(api_url.as_str())
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| ProviderFetchError::Network(format!("FFmpeg release check failed: {}", e)))?;
    check_response_status(&resp, "BtbN/FFmpeg-Builds GitHub API")?;

    let release: GithubRelease = resp
        .json()
        .await
        .map_err(|e| ProviderFetchError::Other(format!("Malformed FFmpeg release metadata: {}", e)))?;

    // Prefer static GPL win64 zip matching TORI's bundled BtbN win64-gpl package
    let zip_asset = release
        .assets
        .iter()
        .find(|a| a.name == "ffmpeg-master-latest-win64-gpl.zip")
        .or_else(|| {
            release.assets.iter().find(|a| {
                a.name.starts_with("ffmpeg-n")
                    && a.name.ends_with("-win64-gpl.zip")
                    && !a.name.contains("shared")
            })
        })
        .or_else(|| {
            release.assets.iter().find(|a| {
                a.name.ends_with("-win64-gpl.zip") && !a.name.contains("shared")
            })
        })
        .ok_or_else(|| {
            ProviderFetchError::Other(
                "Upstream BtbN/FFmpeg-Builds release missing Windows x64 static GPL zip".to_string(),
            )
        })?;

    validate_trusted_url(&zip_asset.browser_download_url, config.allow_loopback_http)
        .map_err(|e| ProviderFetchError::Untrusted(e.to_string()))?;

    let mut expected_sha256 = normalize_github_digest(zip_asset.digest.as_deref());
    if expected_sha256.is_none() {
        if let Some(sums_asset) = release.assets.iter().find(|a| a.name == "checksums.sha256") {
            if validate_trusted_url(&sums_asset.browser_download_url, config.allow_loopback_http)
                .is_ok()
            {
                if let Ok(sums_resp) = client
                    .get(&sums_asset.browser_download_url)
                    .timeout(Duration::from_secs(config.http_timeout_secs))
                    .send()
                    .await
                {
                    if sums_resp.status().is_success() {
                        if let Ok(text) = sums_resp.text().await {
                            let map = parse_sha256_sums_file(&text);
                            expected_sha256 = map.get(&zip_asset.name).cloned();
                        }
                    }
                }
            }
        }
    }

    // Extract clear version tag from BtbN release metadata
    let version = if release.tag_name.eq_ignore_ascii_case("latest") {
        release
            .published_at
            .as_deref()
            .and_then(|ts| ts.get(0..10))
            .map(|d| format!("btbn-{}", d))
            .unwrap_or_else(|| "btbn-latest".to_string())
    } else {
        release.tag_name.trim().to_string()
    };

    // Upstream BtbN/FFmpeg-Builds publishes checksums over HTTPS without a publisher cryptographic signature.
    // Per TORI supply-chain trust policy, direct unsigned upstream archives MUST NOT be installed automatically.
    Ok(UpdateCandidate {
        bundle: ToolBundleId::FfmpegBundle,
        version,
        download_url: zip_asset.browser_download_url.clone(),
        expected_sha256,
        expected_size: zip_asset.size,
        source_name: "github:BtbN/FFmpeg-Builds".to_string(),
        trust_level: TrustLevel::ChecksumOnlyUntrusted,
        untrusted_reason: Some(
            "Upstream BtbN/FFmpeg-Builds provides HTTPS checksums without a detached cryptographic publisher signature. Unattended installation is blocked until verified by a TORI Ed25519-signed tools manifest."
                .to_string(),
        ),
        published_at: release.published_at,
        artifact_kind: ArtifactKind::FfmpegZip,
        allow_rollback_to: false,
        manifest_revision: None,
        is_higher_manifest_revision: false,
        expected_ffmpeg_version: None,
        expected_ffprobe_version: None,
    })
}

/// Validates and parses expected SHA-256 hex digest strings.
pub fn validate_sha256_hex(s: &str) -> Result<String> {
    let lc = s.trim().to_ascii_lowercase();
    if lc.len() == 64 && lc.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(lc)
    } else {
        Err(EngineError::Other(format!(
            "Invalid SHA-256 hex checksum '{}'",
            s
        )))
    }
}
