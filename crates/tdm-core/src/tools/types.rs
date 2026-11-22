use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolId {
    #[serde(rename = "yt-dlp")]
    YtDlp,
    #[serde(rename = "ffmpeg")]
    Ffmpeg,
    #[serde(rename = "ffprobe")]
    Ffprobe,
}

impl ToolId {
    pub const ALL: [ToolId; 3] = [ToolId::YtDlp, ToolId::Ffmpeg, ToolId::Ffprobe];

    pub fn as_str(&self) -> &'static str {
        match self {
            ToolId::YtDlp => "yt-dlp",
            ToolId::Ffmpeg => "ffmpeg",
            ToolId::Ffprobe => "ffprobe",
        }
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            ToolId::YtDlp => "yt-dlp",
            ToolId::Ffmpeg => "FFmpeg",
            ToolId::Ffprobe => "FFprobe",
        }
    }

    pub fn exe_name(&self) -> &'static str {
        #[cfg(windows)]
        {
            match self {
                ToolId::YtDlp => "yt-dlp.exe",
                ToolId::Ffmpeg => "ffmpeg.exe",
                ToolId::Ffprobe => "ffprobe.exe",
            }
        }
        #[cfg(not(windows))]
        {
            self.as_str()
        }
    }

    pub fn bundle_id(&self) -> ToolBundleId {
        match self {
            ToolId::YtDlp => ToolBundleId::YtDlp,
            ToolId::Ffmpeg | ToolId::Ffprobe => ToolBundleId::FfmpegBundle,
        }
    }
}

impl fmt::Display for ToolId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for ToolId {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "yt-dlp" | "yt_dlp" | "ytdlp" => Ok(ToolId::YtDlp),
            "ffmpeg" => Ok(ToolId::Ffmpeg),
            "ffprobe" => Ok(ToolId::Ffprobe),
            other => Err(format!(
                "Unsupported external tool identifier '{}'. Allowed tools: yt-dlp, ffmpeg, ffprobe.",
                other
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolBundleId {
    YtDlp,
    FfmpegBundle,
}

impl ToolBundleId {
    pub fn as_str(&self) -> &'static str {
        match self {
            ToolBundleId::YtDlp => "yt-dlp",
            ToolBundleId::FfmpegBundle => "ffmpeg",
        }
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            ToolBundleId::YtDlp => "yt-dlp",
            ToolBundleId::FfmpegBundle => "FFmpeg & FFprobe",
        }
    }

    pub fn tools(&self) -> &'static [ToolId] {
        match self {
            ToolBundleId::YtDlp => &[ToolId::YtDlp],
            ToolBundleId::FfmpegBundle => &[ToolId::Ffmpeg, ToolId::Ffprobe],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolUpdateStatus {
    UpToDate,
    Checking,
    UpdateAvailable,
    Downloading,
    Verifying,
    Testing,
    PendingActivation,
    Installing,
    Updated,
    UpdateFailed,
    RolledBack,
    SourceUntrusted,
}

impl ToolUpdateStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ToolUpdateStatus::UpToDate => "up_to_date",
            ToolUpdateStatus::Checking => "checking",
            ToolUpdateStatus::UpdateAvailable => "update_available",
            ToolUpdateStatus::Downloading => "downloading",
            ToolUpdateStatus::Verifying => "verifying",
            ToolUpdateStatus::Testing => "testing",
            ToolUpdateStatus::PendingActivation => "pending_activation",
            ToolUpdateStatus::Installing => "installing",
            ToolUpdateStatus::Updated => "updated",
            ToolUpdateStatus::UpdateFailed => "update_failed",
            ToolUpdateStatus::RolledBack => "rolled_back",
            ToolUpdateStatus::SourceUntrusted => "source_untrusted",
        }
    }

    pub fn display_label(&self) -> &'static str {
        match self {
            ToolUpdateStatus::UpToDate => "Up to Date",
            ToolUpdateStatus::Checking => "Checking...",
            ToolUpdateStatus::UpdateAvailable => "Update Available",
            ToolUpdateStatus::Downloading => "Downloading...",
            ToolUpdateStatus::Verifying => "Verifying...",
            ToolUpdateStatus::Testing => "Testing...",
            ToolUpdateStatus::PendingActivation => "Pending Activation",
            ToolUpdateStatus::Installing => "Installing...",
            ToolUpdateStatus::Updated => "Updated",
            ToolUpdateStatus::UpdateFailed => "Update Failed",
            ToolUpdateStatus::RolledBack => "Rolled Back",
            ToolUpdateStatus::SourceUntrusted => "Source Untrusted",
        }
    }
}

