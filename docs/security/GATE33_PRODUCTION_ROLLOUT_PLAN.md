# TORI Download Manager — Future Production Rollout Plan (Gates 33.2 → 33.4)

**Document ID:** `TORI-ROLLOUT-G33_1-001`  
**Status:** Preparation Complete — **NO PUBLIC EXECUTION PERFORMED IN GATE 33.1**  
**Scope:** Separates production manifest renewal, Stage 1 dual-key Desktop `v1.0.8` release, and future dedicated-key cutover into three independently authorized gates.

---

## Pre-Requisite Operator Custody Action (Before Gate 33.3 Final Build)

1. Run interactive key provisioning on the operator workstation (offline passphrase, never written to `.pwd`, never overwriting `tori-updater.key`):
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision_dedicated_tools_key.ps1 -Mode ProductionInteractive
   ```
2. Copy encrypted `%USERPROFILE%\.tori-keys\tori-tools.key` + `.pub` to an encrypted offline backup medium stored separately from `tori-updater.key`.
3. Embed ONLY the public key box (`TORI_DEDICATED_TOOLS_ED25519_PUBKEY_B64`) and 16-hex Key ID (`TORI_DEDICATED_TOOLS_ED25519_KEY_ID`) into `crates/tdm-core/src/tools/trust.rs`, rebuild `v1.0.8-rc`, and verify `TrustedToolsKeyring::default_production_transition().has_dedicated_active_key() == true`.

---

## Gate 33.2 — Authorized Production Manifest Renewal (`rev 1 → rev 2`)

**Timing Window:** Execute before `2026-12-06` (30-day renewal threshold ahead of `rev 1` expiration `2027-01-05T16:00:29.945Z`).  
**Backward Compatibility:** 100% compatible with public Desktop `v1.0.7` AND planned `v1.0.8`.

### Exact Pre-Publication Race & Safety Checklist
1. Re-fetch live `https://toridownload.xyz/assets/tools/tools-manifest.json` (`node scripts/renew_trusted_tools_manifest.js --check`).
2. **Race Guard:** Confirm live `manifest_revision == 1`. If live revision is already `> 1`, abort and reconcile against the highest published revision.
3. Confirm immutable FFmpeg archive (`N-129150-g7ddf7bc8a4-20261120`, `205,445,856` B, SHA-256 `03d33066832e7149a8577bed73713c5d5344aed14199063e521b798cf1b60076`) returns HTTP `200` `HEAD`.
4. Sign `rev 2` candidate with legacy shared key `CDC23D8CC8DA5397` (preserving 100% `v1.0.7` compatibility; optionally attach `.tools.sig` signed by `tori-tools.key` if provisioned).
5. Run `node scripts/renew_trusted_tools_manifest.js --verify` over exact signed bytes.
6. Deploy `assets/tools/tools-manifest.json` + `.sig` to `tori-website-private`, verify live Cloudflare Pages HTTP `200` + exact SHA-256 + live `v1.0.7` acceptance, and append immutable `rev 2` record & archived files to `docs/security/tools-manifest-registry/`.

### Gate 33.2 GO / NO-GO Criteria
- **GO:** Live `rev 2` verifies cryptographically against `CDC23D8CC8DA5397`, retains unchanged artifact SHA-256, has bounded TTL (`30–45` days), passes live `v1.0.7` check, and leaves `rev 1` archive untouched.
- **NO-GO:** Any SHA-256 mismatch, missing `.sig`, revision conflict, or live `v1.0.7` verification failure.

---

## Gate 33.3 — Authorized Desktop `v1.0.8` Public Stable Release (Stage 1 Dual-Key Client)

**Scope:** Desktop-only stable release (`v1.0.8`). Browser Companion `v1.0.10` remains completely unchanged.

### Dependencies
- Production `tori-tools.key` custody completed and public key embedded in `crates/tdm-core/src/tools/trust.rs` (for full Stage 1 dual-key activation in `v1.0.8`).
- Clean Windows 10/11 release QA run via `.github/workflows/clean-windows-release-qa.yml` or provisioned Hyper-V VM (or explicit owner acceptance of documented clean-VM / Authenticode limitations).
- Optional: merge & enable `.github/workflows/tools-manifest-expiry-monitor.yml` on default branch so daily 06:00 UTC monitoring runs automatically in GitHub Actions.

### Execution Order
1. Freeze verified `release/v1.0.8-rc/` (signed with Desktop updater key `CDC23D8CC8DA5397` — NEVER `tori-tools.key`).
2. Two-phase GitHub release publication: push annotated tag `v1.0.8` -> draft upload -> remote re-download SHA-256 check -> promote Latest Stable + `latest.json` (`1.0.8`).
3. Update `toridownload.xyz` Desktop download links/checksums to `v1.0.8` (leaving Companion `v1.0.10` untouched).
4. Execute full live post-release verification (`v1.0.7 → public v1.0.8` physical upgrade, Native Messaging, Companion `v1.0.10`, production manifest acceptance).

---

## Gate 33.4 — Dedicated-Key Cutover & Eventual Legacy Key Retirement (Stage 2 → Stage 3)

**No Unsafe Fixed Date:** Cutover and legacy key retirement MUST be gated strictly on verified client-fleet adoption metrics, NEVER on an arbitrary calendar deadline!

### Stage 2 (Dedicated Primary Signature Activation)
- **Prerequisite:** Confirmed migration of active Desktop fleet from `v1.0.7` to dual-key `v1.0.8+`, plus explicit operator authorization.
- **Action:** Publish `manifest_revision = N + 1` with primary `tools-manifest.json.sig` signed by dedicated `tori-tools.key` (`signing_key_id = <DEDICATED_KEY_ID>`, `key_purpose = "external_tools_manifest"`).
- **Safety Rollback During Stage 2:** If any unexpected client compatibility issue arises, immediately publish `manifest_revision = N + 2` signed by legacy `CDC23D8CC8DA5397` (`v1.0.8` still trusts legacy key while `allow_legacy_shared_key = true`).

### Stage 3 (Legacy Shared Key Retirement from External Tools — Future `v1.0.9+`)
- **Prerequisite:** Zero operational incidents after Stage 2 cutover + operator retirement approval.
- **Action:** In future Desktop `v1.0.9+`, set `allow_legacy_shared_key = false` and mark `CDC23D8CC8DA5397` as `TrustedKeyStatus::Retired` inside `TrustedToolsKeyring`. Desktop Auto-Updater (`src-tauri/tauri.conf.json`) continues using `CDC23D8CC8DA5397` independently with full cryptographic blast-radius separation achieved.
