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
