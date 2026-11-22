# TORI Download Manager — Dedicated External Tools Signing-Key Architecture & Migration Specification

**Document ID:** `TORI-SEC-G33-001`  
**Gate:** Gate 33 — External Tools Security Hardening, Signing-Key Separation, Manifest Renewal & Clean Windows QA  
**Status:** Design & Development Implementation Complete (Production Key Transition **NOT ACTIVATED**)  
**Current Production Shared Key ID:** `CDC23D8CC8DA5397` (Ed25519 Minisign)  
**Target Dedicated Tools Key Identity:** `tori-tools.key` (to be generated offline under approved key-custody arrangements prior to a future Desktop release)

---

## 1. Phase 1 — Existing Cryptographic Architecture Audit

### 1.1 Current Trust Inventory

| Surface | Component / File | Algorithm & Format | Pinned Key ID | Private Key Storage | Verification Path |
| --- | --- | --- | --- | --- | --- |
| **Desktop Auto-Updater** | `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`) | Ed25519 Minisign (`ED` prehash / Tauri `Ed`) | `CDC23D8CC8DA5397` | Out-of-repo `%USERPROFILE%\.tori-keys\tori-updater.key` + `.pwd` | `tauri-plugin-updater` verifying `latest.json` + `.sig` |
| **External Tools Signed Manifest** | `crates/tdm-core/src/tools/trust.rs` (`TORI_ED25519_PUBKEY_B64`, `TORI_ED25519_KEY_ID`) | Ed25519 Minisign (`minisign-verify` crate) | `CDC23D8CC8DA5397` | Out-of-repo `%USERPROFILE%\.tori-keys\tori-updater.key` + `.pwd` | `fetch_signed_tools_manifest()` -> `verify_minisign_ed25519()` |
| **Manifest Publisher CLI** | `scripts/publish_trusted_tools_manifest.js` | `cargo tauri signer sign` (Minisign base64 box) | `CDC23D8CC8DA5397` | Out-of-repo `%USERPROFILE%\.tori-keys\tori-updater.key` + `.pwd` | Self-checks pubkey ID + base64 box format |
| **`yt-dlp` Direct Releases** | `crates/tdm-core/src/tools/ytdlp_pubkey.asc` | Pure-Rust RFC 4880 V4 OpenPGP RSA-4096 | `AC0CBBE6848D6A873464AF4E57CF65933B5A7581` | Held by upstream `yt-dlp` maintainers | `verify_openpgp_detached_rsa_signature()` over `SHA2-256SUMS` |

### 1.2 Audit Findings — Answers to All 8 Mandatory Questions

1. **Are Desktop and External Tools using the same signing key?**  
   **Yes.** As of public Desktop `v1.0.7` (commit `84da0c08`), both Tauri Desktop Auto-Updater (`src-tauri/tauri.conf.json`) and the External Tools Signed Manifest (`crates/tdm-core/src/tools/trust.rs`) share Ed25519 Minisign key `CDC23D8CC8DA5397` (`%USERPROFILE%\.tori-keys\tori-updater.key`).

2. **Which code paths trust the shared key?**
   - **Desktop App Updater:** `tauri-plugin-updater` using `src-tauri/tauri.conf.json -> plugins.updater.pubkey`.
   - **External Tools Updater:** `crates/tdm-core/src/tools/trust.rs` (`TORI_ED25519_PUBKEY_B64` / `TORI_ED25519_KEY_ID`), `crates/tdm-core/src/tools/types.rs` (`ToolsManagerConfig::default()`), and `crates/tdm-core/src/tools/providers.rs` (`fetch_signed_tools_manifest()`).
   - **Release & Manifest Tooling:** `scripts/build_nsis_installer.ps1`, `scripts/publish_trusted_tools_manifest.js`, and `crates/tdm-core/tests/updater_cryptography_tests.rs`.

3. **Can tools use a separate public key without changing Desktop updater signatures?**  
   **Yes.** `tauri-plugin-updater` reads ONLY `src-tauri/tauri.conf.json`. The External Tools updater reads ONLY `ToolsManagerConfig` (`TrustedToolsKeyring`) in `tdm-core`. Separating `tori-tools.key` leaves Desktop updater signatures (`CDC23D8CC8DA5397`) 100% untouched.

4. **Can existing installed Desktop `v1.0.7` clients accept a new tools-only key?**  
   **No.** Public Desktop `v1.0.7` binaries compiled at `84da0c08` have `TORI_ED25519_PUBKEY_B64` (`CDC23D8CC8DA5397`) hardcoded in `tdm-core` and strictly require `manifest.signing_key_id == "CDC23D8CC8DA5397"` and valid signature verification against that exact public key on `tools-manifest.json.sig`. Replacing the production `.sig` with a new unknown key today would immediately break FFmpeg/FFprobe updates for every installed `v1.0.7` client.

