# TORI Download Manager — Gate 35 Clean Windows 10/11 QA, Authenticode & Key Custody Readiness Checklist

**Gate:** Gate 35.1 — Post-Release Production Audit, Security Hardening & Stage 2 Readiness  
**Date:** 2026-11-25  
**Target Public Release Audited:** Desktop `v1.0.8` (`TORI Download Manager_1.0.8_x64-setup.exe`, SHA-256 `728d0d253a8fadc3fea5244723237f267dcd13abf65cac49b91a4ec83a3dcffb`, `118,110,372` bytes)

---

## 1. Honest Current Verification Status (Host Audit — 2026-11-25)

| Area | Current Status | Audited Host Evidence |
| :--- | :--- | :--- |
| **Clean Windows 10 x64 VM QA** | **`NOT TESTED`** | Host OS is Windows 11 Pro Build `26300` x64. Hyper-V service is `Running` with `0` provisioned guest VMs; VirtualBox, VMware, QEMU, and Windows Sandbox are not installed. |
| **Clean Windows 11 x64 VM QA** | **`NOT TESTED`** | `0` clean guest VMs provisioned locally; GitHub Actions manual workflow `.github/workflows/clean-windows-release-qa.yml` has not been dispatched yet. |
| **Commercial Authenticode Signing** | **`NOT SIGNED` (`NotSigned`)** | `signtool.exe` (`10.0.26100.0\x64`) is installed locally, but `Cert:\CurrentUser\My` contains only a self-signed WDK test certificate (`CN="WDKTestCert Robi Joy Chakma,134348879406232246"`). No commercial OV/EV code signing certificate or HSM/Trusted Signing account is configured. |
| **Offline Dedicated Key Backup** | **`BACKUP_VERIFICATION_DEFERRED_BY_OWNER`** | External offline storage unavailable (`RISK-34-01`). Dedicated key `C3FD6626A3718E63` exists encrypted on host (`C:\Users\ritud\.tori-keys\tori-tools.key`). |
| **Backup Recovery Verification** | **`BACKUP_RECOVERY_NOT_VERIFIED`** | Independent restore-and-sign verification drill has not been performed yet. |

> [!WARNING]
> **Never claim Clean Windows 10/11 QA passed, Authenticode signed, or offline key backup verified until the corresponding execution checklist below is actually completed and logged.**

---

## 2. Clean Windows 10 & Windows 11 Validation Runbook

### Option A — Reproducible Local Hyper-V Clean VM Validation (Recommended for Full GUI + SmartScreen + Browser Companion Checks)

1. **Provision Clean Guest VMs (Windows 10 22H2 x64 & Windows 11 24H2/25H2 x64):**
   - Enable Hyper-V Generation 2 VM (`4 GB` RAM, `2` vCPU, `40 GB` VHDX, TPM enabled for Win11, default switch NAT).
   - Take a clean baseline checkpoint (`Clean-OS-PreInstall`) BEFORE copying or running any TORI files so every run is repeatable.
   - Verify no developer tools (`cargo`, `rustup`, `node`, global `yt-dlp`, global `ffmpeg`) exist on `PATH` inside the guest.
2. **Download Public Installer Over HTTPS Inside Guest & Verify SHA-256:**
   ```powershell
   $url = "https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.8/TORI.Download.Manager_1.0.8_x64-setup.exe"
   $inst = "$env:TEMP\TORI_1.0.8_x64-setup.exe"
   Invoke-WebRequest -Uri $url -OutFile $inst
   $hash = (Get-FileHash $inst -Algorithm SHA256).Hash.ToLower()
   if ($hash -ne "728d0d253a8fadc3fea5244723237f267dcd13abf65cac49b91a4ec83a3dcffb") { throw "SHA-256 mismatch: $hash" }
   ```
