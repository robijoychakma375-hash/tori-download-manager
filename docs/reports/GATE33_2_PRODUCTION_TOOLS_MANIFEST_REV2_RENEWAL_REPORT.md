# TORI Download Manager — Gate 33.2 Authorized Production Tools Manifest Revision 2 Renewal, Monitor Activation & Live Verification Report

**Report ID:** `TORI-GATE33_2-REPORT-001`  
**Date (UTC):** `2026-11-22T20:38:00Z`  
**Development Branch:** `release/gate33_2-tools-manifest-renewal`  
**Baseline Commit:** `0be23348625f7968e3e1b585ea0846f0a3a7bd3f` (`checkpoint-gate33_1-verified`)  
**Pre-Renewal Safety Tag:** `checkpoint-gate33_2-before-production-renewal`  
**Final Gate 33.2 Verdict:** **`GO`**

---

## 1. Executive Summary

Gate 33.2 executed the project-owner-authorized, metadata-only production renewal of TORI Download Manager's Ed25519-signed External Tools Manifest from **`manifest_revision: 1`** to **`manifest_revision: 2`** with a fresh **60-day UTC validity horizon** (`2026-11-22T19:46:42.049Z` → `2027-01-21T19:46:42.049Z`), promoted it atomically via Cloudflare Pages (`449b84d7-4ec8-4a63-b0ec-5f7d3a6a7ebe`), activated the strictly read-only GitHub Actions manifest expiry-monitoring workflow on default branch `master` (verified via real `workflow_dispatch` Run **`45063316490`**), updated the immutable manifest registry preserving `rev 1` verbatim, and completed real live-HTTPS client acceptance testing on both **Public Desktop `v1.0.7`** and **Local Desktop `v1.0.8-rc`** — including a full live 196 MiB FFmpeg/FFprobe download, SHA-256 verification, version-parity verification, atomic activation, live H.264/AAC MP4→MKV media processing, atomic rollback, and reapply.

Public Desktop `v1.0.7`, GitHub `latest.json` (`1.0.7`), Browser Companion `v1.0.10`, the approved FFmpeg archive (`N-129150-g7ddf7bc8a4-20261120`), website download links, local unpublished `v1.0.8-rc` audit artifacts, and all workstation OEM user data remain 100% preserved and untouched.

---

## 2. Owner Authorization

Explicit project-owner authorization granted for Gate 33.2 covering:
- Metadata-only production External Tools Manifest renewal (`rev 1 → rev 2`, 60-day validity, unchanged approved FFmpeg/FFprobe artifact, existing approved legacy Ed25519 key `CDC23D8CC8DA5397`).
- Atomic production publication to `https://toridownload.xyz/assets/tools/tools-manifest.json` and `.sig`.
- Read-only GitHub Actions expiry-monitor activation on the repository default branch (`master`) with zero signing secrets.
- Full live HTTPS acceptance, tool update/rollback, registry update, and preservation verification.

Strictly excluded and enforced as non-modified: Desktop `v1.0.8` publication, Desktop `v1.0.7` binaries/assets, public `latest.json`, dedicated `tori-tools.key` activation, updater key rotation, FFmpeg binary substitution, and Browser Companion `v1.0.10`.

---

## 3. Gate 33.1 Baseline

- **Branch / Commit:** `feat/gate33_1-dual-key-v108-rc` @ `0be23348625f7968e3e1b585ea0846f0a3a7bd3f` (`checkpoint-gate33_1-verified`).
- **Safety Anchor Created:** `checkpoint-gate33_2-before-production-renewal` at `0be23348625f7968e3e1b585ea0846f0a3a7bd3f`.
- **Working Branch:** `release/gate33_2-tools-manifest-renewal`.
- **Audit Preservation of Earlier Gate 33.1 Artifacts:** Verified unchanged in `G332-PRE-13` and `G332-LIVE-08`:
  - `release/v1.0.8-rc/tools-manifest-rev2-candidate/tools-manifest.json` (`af7edd089989d150bb6179c0a051e8b4669aed04fe6b564c3a44cbe1f23bdfe4`, `UNSIGNED_BY_POLICY`) — untouched.
  - `release/v1.0.8-rc/TORI Download Manager_1.0.8_x64-setup.exe` (`659f5f239c80510d4e2da8d50a7f2ab92e1ba6a48fa63cd6c7ad2604078a5c02`) — untouched.

