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

pub fn get_manifest_path() -> PathBuf {
    let base = if let Ok(app_data) = std::env::var("APPDATA") {
        PathBuf::from(app_data).join("tori-download-manager")
    } else {
        PathBuf::from(".tdm-data")
    };
    let _ = fs::create_dir_all(&base);
    base.join(format!("{}.json", HOST_NAME))
}

pub fn register_host(custom_extension_id: Option<&str>) -> std::io::Result<()> {
    let exe_path = std::env::current_exe()?;
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

    #[cfg(windows)]
    {
        let manifest_str = manifest_path.to_string_lossy();

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
    }

    eprintln!(
        "[TORI] Successfully registered Native Messaging host '{}' at: {}",
        HOST_NAME,
        manifest_path.display()
    );
    eprintln!("[TORI] Target binary: {}", exe_path.display());
    eprintln!("[TORI] Allowed Extension ID: {}", ext_id);

    Ok(())
}

pub fn unregister_host() -> std::io::Result<()> {
    let manifest_path = get_manifest_path();
    let _ = fs::remove_file(manifest_path);

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
    }

    eprintln!("[TORI] Unregistered Native Messaging host '{}'", HOST_NAME);
    Ok(())
}
