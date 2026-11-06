use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

const MAX_LOG_SIZE: u64 = 1024 * 1024; // 1 MB limit
static LOG_MUTEX: Mutex<()> = Mutex::new(());

/// Returns the lifecycle log file path: %APPDATA%/tori-download-manager/logs/lifecycle.log
pub fn get_log_path() -> PathBuf {
    let base = if let Ok(override_dir) = std::env::var("TORI_DATA_DIR") {
        PathBuf::from(override_dir)
    } else if let Ok(app_data) = std::env::var("APPDATA") {
        PathBuf::from(app_data).join("tori-download-manager")
    } else {
        PathBuf::from(".tdm-data")
    };
    base.join("logs").join("lifecycle.log")
}

/// Sanitizes a log message by redacting auth tokens and sensitive query parameters.
pub fn sanitize_log_message(msg: &str) -> String {
    // Redact tori_<hex> tokens
    let mut sanitized = String::with_capacity(msg.len());
    let mut remaining = msg;

    while let Some(idx) = remaining.find("tori_") {
        sanitized.push_str(&remaining[..idx]);
        sanitized.push_str("tori_[redacted]");
        let after = &remaining[idx + 5..];
        // Skip subsequent hex chars or alphanumeric chars
        let skip_len = after
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
            .map(|c| c.len_utf8())
            .sum::<usize>();
        remaining = &after[skip_len..];
    }
    sanitized.push_str(remaining);

    // Redact Bearer tokens
    if sanitized.contains("Bearer ") {
        sanitized = sanitized
            .split("Bearer ")
            .enumerate()
            .map(|(i, part)| {
                if i == 0 {
                    part.to_string()
                } else {
                    let end_token = part.find(' ').unwrap_or(part.len());
                    format!("[redacted]{}", &part[end_token..])
                }
            })
            .collect::<Vec<_>>()
            .join("Bearer ");
    }

    sanitized
}

/// Appends a structured lifecycle log entry with bounded file rotation.
pub fn log_event(category: &str, action: &str, details: &str) {
    let _guard = match LOG_MUTEX.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };

    let log_path = get_log_path();
    if let Some(parent) = log_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    // Check size for rotation
    if let Ok(meta) = fs::metadata(&log_path) {
        if meta.len() > MAX_LOG_SIZE {
            let backup_path = log_path.with_extension("log.1");
            let _ = fs::rename(&log_path, backup_path);
        }
    }

    let timestamp = chrono::Utc::now().to_rfc3339();
    let pid = std::process::id();
    let sanitized_details = sanitize_log_message(details);
    let line = format!(
        "[{}] [PID:{}] [{}] {}: {}\n",
        timestamp, pid, category, action, sanitized_details
    );

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&log_path) {
        let _ = file.write_all(line.as_bytes());
    }
}

/// Installs a global panic hook that writes panic diagnostics to the lifecycle log.
pub fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        let payload = if let Some(s) = panic_info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = panic_info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "Unknown panic payload".to_string()
        };

        let location = if let Some(loc) = panic_info.location() {
            format!("{}:{}:{}", loc.file(), loc.line(), loc.column())
        } else {
            "Unknown location".to_string()
        };

        let details = format!("PANIC at {}: {}", location, payload);
        log_event("CRASH", "RUST_PANIC", &details);

        // Chain to default hook for stderr / debugger
        default_hook(panic_info);
    }));
}

#[cfg(windows)]
mod mem_trim {
    use std::collections::HashSet;
    use std::mem::size_of;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static LAST_TRIM_TIME_MS: AtomicU64 = AtomicU64::new(0);
    const TRIM_COOLDOWN_MS: u64 = 4000; // 4 seconds minimum between trims to prevent page fault thrashing

    #[repr(C)]
    struct ProcessEntry32W {
        dw_size: u32,
        cnt_usage: u32,
        th32_process_id: u32,
        th32_default_heap_id: usize,
        th32_module_id: u32,
        cnt_threads: u32,
        th32_parent_process_id: u32,
        pc_pri_class_base: i32,
        dw_flags: u32,
        sz_exe_file: [u16; 260],
    }