---

## 4. Public Production Baseline (Pre-Renewal Phase 0 Audit)

Fetched live prior to any modification:
- **Public Desktop Latest Stable:** `v1.0.7` (GitHub Release ID `454278227`, commit `84da0c08256d6abaca253b5612010034237c86f9`, `16` assets).
- **Public Desktop `latest.json`:** `version: "1.0.7"`, SHA-256 `45b89af208f792e674419de1438c5a0c3fb8b8972edd1e455f6f30753e0f3c16`.
- **Public Browser Companion:** `v1.0.10` (`extension-v1.0.10`, Release ID `451270856`).
- **Pre-Renewal Production Manifest (`rev 1`):**
  - `published_at`: `2026-11-21T16:00:29.945Z`
  - `expires_at`: `2027-01-05T16:00:29.945Z` (`43.84` days remaining at audit time)
  - Manifest SHA-256: `9fa61a38bb77bb8cdf05364565db2cf3b2b3ab8d0c7af98dfd7c50b2ee287662`
  - Signature SHA-256: `e0e23db79990f885c0745165299b20befd41f5dc8a73f7b00ca0476502955eb4`
- **Pre-Renewal Website State:** `robijoychakma375-hash/tori-website-private` `main` @ `fb42622f38a3c79e88e002dd13d731105085fb79` (Cloudflare Deployment ID `340498ae-737a-422d-9218-e1d85567e77f`).

---

## 5. Manifest Revision 1 Archival & Out-of-Repository Durable Backup

