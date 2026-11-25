use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::windows::named_pipe::{
    ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
};
use tokio_util::sync::CancellationToken;

use tdm_core::{Database, DownloadManager};

use crate::handle_message;
use crate::protocol::{
    read_message_async, read_response_async, write_message_async, write_response_async,
    NativeMessage, NativeResponse,
};

pub const IPC_PIPE_NAME: &str = r"\\.\pipe\tori-download-manager-ipc";

/// Resolves the IPC Named Pipe name, checking for `TORI_IPC_PIPE` environment variable override for test isolation.
pub fn get_ipc_pipe_name() -> String {
    if let Ok(pipe) = std::env::var("TORI_IPC_PIPE") {
        let trimmed = pipe.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    IPC_PIPE_NAME.to_string()
}

/// Starts the asynchronous Windows Named Pipe IPC Server on a specific pipe name.
pub async fn run_ipc_server_on_pipe(
    pipe_name: &str,
    manager: Arc<DownloadManager>,
    db: Database,
    shutdown_token: CancellationToken,
) {
    tracing::info!("[TDM IPC] Starting Named Pipe Server on {}", pipe_name);
    let mut first_instance = true;

    loop {
        let server = match ServerOptions::new()
            .first_pipe_instance(first_instance)
            .reject_remote_clients(true)
            .max_instances(32)
            .create(pipe_name)
        {
            Ok(s) => {
                first_instance = false;
                s
            }
            Err(e) => {
                tracing::warn!(
                    "[TDM IPC] Failed to create Named Pipe instance: {}. Retrying in 500ms...",
                    e
                );
                tokio::select! {
                    _ = shutdown_token.cancelled() => break,
                    _ = tokio::time::sleep(Duration::from_millis(500)) => continue,
                }
            }
        };

        tokio::select! {
            _ = shutdown_token.cancelled() => {
                tracing::info!("[TDM IPC] IPC Server shutting down");
                break;
            }
            res = server.connect() => {
                if let Err(e) = res {
                    tracing::warn!("[TDM IPC] Client connection error: {}", e);
                    continue;
                }

                let mgr = manager.clone();
                let d = db.clone();
                tokio::spawn(async move {
                    handle_client_connection(server, mgr, d).await;
                });
            }
        }
    }
}

/// Starts the asynchronous Windows Named Pipe IPC Server on default IPC_PIPE_NAME (or TORI_IPC_PIPE override).
pub async fn run_ipc_server(
    manager: Arc<DownloadManager>,
    db: Database,
    shutdown_token: CancellationToken,
) {
    run_ipc_server_on_pipe(&get_ipc_pipe_name(), manager, db, shutdown_token).await;
}

async fn handle_client_connection(
    mut client: NamedPipeServer,
    manager: Arc<DownloadManager>,
    db: Database,
) {
    let (mut reader, mut writer) = tokio::io::split(&mut client);

    while let Ok(Some(msg)) = read_message_async(&mut reader).await {
        let resp = handle_message(msg, &manager, &db).await;
        if write_response_async(&mut writer, &resp).await.is_err() {
            break;
        }
    }
}

/// Attempts to connect to the persistent engine Named Pipe.
pub fn try_connect_engine() -> io::Result<NamedPipeClient> {
    ClientOptions::new().open(get_ipc_pipe_name())
}

/// Locates the `tori-download-manager.exe` desktop binary.
pub fn locate_desktop_binary() -> Option<PathBuf> {
    // 1. Same folder as current executable or any parent directory (e.g. resources/bin -> INSTDIR)
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            let candidate = parent.join("tori-download-manager.exe");
            if candidate.exists() {
                return Some(candidate);
            }

            // Climb parent directories (e.g. resources/bin -> resources -> app root)
            let mut curr = parent;
            while let Some(p) = curr.parent() {
                let cand = p.join("tori-download-manager.exe");
                if cand.exists() {
                    return Some(cand);
                }
                curr = p;
            }

            // 2. target/release or target/debug check
            let target_release = parent.parent().and_then(|p| p.parent()).map(|p| {
                p.join("target")
                    .join("release")
                    .join("tori-download-manager.exe")
            });
            if let Some(c) = target_release {
                if c.exists() {
                    return Some(c);
                }
            }
        }
    }

    // 3. Current working directory
    let cwd_cand = Path::new("target")
        .join("release")
        .join("tori-download-manager.exe");
    if cwd_cand.exists() {
        return Some(cwd_cand);
    }

    // 4. User profile LocalAppData installation (standard Tauri NSIS targets)
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let nsis_direct_cand = PathBuf::from(&local_app_data)
            .join("TORI Download Manager")
            .join("tori-download-manager.exe");
        if nsis_direct_cand.exists() {
            return Some(nsis_direct_cand);
        }

        let nsis_user_cand = PathBuf::from(&local_app_data)
            .join("Programs")
            .join("TORI Download Manager")
            .join("tori-download-manager.exe");
        if nsis_user_cand.exists() {
            return Some(nsis_user_cand);
        }
    }

    // 5. System Program Files installation
    if let Ok(prog_files) = std::env::var("ProgramFiles") {
        let nsis_sys_cand = PathBuf::from(prog_files)
            .join("TORI Download Manager")
            .join("tori-download-manager.exe");
        if nsis_sys_cand.exists() {
            return Some(nsis_sys_cand);
        }
    }

    None
}