impl FromStr for ToolUpdateStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "up_to_date" => Ok(ToolUpdateStatus::UpToDate),
            "checking" => Ok(ToolUpdateStatus::Checking),
            "update_available" => Ok(ToolUpdateStatus::UpdateAvailable),
            "downloading" => Ok(ToolUpdateStatus::Downloading),
            "verifying" => Ok(ToolUpdateStatus::Verifying),
            "testing" => Ok(ToolUpdateStatus::Testing),
            "pending_activation" => Ok(ToolUpdateStatus::PendingActivation),
            "installing" => Ok(ToolUpdateStatus::Installing),
            "updated" => Ok(ToolUpdateStatus::Updated),
            "update_failed" => Ok(ToolUpdateStatus::UpdateFailed),
            "rolled_back" => Ok(ToolUpdateStatus::RolledBack),
            "source_untrusted" => Ok(ToolUpdateStatus::SourceUntrusted),
            _ => Ok(ToolUpdateStatus::UpToDate),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustLevel {
    PublisherOpenPgpVerified,
    ToriEd25519ManifestVerified,
    ChecksumOnlyUntrusted,
    BundledVerified,
    Untrusted,
}

impl TrustLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            TrustLevel::PublisherOpenPgpVerified => "publisher_openpgp_verified",
            TrustLevel::ToriEd25519ManifestVerified => "tori_ed25519_manifest_verified",
            TrustLevel::ChecksumOnlyUntrusted => "checksum_only_untrusted",
            TrustLevel::BundledVerified => "bundled_verified",
            TrustLevel::Untrusted => "untrusted",
        }
    }

    pub fn allows_automatic_install(&self) -> bool {
        matches!(
            self,
            TrustLevel::PublisherOpenPgpVerified | TrustLevel::ToriEd25519ManifestVerified
        )
    }
}

/// User-configurable policy for the Independent External Tools Auto-Update Manager.
/// Defaults strictly match the approved Gate 32 policy:
/// - External Tools Auto-Update: ENABLED
/// - Check Frequency: EVERY 24 HOURS
/// - Automatic Installation: ENABLED AFTER VERIFICATION
/// - Update Notifications: ENABLED
/// - Update During Active Tool Usage: DEFER
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ExternalToolsSettings {
    pub auto_update: bool,
    /// Allowed values: 24 (Every 24 hours), 168 (Every 7 days), 0 (Manual only)
    pub check_interval_hours: u32,
    pub auto_install: bool,
    pub notify_on_update: bool,
    pub defer_while_in_use: bool,
}

impl Default for ExternalToolsSettings {
    fn default() -> Self {
        Self {
            auto_update: true,
            check_interval_hours: 24,
            auto_install: true,
            notify_on_update: true,
            defer_while_in_use: true,
        }
    }
}

impl ExternalToolsSettings {
    pub fn normalized(mut self) -> Self {
        self.check_interval_hours = match self.check_interval_hours {
            0 => 0,
            1..=48 => 24,
            _ => 168,
        };
        self
    }