- **Out-of-Repository Pre-Renewal Backup:** `C:\Users\ritud\.tori-release-backups\gate33_2_pre_renewal\`
  - Contains exact pre-renewal `prod_rev1_tools-manifest.json` (`9fa61a38...`), `prod_rev1_tools-manifest.json.sig` (`e0e23db7...`), `public_v107_latest.json`, full copy of pre-renewal `registry/`, and `PRE_RENEWAL_BACKUP_MANIFEST.json`.
  - Contains **zero** private signing keys (`contains_private_keys: false`).
- **In-Repository Immutable Archive:** `docs/security/tools-manifest-registry/history/prod_rev_0001_tools-manifest.json` (`9fa61a38...`) and `.sig` (`e0e23db7...`) verified byte-identical and preserved verbatim.

---

## 6. Approved Artifact Verification

Verified unchanged via live GitHub Releases API (`tools-ffmpeg-N-129150-g7ddf7bc8a4`, Release ID `453686141`), remote HTTPS `HEAD`, and real 196 MiB client download + SHA-256 check (`G332-LIVE-03`):
- **Bundle Version:** `N-129150-g7ddf7bc8a4-20261120` (FFmpeg & FFprobe parity verified)
- **Archive Filename:** `ffmpeg-N-129150-g7ddf7bc8a4-win64-gpl.zip`
- **Immutable URL:** `https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/tools-ffmpeg-N-129150-g7ddf7bc8a4/ffmpeg-N-129150-g7ddf7bc8a4-win64-gpl.zip`
- **Exact Size:** `205,445,856` bytes (`HEAD` HTTP `200`, exact `Content-Length`)
- **Exact SHA-256:** `03d33066832e7149a8577bed73713c5d5344aed14199063e521b798cf1b60076`
- **Compatibility:** `platform: "windows"`, `architecture: "x86_64"`, `min_tori_version: "1.0.6"`, `max_tori_version: null`

---

## 7. Existing Signing-Key Validation

- **Approved Key Location:** `%USERPROFILE%\.tori-keys\tori-updater.key`
- **Verified Key ID:** `CDC23D8CC8DA5397` (`external_tools_legacy_shared` / `transition_legacy`)
- **Custody Verification:** Key present, matches embedded production Ed25519 public key in `src-tauri/tauri.conf.json` and `crates/tdm-core/src/tools/trust.rs`, not expired/revoked/compromised, zero key material or passphrase logged, zero key files committed or uploaded.
- **Dedicated Key Policy Enforced:** `tori-tools.key` remains `PRODUCTION_KEY_PROVISIONING_PENDING` and was **not** activated or used for primary `rev 2` signing, ensuring 100% backward compatibility with public Desktop `v1.0.7`.

---

## 8. New Revision 2 Metadata

Generated fresh via `scripts/renew_trusted_tools_manifest.js --prepare --force --revision 2 --ttl-days 60 --target-key-id CDC23D8CC8DA5397 --sign-with-tauri-key ... --out-dir release/gate33_2-manifest-rev2`:
- **`schema_version`:** `2`
- **`manifest_revision`:** `2` (strictly monotonic `2 > 1`, race-checked live before signing & publishing)
- **`generated_at` / `published_at`:** `2026-11-22T19:46:42.049Z`
- **`signing_key_id`:** `CDC23D8CC8DA5397`
- **`key_purpose`:** `external_tools_manifest`
- **`provenance.renewal_type`:** `metadata_only_unchanged_artifact` (`renewed_from_revision: 1`)

---

## 9. New Expiration Date

- **Previous (`rev 1`) Expiration:** `2027-01-05T16:00:29.945Z`
- **New (`rev 2`) Expiration:** **`2027-01-21T19:46:42.049Z`**
- **Validity Horizon:** **`60.0` days** from actual publication time (within bounded policy `[7..90]` days; extends service lifetime by `+16.16` days beyond `rev 1` and resets the 30-day renewal threshold to `2026-12-22T19:46:42Z`).

---

## 10. Manifest SHA-256

- **Exact Size:** `1,564` bytes
- **SHA-256:** `caa2d4ed2a7e424badcd8662e67b986a3fdfbf2847dded0625ea2b2547663f3a`

---

## 11. Signature SHA-256

- **Exact Size:** `408` bytes
- **SHA-256:** `11efa53f290d3d46fb16915fd3d1e69451de8c654eae8d75844b840ab99bb1c2`
- **Minisign Verification:** `sigAlg: "ED"`, `keyId: "CDC23D8CC8DA5397"`, `trustedComment: "timestamp:1795376802\tfile:tools-manifest.json"`, verified both pre-publication (`VERIFIED_VALID`) and post-publication over downloaded live HTTPS bytes (`G332-LIVE-01`).

---

## 12. Production Approval Audit

Upgraded `cmdPublishProduction` in `scripts/renew_trusted_tools_manifest.js` to execute authorized production promotion strictly behind dual fail-closed controls:
- CLI Flag: `--i-authorize-production-manifest`
- Bound Approval Token File: `release/gate33_2-manifest-rev2/GATE33_2_PRODUCTION_APPROVAL_TOKEN.json` (`approval_id: "TORI-APPROVAL-G33_2-PROD-REV2"`, bound to exact `manifest_sha256: caa2d4ed...`, `signature_sha256: 11efa53f...`, `manifest_revision: 2`, `expected_live_revision: 1`, `signing_key_id: CDC23D8CC8DA5397`, 24-hour expiry).
- Enforced live race-guard check (`live.manifest_revision === 1`), strict unchanged-artifact guard, exclusive renewal lock, and website diff allowlist (only `assets/tools/tools-manifest.json` and `.sig`).
- Fail-closed negative guards (`PRODUCTION_APPROVAL_REQUIRED` and `PRODUCTION_APPROVAL_MISMATCH`) re-verified in `G33S-09` (`PASS`).

---

## 13. Cloudflare Publication Sequence

1. Executed Phase 6 pre-publication 20-check matrix (`node scripts/verify_gate33_2_production_manifest_renewal.js --pre-publish`) — **`14/14 PASS`** (`0 FAIL`).
2. Executed atomic publisher:
   ```powershell
   node scripts\renew_trusted_tools_manifest.js --publish-production --i-authorize-production-manifest --approval-token-file release\gate33_2-manifest-rev2\GATE33_2_PRODUCTION_APPROVAL_TOKEN.json --manifest-file release\gate33_2-manifest-rev2\tools-manifest.json --sig-file release\gate33_2-manifest-rev2\tools-manifest.json.sig
   ```
3. Audited `git show --stat HEAD` in `C:\Users\ritud\Downloads\tori-website`: confirmed **ONLY** `assets/tools/tools-manifest.json` and `assets/tools/tools-manifest.json.sig` changed (`2 files changed, 11 insertions(+), 7 deletions(-)`); zero changes to `index.html`, Desktop/Companion links, staging fixtures, `sitemap.xml`, or `robots.txt`.
4. Polled GitHub Check Runs on `tori-website-private` until `Cloudflare Pages` reported `status: "completed"`, `conclusion: "success"`.
5. Polled live HTTPS production endpoints with cache-busting headers until byte-for-byte SHA-256 parity matched both approved files.

---

## 14. Deployment Commit and ID

- **Website Repository:** `robijoychakma375-hash/tori-website-private` (`main`)
- **Website Commit SHA:** `2eff4f20a64989c39a75cb6b1739ce3948431048`
- **Cloudflare Pages Deployment ID:** `449b84d7-4ec8-4a63-b0ec-5f7d3a6a7ebe`
- **Cloudflare Completion Timestamp (UTC):** `2026-11-22T19:51:57Z`
- **Cloudflare Details URL:** `https://dash.cloudflare.com/?to=/f903c690199da4b181753ed3370bb658/pages/view/tori-download-manager/449b84d7-4ec8-4a63-b0ec-5f7d3a6a7ebe`