/// Computes a deterministic per-pipe Windows named mutex identifier so isolated test pipes
/// never collide with the production TORI Desktop spawn mutex.
pub fn spawn_mutex_name_for_pipe(pipe_name: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in pipe_name.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("Local\\TORI_DM_EngineSpawn_{:016x}", hash)
}

#[cfg(windows)]
pub(crate) struct EngineSpawnMutexGuard {
    handle: *mut std::ffi::c_void,
    owned: bool,
}

#[cfg(windows)]
unsafe impl Send for EngineSpawnMutexGuard {}

#[cfg(windows)]
impl EngineSpawnMutexGuard {
    pub(crate) fn acquire_for_pipe(pipe_name: &str, timeout_ms: u32) -> Option<Self> {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;

        const WAIT_OBJECT_0: u32 = 0x0000_0000;
        const WAIT_ABANDONED: u32 = 0x0000_0080;

        #[link(name = "kernel32")]
        extern "system" {
            fn CreateMutexW(
                lp_mutex_attributes: *mut std::ffi::c_void,
                b_initial_owner: i32,
                lp_name: *const u16,
            ) -> *mut std::ffi::c_void;
            fn WaitForSingleObject(h_handle: *mut std::ffi::c_void, dw_milliseconds: u32) -> u32;
            fn CloseHandle(h_object: *mut std::ffi::c_void) -> i32;
        }

        let wide_name: Vec<u16> = OsStr::new(&spawn_mutex_name_for_pipe(pipe_name))
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        unsafe {
            let handle = CreateMutexW(std::ptr::null_mut(), 0, wide_name.as_ptr());
            if handle.is_null() {
                return None;
            }
            let wait_res = WaitForSingleObject(handle, timeout_ms);
            if wait_res == WAIT_OBJECT_0 || wait_res == WAIT_ABANDONED {
                Some(Self {
                    handle,
                    owned: true,
                })
            } else {
                let _ = CloseHandle(handle);
                None
            }
        }
    }
}

#[cfg(windows)]
impl Drop for EngineSpawnMutexGuard {
    fn drop(&mut self) {
        #[link(name = "kernel32")]
        extern "system" {
            fn ReleaseMutex(h_mutex: *mut std::ffi::c_void) -> i32;
            fn CloseHandle(h_object: *mut std::ffi::c_void) -> i32;
        }
        unsafe {
            if self.owned && !self.handle.is_null() {
                let _ = ReleaseMutex(self.handle);
            }
            if !self.handle.is_null() {
                let _ = CloseHandle(self.handle);
            }
        }
    }
}