5. **How can the trust transition avoid breaking installed clients?**  
   By executing a **staged, forward-compatible dual-key transition**:
   - Never switch production `tools-manifest.json.sig` to the dedicated key until a Desktop release (`v1.0.8+`) carrying `TrustedToolsKeyring` (trusting BOTH legacy shared key `CDC23D8CC8DA5397` in `TransitionLegacy` mode AND the new dedicated `tori-tools.key` in `Active` mode) has shipped and achieved adoption.
   - During the overlap window (Stage 1–2), primary `tools-manifest.json.sig` continues to be signed by `CDC23D8CC8DA5397` (preserving 100% `v1.0.7` compatibility), while dual-key clients may also verify an optional dedicated-key sidecar signature (`tools-manifest.json.tools.sig`) when `dedicated_signing_key_id` is declared.

6. **Can multiple tools public keys be trusted during an authorized transition?**  
   **Yes.** Gate 33 introduces `TrustedToolsKeyring` (`keyring_version: 1`) with explicit per-key `key_id`, `pubkey_b64`, `SigningKeyPurpose`, `TrustedKeyStatus`, optional `valid_from` / `retired_after` timestamps, and explicit `revoked_key_ids`. Verification extracts the signer's exact 8-byte key ID from the Minisign signature header first, checks revocation and purpose binding, and verifies exclusively against that pinned key — never accepting arbitrary Ed25519 keys.

7. **How can old keys be safely retired?**  
   Through a two-step controlled retirement:
   - First stop signing new manifests with `CDC23D8CC8DA5397` once legacy `v1.0.7` clients are superseded (Stage 2 → Stage 3).
   - Then ship a Desktop release setting `allow_legacy_shared_key = false` and marking `CDC23D8CC8DA5397` as `TrustedKeyStatus::Retired` inside `TrustedToolsKeyring` (while keeping `CDC23D8CC8DA5397` active solely in `src-tauri/tauri.conf.json` for Desktop updater). `TrustedToolsKeyring::validate_safety()` refuses to build a keyring with zero remaining active tools-signing keys.

8. **What happens if one signing key becomes compromised?**
   - **If dedicated `tori-tools.key` is compromised (post-separation):** Desktop auto-updater key `CDC23D8CC8DA5397` remains uncompromised! TORI can immediately ship an authenticated Desktop auto-update (signed by `CDC23D8CC8DA5397`) that places the compromised `tori-tools.key` ID into `revoked_key_ids` and introduces a fresh replacement `tori-tools-v2.key`, while removing/replacing the manifest on Cloudflare Pages and unpublishing any tainted artifact tag on GitHub.
   - **If shared key `CDC23D8CC8DA5397` is compromised (current pre-separation state):** Blast radius affects BOTH Desktop auto-updates AND External Tools manifests; recovery requires rotating the Desktop updater key in a newly signed/verified manual release, revoking `CDC23D8CC8DA5397` in `TrustedToolsKeyring`, and publishing a security advisory with SHA-256 verification instructions. **This asymmetry is the core security justification for Gate 33's key separation.**

---

## 2. Phase 2 — Dedicated External Tools Key Architecture (`TrustedToolsKeyring`)

Implemented in `crates/tdm-core/src/tools/types.rs`, `trust.rs`, and `providers.rs`:

- **Explicit Key Purposes (`SigningKeyPurpose`):**
  - `ExternalToolsManifest`: Dedicated tools-only signing key (`tori-tools.key`). Allowed for External Tools manifests.
  - `ExternalToolsLegacyShared`: Transitional legacy shared key (`CDC23D8CC8DA5397`). Allowed ONLY while `allow_legacy_shared_key == true` and `status == TransitionLegacy`.
  - `DesktopAppUpdater`: Desktop updater-only key. **Strictly rejected** for External Tools manifest verification (`wrong-purpose key rejection`).
- **Explicit Key Lifecycle (`TrustedKeyStatus`):**
  - `Active` → Accepted within `[valid_from, retired_after]`.
  - `TransitionLegacy` → Accepted only when `allow_legacy_shared_key == true` and within validity window.
  - `Retired` → Rejected for new manifests.
  - `Revoked` → Rejected unconditionally (checked before cryptographic verification).
- **Manifest Domain Binding & No Self-Authorization:**
  - Optional `key_purpose` field in `SignedToolsManifest`: if present, MUST equal `"external_tools_manifest"` (rejects `"desktop_app_updater"` or any other purpose).
  - Manifests **cannot** add, promote, or authorize new public keys. Any signature from a key ID absent from the compiled/configured `TrustedToolsKeyring` fails closed as `RejectedSecurity`.
  - Minisign signature header key ID (`extract_minisign_sig_key_id_hex`) MUST match BOTH the selected `TrustedSigningKey.key_id` AND `manifest.signing_key_id`.