---

## 15. Live HTTPS Verification

Verified live (`G332-LIVE-01`, `renew_trusted_tools_manifest.js --check --strict-exit`, `monitor_tools_manifest_expiry.js --force --strict-exit`):
- `https://toridownload.xyz/assets/tools/tools-manifest.json`: HTTP `200`, `1,564` B, `Content-Type: application/json`, `Cache-Control: public, max-age=0, must-revalidate`, SHA-256 `caa2d4ed2a7e424badcd8662e67b986a3fdfbf2847dded0625ea2b2547663f3a`, `manifest_revision: 2`, `expires_at: 2027-01-21T19:46:42.049Z`.
- `https://toridownload.xyz/assets/tools/tools-manifest.json.sig`: HTTP `200`, `408` B, SHA-256 `11efa53f290d3d46fb16915fd3d1e69451de8c654eae8d75844b840ab99bb1c2`.
- Ed25519 signature verified directly over downloaded live HTTPS bytes against `CDC23D8CC8DA5397`. Zero stale CDN responses observed.

---

## 16. Public Desktop `v1.0.7` Compatibility

Verified against isolated installed **Public Desktop `v1.0.7`** with **ZERO staging URL override** (`G332-LIVE-02`..`G332-LIVE-06` and `G332-PRE-01`..`G332-PRE-03`):
- Fetches live `https://toridownload.xyz/assets/tools/tools-manifest.json` (`rev 2`), verifies legacy Ed25519 signature (`CDC23D8CC8DA5397`), accepts `rev 2`, detects FFmpeg & FFprobe `N-129150-g7ddf7bc8a4-20261120`, rejects tampered bytes fail-closed, and executes full download/activation/media-processing/rollback/reapply cleanly.