/// Ensures the persistent desktop engine is active.
/// If not already active, launches `tori-download-manager.exe` in background mode,
/// serialized by a cross-process Windows named mutex (preventing multi-process startup stampedes)
/// and strictly detaching standard I/O handles and breaking away from the browser's
/// Native Messaging Job Object so the desktop engine is not terminated when the
/// short-lived native host process exits.
pub async fn ensure_engine_running() -> bool {
    if try_connect_engine().is_ok() {
        return true;
    }

    if std::env::var("TORI_DISABLE_AUTO_SPAWN")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
    {
        return false;
    }

    // Serialize cold spawns across concurrent native-host processes so a burst of browser
    // events can never stampede-launch multiple copies of tori-download-manager.exe.
    #[cfg(windows)]
    let _spawn_guard = {
        let pipe_for_lock = get_ipc_pipe_name();
        tokio::task::spawn_blocking(move || {
            EngineSpawnMutexGuard::acquire_for_pipe(&pipe_for_lock, 12_000)
        })
        .await
        .ok()
        .flatten()
    };

    // Re-check after acquiring the cross-process spawn mutex in case another native host
    // process just finished starting the persistent desktop engine.
    if try_connect_engine().is_ok() {
        return true;
    }

    if let Some(exe_path) = locate_desktop_binary() {
        eprintln!(
            "[TORI Native Host] Spawning persistent desktop engine: {:?}",
            exe_path
        );

        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            const HANDLE_FLAG_INHERIT: u32 = 0x0000_0001;
            #[link(name = "kernel32")]
            extern "system" {
                fn SetHandleInformation(
                    h_object: *mut std::ffi::c_void,
                    dw_mask: u32,
                    dw_flags: u32,
                ) -> i32;
            }
            unsafe {
                let _ = SetHandleInformation(
                    io::stdin().as_raw_handle() as *mut std::ffi::c_void,
                    HANDLE_FLAG_INHERIT,
                    0,
                );
                let _ = SetHandleInformation(
                    io::stdout().as_raw_handle() as *mut std::ffi::c_void,
                    HANDLE_FLAG_INHERIT,
                    0,
                );
                let _ = SetHandleInformation(
                    io::stderr().as_raw_handle() as *mut std::ffi::c_void,
                    HANDLE_FLAG_INHERIT,
                    0,
                );
            }
        }

        let build_cmd = |flags: u32| -> Command {
            let mut cmd = Command::new(&exe_path);
            cmd.arg("--minimized");
            cmd.stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            #[cfg(windows)]
            {
                cmd.creation_flags(flags);
            }
            if let Ok(dir) = std::env::var("TORI_DATA_DIR") {
                cmd.env("TORI_DATA_DIR", dir);
            }
            if let Ok(pipe) = std::env::var("TORI_IPC_PIPE") {
                cmd.env("TORI_IPC_PIPE", pipe);
            }
            if let Ok(lb) = std::env::var("TORI_ALLOW_LOOPBACK") {
                cmd.env("TORI_ALLOW_LOOPBACK", lb);
            }
            cmd
        };

        // CREATE_BREAKAWAY_FROM_JOB (0x01000000) | CREATE_NEW_PROCESS_GROUP (0x00000200) | DETACHED_PROCESS (0x00000008)
        let breakaway_flags: u32 = 0x0100_0000 | 0x0000_0200 | 0x0000_0008;
        // Fallback if parent Job Object does not allow breakaway: CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        let fallback_flags: u32 = 0x0000_0200 | 0x0800_0000;

        if build_cmd(breakaway_flags).spawn().is_err() {
            let _ = build_cmd(fallback_flags).spawn();
        }

        // Wait up to 10000ms for Named Pipe to become ready on cold launch
        let start = std::time::Instant::now();
        while start.elapsed() < Duration::from_millis(10000) {
            tokio::time::sleep(Duration::from_millis(50)).await;
            if try_connect_engine().is_ok() {
                return true;
            }
        }
    }

    try_connect_engine().is_ok()
}

/// Forwards a `NativeMessage` over a specific Named Pipe.
pub async fn forward_to_pipe(pipe_name: &str, msg: &NativeMessage) -> io::Result<NativeResponse> {
    let mut client = {
        let mut attempts = 0;
        loop {
            match ClientOptions::new().open(pipe_name) {
                Ok(c) => break c,
                Err(e) if e.raw_os_error() == Some(231) && attempts < 10 => {
                    attempts += 1;
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                Err(e) => return Err(e),
            }
        }
    };
    let (mut reader, mut writer) = tokio::io::split(&mut client);

    write_message_async(&mut writer, msg).await?;
    read_response_async(&mut reader).await?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "Received empty response from persistent TORI engine",
        )
    })
}

/// Forwards a `NativeMessage` to the persistent desktop engine over default IPC_PIPE_NAME (or TORI_IPC_PIPE override).
pub async fn forward_to_persistent_engine(msg: &NativeMessage) -> io::Result<NativeResponse> {
    forward_to_pipe(&get_ipc_pipe_name(), msg).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_spawn_mutex_name_is_deterministic_and_pipe_scoped() {
        let a1 = spawn_mutex_name_for_pipe(r"\\.\pipe\tori-download-manager-ipc");
        let a2 = spawn_mutex_name_for_pipe(r"\\.\pipe\tori-download-manager-ipc");
        let b = spawn_mutex_name_for_pipe(r"\\.\pipe\tori-qa-isolated-ipc");
        assert_eq!(a1, a2);
        assert_ne!(a1, b);
        assert!(a1.starts_with(r"Local\TORI_DM_EngineSpawn_"));
    }

    #[cfg(windows)]
    #[test]
    fn test_spawn_mutex_serializes_concurrent_callers_per_pipe() {
        let pipe = format!(
            r"\\.\pipe\tori-gate35-2-mutex-test-{}",
            std::process::id()
        );
        let guard = EngineSpawnMutexGuard::acquire_for_pipe(&pipe, 1000)
            .expect("initial mutex acquisition should succeed");

        let pipe_clone = pipe.clone();
        let contended = std::thread::spawn(move || {
            EngineSpawnMutexGuard::acquire_for_pipe(&pipe_clone, 60).is_some()
        })
        .join()
        .unwrap();
        assert!(!contended, "Concurrent caller must not bypass held spawn mutex");

        let other_pipe = format!(r"\\.\pipe\tori-gate35-2-other-{}", std::process::id());
        let other_guard = EngineSpawnMutexGuard::acquire_for_pipe(&other_pipe, 200);
        assert!(other_guard.is_some(), "Different pipe names must use independent mutexes");
        drop(other_guard);

        drop(guard);
        let reacquired = EngineSpawnMutexGuard::acquire_for_pipe(&pipe, 500);
        assert!(reacquired.is_some(), "Mutex must be re-acquirable after drop");
    }
}
