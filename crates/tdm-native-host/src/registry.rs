use std::fs;
use std::path::PathBuf;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
fn silent_reg_command() -> Command {
    let mut cmd = Command::new("reg");
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd
}

pub const HOST_NAME: &str = "com.tori.download_manager";
pub const DEFAULT_EXTENSION_ID: &str = "jfnfgmcbgapcpieaonbaolgebjaejcdm";
pub const DEFAULT_FIREFOX_EXTENSION_ID: &str = "tori-download-manager@toridm.org";

pub fn get_manifest_path() -> PathBuf {
    let base = if let Ok(app_data) = std::env::var("APPDATA") {
        PathBuf::from(app_data).join("tori-download-manager")
    } else {
        PathBuf::from(".tdm-data")
    };
    let _ = fs::create_dir_all(&base);
    base.join(format!("{}.json", HOST_NAME))
}

pub fn get_firefox_manifest_path() -> PathBuf {
    let base = if let Ok(app_data) = std::env::var("APPDATA") {
        PathBuf::from(app_data).join("tori-download-manager")
    } else {
        PathBuf::from(".tdm-data")
    };
    let _ = fs::create_dir_all(&base);
    base.join(format!("{}.firefox.json", HOST_NAME))
}

/// Resolves the actual `tdm-native-host` executable path so invoking registration from
/// `tori-download-manager.exe` never overwrites the Chrome/Edge/Firefox Native Messaging
/// manifest with the GUI executable path.
pub fn resolve_native_host_binary_from(current_exe: &std::path::Path) -> std::io::Result<PathBuf> {
    let target_name = if cfg!(windows) {
        "tdm-native-host.exe"
    } else {
        "tdm-native-host"
    };

    if current_exe
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.eq_ignore_ascii_case(target_name))
        .unwrap_or(false)
    {
        return Ok(current_exe.to_path_buf());
    }

    if let Some(dir) = current_exe.parent() {
        let candidates = [
            dir.join(target_name),
            dir.join("bin").join(target_name),
            dir.join("resources").join("bin").join(target_name),
        ];
        for cand in candidates {
            if cand.is_file() {
                return Ok(cand);
            }
        }
    }

    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        format!(
            "Could not locate '{}' near '{}'. Refusing to register non-native-host executable.",
            target_name,
            current_exe.display()
        ),
    ))
}

pub fn register_host(custom_extension_id: Option<&str>) -> std::io::Result<()> {
    let current_exe = std::env::current_exe()?;
    let exe_path = resolve_native_host_binary_from(&current_exe)?;
    let manifest_path = get_manifest_path();

    let ext_id = custom_extension_id.unwrap_or(DEFAULT_EXTENSION_ID);
    let mut origins = vec![
        format!("chrome-extension://{}/", ext_id),
        "chrome-extension://jfnfgmcbgapcpieaonbaolgebjaejcdm/".to_string(),
        "chrome-extension://bflchfddfgkfglmjapohkjmldepflkbe/".to_string(),
    ];
    origins.sort();
    origins.dedup();

    let manifest_json = serde_json::json!({
        "name": HOST_NAME,
        "description": "TORI Download Manager Native Messaging Host",
        "path": exe_path.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": origins
    });

    fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&manifest_json)?,
    )?;

    // Write Firefox-specific Native Messaging manifest
    let firefox_manifest_path = get_firefox_manifest_path();
    let firefox_manifest_json = serde_json::json!({
        "name": HOST_NAME,
        "description": "TORI Download Manager Native Messaging Host (Firefox)",
        "path": exe_path.to_string_lossy(),
        "type": "stdio",
        "allowed_extensions": [DEFAULT_FIREFOX_EXTENSION_ID]
    });

    fs::write(
        &firefox_manifest_path,
        serde_json::to_string_pretty(&firefox_manifest_json)?,
    )?;

    #[cfg(windows)]
    {
        let manifest_str = manifest_path.to_string_lossy();
        let firefox_manifest_str = firefox_manifest_path.to_string_lossy();

        // Register for Chrome
        let _ = silent_reg_command()
            .args([
                "add",
                &format!(
                    r"HKCU\Software\Google\Chrome\NativeMessagingHosts\{}",
                    HOST_NAME
                ),
                "/ve",
                "/t",
                "REG_SZ",
                "/d",
                &manifest_str,
                "/f",
            ])
            .output();

        // Register for Edge
        let _ = silent_reg_command()
            .args([
                "add",
                &format!(
                    r"HKCU\Software\Microsoft\Edge\NativeMessagingHosts\{}",
                    HOST_NAME
                ),
                "/ve",
                "/t",
                "REG_SZ",
                "/d",
                &manifest_str,
                "/f",
            ])
            .output();

        // Register for Firefox
        let _ = silent_reg_command()
            .args([
                "add",
                &format!(r"HKCU\Software\Mozilla\NativeMessagingHosts\{}", HOST_NAME),
                "/ve",
                "/t",
                "REG_SZ",
                "/d",
                &firefox_manifest_str,
                "/f",
            ])
            .output();
    }

    eprintln!(
        "[TORI] Successfully registered Native Messaging host '{}' at: {}",
        HOST_NAME,
        manifest_path.display()
    );
    eprintln!(
        "[TORI] Firefox Native Messaging manifest registered at: {}",
        firefox_manifest_path.display()
    );
    eprintln!("[TORI] Target binary: {}", exe_path.display());
    eprintln!("[TORI] Allowed Extension ID (Chrome/Edge): {}", ext_id);
    eprintln!(
        "[TORI] Allowed Extension ID (Firefox): {}",
        DEFAULT_FIREFOX_EXTENSION_ID
    );

    Ok(())
}

pub fn unregister_host() -> std::io::Result<()> {
    let manifest_path = get_manifest_path();
    let _ = fs::remove_file(&manifest_path);

    let firefox_manifest_path = get_firefox_manifest_path();
    let _ = fs::remove_file(&firefox_manifest_path);

    #[cfg(windows)]
    {
        let _ = silent_reg_command()
            .args([
                "delete",
                &format!(
                    r"HKCU\Software\Google\Chrome\NativeMessagingHosts\{}",
                    HOST_NAME
                ),
                "/f",
            ])
            .output();

        let _ = silent_reg_command()
            .args([
                "delete",
                &format!(
                    r"HKCU\Software\Microsoft\Edge\NativeMessagingHosts\{}",
                    HOST_NAME
                ),
                "/f",
            ])
            .output();

        let _ = silent_reg_command()
            .args([
                "delete",
                &format!(r"HKCU\Software\Mozilla\NativeMessagingHosts\{}", HOST_NAME),
                "/f",
            ])
            .output();
    }

    eprintln!(
        "[TORI] Unregistered Native Messaging host '{}' from Chrome, Edge, and Firefox",
        HOST_NAME
    );
    Ok(())
}
