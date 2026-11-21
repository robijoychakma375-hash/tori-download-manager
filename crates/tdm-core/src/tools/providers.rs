use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

use crate::error::{EngineError, Result};
use crate::tools::trust::{
    build_trusted_http_client, validate_trusted_url, verify_minisign_ed25519,
    verify_openpgp_detached_rsa_signature,
};
use crate::tools::types::{ToolBundleId, ToolsManagerConfig, TrustLevel};

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
pub struct SignedManifestToolEntry {
    pub version: String,
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub architecture: Option<String>,
    #[serde(default)]
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedToolsManifest {
    pub schema_version: u32,
    pub generated_at: String,
    #[serde(default)]
    pub yt_dlp: Option<SignedManifestToolEntry>,
    #[serde(default)]
    pub ffmpeg_bundle: Option<SignedManifestToolEntry>,
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

/// Fetches and cryptographically verifies an optional TORI Ed25519-signed tools manifest
/// (`tools-manifest.json` + `tools-manifest.json.sig`).
pub async fn fetch_signed_tools_manifest(
    config: &ToolsManagerConfig,
) -> std::result::Result<Option<SignedToolsManifest>, ProviderFetchError> {
    let Some(ref raw_url) = config.signed_manifest_url else {
        return Ok(None);
    };

    let manifest_url = validate_trusted_url(raw_url, config.allow_loopback_http)
        .map_err(|e| ProviderFetchError::Untrusted(e.to_string()))?;
    let sig_url_str = format!("{}.sig", manifest_url.as_str());
    let sig_url = validate_trusted_url(&sig_url_str, config.allow_loopback_http)
        .map_err(|e| ProviderFetchError::Untrusted(e.to_string()))?;

    let client = build_trusted_http_client(config.http_timeout_secs, config.allow_loopback_http)
        .map_err(|e| ProviderFetchError::Other(e.to_string()))?;

    let resp = client
        .get(manifest_url.as_str())
        .send()
        .await
        .map_err(|e| ProviderFetchError::Network(format!("Signed manifest fetch failed: {}", e)))?;
    check_response_status(&resp, "TORI signed tools manifest")?;
    let manifest_bytes = resp
        .bytes()
        .await
        .map_err(|e| ProviderFetchError::Network(format!("Failed reading signed manifest: {}", e)))?;
    if manifest_bytes.len() > 2 * 1024 * 1024 {
        return Err(ProviderFetchError::Other(
            "Signed tools manifest exceeds 2 MiB safety limit".to_string(),
        ));
    }

    let sig_resp = client
        .get(sig_url.as_str())
        .send()
        .await
        .map_err(|e| {
            ProviderFetchError::Network(format!("Signed manifest signature fetch failed: {}", e))
        })?;
    check_response_status(&sig_resp, "TORI signed tools manifest signature")?;
    let sig_text = sig_resp.text().await.map_err(|e| {
        ProviderFetchError::Network(format!("Failed reading manifest signature: {}", e))
    })?;

    verify_minisign_ed25519(&config.tori_manifest_pubkey_b64, &manifest_bytes, &sig_text)
        .map_err(|e| ProviderFetchError::Untrusted(e.to_string()))?;

    let manifest: SignedToolsManifest = serde_json::from_slice(&manifest_bytes).map_err(|e| {
        ProviderFetchError::Other(format!("Malformed signed tools manifest JSON: {}", e))
    })?;

    if manifest.schema_version != 1 {
        return Err(ProviderFetchError::Other(format!(
            "Unsupported signed tools manifest schema_version {}",
            manifest.schema_version
        )));
    }

    Ok(Some(manifest))
}

fn validate_manifest_entry(
    entry: &SignedManifestToolEntry,
    bundle: ToolBundleId,
    config: &ToolsManagerConfig,
) -> std::result::Result<UpdateCandidate, ProviderFetchError> {
    if let Some(ref plat) = entry.platform {
        if !plat.eq_ignore_ascii_case("windows") {
            return Err(ProviderFetchError::Untrusted(format!(
                "Manifest entry platform '{}' is incompatible with Windows",
                plat
            )));
        }
    }
    if let Some(ref arch) = entry.architecture {
        if !matches!(arch.to_ascii_lowercase().as_str(), "x86_64" | "amd64" | "x64") {
            return Err(ProviderFetchError::Untrusted(format!(
                "Manifest entry architecture '{}' is incompatible with Windows x86_64",
                arch
            )));
        }
    }

    validate_trusted_url(&entry.url, config.allow_loopback_http)
        .map_err(|e| ProviderFetchError::Untrusted(e.to_string()))?;

    let sha = entry.sha256.trim().to_ascii_lowercase();
    if sha.len() != 64 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ProviderFetchError::Other(
            "Signed manifest entry has invalid SHA-256 digest".to_string(),
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
    })
}

/// Fetches the latest official `yt-dlp` release from `github.com/yt-dlp/yt-dlp`
/// and cryptographically verifies `SHA2-256SUMS` against `SHA2-256SUMS.sig` using yt-dlp's pinned RSA-4096 OpenPGP key.
pub async fn fetch_ytdlp_candidate(
    config: &ToolsManagerConfig,
    signed_manifest: Option<&SignedToolsManifest>,
) -> std::result::Result<UpdateCandidate, ProviderFetchError> {
    if let Some(manifest) = signed_manifest {
        if let Some(ref entry) = manifest.yt_dlp {
            return validate_manifest_entry(entry, ToolBundleId::YtDlp, config);
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
    })
}

/// Fetches the latest FFmpeg + FFprobe Windows x64 candidate.
/// - When a TORI Ed25519-signed tools manifest is configured and verified, returns `TrustLevel::ToriEd25519ManifestVerified`.
/// - When querying upstream `BtbN/FFmpeg-Builds` directly without a signed manifest, honestly reports availability
///   as `TrustLevel::ChecksumOnlyUntrusted`, which strictly blocks unattended installation (`Source Untrusted`).
pub async fn fetch_ffmpeg_bundle_candidate(
    config: &ToolsManagerConfig,
    signed_manifest: Option<&SignedToolsManifest>,
) -> std::result::Result<UpdateCandidate, ProviderFetchError> {
    if let Some(manifest) = signed_manifest {
        if let Some(ref entry) = manifest.ffmpeg_bundle {
            return validate_manifest_entry(entry, ToolBundleId::FfmpegBundle, config);
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