- **Safe Keyring Invariant (`TrustedToolsKeyring::validate_safety`):**
  - Prevents unsafe key removal: rejects any keyring where zero usable (`Active` or permitted `TransitionLegacy`) keys remain.

### Private Key Custody Standard (Production `tori-tools.key`)

1. **Out-of-Repo Storage:** Store `tori-tools.key` (passphrase-encrypted Minisign secret key), `tori-tools.key.pub`, and separate offline recovery backup strictly outside all Git repositories (e.g., encrypted local vault `%USERPROFILE%\.tori-keys\tori-tools.key` with NTFS ACL restricted to owner `icacls ... /inheritance:r /grant:r %USERNAME%:(F)`, plus offline encrypted USB/hardware backup stored separately from `tori-updater.key`).
2. **Never Commit or Log:** Private keys, passphrases, `.key`, `.pwd`, and recovery phrases must NEVER enter `tori-download-manager`, `tori-website-private`, CI artifacts, stdout, or logs.
3. **Separate Passphrase:** `tori-tools.key` must use an independent high-entropy passphrase distinct from `tori-updater.key`.
4. **Generation Command (When Authorized in Future Release Gate):**
   ```powershell
   cargo tauri signer generate -w "$env:USERPROFILE\.tori-keys\tori-tools.key"
   ```
   Record ONLY the public key box (`tori-tools.key.pub`) and 16-hex key ID for inclusion in `TrustedToolsKeyring`.

---

## 3. Phase 3 — Staged Safe Key Transition Plan (Zero `v1.0.7` Breakage)

```text
Stage 0 (NOW — Public v1.0.7)
  - Clients: v1.0.7 trusts ONLY shared key CDC23D8CC8DA5397
  - Prod manifest: rev 1 signed by CDC23D8CC8DA5397
  - Gate 33 code: Dedicated keyring + dual-key verification READY in development branch (NOT publicly shipped)

Stage 1 (Future Desktop v1.0.8 Release — Dual-Key Capable Clients)
  - Operator generates production tori-tools.key offline under custody policy
  - v1.0.8 ships with TrustedToolsKeyring trusting:
      1) tori-tools.key       (purpose: ExternalToolsManifest, status: Active)
      2) CDC23D8CC8DA5397     (purpose: ExternalToolsLegacyShared, status: TransitionLegacy)
      allow_legacy_shared_key: true
  - Production tools-manifest.json.sig CONTINUES signing with CDC23D8CC8DA5397 so v1.0.7 never breaks
  - Optional dual-signature sidecar tools-manifest.json.tools.sig signed by tori-tools.key
    verifies live end-to-end on v1.0.8+ clients without breaking v1.0.7

Stage 2 (Primary Tools-Key Cutover — After v1.0.8+ Adoption Threshold)
  - Operator verifies v1.0.7 clients have migrated via Desktop auto-updater (v1.0.7 -> v1.0.8+)
  - Production manifest revision N+1 switches primary tools-manifest.json.sig & signing_key_id
    to dedicated tori-tools.key
  - v1.0.8+ verifies natively using tori-tools.key; Desktop updater remains on CDC23D8CC8DA5397

Stage 3 (Legacy Key Retirement — Future Desktop v1.0.9+)
  - v1.0.9+ sets allow_legacy_shared_key = false and marks CDC23D8CC8DA5397 as
    TrustedKeyStatus::Retired inside TrustedToolsKeyring
  - Desktop Auto-Updater continues using CDC23D8CC8DA5397 independently
  - Full cryptographic blast-radius isolation achieved!
```

### Emergency Rollback During Transition

- **If Stage 2 cutover reveals remaining `v1.0.7` users unable to verify `tori-tools.key`:**
  1. Do **not** republish an older revision (clients enforce anti-replay).
  2. Publish revision **`N + 1`** signed with legacy `CDC23D8CC8DA5397` (`allow_legacy_shared_key` is still `true` on `v1.0.8`!).
  3. Both `v1.0.7` and `v1.0.8` immediately accept revision `N + 1` with zero client breakage.
- **If `tori-tools.key` is compromised during Stage 1–3:**
  1. Immediately publish Desktop emergency update (signed by uncompromised Desktop key `CDC23D8CC8DA5397`) placing compromised key ID in `revoked_key_ids` and installing replacement `tori-tools-v2.key`.
  2. Remove tainted manifest from `tori-website-private` and replace with safe revision signed by trusted active key.
