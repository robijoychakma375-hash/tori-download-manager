# TORI Download Manager — Dedicated External Tools Signing-Key Custody & Recovery Runbook

**Document ID:** `TORI-CUSTODY-G33_3-001`  
**Scope:** Dedicated Production External Tools Ed25519 Signing Key (`tori-tools.key`)  
**Tooling:** `scripts/provision_dedicated_tools_key.ps1`, `scripts/renew_trusted_tools_manifest.js`  
**Security Rule:** This document contains **ZERO** private keys, passphrases, or recovery secrets.

---

## 1. Purpose of the Dedicated Signing Key

The dedicated External Tools signing key (`tori-tools.key`) cryptographically isolates TORI's External Tools Manifest distribution (`FFmpeg` / `FFprobe`) from TORI's Desktop Auto-Updater trust anchor (`tori-updater.key`, Key ID `CDC23D8CC8DA5397`). If a tools-signing key is ever compromised, the uncompromised Desktop Auto-Updater key remains available as an authenticated emergency revocation and key-replacement channel.

## 2. Key-Generation Procedure (Operator-Controlled Interactive Terminal Only)

Never run production key generation with hardcoded passphrases, AI-visible arguments, or unencrypted output. Execute locally in an interactive PowerShell terminal:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision_dedicated_tools_key.ps1 -Mode ProductionInteractive
```

The script invokes `cargo tauri signer generate` with a `Read-Host -AsSecureString` prompt (minimum 16 characters), verifies binary `Ed`/`Sc` scrypt encryption, applies owner-only NTFS ACLs, verifies Key ID independence from `CDC23D8CC8DA5397`, executes an immediate sign/verify roundtrip test on an ephemeral probe file, zeros memory (`ZeroFreeBSTR`), and outputs **only** non-sensitive public key metadata.

## 3. Passphrase Handling

- Use a unique high-entropy passphrase (>= 16 characters, ideally >= 24 characters) **strictly distinct** from `tori-updater.key`.
- **NEVER** create a plaintext `tori-tools.key.pwd` file on disk.
- **NEVER** enter passphrases on the command line, in shell history, in environment files, in CI secrets, or in AI chat transcripts.
- Store the passphrase in an offline encrypted password manager and/or sealed physical safe separated from the key file backup.

## 4. Private-Key File Permissions

- Primary local custody path: `%USERPROFILE%\.tori-keys\tori-tools.key`
- Mandatory NTFS ACL: inherited permissions removed (`/inheritance:r`) and full control granted exclusively to the local operator account (`$env:USERDOMAIN\$env:USERNAME:(F)`).
- Verify at any time (read-only):
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision_dedicated_tools_key.ps1 -Mode VerifyProductionKey
  ```

## 5. Public-Key Fingerprint Verification

Derive and cross-check three independent identifiers from `%USERPROFILE%\.tori-keys\tori-tools.key.pub`:
1. 16-character uppercase Minisign Key ID (`TORI_DEDICATED_TOOLS_ED25519_KEY_ID`).
2. Lowercase SHA-256 digest of the raw 32-byte Ed25519 public key (`pubkeySha256`).
3. Base64-encoded Minisign public key box (`TORI_DEDICATED_TOOLS_ED25519_PUBKEY_B64`).

Confirm `keyIdHex != "CDC23D8CC8DA5397"` and verify `src-tauri/tauri.conf.json` remains pinned solely to `CDC23D8CC8DA5397`.

## 6. Offline Encrypted Backup Procedure

1. Mount an offline encrypted backup medium (e.g., BitLocker/VeraCrypt encrypted USB drive stored separately from `tori-updater.key` backup).
2. Copy ONLY the already scrypt-encrypted `tori-tools.key` and `tori-tools.key.pub` to the offline medium (never export unencrypted raw keys).
3. Record the public key SHA-256 fingerprint and Key ID in an offline custody ledger.
4. Safely eject and store the medium offline.

## 7. Recovery Validation

Validate backup integrity before embedding the public key into Desktop `v1.0.8`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision_dedicated_tools_key.ps1 `
  -Mode VerifyBackup `
  -BackupDir "E:\TORI-OFFLINE-VAULT\tori-tools-backup" `
  -VerifyPassphrase
```

Confirm output reports `"status": "BACKUP_VERIFIED"`, `"encryptedKeyMatch": true`, `"publicKeyMatch": true`, `"backupScryptEncrypted": true`, and `"passphraseRoundtripOk": true`.

## 8. Signing Access-Control Policy

- Signing operations using `tori-tools.key` occur **exclusively** on the operator's secured local workstation via interactive passphrase entry.
- GitHub Actions, Cloudflare Pages, pull-request runners, and unattended expiry-monitor schedules **never** hold private signing keys.

