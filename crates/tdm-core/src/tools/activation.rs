use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock, RwLock};

use crate::error::{EngineError, Result};
use crate::hls::muxer::silent_command;
use crate::tools::staging::ToolsDirLayout;
use crate::tools::types::{ToolBundleId, ToolId};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManagedBinarySlot {
    pub version: String,
    pub binary_path: PathBuf,
    pub sha256: Option<String>,
    pub source: String,
    pub activated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManagedFfmpegBundleSlot {
    pub version: String,
    pub ffmpeg_version: String,
    pub ffprobe_version: String,
    pub ffmpeg_path: PathBuf,
    pub ffprobe_path: PathBuf,
    pub sha256: Option<String>,
    pub source: String,
    pub activated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct ActiveToolsManifest {
    pub schema_version: u32,
    pub updated_at: Option<DateTime<Utc>>,
    pub yt_dlp_active: Option<ManagedBinarySlot>,
    pub yt_dlp_rollback: Option<ManagedBinarySlot>,
    pub yt_dlp_pending: Option<ManagedBinarySlot>,
    pub ffmpeg_bundle_active: Option<ManagedFfmpegBundleSlot>,
    pub ffmpeg_bundle_rollback: Option<ManagedFfmpegBundleSlot>,
    pub ffmpeg_bundle_pending: Option<ManagedFfmpegBundleSlot>,
}

impl ActiveToolsManifest {
    pub fn new() -> Self {
        Self {
            schema_version: 1,
            updated_at: Some(Utc::now()),
            ..Default::default()
        }
    }
}

/// Crash-safely writes `active-tools.json` via write-to-`.tmp` + `sync_all()` + backup + atomic replace.
pub fn write_active_manifest_atomic(
    layout: &ToolsDirLayout,
    manifest: &ActiveToolsManifest,
) -> Result<()> {
    layout.ensure_dirs()?;
    let target = layout.active_manifest_path();
    let backup = layout.active_manifest_backup_path();
    let tmp = layout
        .manifests
        .join(format!("active-tools.json.{}.tmp", uuid::Uuid::new_v4()));

    let mut to_save = manifest.clone();
    to_save.schema_version = 1;
    to_save.updated_at = Some(Utc::now());

    let serialized = serde_json::to_vec_pretty(&to_save)
        .map_err(|e| EngineError::Other(format!("Failed serializing active-tools.json: {}", e)))?;

    {
        let mut f = File::create(&tmp)?;
        f.write_all(&serialized)?;
        f.flush()?;
        f.sync_all()?;
    }

    // Preserve previous valid manifest in `.bak` for corruption recovery
    if target.exists() {
        let _ = fs::copy(&target, &backup);
    }

    replace_file_atomic(&tmp, &target)?;
    Ok(())
}

#[cfg(windows)]
fn replace_file_atomic(src: &Path, dst: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;

    extern "system" {
        fn MoveFileExW(
            lp_existing_file_name: *const u16,
            lp_new_file_name: *const u16,
            dw_flags: u32,
        ) -> i32;
    }

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    let src_w: Vec<u16> = src
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let dst_w: Vec<u16> = dst
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let ok = unsafe {
        MoveFileExW(
            src_w.as_ptr(),
            dst_w.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok != 0 {
        Ok(())
    } else {
        let err = std::io::Error::last_os_error();
        let _ = fs::remove_file(src);
        Err(EngineError::Io(err))
    }
}

#[cfg(not(windows))]
fn replace_file_atomic(src: &Path, dst: &Path) -> Result<()> {
    fs::rename(src, dst)?;
    Ok(())
}

/// Loads `active-tools.json`, automatically recovering from `.bak` or returning a clean default
/// if the manifest file was corrupted or truncated (e.g. abrupt power loss).
pub fn load_active_manifest_with_recovery(layout: &ToolsDirLayout) -> (ActiveToolsManifest, bool) {
    let target = layout.active_manifest_path();
    if target.exists() {
        if let Ok(bytes) = fs::read(&target) {
            if let Ok(parsed) = serde_json::from_slice::<ActiveToolsManifest>(&bytes) {
                return (parsed, false);
            }
        }
        // Primary manifest is corrupted — attempt `.bak` recovery
        let backup = layout.active_manifest_backup_path();
        if backup.exists() {
            if let Ok(bytes) = fs::read(&backup) {
                if let Ok(parsed) = serde_json::from_slice::<ActiveToolsManifest>(&bytes) {
                    let _ = write_active_manifest_atomic(layout, &parsed);
                    return (parsed, true);
                }
            }
        }
        // Both corrupted — reset to clean manifest (bundled fallback will automatically take over)
        let fresh = ActiveToolsManifest::new();
        let _ = write_active_manifest_atomic(layout, &fresh);
        return (fresh, true);
    }

    (ActiveToolsManifest::new(), false)
}

/// Discovers a TORI-bundled tool binary (sidecar next to executable or repository `resources/bin/`).
pub fn discover_bundled_tool(
    tool: ToolId,
    bundled_override_dir: Option<&Path>,
) -> Option<PathBuf> {
    let exe_name = tool.exe_name();

    if let Some(dir) = bundled_override_dir {
        for cand in [dir.join(exe_name), dir.join("bin").join(exe_name)] {
            if cand.exists() && cand.is_file() {
                return Some(cand);
            }
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Production NSIS install layout: <app_dir>/bin/<tool>.exe or <app_dir>/<tool>.exe
            for cand in [
                dir.join("bin").join(exe_name),
                dir.join(exe_name),
                dir.join("resources").join("bin").join(exe_name),
                dir.join("resources").join(exe_name),
            ] {
                if cand.exists() && cand.is_file() {
                    return Some(cand);
                }
            }

            // Development / cargo target layout: walk up to 4 levels for repo `resources/bin/`
            let mut ancestor = dir.parent();
            for _ in 0..4 {
                if let Some(a) = ancestor {
                    let cand = a.join("resources").join("bin").join(exe_name);
                    if cand.exists() && cand.is_file() {
                        return Some(cand);
                    }
                    ancestor = a.parent();
                } else {
                    break;
                }
            }
        }
    }

    // Also check current working directory's `resources/bin/` when running from repo root
    if let Ok(cwd) = std::env::current_dir() {
        let cand = cwd.join("resources").join("bin").join(exe_name);
        if cand.exists() && cand.is_file() {
            return Some(cand);
        }
    }

    None
}

/// Discovers system-installed tool binaries as a final fallback ONLY when neither managed nor bundled binaries exist.
pub fn discover_system_fallback_tool(tool: ToolId) -> Option<PathBuf> {
    let exe_name = tool.exe_name();
    let short_name = tool.as_str();

    // 1. Legacy user local runtime directory (%LOCALAPPDATA%\tori-download-manager\bin)
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let p = PathBuf::from(&local_app_data)
            .join("tori-download-manager")
            .join("bin")
            .join(exe_name);
        if p.exists() && p.is_file() {
            return Some(p);
        }
    }

    // 2. PATH via where.exe
    if let Ok(output) = silent_command("where.exe").arg(short_name).output() {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(line) = stdout.lines().next() {
                let p = PathBuf::from(line.trim());
                if p.exists() && p.is_file() {
                    return Some(p);
                }
            }
        }
    }

    // 3. WinGet Packages & common system locations
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let winget_dir = PathBuf::from(&local_app_data)
            .join("Microsoft")
            .join("WinGet")
            .join("Packages");
        if let Ok(entries) = fs::read_dir(winget_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let name_lc = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                match tool {
                    ToolId::YtDlp if name_lc.contains("yt-dlp.yt-dlp") => {
                        let bin = path.join(exe_name);
                        if bin.exists() && bin.is_file() {
                            return Some(bin);
                        }
                    }
                    ToolId::Ffmpeg | ToolId::Ffprobe if name_lc.contains("ffmpeg") => {
                        if let Ok(sub_entries) = fs::read_dir(&path) {
                            for sub in sub_entries.flatten() {
                                let bin = sub.path().join("bin").join(exe_name);
                                if bin.exists() && bin.is_file() {
                                    return Some(bin);
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    let common_paths: &[&str] = match tool {
        ToolId::YtDlp => &[
            r"C:\yt-dlp\yt-dlp.exe",
            r"C:\Program Files\yt-dlp\yt-dlp.exe",
            r"C:\ProgramData\chocolatey\bin\yt-dlp.exe",
            r"C:\tools\yt-dlp\yt-dlp.exe",
        ],
        ToolId::Ffmpeg => &[
            r"C:\ffmpeg\bin\ffmpeg.exe",
            r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
        ],
        ToolId::Ffprobe => &[
            r"C:\ffmpeg\bin\ffprobe.exe",
            r"C:\Program Files\ffmpeg\bin\ffprobe.exe",
        ],
    };

    for cand in common_paths {
        let p = PathBuf::from(cand);
        if p.exists() && p.is_file() {
            return Some(p);
        }
    }

    None
}

/// Resolved executable location along with provenance (managed, rollback, bundled, or system).
#[derive(Debug, Clone)]
pub struct ResolvedToolBinary {
    pub path: PathBuf,
    pub source: &'static str,
    pub version_hint: Option<String>,
    pub sha256_hint: Option<String>,
}

/// Process-wide (or test-isolated) active-tool resolver and active-usage lease coordinator.
/// Ensures race-free coordination between active tool executions (`yt-dlp`, `ffmpeg`, `ffprobe`)
/// and atomic active-version switches.
pub struct ToolUsageCoordinator {
    manifest: RwLock<ActiveToolsManifest>,
    bundled_override_dir: RwLock<Option<PathBuf>>,
    yt_dlp_leases: AtomicUsize,
    ffmpeg_leases: AtomicUsize,
    ffprobe_leases: AtomicUsize,
}

impl Default for ToolUsageCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolUsageCoordinator {
    pub fn new() -> Self {
        Self {
            manifest: RwLock::new(ActiveToolsManifest::new()),
            bundled_override_dir: RwLock::new(None),
            yt_dlp_leases: AtomicUsize::new(0),
            ffmpeg_leases: AtomicUsize::new(0),
            ffprobe_leases: AtomicUsize::new(0),
        }
    }

    pub fn set_manifest(&self, manifest: ActiveToolsManifest) {
        let mut guard = self.manifest.write().unwrap();
        *guard = manifest;
    }

    pub fn snapshot_manifest(&self) -> ActiveToolsManifest {
        self.manifest.read().unwrap().clone()
    }

    pub fn set_bundled_override_dir(&self, dir: Option<PathBuf>) {
        let mut guard = self.bundled_override_dir.write().unwrap();
        *guard = dir;
    }

    fn lease_counter(&self, tool: ToolId) -> &AtomicUsize {
        match tool {
            ToolId::YtDlp => &self.yt_dlp_leases,
            ToolId::Ffmpeg => &self.ffmpeg_leases,
            ToolId::Ffprobe => &self.ffprobe_leases,
        }
    }

    pub fn active_leases(&self, tool: ToolId) -> usize {
        self.lease_counter(tool).load(Ordering::SeqCst)
    }

    pub fn is_bundle_busy(&self, bundle: ToolBundleId) -> bool {
        match bundle {
            ToolBundleId::YtDlp => self.active_leases(ToolId::YtDlp) > 0,
            ToolBundleId::FfmpegBundle => {
                self.active_leases(ToolId::Ffmpeg) > 0 || self.active_leases(ToolId::Ffprobe) > 0
            }
        }
    }

    /// Resolves the highest-priority healthy executable path for `tool`:
    /// 1. Active verified managed version (`active-tools.json`)
    /// 2. Verified rollback managed version (`active-tools.json`)
    /// 3. Bundled binary shipped with TORI
    /// 4. System fallback (only if neither managed nor bundled exists)
    pub fn resolve_tool(&self, tool: ToolId) -> Option<ResolvedToolBinary> {
        let manifest = self.manifest.read().unwrap();
        let bundled_override = self.bundled_override_dir.read().unwrap().clone();

        match tool {
            ToolId::YtDlp => {
                if let Some(ref slot) = manifest.yt_dlp_active {
                    if is_healthy_file(&slot.binary_path) {
                        return Some(ResolvedToolBinary {
                            path: slot.binary_path.clone(),
                            source: "managed",
                            version_hint: Some(slot.version.clone()),
                            sha256_hint: slot.sha256.clone(),
                        });
                    }
                }
                if let Some(ref slot) = manifest.yt_dlp_rollback {
                    if is_healthy_file(&slot.binary_path) {
                        return Some(ResolvedToolBinary {
                            path: slot.binary_path.clone(),
                            source: "rollback",
                            version_hint: Some(slot.version.clone()),
                            sha256_hint: slot.sha256.clone(),
                        });
                    }
                }
            }
            ToolId::Ffmpeg | ToolId::Ffprobe => {
                // Only use managed FFmpeg/FFprobe if BOTH binaries exist so pair parity is never broken
                if let Some(ref slot) = manifest.ffmpeg_bundle_active {
                    if is_healthy_file(&slot.ffmpeg_path) && is_healthy_file(&slot.ffprobe_path) {
                        let (path, ver) = match tool {
                            ToolId::Ffmpeg => (slot.ffmpeg_path.clone(), slot.ffmpeg_version.clone()),
                            ToolId::Ffprobe => {
                                (slot.ffprobe_path.clone(), slot.ffprobe_version.clone())
                            }
                            ToolId::YtDlp => unreachable!(),
                        };
                        return Some(ResolvedToolBinary {
                            path,
                            source: "managed",
                            version_hint: Some(ver),
                            sha256_hint: slot.sha256.clone(),
                        });
                    }
                }
                if let Some(ref slot) = manifest.ffmpeg_bundle_rollback {
                    if is_healthy_file(&slot.ffmpeg_path) && is_healthy_file(&slot.ffprobe_path) {
                        let (path, ver) = match tool {
                            ToolId::Ffmpeg => (slot.ffmpeg_path.clone(), slot.ffmpeg_version.clone()),
                            ToolId::Ffprobe => {
                                (slot.ffprobe_path.clone(), slot.ffprobe_version.clone())
                            }
                            ToolId::YtDlp => unreachable!(),
                        };
                        return Some(ResolvedToolBinary {
                            path,
                            source: "rollback",
                            version_hint: Some(ver),
                            sha256_hint: slot.sha256.clone(),
                        });
                    }
                }
            }
        }
        drop(manifest);

        if let Some(bundled) = discover_bundled_tool(tool, bundled_override.as_deref()) {
            return Some(ResolvedToolBinary {
                path: bundled,
                source: "bundled",
                version_hint: None,
                sha256_hint: None,
            });
        }

        if let Some(sys) = discover_system_fallback_tool(tool) {
            return Some(ResolvedToolBinary {
                path: sys,
                source: "system",
                version_hint: None,
                sha256_hint: None,
            });
        }

        None
    }

    /// Acquires an RAII usage lease for `tool` and returns the resolved executable path.
    /// While this guard is alive, active-tool switches for this tool's bundle will defer cleanly.
    pub fn acquire_lease(self: &Arc<Self>, tool: ToolId) -> Option<ToolLeaseGuard> {
        // Hold read lock while resolving & incrementing lease counter so activation's write lock
        // cannot interleave between path resolution and lease acquisition.
        let _manifest_guard = self.manifest.read().unwrap();
        self.lease_counter(tool).fetch_add(1, Ordering::SeqCst);
        drop(_manifest_guard);

        match self.resolve_tool(tool) {
            Some(resolved) => Some(ToolLeaseGuard {
                coordinator: Arc::clone(self),
                tool,
                path: resolved.path,
            }),
            None => {
                self.lease_counter(tool).fetch_sub(1, Ordering::SeqCst);
                None
            }
        }
    }

    /// Attempts an exclusive manifest mutation ONLY if `defer_while_in_use` allows it
    /// (zero active leases for `bundle` and `extra_busy == false`).
    /// Returns `Ok(true)` if activated immediately, or `Ok(false)` if deferred due to active usage.
    pub fn try_commit_manifest_if_idle<F>(
        &self,
        bundle: ToolBundleId,
        defer_while_in_use: bool,
        extra_busy: bool,
        layout: &ToolsDirLayout,
        mutate: F,
    ) -> Result<bool>
    where
        F: FnOnce(&mut ActiveToolsManifest),
    {
        let mut guard = self.manifest.write().unwrap();
        if defer_while_in_use && (self.is_bundle_busy(bundle) || extra_busy) {
            return Ok(false);
        }
        let mut next = guard.clone();
        mutate(&mut next);
        write_active_manifest_atomic(layout, &next)?;
        *guard = next;
        Ok(true)
    }

    /// Mutates manifest metadata that does not swap an in-use active binary (e.g. recording a pending candidate).
    pub fn update_manifest_metadata<F>(&self, layout: &ToolsDirLayout, mutate: F) -> Result<()>
    where
        F: FnOnce(&mut ActiveToolsManifest),
    {
        let mut guard = self.manifest.write().unwrap();
        let mut next = guard.clone();
        mutate(&mut next);
        write_active_manifest_atomic(layout, &next)?;
        *guard = next;
        Ok(())
    }
}

pub struct ToolLeaseGuard {
    coordinator: Arc<ToolUsageCoordinator>,
    tool: ToolId,
    path: PathBuf,
}

impl ToolLeaseGuard {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn into_path_buf_ref(&self) -> PathBuf {
        self.path.clone()
    }
}

impl Drop for ToolLeaseGuard {
    fn drop(&mut self) {
        self.coordinator
            .lease_counter(self.tool)
            .fetch_sub(1, Ordering::SeqCst);
    }
}

fn is_healthy_file(path: &Path) -> bool {
    path.exists()
        && path.is_file()
        && fs::metadata(path).map(|m| m.len() >= 512).unwrap_or(false)
}

/// Removes obsolete version directories under `versions/<bundle>/`, strictly preserving
/// the active version, the rollback version, and any pending version.
pub fn prune_obsolete_versions(
    versions_dir: &Path,
    keep_paths: &[&Path],
) -> usize {
    let Ok(entries) = fs::read_dir(versions_dir) else {
        return 0;
    };
    let mut removed = 0usize;
    for entry in entries.flatten() {
        let dir_path = entry.path();
        if !dir_path.is_dir() {
            continue;
        }
        let should_keep = keep_paths
            .iter()
            .any(|kp| kp.starts_with(&dir_path) || *kp == dir_path);
        if !should_keep && fs::remove_dir_all(&dir_path).is_ok() {
            removed += 1;
        }
    }
    removed
}

// ============================================================================
// Global Active-Tools Coordinator Registry (wired into find_yt_dlp / ffmpeg / ffprobe)
// ============================================================================

static GLOBAL_COORDINATOR: OnceLock<Arc<ToolUsageCoordinator>> = OnceLock::new();

pub fn global_tool_coordinator() -> Arc<ToolUsageCoordinator> {
    GLOBAL_COORDINATOR
        .get_or_init(|| Arc::new(ToolUsageCoordinator::new()))
        .clone()
}

pub fn acquire_global_tool_lease(tool: ToolId) -> Option<ToolLeaseGuard> {
    global_tool_coordinator().acquire_lease(tool)
}

pub fn resolve_global_tool_path(tool: ToolId) -> Option<PathBuf> {
    global_tool_coordinator().resolve_tool(tool).map(|r| r.path)
}