---

## 17. Local Desktop `v1.0.8-rc` Compatibility

Verified against isolated installed **Desktop `v1.0.8-rc`** with **ZERO staging URL override** (`G332-LIVE-07`, `G332-PRE-04`..`G332-PRE-12`):
- Fetches and verifies live production `rev 2` (`verification_status: "verified"`, `current_revision: 2`, `signing_key_id: "CDC23D8CC8DA5397"`, `signing_key_purpose: "external_tools_legacy_shared"`, `expires_at: "2027-01-21T19:46:42.049Z"`).
- Requires no dedicated-only signature while enforcing all Stage 1 dual-key boundaries (rejecting unknown keys, wrong-purpose `desktop_app_updater` keys, expired/future-dated metadata, lower-revision replay, and same-revision equivocation).
- Bundled fallback preserved (`source: "bundled"` before manual update).

---

## 18. FFmpeg Live Update Test (`G332-LIVE-03`, `G332-LIVE-04`, `G332-LIVE-06`)

- **Live Download & Activation (`G332-LIVE-03`):** Public Desktop `v1.0.7` downloaded `ffmpeg-N-129150-g7ddf7bc8a4-win64-gpl.zip` (`205,445,856` B) over live HTTPS in `313,988 ms`, verified exact SHA-256 `03d33066...`, verified Windows x64 PE32+ and version parity, and activated `target/gate33_2_qa/live_v107_data/tools/versions/ffmpeg/N-129150-g7ddf7bc8a4-20261120/ffmpeg.exe` (`source: "managed"`).
- **Live Media Processing (`G332-LIVE-04`):** Activated managed `ffmpeg.exe` encoded H.264/AAC MP4 (`17,975` B) and remuxed to MKV (`17,093` B) cleanly (exit `0`).

---

## 19. FFprobe Live Update Test (`G332-LIVE-03`, `G332-LIVE-04`, `G332-LIVE-06`)

- Activated simultaneously with FFmpeg at `target/gate33_2_qa/live_v107_data/tools/versions/ffmpeg/N-129150-g7ddf7bc8a4-20261120/ffprobe.exe` (`installed_version: "N-129150-g7ddf7bc8a4-20261120"`, `source: "managed"`).
- Executed `-print_format json -show_streams -show_format` on the generated MKV, confirming `2` valid streams (`h264` + `aac`).

---

## 20. Atomic Activation, Rollback, Reapply & Bundled Fallback

- **Atomic Activation (`G332-LIVE-03`):** Both `ffmpeg` and `ffprobe` transitioned atomically from `bundled` (`N-126374-g089a48eb36-20260831`) to `managed` (`N-129150-g7ddf7bc8a4-20261120`).
- **Atomic Rollback (`G332-LIVE-05`):** Single `rollback_external_tool({ toolId: 'ffmpeg' })` reverted **both** `ffmpeg` and `ffprobe` atomically in `1,869 ms` back to bundled `N-126374-g089a48eb36-20260831` (`update_status: "rolled_back"`).
- **Reapply (`G332-LIVE-06`):** Subsequent `update_external_tool({ toolId: 'ffmpeg' })` (`285,539 ms`) cleanly reactivated both managed `ffmpeg` and `ffprobe` (`N-129150-g7ddf7bc8a4-20261120`).
- **Bundled Fallback:** Verified in `G332-LIVE-07` and `external_tools_updater_tests` (`11/11 PASS`, including `test_32_gate32_1_missing_ffprobe_corrupt_ffmpeg_and_failed_auto_rollback_fallback`).

---

## 21. Expiry Monitor Deployment (Phase 9)

