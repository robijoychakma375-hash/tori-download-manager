# TORI Download Manager — Windows Authenticode Readiness & Integration Guide

**Document ID:** `TORI-SEC-G33-003`  
**Current Production Status:** **NOT AVAILABLE / UNSIGNED (`NotSigned`)** — No commercial OV/EV or cloud-HSM Authenticode certificate is provisioned yet.  
**Tauri Ed25519 Updater Signature:** **ACTIVE (`CDC23D8CC8DA5397`)** — Independent of Windows Authenticode and strictly preserved.

---

## 1. Honest Current State & SmartScreen Disclosure

- Current public installers (`v1.0.6`, `v1.0.7`) are **not** Authenticode-signed. Windows `Get-AuthenticodeSignature` honestly reports `Status: NotSigned`.
- Adding Authenticode signing improves publisher identity verification and Windows PE integrity, **but does not guarantee immediate elimination of Microsoft Defender SmartScreen warnings**:
  - Standard OV certificates build SmartScreen reputation over time based on download volume and clean telemetry.
  - EV certificates and Microsoft Azure Trusted Signing accelerate SmartScreen reputation establishment, though SmartScreen decisions remain controlled by Microsoft.
- **Cryptographic Independence:** Windows Authenticode and Tauri's Ed25519 Minisign updater signature (`CDC23D8CC8DA5397`) are completely independent mechanisms. Both MUST coexist; Authenticode signing MUST happen **before** generating Tauri `.sig` files because embedding an Authenticode PE signature modifies the binary's bytes!

## 2. Certificate & Signing Infrastructure Evaluation

| Option | Key Custody | SmartScreen Impact | CI / Automation Fit | Recommendation |
| --- | --- | --- | --- | --- |
| **Microsoft Azure Trusted Signing (Recommended)** | Cloud HSM (FIPS 140-2 L3), short-lived certs | Strong reputation acceleration | Native `signtool` / `TrustedSigningClientTools`, zero local `.pfx` | **Best fit** for indie/OSS Windows desktop releases once organization/individual identity verification is approved |
| **EV Code Signing (USB HSM / YubiKey / SafeNet)** | Hardware token (non-exportable) | Immediate/fast reputation | Requires local operator token presence during release build | Strong option for local maintainer-driven release builds |
| **Standard OV Code Signing (HSM / Cloud KMS)** | Hardware token or Cloud HSM (CA/B Forum 2023+ mandates hardware-backed storage) | Gradual reputation build-up | Works with local token or Cloud HSM | Viable lower-cost baseline; requires hardware key storage |
| **Software `.pfx` file (Legacy / Dev QA Only)** | Password-protected PKCS#12 file | N/A (public CAs no longer issue exportable OV/EV PFX) | Good for isolated internal testing only | Supported in `build_nsis_installer.ps1` strictly for testing / private HSM export wrappers |

## 3. Host Toolchain Audit (Gate 33)

- `signtool.exe` is already installed on the build host:
  - `C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe`
  - `C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\arm64\signtool.exe`
- RFC 3161 SHA-256 timestamping (`signtool sign /fd SHA256 /tr <TSA_URL> /td SHA256`) is wired into `scripts/build_nsis_installer.ps1`.

## 4. Pipeline Usage (`scripts/build_nsis_installer.ps1`)

Authenticode signing is **strictly opt-in** and activates ONLY when explicitly configured:

### Option A: Local Certificate Store / Hardware Token Thumbprint (OV / EV USB HSM)
```powershell
powershell -ExecutionPolicy Bypass -File scripts\build_nsis_installer.ps1 `
  -SignAuthenticode `
  -RequireAuthenticode `
  -CertThumbprint "<40-HEX-CERT-THUMBPRINT>" `
  -TimestampUrl "http://timestamp.digicert.com"
```

### Option B: PKCS#12 PFX File (Env-Var Passphrase Only — Never CLI Plaintext)
```powershell
$env:TORI_AUTHENTICODE_PFX_PASSWORD = "<secret-loaded-in-memory>"
powershell -ExecutionPolicy Bypass -File scripts\build_nsis_installer.ps1 `
  -SignAuthenticode `
  -RequireAuthenticode `
  -CertPfxPath "C:\Users\ritud\.tori-keys\tori-authenticode.pfx" `
  -TimestampUrl "http://timestamp.digicert.com"
```

### Fail-Closed Guarantee & Verification
- Passing `-RequireAuthenticode` without valid certificate credentials **aborts the build immediately** with a clear error before producing release artifacts.
- Signing order enforced by `scripts/build_nsis_installer.ps1`:
  1. Sign inner executables (`tori-download-manager.exe`, `tdm-native-host.exe`, `tdm-cli.exe`) with SHA-256 + RFC 3161 timestamp and verify each via `signtool verify /pa /v`.
  2. Build NSIS installer via `cargo tauri build --bundles nsis`.
  3. Sign final NSIS installer (`*_x64-setup.exe`) with SHA-256 + RFC 3161 timestamp and verify via `signtool verify /pa /v`.
  4. **Re-generate** Tauri Ed25519 `.sig` over the final Authenticode-signed NSIS installer bytes via `cargo tauri signer sign`, preserving full Ed25519 updater integrity!

### Readiness Verification Check
```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify_authenticode_readiness.ps1
```
