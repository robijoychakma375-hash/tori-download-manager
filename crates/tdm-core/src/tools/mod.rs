pub mod activation;
pub mod health;
pub mod manager;
pub mod providers;
pub mod staging;
pub mod store;
pub mod trust;
pub mod types;
pub mod version;

pub use activation::{
    acquire_global_tool_lease, discover_bundled_tool, discover_system_fallback_tool,
    global_tool_coordinator, resolve_global_tool_path, ActiveToolsManifest, ManagedBinarySlot,
    ManagedFfmpegBundleSlot, ResolvedToolBinary, ToolLeaseGuard, ToolUsageCoordinator,
};
pub use health::{verify_staged_ffmpeg_bundle, verify_staged_ytdlp};
pub use manager::{BusyJobsCheckFn, ExternalToolsEvent, ExternalToolsManager};
pub use providers::{
    parse_sha256_sums_file, ManifestFetchOutcome, ManifestProvenance, SignedManifestToolEntry,
    SignedToolsManifest, UpdateCandidate, ValidatedSignedManifest,
};
pub use staging::{extract_ffmpeg_bundle_zip, ToolsDirLayout};
pub use trust::{
    compare_semver_versions, compute_file_sha256, extract_minisign_key_id_hex,
    extract_minisign_sig_key_id_hex, parse_and_pin_openpgp_rsa_pubkey, reject_duplicate_json_keys,
    validate_trusted_url, validate_windows_x64_pe_bytes, validate_windows_x64_pe_file,
    verify_minisign_ed25519, verify_minisign_with_keyring, verify_openpgp_detached_rsa_signature,
    VerifiedKeyringSignature, TORI_DEFAULT_TOOLS_MANIFEST_URL, TORI_ED25519_KEY_ID,
    TORI_ED25519_PUBKEY_B64, TORI_STAGING_GATE33_TOOLS_MANIFEST_PREFIX,
    TORI_STAGING_TOOLS_MANIFEST_PREFIX, YTDLP_PGP_FINGERPRINT_HEX, YTDLP_PGP_PUBKEY_ASC,
};
pub use types::{
    ExternalToolHistoryEntry, ExternalToolRecord, ExternalToolsSettings, ExternalToolsSnapshot,
    ManifestAntiReplayState, ManifestHealthSummary, SchedulerState, SigningKeyPurpose,
    ToolBundleId, ToolId, ToolNotificationEvent, ToolNotificationKind, ToolProgressEvent,
    ToolUpdateStatus, ToolsManagerConfig, TrustLevel, TrustedKeyStatus, TrustedSigningKey,
    TrustedToolsKeyring,
};
pub use version::{
    compare_tool_versions, ffmpeg_ffprobe_versions_compatible, parse_tool_version_output,
    probe_tool_version, VersionComparison,
};