Deployed strictly the 8 read-only monitoring & immutable registry files onto the remote default branch **`master`** of `robijoychakma375-hash/tori-download-manager` using an isolated detached worktree (zero `v1.0.8` app code on `master`, zero movement of tag `v1.0.7`):
- **Default Branch Commit (`master`):** `62715926785da3fd7da811da997279931cc5cad0` (parent `2f8ae10b6065d4b58e3d889ceaef6dcde0aa4aaa`)
- **Files Deployed on `master`:**
  - `.github/workflows/tools-manifest-expiry-monitor.yml` (`permissions: contents: read`, zero signing secrets)
  - `scripts/monitor_tools_manifest_expiry.js`
  - `docs/security/manifest_expiry_monitoring_config.json`
  - `docs/security/tools-manifest-registry/registry.json`
  - `docs/security/tools-manifest-registry/history/prod_rev_0001_tools-manifest.json` (+ `.sig`)
  - `docs/security/tools-manifest-registry/history/prod_rev_0002_tools-manifest.json` (+ `.sig`)
- **Registered GitHub Actions Workflow ID:** `427101855` (`state: "active"`)

---

## 22. GitHub Actions Manual Run Evidence (Phase 9 & Phase 10)

Triggered real `workflow_dispatch` on `master` with `strict_exit: true`:
- **Run ID:** **`45063316490`** (`run_number: 1`)
- **URL:** `https://github.com/robijoychakma375-hash/tori-download-manager/actions/runs/45063316490`
- **Timestamps (UTC):** `2026-11-22T19:53:43Z` → `2026-11-22T19:54:01Z`
- **Status / Conclusion:** `completed` / **`success`**
- **Uploaded Auditable Artifact (`tools-manifest-expiry-monitor-report/ci_expiry_report.json`):**
  ```json
  {
    "status": "OK",
    "nowUtc": "2026-11-22T19:53:57.448Z",
    "manifestUrl": "https://toridownload.xyz/assets/tools/tools-manifest.json",
    "manifestRevision": 2,
    "manifestSha256": "caa2d4ed2a7e424badcd8662e67b986a3fdfbf2847dded0625ea2b2547663f3a",
    "signatureValid": true,
    "expiry": { "level": "HEALTHY", "remainingHours": 1439.88, "remainingDays": 59.99 },
    "effectiveAlertLevel": "HEALTHY",
    "emitAlert": false,
    "anomalies": []
  }
  ```

---

## 23. Scheduled Monitoring Status

- **Workflow State on Default Branch (`master`):** `active` (cron `"0 6 * * *"` daily at `06:00 UTC`).
- **Next Scheduled Run (UTC):** `2026-11-23T06:00:00Z`.
- **Honest Observation Distinction:** The workflow is **ENABLED AND VERIFIED VIA MANUAL `workflow_dispatch` (`45063316490`)**; the first autonomous future cron-scheduled trigger has **not yet occurred** (scheduled for `06:00 UTC`).

---

## 24. Immutable Registry Update (Phase 11)

Updated `docs/security/tools-manifest-registry/registry.json` (`active_revision: 2`) while preserving `rev 1` verbatim:
- **`rev 1`:** Marked `publication_status: "superseded"`, `superseded_by_revision: 2`; `prod_rev_0001_tools-manifest.json` (`9fa61a38...`) and `.sig` (`e0e23db7...`) completely unmodified.
- **`rev 2`:** Appended as `publication_status: "active"`, `supersedes_revision: 1`, `rollback_eligible: true`, `website_commit: "2eff4f20a64989c39a75cb6b1739ce3948431048"`, `cloudflare_deployment_id: "449b84d7-4ec8-4a63-b0ec-5f7d3a6a7ebe"`, `approval_reference: "TORI-APPROVAL-G33_2-PROD-REV2"`, archiving exact bytes in `docs/security/tools-manifest-registry/history/prod_rev_0002_tools-manifest.json` and `.sig`.

---

## 25. Security Regression Results