3. **Execute Automated 18-Check Guest Harness (`scripts/clean_windows_qa_guest.ps1`):**
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\clean_windows_qa_guest.ps1 `
     -InstallerPath $inst `
     -OutputDir "$env:TEMP\tori_clean_qa_out" `
     -AllowCleanMachineMutation
   ```
   *(Safety guard: NEVER pass `-AllowCleanMachineMutation` on the operator's production/OEM workstation!)*

### Option B — Ephemeral GitHub Actions Clean Windows CI (`windows-2022` & `windows-2025`)

- Workflow file: `.github/workflows/clean-windows-release-qa.yml` (updated in Gate 35.1 to default to public stable `v1.0.8` and SHA-256 `728d0d253a8fadc3fea5244723237f267dcd13abf65cac49b91a4ec83a3dcffb`).
- Once merged/pushed to GitHub (in a future authorized PR/gate), dispatch manually via GitHub Actions (`workflow_dispatch`) and inspect uploaded artifacts `clean-windows-qa-windows-2022` and `clean-windows-qa-windows-2025`.
- *Limitation:* GitHub-hosted Windows runners cover headless installation, SQLite, registry, bundled `yt-dlp`/`FFmpeg`/`FFprobe`, live signed manifest HTTPS check, and clean uninstall/repair (`17/18` checks), whereas interactive GUI/SmartScreen/Browser Extension UI (`CWQA-14` & SmartScreen prompt behavior) still require a desktop VM session (Option A).

### Mandatory 20-Item Clean Machine Sign-Off Checklist

| ID | Verification Item | Win 10 x64 | Win 11 x64 | Evidence / Notes |
| :--- | :--- | :---: | :---: | :--- |
| `CWQA-01` | Fresh NSIS silent & interactive installation succeeds (`exit=0`) | `[ ]` | `[ ]` | `%LOCALAPPDATA%\TORI Download Manager\tori-download-manager.exe` |
| `CWQA-02` | Desktop executable launches cleanly with zero crash / missing DLL | `[ ]` | `[ ]` | Verify PE `ProductVersion` matches release |
| `CWQA-03` | Microsoft Edge WebView2 Runtime detection / bootstrapper behavior | `[ ]` | `[ ]` | Confirm clean launch on fresh Win10 & Win11 |
| `CWQA-04` | First-run profile & `%APPDATA%\tori-download-manager` initialization | `[ ]` | `[ ]` | Zero pre-existing data required |
| `CWQA-05` | SQLite initialization & `PRAGMA integrity_check = ok` | `[ ]` | `[ ]` | All required tables created cleanly |
| `CWQA-06` | Native Messaging Registry (`HKCU` Chrome, Edge, Firefox) points to `bin\tdm-native-host.exe` | `[ ]` | `[ ]` | Confirm JSON manifests valid & binary path exact |
| `CWQA-07` | Settings -> External Tools panel renders registry & manifest health | `[ ]` | `[ ]` | Shows verified signed manifest revision & signer |
| `CWQA-08` | Bundled `bin\yt-dlp.exe --version` executes with zero system PATH deps | `[ ]` | `[ ]` | Confirm self-contained runtime |
| `CWQA-09` | Bundled `bin\ffmpeg.exe` & `bin\ffprobe.exe` pass synthetic H.264/AAC MP4 mux + probe | `[ ]` | `[ ]` | Video + audio streams verified |
| `CWQA-10` | Live HTTPS `tools-manifest.json` + `.sig` verified on clean machine | `[ ]` | `[ ]` | Confirms TLS roots & trust anchor work cleanly |
| `CWQA-11` | Real External Tool update check / staged download & verification | `[ ]` | `[ ]` | Verifies atomic switch & health check |
| `CWQA-12` | Automatic daily (24h) External Tools schedule default active | `[ ]` | `[ ]` | `auto_update=true`, `check_interval_hours=24` |
| `CWQA-13` | Rollback / bundled fallback recovery works cleanly | `[ ]` | `[ ]` | Simulate failed binary -> falls back cleanly |
| `CWQA-14` | Standalone IDM-style progress window renders cleanly on active download | `[ ]` | `[ ]` | Interactive desktop check |
| `CWQA-15` | Close-to-Tray default persisted (`closeToTray = true`) & tray restore works | `[ ]` | `[ ]` | Close main window -> restore from system tray |
| `CWQA-16` | Clean uninstall removes binaries & NM registry while preserving user downloads/SQLite; repair reinstall succeeds | `[ ]` | `[ ]` | Verify `tdm_storage.sqlite` preserved |
| `CWQA-17` | Zero unexpected visible `cmd.exe` / `conhost.exe` / `powershell.exe` windows | `[ ]` | `[ ]` | Check during download, notification, and tool check |
| `CWQA-18` | All bundled binaries & `LICENSE-THIRD-PARTY.txt` present | `[ ]` | `[ ]` | `yt-dlp`, `ffmpeg`, `ffprobe`, `tdm-native-host`, `tdm-cli` |
| `CWQA-19` | Windows Defender & SmartScreen prompt behavior recorded accurately | `[ ]` | `[ ]` | Record unsigned warning until Authenticode active |
| `CWQA-20` | Browser Companion (`v1.0.10` / future `v1.0.11`) pairs & downloads on clean Chrome/Edge/Firefox | `[ ]` | `[ ]` | Verify end-to-end download handoff |

---

## 3. Commercial Windows Authenticode Signing Readiness Plan

### 3.1 Current Posture
- Windows SDK `signtool.exe` is available locally at `C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe`.
- Public Desktop `v1.0.8` installer is **`NotSigned`** (expected under `RISK-34-03` until commercial certificate procurement).
- **Hard Rule:** Self-signed / WDK test certificates (`WDKTestCert`) MUST NEVER be used on public release installers.

### 3.2 Recommended Commercial Signing Options
1. **Microsoft Azure Trusted Signing** *(Recommended for indie/small org Windows apps)*: Cloud HSM-backed short-lived Authenticode certificates, native Windows SmartScreen integration, zero physical USB token management, seamless `signtool` / `TrustedSigning` CLI integration.
2. **Commercial OV/EV Code Signing Certificate on FIPS 140-2/3 Hardware Token or Cloud HSM** (DigiCert KeyLocker, Sectigo, SSL.com eSigner): Meets CA/B Forum hardware private-key storage mandate; EV certificates accelerate SmartScreen reputation immediately.

### 3.3 Mandatory Cryptographic Signing Order (CRITICAL!)
Authenticode signing embeds a PE signature directly into the executable/installer bytes, which **changes the installer SHA-256 hash**. Therefore, signing MUST always follow this exact sequence:

1. **Step 1 — Sign Inner Binaries (Before NSIS Packaging):**
   - Authenticode sign `tori-download-manager.exe`, `bin\tdm-native-host.exe`, and `bin\tdm-cli.exe` with SHA-256 digest (`/fd SHA256`) and RFC 3161 SHA-256 timestamp (`/tr http://timestamp.digicert.com /td SHA256`). *(Do not re-sign third-party `yt-dlp.exe`/`ffmpeg.exe`/`ffprobe.exe` unless policy requires; preserve upstream provenance where applicable.)*
2. **Step 2 — Build NSIS Installer (`TORI Download Manager_<ver>_x64-setup.exe`).**
3. **Step 3 — Authenticode Sign the NSIS Installer (`signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 ...`).**
4. **Step 4 — Verify Authenticode Signature Chain & Timestamp:**
   ```powershell
   signtool.exe verify /pa /v "TORI Download Manager_<ver>_x64-setup.exe"
   $sig = Get-AuthenticodeSignature "TORI Download Manager_<ver>_x64-setup.exe"
   if ($sig.Status -ne 'Valid' -or -not $sig.TimeStamperCertificate) { throw "Authenticode verification failed" }
   ```
5. **Step 5 — Generate Tauri Ed25519 Updater `.sig` & `SHA256SUMS.txt` AFTER Authenticode Signing:**
   - Sign the **final Authenticode-signed installer bytes** with the Tauri Desktop Updater Ed25519 key (`CDC23D8CC8DA5397`) to produce `.exe.sig` and `latest.json`.
   - Never Authenticode-sign after generating `.exe.sig` — doing so will immediately invalidate Tauri's Ed25519 updater signature!

### 3.4 SmartScreen & CI Secret Safety
- Never commit `.pfx`, `.p12`, cloud signing credentials, or PINs into Git.
- Use OIDC workload identity / short-lived cloud HSM tokens in protected release environments with manual owner approval gate.
- Submit newly signed installers to Microsoft Security Intelligence (WDSI) developer portal as part of pre-release warmup to minimize SmartScreen friction.

---

## 4. Offline Key Custody, Backup Recovery & Workstation Hardening Checklist

Audit findings from `scripts/provision_dedicated_tools_key.ps1 -Mode AuditCustody` on `2026-11-25`:

| Custody Control | Current Status | Required Operator Action |
| :--- | :--- | :--- |
| Dedicated key `C3FD6626A3718E63` exists & scrypt-encrypted (`Ed`/`Sc`) | **PASS** | Preserve intact — never regenerate or overwrite |
| Dedicated key file NTFS ACL owner-only (`DESKTOP-AC3727R\Robi Joy Chakma:(F)`) | **PASS** | Maintain owner-only ACL |
| Zero plaintext `tori-tools.key.pwd` file | **PASS** | Never create a plaintext passphrase file for `tori-tools.key` |
| Zero private keys in Git history, working tree, or `release/` | **PASS** | Verified in Gate 35.1 (`0` hits) |
| Key directory `C:\Users\ritud\.tori-keys` NTFS ACL owner-only | **GAP (`keyDirAclHardenedOwnerOnly: false`)** | Operator to restrict directory ACL (`icacls "C:\Users\ritud\.tori-keys" /inheritance:r /grant:r "$env:USERNAME:(OI)(CI)F"`) |
| Legacy plaintext `C:\Users\ritud\.tori-keys\tori-updater.key.pwd` | **GAP (present on workstation)** | Operator to store Desktop updater passphrase in a password manager and securely remove plaintext `.pwd` file |
| Offline encrypted backup on >= 2 independent storage media | **`BACKUP_VERIFICATION_DEFERRED_BY_OWNER`** | Operator to create 2 encrypted offline backups once external storage is acquired |
| Independent backup recovery verification drill | **`BACKUP_RECOVERY_NOT_VERIFIED`** | Mandatory gate before Stage 1.5 / Stage 2 signing operations |

### Offline Recovery Drill Verification Procedure
1. Copy `tori-tools.key` from Backup Medium #1 into an isolated temporary folder (`%TEMP%\key_recovery_drill`).
2. Run:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision_dedicated_tools_key.ps1 `
     -Mode VerifyProductionKey `
     -KeyPath "$env:TEMP\key_recovery_drill\tori-tools.key"
   ```
3. Confirm output reports `VALID_PRODUCTION_KEY`, Key ID `C3FD6626A3718E63`, and SHA-256 fingerprint `6807e183079787d7d00f889293a27a880b2a346e83556d3d090f28b92a132c9d`.
4. Perform one test detached signature over a non-production scratch file and verify Ed25519 signature validity against `TORI_DEDICATED_TOOLS_ED25519_PUBKEY_B64`.
5. Securely delete `%TEMP%\key_recovery_drill` and record `BACKUP_VERIFIED` + `BACKUP_RECOVERY_VERIFIED` with date and operator sign-off before authorizing Stage 1.5 or Stage 2.