    pub fn background_checks_enabled(&self) -> bool {
        self.auto_update && self.check_interval_hours > 0
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalToolRecord {
    pub tool_id: ToolId,
    pub display_name: String,
    pub installed_version: Option<String>,
    pub available_version: Option<String>,
    pub active_binary_path: Option<String>,
    pub source: String,
    pub platform: String,
    pub architecture: String,
    pub artifact_sha256: Option<String>,
    pub installed_at: Option<DateTime<Utc>>,
    pub last_checked_at: Option<DateTime<Utc>>,
    pub last_updated_at: Option<DateTime<Utc>>,
    pub last_successful_version: Option<String>,
    pub update_status: ToolUpdateStatus,
    pub last_error: Option<String>,
    pub rollback_available: bool,
    pub rollback_version: Option<String>,
    pub rollback_binary_path: Option<String>,
    pub pending_version: Option<String>,
    pub pending_binary_path: Option<String>,
    pub failed_versions: Vec<String>,
}

impl ExternalToolRecord {
    pub fn new_default(tool_id: ToolId) -> Self {
        Self {
            tool_id,
            display_name: tool_id.display_name().to_string(),
            installed_version: None,
            available_version: None,
            active_binary_path: None,
            source: "bundled".to_string(),
            platform: current_platform().to_string(),
            architecture: current_architecture().to_string(),
            artifact_sha256: None,
            installed_at: None,
            last_checked_at: None,
            last_updated_at: None,
            last_successful_version: None,
            update_status: ToolUpdateStatus::UpToDate,
            last_error: None,
            rollback_available: false,
            rollback_version: None,
            rollback_binary_path: None,
            pending_version: None,
            pending_binary_path: None,
            failed_versions: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalToolHistoryEntry {
    pub id: i64,
    pub tool_id: String,
    pub action: String,
    pub from_version: Option<String>,
    pub to_version: Option<String>,
    pub status: String,
    pub source: Option<String>,
    pub artifact_sha256: Option<String>,
    pub trust_level: Option<String>,
    pub message: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolProgressEvent {
    pub tool_id: ToolId,
    pub status: ToolUpdateStatus,
    pub stage: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub speed_bps: u64,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolNotificationKind {
    ToolUpdatedYtDlp,
    ToolUpdatedFfmpegBundle,
    ToolUpdatePostponed,
    ToolUpdateFailed,
    ToolRolledBack,
    ToolOperatorActionRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolNotificationEvent {
    pub kind: ToolNotificationKind,
    pub tool_id: ToolId,
    pub title: String,
    pub body: String,
    pub version: Option<String>,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SchedulerState {
    pub last_successful_check_at: Option<DateTime<Utc>>,
    pub last_attempt_at: Option<DateTime<Utc>>,
    pub consecutive_failures: u32,
    pub next_retry_after: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
}

/// Cryptographic key-purpose domain binding (Gate 33 signing-key separation).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SigningKeyPurpose {
    /// Dedicated signing key exclusively authorized for External Tools manifests (`tori-tools.key`).
    ExternalToolsManifest,
    /// Transitional legacy key shared with Desktop Auto-Updater (`CDC23D8CC8DA5397`).
    /// Accepted ONLY while `TrustedToolsKeyring::allow_legacy_shared_key` is `true`.
    ExternalToolsLegacyShared,
    /// Desktop Auto-Updater ONLY key — strictly rejected for External Tools manifests.
    DesktopAppUpdater,
}

impl SigningKeyPurpose {
    pub fn as_str(&self) -> &'static str {
        match self {
            SigningKeyPurpose::ExternalToolsManifest => "external_tools_manifest",
            SigningKeyPurpose::ExternalToolsLegacyShared => "external_tools_legacy_shared",
            SigningKeyPurpose::DesktopAppUpdater => "desktop_app_updater",
        }
    }
}

/// Lifecycle state of a configured trusted public signing key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustedKeyStatus {
    Active,
    TransitionLegacy,
    Retired,
    Revoked,
}

impl TrustedKeyStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            TrustedKeyStatus::Active => "active",
            TrustedKeyStatus::TransitionLegacy => "transition_legacy",
            TrustedKeyStatus::Retired => "retired",
            TrustedKeyStatus::Revoked => "revoked",
        }
    }
}

/// Public-only metadata for a pinned External Tools Ed25519 signing key.
/// Never stores private key material or passphrases.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrustedSigningKey {
    pub key_id: String,
    pub pubkey_b64: String,
    pub purpose: SigningKeyPurpose,
    pub status: TrustedKeyStatus,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub valid_from: Option<DateTime<Utc>>,
    #[serde(default)]
    pub retired_after: Option<DateTime<Utc>>,
}

fn default_keyring_version() -> u32 {
    1
}

fn default_allow_legacy_shared_key() -> bool {
    true
}

/// Versioned, purpose-bound, revocation-aware External Tools trust keyring (Gate 33).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustedToolsKeyring {
    #[serde(default = "default_keyring_version")]
    pub keyring_version: u32,
    #[serde(default)]
    pub keys: Vec<TrustedSigningKey>,
    #[serde(default)]
    pub revoked_key_ids: Vec<String>,
    #[serde(default = "default_allow_legacy_shared_key")]
    pub allow_legacy_shared_key: bool,
}

impl TrustedToolsKeyring {
    /// Default Stage 0 production keyring: preserves full compatibility with live
    /// Desktop v1.0.7 manifests signed by shared key `CDC23D8CC8DA5397` until an
    /// operator-approved dedicated `tori-tools.key` is added in a future release.
    pub fn default_production_transition() -> Self {
        Self {
            keyring_version: 1,
            keys: vec![TrustedSigningKey {
                key_id: crate::tools::trust::TORI_ED25519_KEY_ID.to_string(),
                pubkey_b64: crate::tools::trust::TORI_ED25519_PUBKEY_B64.to_string(),
                purpose: SigningKeyPurpose::ExternalToolsLegacyShared,
                status: TrustedKeyStatus::TransitionLegacy,
                label: "TORI Production Legacy Shared Key (Pre-Separation Transition)".to_string(),
                valid_from: None,
                retired_after: None,
            }],
            revoked_key_ids: Vec::new(),
            allow_legacy_shared_key: true,
        }
    }