| Security Suite | Result | Details |
|---|---|---|
| `verify_gate33_2_production_manifest_renewal.js --pre-publish` | **`14/14 PASS`** | All 20 Phase 6 checks: `v1.0.7` & `v1.0.8-rc` rev 1/rev 2 acceptance, tamper, unknown key, wrong-purpose key, expired, future-dated, anti-replay, anti-equivocation, emergency rev 3 rollback |
| `verify_gate33_1_expiry_monitor_matrix.js` | **`18/18 PASS`** | All 18 expiry, redirect, clock-skew, drift, approval-token & outage failure scenarios |
| `verify_gate33_renewal_and_security.js` | **`14/14 PASS`** | Live rev 2 + immutable rev 1 check, monotonicity, TTL bounds, lock, dual-auth guard, zero secret leaks, Authenticode fail-closed |
| `cargo test -p tdm-core --test updater_cryptography_tests` | **`9/9 PASS`** | Ed25519 verification for v1.0.5/1.0.6/1.0.7/1.0.8-rc + tamper/corrupt rejection |
| `cargo test -p tdm-core --test external_tools_security_matrix_tests` | **`4/4 PASS`** | Keyring separation, purpose enforcement, revocation, anti-trust-escalation |
| `cargo test -p tdm-core --test external_tools_updater_tests` | **`11/11 PASS`** | OpenPGP/Ed25519 verification, zip limits, auto-rollback, quarantine, active-usage deferral |

---

## 26. Functional Regression Results

| Functional Suite | Result | Details |
|---|---|---|
| `verify_gate33_2_production_manifest_renewal.js --post-publish` | **`9/9 PASS`** | Live HTTPS rev 2, real 196 MiB FFmpeg/FFprobe download, SHA-256, activation, transcode, rollback, reapply, `v1.0.8-rc` live check |
| `verify_gate32_3_public_release.js --post-release` | **`14/14 PASS`** | Live GitHub `v1.0.7`, `latest.json`, `rev 2` prod manifest, Companion `v1.0.10`, `toridownload.xyz` Desktop & Mobile, physical upgrade |
| `verify_gate32_1_remote_manifest.js` | **`19/19 PASS`** | Live HTTPS staging signed manifest |
| `verify_gate32_external_tools_updater.js` | **`18/18 PASS`** | External Tools Manager end-to-end |
| `verify_gate31_5_install_repair_and_preflight.js` | **`23/23 PASS`** | Installation & Native Messaging safety |
| `verify_gate29_4_final_integration.js` | **`18/18 PASS`** | Full integration, crash recovery, live YouTube 360p/720p/1080p/audio/playlist & Firefox capture |
| Prior Gate 33.1 Core Rust Workspace (no Rust/UI edits in Gate 33.2) | **`270/276 PASS`** (clippy `0 errors`, UI lint/build `0 errors`) | 270/270 deterministic local/core/security/crypto/tools/protocol tests passed; 6 external live-YouTube tests noted as externally rate-limited by YouTube's unauthenticated anti-bot prompt in Gate 33.1 (while Gate 29.4 live YouTube passed 18/18 during Gate 33.2). |

---

## 27. User Data Preservation (Phase 13)

Verified across every isolated suite (`G332-PRE-14`, `G332-LIVE-09`, `G323-14`, `G294-SAFETY-DB`, `G294-SAFETY-REG`):
- **OEM Installed Desktop `v1.0.6` Binary:** Byte-identical SHA-256 `570833b379668f64d8f0a81e0a2c138635835e0c0382f37f24ec969caccf0fda`.
- **Production SQLite Database:** `PRAGMA integrity_check = ok`, `42` downloads, `355` chunks, `5` protected settings, `11` `.tdm-part` files — 100% unchanged.
- **Windows Registry & Native Messaging:** Restored with 100% parity (`regOk=true`).

---

## 28. Browser Companion Preservation

Verified live (`G323-06`, `G323-12`, `G332-PRE-13`):
- GitHub `extension-v1.0.10` (`451270856`), website download links, Firefox signed XPI (`a93a43872d224426902c49e217e31b2c603263d8c260c429940539b34b2852b8`, `application/x-xpinstall`), and Chromium ZIP (`f220fab2e26fd54ef7f85fd7e40613faad79e7f9a7f44fadf228ccd0edcc22f1`) remain 100% unchanged.