## 9. Operator Role

The project owner / designated release custodian is the sole authority permitted to:
- Generate or rotate `tori-tools.key`
- Unlock `tori-tools.key` for staging or production signing
- Authorize embedding the public key in `crates/tdm-core/src/tools/trust.rs`
- Issue signed production manifest approval tokens

## 10. Compromise Response

If `tori-tools.key` is suspected or confirmed compromised:
1. **Immediate Containment:** Replace or remove any unauthorized manifest on `tori-website-private` (`assets/tools/`) and unpublish any tainted GitHub prerelease asset.
2. **Replacement Key Generation:** Provision a new independent `tori-tools-v2.key` offline (`-ForceRotate`).
3. **Authenticated Desktop Revocation Release:** Ship an emergency Desktop update signed by the uncompromised Desktop Auto-Updater key (`CDC23D8CC8DA5397`) that adds the compromised key ID to `TrustedToolsKeyring.revoked_key_ids` and activates `tori-tools-v2.key`.
4. **No Dependency on Compromised Key:** Revocation is enforced by the Desktop release and checked prior to signature verification — recovery never depends on the compromised key remaining trusted.

## 11. Lost-Key Response

If both primary and backup copies of `tori-tools.key` (or its passphrase) are permanently lost:
1. During Stage 1–2 (while legacy key `CDC23D8CC8DA5397` remains trusted): continue renewing production manifests with `CDC23D8CC8DA5397`, generate a fresh dedicated key `tori-tools-v2.key`, and embed it in the next Desktop release.
2. Post-Stage 3: ship a Desktop release (signed by `CDC23D8CC8DA5397`) replacing the lost dedicated key ID with a newly provisioned `tori-tools-v2.key` and marking the lost key `Retired`.

## 12. Key Rotation

Planned rotation follows zero-downtime overlapping trust:
1. Provision `tori-tools-v(N+1).key` offline and verify backup.
2. Ship Desktop release trusting both `vN` and `v(N+1)`.
3. After fleet adoption, switch primary manifest signing to `v(N+1)` at strictly higher `manifest_revision`.
4. Mark `vN` `Retired` in a subsequent Desktop release.

## 13. Legacy Signer Transition

- **Stage 0 (Current Public `v1.0.7`):** Legacy shared key `CDC23D8CC8DA5397` signs production `rev 2`.
- **Stage 1 (`v1.0.8`):** Trusts BOTH `CDC23D8CC8DA5397` (`TransitionLegacy`, `allow_legacy_shared_key: true`) AND dedicated `tori-tools.key` (`Active`). Production continues primary signing with `CDC23D8CC8DA5397` (optionally with `.tools.sig` sidecar) so `v1.0.7` never breaks.
- **Stage 2 (Cutover — Gate 33.4+):** Switch primary `.sig` to `tori-tools.key` only after verified `v1.0.8+` fleet adoption.
- **Stage 3 (Retirement — `v1.0.9+`):** Set `allow_legacy_shared_key = false` and retire `CDC23D8CC8DA5397` from External Tools while preserving it independently for Desktop Auto-Updater.

## 14. Revocation

Revoked key IDs are listed in `TrustedToolsKeyring.revoked_key_ids` (and/or marked `TrustedKeyStatus::Revoked`). Clients check revocation **before** cryptographic verification and reject any manifest signed by a revoked key with `RejectedSecurity`.

## 15. Future Retirement

Retirement of `CDC23D8CC8DA5397` from External Tools is gated strictly on verified client-fleet migration telemetry/adoption — **never** on an arbitrary fixed calendar date. `TrustedToolsKeyring::validate_safety()` enforces that retiring a key cannot leave zero active tools-signing keys.

## 16. Emergency Recovery

Because clients enforce strict `manifest_revision` monotonicity, emergency manifest recovery always publishes a **strictly higher** signed revision (`N + 1`, `allow_rollback_to: true`) referencing an immutable known-good artifact from `docs/security/tools-manifest-registry/registry.json` (`node scripts/renew_trusted_tools_manifest.js --rollback-plan`).

## 17. Audit Logging

All custody audits, key verifications, staging tests, and production renewals record structured JSON metadata containing **only** public Key ID, public key SHA-256 fingerprint, manifest revision, manifest/signature SHA-256, Cloudflare deployment ID, and approval reference — never private keys or passphrases.

## 18. Release Approval Requirements

No production key embedding, manifest publication, or Desktop release may proceed without:
1. Verified custody status (`VALID_PRODUCTION_KEY`) and verified offline backup (`BACKUP_VERIFIED`).
2. Passing full cryptographic, upgrade, compatibility, and preservation suites.
3. Explicit project-owner authorization scoped to that specific gate and artifact SHA-256.
