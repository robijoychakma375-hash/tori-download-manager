use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
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
    // 1. Same folder as current executable
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            let candidate = parent.join("tori-download-manager.exe");
            if candidate.exists() {
                return Some(candidate);
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

    None
}

/// Ensures the persistent desktop engine is active.
/// If not already active, launches `tori-download-manager.exe` in background mode.
pub async fn ensure_engine_running() -> bool {
    if try_connect_engine().is_ok() {
        return true;
    }

    if let Some(exe_path) = locate_desktop_binary() {
        eprintln!(
            "[TORI Native Host] Spawning persistent desktop engine: {:?}",
            exe_path
        );
        let mut cmd = Command::new(&exe_path);
        cmd.arg("--minimized");
        if let Ok(dir) = std::env::var("TORI_DATA_DIR") {
            cmd.env("TORI_DATA_DIR", dir);
        }
        if let Ok(pipe) = std::env::var("TORI_IPC_PIPE") {
            cmd.env("TORI_IPC_PIPE", pipe);
        }
        let _ = cmd.spawn();

        // Wait up to 1500ms for Named Pipe to become ready
        let start = std::time::Instant::now();
        while start.elapsed() < Duration::from_millis(1500) {
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
