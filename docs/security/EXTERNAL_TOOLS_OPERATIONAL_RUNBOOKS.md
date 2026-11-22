# TORI Download Manager — External Tools & Release Security Operational Runbooks

**Document ID:** `TORI-OPS-G33-002`  
**Audience:** TORI Maintainers & Release Engineers  
**Important Rule:** Commands marked **[REQUIRES OPERATOR APPROVAL]** must never be run unattended or triggered automatically by expiry alerts.

---

## Runbook 1 — Manifest Expiry Monitoring (UTC)

Check current production manifest health, cryptographic signature, remote artifact `HEAD`, and expiry alert status:

```powershell
node scripts/monitor_tools_manifest_expiry.js --force
```

Strict exit-code mode (exits `2` on `CRITICAL_ALERT`/`EXPIRED_INCIDENT`/`SECURITY_INCIDENT`, `3` on fetch outage):

```powershell
node scripts/monitor_tools_manifest_expiry.js --force --strict-exit
```

Direct manifest inspection via renewal CLI:

```powershell
node scripts/renew_trusted_tools_manifest.js --check
```

Configurable thresholds live in `docs/security/manifest_expiry_monitoring_config.json` (`30d` renewal due, `14d` warning, `7d` high-priority, `48h` critical, `<= 0` expired). Automated daily read-only checks are defined in `.github/workflows/tools-manifest-expiry-monitor.yml`.

---

## Runbook 2 — Controlled Metadata Renewal (Same Approved Artifact)

Use when an approved immutable FFmpeg/FFprobe artifact is unchanged and only `published_at`, `expires_at`, and `manifest_revision` need renewal.

1. **Dry-run validation (no disk writes):**
   ```powershell
   node scripts/renew_trusted_tools_manifest.js --dry-run --ttl-days 45
   ```
2. **Prepare unsigned renewal proposal (`target/tools_renewal_staging/rev_<N>/`):**
   ```powershell
   node scripts/renew_trusted_tools_manifest.js --prepare --ttl-days 45
   ```
3. **[REQUIRES OPERATOR APPROVAL] Sign prepared renewal with protected out-of-repo key:**
   ```powershell
   node scripts/renew_trusted_tools_manifest.js --prepare --force --ttl-days 45 `
     --sign-with-tauri-key `
     --priv-key-file "$env:USERPROFILE\.tori-keys\tori-updater.key" `
     --pub-key-file "$env:USERPROFILE\.tori-keys\tori-updater.key.pub" `
     --pwd-file "$env:USERPROFILE\.tori-keys\tori-updater.key.pwd"
   ```
