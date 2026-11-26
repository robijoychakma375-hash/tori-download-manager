# TORI Download Manager — Gate 37.2 Clean Windows 10 & Windows 11 Client VM QA Plan

**Gate:** Gate 37.2 — Clean Windows 10/11 QA Infrastructure & GitHub Actions CI Integration  
**Environment Classifications:** **`WINDOWS_10_CLIENT_VM`** and **`WINDOWS_11_CLIENT_VM`**  
**Current Execution Status:**
- **Windows 10 Client VM Execution:** **`NOT_TESTED`** *(`0` provisioned licensed Windows 10 Client VMs on host)*
- **Windows 11 Client VM Execution:** **`NOT_TESTED`** *(`0` provisioned licensed Windows 11 Client VMs on host)*

---

## 1. Host Capability & Provisioning Baseline (Audited 2026-11-26)

`scripts/run_clean_windows_vm_qa.ps1 -AuditOnly` verified:
- **Host:** Microsoft Windows 11 Pro (`10.0.26300`, Build `26300`, x64), AMD Ryzen 5 5500 (6C/12T), `virtualizationFirmware = true`, `15.90 GB` RAM, `C: 61.68 GB` free, `F: 38.11 GB` free.
- **Hyper-V:** `vmms = Running`, `HvHost = Running`, `hyperVModuleInstalled = true`.
- **Provisioned Licensed Client VMs:** **`0`** (Windows Sandbox, VirtualBox, VMware, Docker: `NotInstalled`).
- **Licensing Policy:** Never download unlicensed OS images or bypass Windows activation/licensing; only owner-provisioned, properly licensed Windows 10 x64 (22H2) and Windows 11 x64 (23H2/24H2) Hyper-V VMs are permitted.

---

## 2. Mandatory Clean VM Baseline & Safety Controls (`scripts/run_clean_windows_vm_qa.ps1`)

1. **Strict Disposable Designation Guard:** `run_clean_windows_vm_qa.ps1` refuses to touch any VM unless its name matches `^TORI-(Win10|Win11)-[A-Za-z0-9_\-]+$` (e.g., `TORI-Win10-Clean`, `TORI-Win11-Clean`) OR its Hyper-V Notes field explicitly contains `TORI_DISPOSABLE_QA_VM`. Unrelated user VMs are rejected fail-closed (`VM_SAFETY_ABORT_UNRELATED_VM`).
2. **Immutable Golden Checkpoint (`CleanBaseline`):**
   - Fresh Windows 10 or Windows 11 x64 installation with zero preinstalled TORI binaries, zero TORI registry keys, zero TORI AppData, known browser installs (Chrome, Edge, Firefox), enabled Windows Defender & SmartScreen at defaults, WebView2 runtime checkable, and >=15 GB guest free space.
   - Orchestrator validates `CleanBaseline` exists BEFORE mutating VM state (`VM_CHECKPOINT_MISSING` otherwise), **never deletes checkpoints**, verifies guest OS matches `-ExpectedOsClass`, verifies installer SHA-256 on BOTH host and guest after transfer, retains `qa-results.json`/`qa-summary.md`/`guest_console.log` even on failure, and restores `CleanBaseline` inside `finally`.
3. **Zero Security Weakening:** Never disable Windows Defender, exclude TORI from scans, or disable SmartScreen during Client VM QA; record SmartScreen reputation warnings and `NotSigned` Authenticode honestly.

---

## 3. Complete 20-Point Client VM Matrix (Windows 10 & Windows 11)

| # | Verification Area | Automation / Execution Path |
| :-: | :--- | :--- |
| 1–2 | Installer SHA-256, Tauri Ed25519 signature + tamper rejection & honest Authenticode status | `clean_windows_qa_guest.ps1` (`CWQA-INT-01/02`) + `verify_pe_authenticode.ps1` |
| 3–4 | NSIS installation, PE `ProductVersion` match & current-user vs machine-wide path boundary | `CWQA-01`, `CWQA-00` |
| 5–6 | First launch & Edge WebView2 bootstrapping/availability (especially virgin Win10 22H2) | `CWQA-02`, `CWQA-03` |
| 7–9 | System tray icon, Close-to-Tray persistence, silent `--minimized` startup, single process count (`1`), `0` console windows | `CWQA-02`, `CWQA-17`, `CWQA-05` |
| 10–14 | Chrome/Edge/Firefox Native Messaging registration, manifest JSON, 4x concurrent pairing (`CWQA-19`), Companion `v1.0.11` (Signed Firefox XPI `4cd6d6fb...` + Chromium ZIP `1e77592b...`) | `CWQA-06`, `CWQA-19` + interactive VM companion run (`verify_gate35_3_signed_firefox.js`, `verify_gate35_3_real_browsers.js`) |
| 15–17 | User-initiated downloads, `Content-Range` broken-CDN fallback (`206 0-(N-1)/N`, `200`, malformed `206`, ETag, `416`), partial `.tdm-part` safety | Parameterized `scripts/verify_release_upgrade_and_engine.js` (`ENG-01`) + deterministic local HTTP fixtures |
| 18–19 | Application restart durability & real in-place NSIS upgrade (`v1.0.8` → `v1.0.9`) via public `latest.json` | `-PreviousInstallerPath` (`CWQA-UPG-01/02`) + live `plugin:updater|check` |
| 20 | Clean silent uninstall preserving `tdm_storage.sqlite` & partial downloads + repair reinstall | `CWQA-16` |
| Win11+ | Windows 11 Defender Real-Time Protection, SmartScreen prompt observation, UAC boundary & taskbar/tray behavior | Observed via `CWQA-00` + interactive VM desktop inspection (never suppressed) |

---

## 4. Repeatable Owner Execution Commands (After Provisioning Licensed VMs)

```powershell
# Elevated Administrator PowerShell on Hyper-V Host:
$cred = Get-Credential -UserName "toriqa" -Message "Clean QA VM Guest Credential"

# Windows 10 x64 Clean Client VM
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run_clean_windows_vm_qa.ps1 `
  -VmName "TORI-Win10-Clean" -CheckpointName "CleanBaseline" -ExpectedOsClass "WINDOWS_10_CLIENT_VM" `
  -InstallerPath "F:\TORI\final tori download manager\release\v1.0.9-rc\TORI.Download.Manager_1.0.9_x64-setup.exe" `
  -ExpectedInstallerSha256 "460f5da00d09267a5f33274645250d92162bbfa3605f0348cc656a39a8a19ead" `
  -TauriSigPath "F:\TORI\final tori download manager\release\v1.0.9-rc\TORI.Download.Manager_1.0.9_x64-setup.exe.sig" `
  -PreviousInstallerPath "F:\TORI\final tori download manager\release\v1.0.8-public\TORI.Download.Manager_1.0.8_x64-setup.exe" `
  -ExpectedVersion "1.0.9" -GuestCredential $cred

# Windows 11 x64 Clean Client VM (same command with -VmName "TORI-Win11-Clean" -ExpectedOsClass "WINDOWS_11_CLIENT_VM")
```