    /// Constructs a keyring containing a single dedicated External Tools signing key.
    pub fn single_dedicated_key(
        key_id: impl Into<String>,
        pubkey_b64: impl Into<String>,
        label: impl Into<String>,
    ) -> Self {
        Self {
            keyring_version: 1,
            keys: vec![TrustedSigningKey {
                key_id: key_id.into().trim().to_ascii_uppercase(),
                pubkey_b64: pubkey_b64.into(),
                purpose: SigningKeyPurpose::ExternalToolsManifest,
                status: TrustedKeyStatus::Active,
                label: label.into(),
                valid_from: None,
                retired_after: None,
            }],
            revoked_key_ids: Vec::new(),
            allow_legacy_shared_key: false,
        }
    }

    pub fn is_revoked(&self, key_id: &str) -> bool {
        let norm = key_id.trim().to_ascii_uppercase();
        if self
            .revoked_key_ids
            .iter()
            .any(|id| id.trim().eq_ignore_ascii_case(&norm))
        {
            return true;
        }
        self.keys.iter().any(|k| {
            k.key_id.trim().eq_ignore_ascii_case(&norm) && k.status == TrustedKeyStatus::Revoked
        })
    }

    pub fn key_is_currently_usable(
        &self,
        key: &TrustedSigningKey,
        now: DateTime<Utc>,
        max_clock_skew_secs: i64,
    ) -> bool {
        if self.is_revoked(&key.key_id) {
            return false;
        }
        match key.status {
            TrustedKeyStatus::Active => {}
            TrustedKeyStatus::TransitionLegacy => {
                if !self.allow_legacy_shared_key {
                    return false;
                }
            }
            TrustedKeyStatus::Retired | TrustedKeyStatus::Revoked => return false,
        }
        match key.purpose {
            SigningKeyPurpose::ExternalToolsManifest => {}
            SigningKeyPurpose::ExternalToolsLegacyShared => {
                if !self.allow_legacy_shared_key {
                    return false;
                }
            }
            SigningKeyPurpose::DesktopAppUpdater => return false,
        }
        let skew = chrono::Duration::seconds(max_clock_skew_secs.max(0));
        if let Some(vf) = key.valid_from {
            if now + skew < vf {
                return false;
            }
        }
        if let Some(ra) = key.retired_after {
            if now > ra + skew {
                return false;
            }
        }
        true
    }

    /// Prevents unsafe key removal / rotation that would leave zero active trusted tools keys.
    pub fn validate_safety(
        &self,
        now: DateTime<Utc>,
        max_clock_skew_secs: i64,
    ) -> crate::error::Result<()> {
        let usable = self
            .keys
            .iter()
            .filter(|k| self.key_is_currently_usable(k, now, max_clock_skew_secs))
            .count();
        if usable == 0 {
            return Err(crate::error::EngineError::Other(
                "Unsafe External Tools keyring: zero active non-revoked signing keys configured"
                    .to_string(),
            ));
        }
        Ok(())
    }

    pub fn has_dedicated_active_key(&self) -> bool {
        self.keys.iter().any(|k| {
            k.purpose == SigningKeyPurpose::ExternalToolsManifest
                && k.status == TrustedKeyStatus::Active
                && !self.is_revoked(&k.key_id)
        })
    }
}

/// Persisted anti-replay state for TORI Ed25519-signed tools manifests.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ManifestAntiReplayState {
    pub highest_accepted_revision: u64,
    pub last_accepted_manifest_sha256: Option<String>,
    pub last_accepted_published_at: Option<DateTime<Utc>>,
    pub last_accepted_expires_at: Option<DateTime<Utc>>,
    pub last_accepted_at: Option<DateTime<Utc>>,
    pub last_signing_key_id: Option<String>,
    pub last_signing_key_purpose: Option<String>,
    pub last_verification_status: Option<String>,
    pub last_verification_error: Option<String>,
}