4. **Independently verify signed bytes, schema v2, TTL bounds, and remote artifact:**
   ```powershell
   node scripts/renew_trusted_tools_manifest.js --verify `
     --manifest-file "target\tools_renewal_staging\rev_<N>\tools-manifest.json"
   ```
5. **Test on isolated staging endpoint before any production promotion:**
   ```powershell
   node scripts/renew_trusted_tools_manifest.js --publish-staging `
     --manifest-file "target\tools_renewal_staging\rev_<N>\tools-manifest.json" `
     --staging-subdir gate33
   ```

---

## Runbook 3 — New FFmpeg/FFprobe Candidate Approval (Distinct From Metadata Renewal)

`renew_trusted_tools_manifest.js --prepare` **strictly refuses** artifact URL/SHA-256/version changes. For a genuinely new FFmpeg/FFprobe binary release:

1. Discover newest immutable dated `BtbN/FFmpeg-Builds` release:
   ```powershell
   node scripts/publish_trusted_tools_manifest.js --discover
   ```
2. Stage locally, cross-check GitHub digest + `checksums.sha256`, verify Windows x64 PE32+ headers, and run the 7-check real media compatibility suite:
   ```powershell
   node scripts/publish_trusted_tools_manifest.js --stage --release-tag <autobuild-YYYY-MM-DD-HH-MM>
   ```
3. Review `target/tools_publish_staging/<tag>/PROVENANCE.json`, `SHA256SUMS.txt`, and license obligations.
4. **[REQUIRES OPERATOR APPROVAL]** Mirror unmodified archive to isolated GitHub prerelease (`make_latest=false`) and publish staging manifest:
   ```powershell
   node scripts/publish_trusted_tools_manifest.js --publish-staging --release-tag <tag> --revision <N>
   ```
5. Run live HTTPS staging end-to-end QA (`node scripts/verify_gate32_1_remote_manifest.js`, must pass `19/19`).
6. **[REQUIRES OPERATOR APPROVAL]** Promote verified manifest & `.sig` to production and append immutable record + archived files to `docs/security/tools-manifest-registry/`.

---

## Runbook 4 — Dedicated Signing-Key Custody (`tori-tools.key`)

1. Never store private keys or passphrases inside any Git repository or cloud-synced public folder.
2. **[REQUIRES OPERATOR APPROVAL — FUTURE RELEASE GATE]** Generate dedicated out-of-repo tools key with a unique high-entropy passphrase distinct from `tori-updater.key`:
   ```powershell
   cargo tauri signer generate -w "$env:USERPROFILE\.tori-keys\tori-tools.key"
   ```
3. Restrict NTFS ACLs to owner-only:
   ```powershell
   icacls "$env:USERPROFILE\.tori-keys" /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F"
   ```
4. Store an encrypted offline backup of `tori-tools.key` and its passphrase in a separate physical safe/hardware vault from `tori-updater.key`.

---

## Runbook 5 — Dedicated Key Transition (Staged Zero-Breakage Rollout)

Follow `docs/security/EXTERNAL_TOOLS_SIGNING_KEY_MIGRATION_SPEC.md`:
- **Stage 0 (Current Public `v1.0.7`):** Shared key `CDC23D8CC8DA5397` remains active; Gate 33 `TrustedToolsKeyring` sits ready in development.
- **Stage 1 (Future Desktop `v1.0.8`):** Add `tori-tools.key` (`Active`) alongside `CDC23D8CC8DA5397` (`TransitionLegacy`, `allow_legacy_shared_key: true`). Keep signing primary `.sig` with `CDC23D8CC8DA5397` and optionally attach `.tools.sig` signed by `tori-tools.key` so `v1.0.7` never breaks.
- **Stage 2 (Cutover):** After `v1.0.8+` adoption succeeds, sign primary `.sig` at revision `N+1` with `tori-tools.key`.
- **Stage 3 (Retirement — Future Desktop `v1.0.9+`):** Set `allow_legacy_shared_key = false` and mark `CDC23D8CC8DA5397` as `Retired` inside `TrustedToolsKeyring` (Desktop updater in `src-tauri/tauri.conf.json` continues using `CDC23D8CC8DA5397` independently).

---

## Runbook 6 — Emergency Manifest Rollback (Defective Tool Release)

Never revert by re-serving an older `manifest_revision` (blocked by client anti-replay).

1. Generate a verified higher-revision rollback plan from the immutable registry (`allow_rollback_to: true`):
   ```powershell
   node scripts/renew_trusted_tools_manifest.js --rollback-plan --target-revision 1 --revision <HIGHEST_REV + 1>
   ```
2. **[REQUIRES OPERATOR APPROVAL]** Sign the generated `tools-manifest.json` using the active trusted signing key (`publish_trusted_tools_manifest.js --rollback-manifest ...` or `cargo tauri signer sign`), verify via `--verify`, and deploy to `tori-website-private` `assets/tools/`.
3. Unpublish/delete the defective GitHub prerelease asset tag so fresh fetches cannot retrieve it.
4. Append the rollback revision and mark the defective revision `revoked` in `docs/security/tools-manifest-registry/registry.json`.

---

## Runbook 7 — Key Compromise Response

- **Dedicated `tori-tools.key` compromised (post-separation):**
  1. Immediately remove/replace tainted manifest on `tori-website-private`.
  2. Generate replacement `tori-tools-v2.key` offline.
  3. Ship emergency Desktop release (signed by uncompromised Desktop updater key `CDC23D8CC8DA5397`) adding compromised key ID to `TrustedToolsKeyring.revoked_key_ids` and activating `tori-tools-v2.key`.
- **Shared / Desktop updater key `CDC23D8CC8DA5397` compromised:**
  1. Immediately halt automated updater distribution (`latest.json`) and remove tainted manifests.
  2. Generate fresh Desktop updater keypair AND separate `tori-tools.key` offline.
  3. Publish security advisory with verified SHA-256 digests and manual upgrade instructions; revoke `CDC23D8CC8DA5397` in all new keyrings.
- **GitHub or Cloudflare account compromised:**
  1. Revoke all PATs/API keys and active sessions; enforce hardware 2FA.
  2. Audit GitHub releases & Cloudflare Pages deployments against `docs/security/tools-manifest-registry/registry.json` and out-of-tree backups (`C:\Users\ritud\.tori-release-backups\`).
  3. Redeploy bit-for-bit verified artifacts.

---

## Runbook 8 — Clean Windows 10/11 VM Release QA

1. **Read-only host virtualization readiness check:**
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run_clean_windows_vm_qa.ps1 -AuditOnly
   ```
2. **Execute on a pre-provisioned clean Windows 10 or Windows 11 Hyper-V VM (Elevated PowerShell):**
   ```powershell
   $cred = Get-Credential
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run_clean_windows_vm_qa.ps1 `
     -VmName "TORI-Clean-Win11" `
     -CheckpointName "CleanBaseline" `
     -InstallerPath "F:\TORI\final tori download manager\release\v1.0.7-rc\TORI Download Manager_1.0.7_x64-setup.exe" `
     -GuestCredential $cred
   ```
3. **Or run manually on clean Microsoft-hosted Windows runners (`windows-2022` / `windows-2025`):** Trigger `.github/workflows/clean-windows-release-qa.yml` via GitHub Actions `workflow_dispatch`.

---

## Runbook 9 — Optional Windows Authenticode Signing

1. **Verify host `signtool.exe` & fail-closed guard:**
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify_authenticode_readiness.ps1
   ```
2. **[REQUIRES PROVISIONED CERTIFICATE]** Build Authenticode + Ed25519 dual-signed NSIS installer:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build_nsis_installer.ps1 `
     -SignAuthenticode -RequireAuthenticode -CertThumbprint "<THUMBPRINT>" -TimestampUrl "http://timestamp.digicert.com"
   ```

---

## Runbook 10 — Post-Deployment Verification

After any authorized manifest renewal or Desktop release:
1. Verify live production manifest & `.sig` cryptographically:
   ```powershell
   node scripts/renew_trusted_tools_manifest.js --check --strict-exit
   ```
2. Verify Desktop `latest.json`, GitHub Latest Stable, website cache-bypass headers, Browser Companion `v1.0.10`, and OEM preservation:
   ```powershell
   node scripts/verify_gate32_3_public_release.js --post-release
   ```
3. Verify Gate 32 dual-condition FFmpeg trust suite (signed production manifest accepted + unsigned direct upstream blocked):
   ```powershell
   node scripts/verify_gate32_external_tools_updater.js
   ```