---

## 29. Desktop Public Release Preservation (Phase 15)

Verified live (`G323-01`..`G323-04`, `G332-LIVE-08`):
- GitHub Latest Stable: `v1.0.7` (Release ID `454278227`, commit `84da0c08256d6abaca253b5612010034237c86f9`, installer SHA-256 `142e4528...`).
- Public `latest.json`: `1.0.7`.
- Website (`https://toridownload.xyz`): Desktop `v1.0.7`, Companion `v1.0.10`, zero references to `1.0.8`.
- Desktop `v1.0.8`: remains **UNPUBLISHED**.

---

## 30. Rollback Readiness (Phase 12)

- **Anti-Replay-Safe Emergency Recovery Plan (`rev 3`):** Generated & verified offline via:
  ```powershell
  node scripts\renew_trusted_tools_manifest.js --rollback-plan --offline --target-revision 1 --revision 3 --out-dir target\gate33_2_qa\emergency_rev3_plan
  ```
  Output: `status: "ROLLBACK_PLAN_READY_UNPUBLISHED"`, `antiReplayPreserved: true`, `previousHighestRevision: 2`, `emergencyRollbackRevision: 3`, `allowRollbackTo: true`, `restoringArtifactSha256: "03d33066832e7149a8577bed73713c5d5344aed14199063e521b798cf1b60076"`.
- **Client Verification:** Both `G332-PRE-12` and `G33S-12` confirmed higher-revision signed rollback acceptance without breaking monotonic anti-replay protection.
- **Pre-Renewal Out-of-Repo Backup:** Preserved intact at `C:\Users\ritud\.tori-release-backups\gate33_2_pre_renewal\`.
- **Production Rollback Triggered:** **NO** (deployment succeeded cleanly on first attempt with zero incidents).

---

## 31. Known Limitations

1. **Dedicated Production External Tools Key (`PRODUCTION_KEY_PROVISIONING_PENDING`):** Intentional in Gate 33.2; `rev 2` uses existing approved legacy key `CDC23D8CC8DA5397` for `v1.0.7` backward compatibility. Dedicated key provisioning awaits interactive operator custody ahead of Gate 33.3.
2. **First Scheduled Cron Observation:** GitHub Actions expiry monitor is active on `master` and verified via manual `workflow_dispatch` Run `45063316490`, while its first autonomous daily `06:00 UTC` scheduled run will occur on `2026-11-23T06:00:00Z`.
3. **Windows Authenticode & Clean Windows 10/11 VMs:** Unchanged from Gate 33.1 (`NotSigned` / `NOT TESTED`); neither applies to this metadata-only manifest renewal.
4. **External Live-YouTube Anti-Bot Rate Limit:** Noted transparently from Gate 33.1's unauthenticated Rust workspace run (6 external live-YouTube tests), while Gate 29.4 live YouTube extraction & downloads passed `18/18` during Gate 33.2.

---

## 32. Unresolved Blockers

**NONE for Gate 33.2.** All 22 Gate 33.2 acceptance criteria passed without exception.

---

## 33. Final Verdict

**`GO`**

---

## 34. Next Recommended Gate

**Gate 33.3 — Dedicated External Tools Key Custody Provisioning & Authorized Desktop `v1.0.8` Public Stable Release** (interactive operator provisioning of `tori-tools.key`, embedding dedicated public key into `crates/tdm-core/src/tools/trust.rs`, rebuilding/signing final `v1.0.8`, clean Windows VM QA or owner limitation acceptance, and two-phase GitHub + `toridownload.xyz` publication), followed by **Gate 33.4** (Dedicated-Key Cutover once `v1.0.8+` fleet adoption threshold is confirmed).