/// Backend-derived consumer-safe signed manifest status for Settings -> External Tools (Phase 15).
/// Never exposes private key material or maintainer secrets.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ManifestHealthSummary {
    pub verification_status: String,
    pub current_revision: Option<u64>,
    pub last_verified_at: Option<DateTime<Utc>>,
    pub published_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
    pub trusted_source_status: String,
    pub signing_key_id: Option<String>,
    pub signing_key_purpose: Option<String>,
    pub next_scheduled_check_at: Option<DateTime<Utc>>,
    pub last_failure: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalToolsSnapshot {
    pub tools: Vec<ExternalToolRecord>,
    pub settings: ExternalToolsSettings,
    pub scheduler: SchedulerState,
    pub checking: bool,
    pub active_yt_dlp_leases: usize,
    pub active_ffmpeg_leases: usize,
    pub active_ffprobe_leases: usize,
    #[serde(default)]
    pub manifest_status: ManifestHealthSummary,
}

#[derive(Debug, Clone)]
pub struct ToolsManagerConfig {
    pub ytdlp_release_api_url: String,
    pub ffmpeg_release_api_url: String,
    pub signed_manifest_url: Option<String>,
    pub tori_manifest_pubkey_b64: String,
    pub expected_manifest_key_id: Option<String>,
    /// Optional explicit multi-key keyring (Gate 33). When `None`, derives cleanly from
    /// default production transition keyring or any legacy single-key override.
    pub tools_keyring: Option<TrustedToolsKeyring>,
    pub current_tori_version: String,
    pub max_clock_skew_secs: i64,
    pub ytdlp_pgp_pubkey_asc: String,
    pub ytdlp_pgp_fingerprint_hex: String,
    pub allow_loopback_http: bool,
    pub http_timeout_secs: u64,
    pub download_timeout_secs: u64,
    pub max_ytdlp_bytes: u64,
    pub max_ffmpeg_zip_bytes: u64,
    pub max_extracted_bundle_bytes: u64,
    pub bundled_override_dir: Option<std::path::PathBuf>,
    pub register_globally: bool,
}

impl ToolsManagerConfig {
    /// Resolves the effective `TrustedToolsKeyring` while preserving full backward
    /// compatibility for tests/callers that set `tori_manifest_pubkey_b64` directly.
    pub fn effective_tools_keyring(&self) -> TrustedToolsKeyring {
        if let Some(ref kr) = self.tools_keyring {
            return kr.clone();
        }
        let is_default_pub = self.tori_manifest_pubkey_b64.trim()
            == crate::tools::trust::TORI_ED25519_PUBKEY_B64.trim();
        let is_default_kid = self.expected_manifest_key_id.as_deref()
            == Some(crate::tools::trust::TORI_ED25519_KEY_ID);
        if is_default_pub && is_default_kid {
            return TrustedToolsKeyring::default_production_transition();
        }
        let key_id = self
            .expected_manifest_key_id
            .clone()
            .or_else(|| crate::tools::trust::extract_minisign_key_id_hex(&self.tori_manifest_pubkey_b64))
            .unwrap_or_else(|| "UNKNOWN_KEY_ID".to_string());
        TrustedToolsKeyring::single_dedicated_key(
            key_id,
            self.tori_manifest_pubkey_b64.clone(),
            "Configured Single External Tools Signing Key",
        )
    }
}

impl Default for ToolsManagerConfig {
    fn default() -> Self {
        Self {
            ytdlp_release_api_url:
                "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest".to_string(),
            ffmpeg_release_api_url:
                "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest".to_string(),
            signed_manifest_url: Some(
                crate::tools::trust::TORI_DEFAULT_TOOLS_MANIFEST_URL.to_string(),
            ),
            tori_manifest_pubkey_b64: crate::tools::trust::TORI_ED25519_PUBKEY_B64.to_string(),
            expected_manifest_key_id: Some(
                crate::tools::trust::TORI_ED25519_KEY_ID.to_string(),
            ),
            tools_keyring: None,
            current_tori_version: env!("CARGO_PKG_VERSION").to_string(),
            max_clock_skew_secs: 15 * 60,
            ytdlp_pgp_pubkey_asc: crate::tools::trust::YTDLP_PGP_PUBKEY_ASC.to_string(),
            ytdlp_pgp_fingerprint_hex: crate::tools::trust::YTDLP_PGP_FINGERPRINT_HEX.to_string(),
            allow_loopback_http: false,
            http_timeout_secs: 20,
            download_timeout_secs: 1800,
            max_ytdlp_bytes: 90 * 1024 * 1024,
            max_ffmpeg_zip_bytes: 380 * 1024 * 1024,
            max_extracted_bundle_bytes: 650 * 1024 * 1024,
            bundled_override_dir: None,
            register_globally: true,
        }
    }
}

pub fn current_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

pub fn current_architecture() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        std::env::consts::ARCH
    }
}