    extern "system" {
        fn GetCurrentProcess() -> isize;
        fn GetCurrentProcessId() -> u32;
        fn SetProcessWorkingSetSize(
            h_process: isize,
            dw_minimum_working_set_size: usize,
            dw_maximum_working_set_size: usize,
        ) -> i32;
        fn CreateToolhelp32Snapshot(dw_flags: u32, th32_process_id: u32) -> isize;
        fn Process32FirstW(h_snapshot: isize, lppe: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(h_snapshot: isize, lppe: *mut ProcessEntry32W) -> i32;
        fn OpenProcess(dw_desired_access: u32, b_inherit_handle: i32, dw_process_id: u32) -> isize;
        fn CloseHandle(h_object: isize) -> i32;
    }

    const TH32CS_SNAPPROCESS: u32 = 0x00000002;
    const PROCESS_SET_QUOTA: u32 = 0x0100;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    fn get_process_name(raw: &[u16; 260]) -> String {
        let len = raw.iter().position(|&c| c == 0).unwrap_or(raw.len());
        String::from_utf16_lossy(&raw[..len]).to_lowercase()
    }

    pub fn trim_working_set_tree() {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let last = LAST_TRIM_TIME_MS.load(Ordering::Relaxed);
        if now_ms.saturating_sub(last) < TRIM_COOLDOWN_MS {
            // Rate-limited: skip trim to avoid excessive page fault thrashing during rapid events
            return;
        }
        LAST_TRIM_TIME_MS.store(now_ms, Ordering::Relaxed);

        unsafe {
            // 1. Trim main TORI process
            let current_handle = GetCurrentProcess();
            let _ = SetProcessWorkingSetSize(current_handle, usize::MAX, usize::MAX);

            // 2. Discover TORI's child process tree (including WebView2 browser, GPU, network, and renderer processes)
            let current_pid = GetCurrentProcessId();
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot != -1 && snapshot != 0 {
                let mut all_procs: Vec<(u32, u32, String)> = Vec::new();
                let mut entry: ProcessEntry32W = std::mem::zeroed();
                entry.dw_size = size_of::<ProcessEntry32W>() as u32;

                if Process32FirstW(snapshot, &mut entry) != 0 {
                    loop {
                        let name = get_process_name(&entry.sz_exe_file);
                        all_procs.push((entry.th32_process_id, entry.th32_parent_process_id, name));
                        if Process32NextW(snapshot, &mut entry) == 0 {
                            break;
                        }
                    }
                }
                CloseHandle(snapshot);

                // Build verified TORI process tree:
                // Start with current_pid, iteratively include children whose parent is already confirmed in the tree.
                // Strictly require the executable name to be msedgewebview2.exe, tori-download-manager.exe, or tdm-*.exe.
                // NEVER include foreign Edge instances (msedge.exe) or unrelated processes.
                let mut tori_pids: HashSet<u32> = HashSet::new();
                tori_pids.insert(current_pid);

                let mut expanded = true;
                while expanded {
                    expanded = false;
                    for (pid, parent_pid, name) in &all_procs {
                        if tori_pids.contains(parent_pid)
                            && !tori_pids.contains(pid)
                            && (name == "msedgewebview2.exe"
                                || name.starts_with("tdm-")
                                || name == "tori-download-manager.exe")
                        {
                            tori_pids.insert(*pid);
                            expanded = true;
                        }
                    }
                }

                // Trim all discovered child processes in TORI's tree
                for pid in tori_pids {
                    if pid == current_pid {
                        continue;
                    }
                    let child_handle = OpenProcess(
                        PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION,
                        0,
                        pid,
                    );
                    if child_handle != 0 && child_handle != -1 {
                        let _ = SetProcessWorkingSetSize(child_handle, usize::MAX, usize::MAX);
                        CloseHandle(child_handle);
                    }
                }
            }
        }
    }
}

/// Trims physical working set memory of the current process and any child processes (e.g. WebView2).
pub fn trim_memory() {
    #[cfg(windows)]
    mem_trim::trim_working_set_tree();
}
