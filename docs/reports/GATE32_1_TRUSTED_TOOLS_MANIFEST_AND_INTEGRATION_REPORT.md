# TORI Download Manager — Gate 32.1 Report
# Trusted Tools Manifest Infrastructure & Final Integration Hardening

**Date:** 2026-11-21
**Development Branch:** `feat/gate32-external-tools-updater`
**Baseline Checkpoint:** `checkpoint-gate32-verified` (`dd9e22e5a3324c2e8fafcf63a0acba9bf53e6b5c`)
**Pre-Gate Safety Tag:** `checkpoint-gate32_1-before-manifest-infrastructure`
**Public Desktop Release (UNCHANGED):** `v1.0.6` (GitHub Release ID `453599579`)
**Public Browser Companion (UNCHANGED):** `v1.0.10` (GitHub Release ID `451270856`)
**Public Desktop Release Performed in Gate 32.1:** **NO (NOT PERFORMED)**

---

## 1. Executive Summary

Gate 32.1 completes and hardens the **Independent External Tools Auto-Update Manager** introduced in Gate 32 so that **FFmpeg and FFprobe** can be safely, atomically, and unattendedly updated over real HTTPS using a maintainer-controlled **Ed25519-signed tools manifest (`schema_version: 2`)**, while keeping **yt-dlp**'s independent RFC 4880 V4 OpenPGP RSA-4096 updater intact and genuinely resolving the Gate 29.4 `G294-SAFETY-DB` false-negative database safety check.

### High-Level Outcomes

| Area | Result | Evidence |
|---|---|---|
| Trusted FFmpeg Source & Provenance Review | **PASS** | `BtbN/FFmpeg-Builds` immutable dated tag `autobuild-2026-11-20-12-40` (`N-129150-g7ddf7bc8a4-20261120`), exact SHA-256 verified against GitHub digest + `checksums.sha256`; honest absence of upstream publisher signature documented |
| Signed Manifest Schema v2 + Ed25519 Verification | **PASS** | Exact-bytes Minisign Ed25519 signature verification (`CDC23D8CC8DA5397`) before JSON parsing; duplicate-key rejection; expiry, future-date, `signing_key_id`, TORI version bounds, and monotonic `manifest_revision` anti-replay |
| Out-of-Repo Signing Key Protection | **PASS** | Signed via out-of-repo `%USERPROFILE%\.tori-keys\tori-updater.key` (`cargo tauri signer sign`); zero private keys or passphrases committed, printed, logged, or embedded |
| Real HTTPS Hosting (Staging) | **PASS** | Immutable 195.93 MiB ZIP hosted on isolated GitHub prerelease `tools-ffmpeg-N-129150-g7ddf7bc8a4` (`prerelease=true, make_latest=false`); signed manifest & `.sig` live on Cloudflare Pages `https://toridownload.xyz/assets/tools/staging/tools-manifest.json` + `.sig` |
| Real Remote HTTPS FFmpeg + FFprobe Update | **PASS** | Isolated Desktop verified live HTTPS staging manifest with embedded production key `CDC23D8CC8DA5397`, downloaded real `205,445,856`-byte ZIP over HTTPS, verified SHA-256 + size + PE32+ x64 + live media self-test, and atomically switched bundled `N-126374` → managed `N-129150` (`19/19 PASS`) |
| Full FFmpeg/FFprobe & YouTube Compatibility | **PASS** | Verified demuxers/muxers, H.264/AAC/Opus/VP9/AV1, MP4/MKV remux, metadata preservation, HLS segment remux, FFprobe JSON, real YouTube video+audio merge (`18.95s`), audio-only (`19.06s`), and playlist resolution |
| Atomic Rollback, Reapply & Emergency Signed Rollback | **PASS** | Manual rollback reverts BOTH `ffmpeg` & `ffprobe` together (`N-129150` → `N-126374`) + live HTTPS reapply succeeds; emergency higher-revision signed rollback (`allow_rollback_to: true`) and failed auto-rollback bundled fallback verified in automated tests |
| Gate 29.4 `G294-SAFETY-DB` Fix | **PASS** | Root-cause WAL checkpoint / pre-pause timing race resolved via WAL-safe logical SQLite + `.tdm-part` snapshot helper in `scripts/lib/qa_oem_state_guard.js`; Gate 29.4 now passes **18 PASS, 0 FAIL** |
| Full Post-Edit TORI Regression Matrix | **PASS** | Rust workspace **270/270**, Clippy `0` errors, UI lint/build `0` errors, Gate 32.1 (`19/19`), Gate 32 (`18/18`), Gate 29.1 (`20/20`), Gate 29.2 (`17/17`), Gate 29.4 (`18/18`), Gate 31.4 (`15/15`), Gate 31.5 (`23/23`), Gate 31.6 (`13/13`) |
| Public Desktop `v1.0.6` & Companion `v1.0.10` Preservation | **PASS** | Verified untouched live on GitHub, `latest.json`, `toridownload.xyz`, and local OEM Windows installation (`13/13 PASS` in Gate 31.6 live audit) |

---

## 2. Pre-Gate 32.1 Safety Checkpoint & Environment Audit

Before modifying any source code or staging infrastructure:

1. Confirmed main repository (`F:\TORI\final tori download manager`) on branch `feat/gate32-external-tools-updater` at verified Gate 32 commit `dd9e22e5a3324c2e8fafcf63a0acba9bf53e6b5c` (`checkpoint-gate32-verified`) with a clean working tree.
2. Created local annotated safety tag **`checkpoint-gate32_1-before-manifest-infrastructure`** at `dd9e22e5a3324c2e8fafcf63a0acba9bf53e6b5c`.
3. Confirmed website repository (`C:\Users\ritud\Downloads\tori-website`) clean on `main` at `6b3945344838a52ae0f9372b727b4d446dac2ec3` (Desktop `v1.0.6`, Browser Companion `v1.0.10`).
4. Confirmed out-of-repo production signing key files exist at `%USERPROFILE%\.tori-keys\` (`tori-updater.key`, `tori-updater.key.pub` with key ID `CDC23D8CC8DA5397`, `tori-updater.key.pwd`) and `cargo tauri --version` = `tauri-cli 2.11.4`.
5. Audited live production SQLite database (`%APPDATA%\tori-download-manager\tdm_storage.sqlite`): `PRAGMA integrity_check = ok`, `42` downloads, `355` chunks, `4` protected `engine_settings` keys, `11` `.tdm-part` partial files.

---

## 3. Trusted FFmpeg Provider Evaluation & Provenance Review

### Upstream Candidate Evaluation

| Provider | Distribution Model | Windows x64 Static GPL Compatibility | Upstream Cryptographic Signature | Verdict |
|---|---|---|---|---|
| **`BtbN/FFmpeg-Builds`** (Selected) | GitHub Actions reproducible builds from official `FFmpeg/FFmpeg` master & release branches; immutable dated release tags (`autobuild-YYYY-MM-DD-HH-MM`) + `checksums.sha256` + GitHub asset digests | **Exact match** to TORI's bundled `N-126374-g089a48eb36-20260831` (`win64-gpl.zip`, includes `ffmpeg.exe` + `ffprobe.exe`, `libx264`, `aac`, `opus`, `vp9`, `av1`, `mp4`, `matroska`, `hls`, `mpegts`) | **NONE** (HTTPS + SHA-256 checksums only) | **Selected as reviewed upstream source** — strictly gated behind TORI compatibility verification and TORI Ed25519 manifest signature |
| `gyan.dev` (`ffmpeg-release-essentials.zip`) | Direct HTTPS hosting on `www.gyan.dev` (`9.1` release + `.sha256` file) | Compatible static Windows x64 builds, but non-GitHub single-server hosting without immutable per-build release API metadata | **NONE** (HTTPS + `.sha256` file only) | Evaluated as secondary reference; not used for primary manifest |

### Honest Trust Boundary & Provenance Record

- **Selected Upstream Release:** `BtbN/FFmpeg-Builds` immutable dated release `autobuild-2026-11-20-12-40`
- **Upstream Asset:** `ffmpeg-N-129150-g7ddf7bc8a4-win64-gpl.zip` (published `2026-11-20T12:42:05Z`, `2,776` FFmpeg commits newer than bundled `N-126374`)
- **Exact Archive Size:** `205,445,856` bytes (`195.93 MiB`)
- **Exact Archive SHA-256:** `03d33066832e7149a8577bed73713c5d5344aed14199063e521b798cf1b60076` (verified bit-for-bit against both GitHub API asset digest AND `checksums.sha256`)
- **Extracted Binary SHA-256 Digests:**
  - `ffmpeg.exe` (`N-129150-g7ddf7bc8a4-20261120`): `9b3e1007bb0edbd0aa5d3bddb6e3b95004f8a10fd74c6d4134bdb322a857685e`
  - `ffprobe.exe` (`N-129150-g7ddf7bc8a4-20261120`): `9d6f7fec9786feb8b8bec2d138ea8881aef8442c344cf392a4c115265e2fb38a`
- **Honest Limitation:** `BtbN/FFmpeg-Builds` does **not** publish a detached OpenPGP or Sigstore/Minisign publisher signature over its Windows ZIP builds. Therefore, TORI **never** installs directly from unsigned upstream BtbN URLs. Trust is established strictly by:
  1. Maintainer provenance review and bit-for-bit upstream SHA-256 verification (archive mirrored unmodified to preserve provenance auditability);
  2. Automated pre-publication Windows PE32+ x64 + real FFmpeg/FFprobe media compatibility verification;
  3. TORI maintainer Ed25519 signing (`CDC23D8CC8DA5397`) over exact serialized `tools-manifest.json` bytes;
  4. Client-side fail-closed Ed25519 verification, exact SHA-256 + byte-size verification, Zip-Slip/symlink/zip-bomb protection, PE32+ x64 verification, FFmpeg/FFprobe parity check, and live media self-test before atomic activation.

---

## 4. Production Signed Manifest Schema (Schema Version 2)

Implemented in `crates/tdm-core/src/tools/providers.rs` (`SignedToolsManifest`, `SignedManifestToolEntry`, `ManifestProvenance`) with full backward compatibility for `schema_version: 1`.

### Live Deployed Staging Manifest (`https://toridownload.xyz/assets/tools/staging/tools-manifest.json`)

```json
{
  "schema_version": 2,
  "manifest_revision": 1,
  "generated_at": "2026-11-21T13:26:00.821Z",
  "published_at": "2026-11-21T13:26:00.821Z",
  "expires_at": "2026-12-21T13:26:00.821Z",
  "signing_key_id": "CDC23D8CC8DA5397",
  "ffmpeg_bundle": {
    "tool_id": "ffmpeg_bundle",
    "version": "N-129150-g7ddf7bc8a4-20261120",
    "ffmpeg_version": "N-129150-g7ddf7bc8a4-20261120",
    "ffprobe_version": "N-129150-g7ddf7bc8a4-20261120",
    "bundle_id": "ffmpeg-win64-gpl-N-129150-g7ddf7bc8a4-20261120",
    "url": "https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/tools-ffmpeg-N-129150-g7ddf7bc8a4/ffmpeg-N-129150-g7ddf7bc8a4-win64-gpl.zip",
    "sha256": "03d33066832e7149a8577bed73713c5d5344aed14199063e521b798cf1b60076",
    "size": 205445856,
    "artifact_format": "zip",
    "platform": "windows",
    "architecture": "x86_64",
    "min_tori_version": "1.0.6",
    "max_tori_version": null,
    "published_at": "2026-11-21T13:26:00.821Z",
    "allow_rollback_to": false,
    "provenance": {
      "upstream_provider": "BtbN/FFmpeg-Builds",
      "upstream_release": "autobuild-2026-11-20-12-40",
      "upstream_url": "https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/tag/autobuild-2026-11-20-12-40",
      "approved_by": "TORI Release Engineering (Gate 32.1)",
      "approved_at": "2026-11-21T13:25:58.786Z"
    }
  }
}
```

### Mandatory Security & Freshness Enforcement Rules

1. **Exact-bytes Ed25519 signature verification BEFORE JSON parsing:** `verify_minisign_ed25519` verifies `.sig` over the raw downloaded byte slice `&manifest_bytes`.
2. **Duplicate JSON key & trailing garbage rejection:** `reject_duplicate_json_keys` uses a strict streaming serde `Deserializer` to reject shadowed/duplicate keys at any nesting depth before deserialization.
3. **Key ID binding:** `extract_minisign_key_id_hex` verifies both configured `expected_manifest_key_id` (`CDC23D8CC8DA5397`) and the manifest's declared `signing_key_id`.
4. **Freshness & clock-skew protection (`±15 min` default):** Rejects expired manifests (`now > expires_at + skew`), future-dated manifests (`published_at > now + skew`), and invalid windows (`expires_at <= published_at`).
5. **Monotonic anti-replay & equivocation protection:** Persists `ManifestAntiReplayState` in SQLite `engine_settings["external_tools_manifest_state"]` (`highest_accepted_revision`, `last_accepted_manifest_sha256`, `last_accepted_published_at`, `last_accepted_at`, `last_signing_key_id`). Rejects any `manifest_revision < highest_accepted_revision`, AND rejects any `manifest_revision == highest_accepted_revision` whose raw SHA-256 bytes changed without incrementing revision.
6. **TORI Desktop version bounds:** Enforces `min_tori_version <= current_tori_version <= max_tori_version` via `compare_semver_versions`.
7. **Anti-downgrade + safe emergency rollback:** Rejects `VersionComparison::Older` unless `allow_rollback_to == true` **AND** `manifest_revision > highest_accepted_revision` **AND** signature is `ToriEd25519ManifestVerified`.
8. **Exact artifact byte size + SHA-256 + PE32+ x64 + ZIP safety:** Enforces exact `size` equality against signed metadata, streaming SHA-256 verification, Zip-Slip/absolute/drive/symlink/zip-bomb rejection, and Windows PE32+ x86_64 validation.
9. **Cloudflare Pages SPA fallback handling:** Because `toridownload.xyz` serves HTTP `200 text/html` (`index.html`) for unpublished paths, `fetch_signed_tools_manifest` classifies `text/html` HTML documents cleanly as `NotPublishedYet` (so unpublished production endpoints degrade gracefully without false security alarms), while any JSON manifest with a missing (404), malformed, or mismatched `.sig` fails strictly closed as `RejectedSecurity`.

---

## 5. Signing Key Policy & Private Key Hygiene

- **Active Signing Key:** Out-of-repo production Ed25519 Minisign key at `%USERPROFILE%\.tori-keys\tori-updater.key` (public key ID **`CDC23D8CC8DA5397`**).
- **Architectural Separation Readiness:** `ToolsManagerConfig` stores `tori_manifest_pubkey_b64` and `expected_manifest_key_id` independently of `src-tauri/tauri.conf.json`'s Tauri desktop updater configuration, enabling zero-refactor cryptographic separation to a dedicated `tori-tools.key` whenever the operator authorizes key generation.
- **Private Key Exposure Audit:**
  - Verified zero private keys, `.key` files, `.pwd` files, or passphrases exist anywhere inside `F:\TORI\final tori download manager` or `C:\Users\ritud\Downloads\tori-website`.
  - `scripts/publish_trusted_tools_manifest.js` reads `%USERPROFILE%\.tori-keys\tori-updater.key.pwd` solely in memory to invoke `cargo tauri signer sign` and never prints, logs, or writes credentials to disk.

---

## 6. Artifact Hosting Architecture & Live Staging Deployment

### Hosting Decision & Cloudflare Pages 25 MiB Constraint

`C:\Users\ritud\Downloads\tori-website\DEPLOYMENT.md` documents that Cloudflare Pages publishes static files from `public/` (`assets/` copied directly) with a **25 MiB per-file limit**:

- **Signed Manifests (`< 4 KiB`):** Hosted on **Cloudflare Pages** (`https://toridownload.xyz/assets/tools/staging/tools-manifest.json` and `.sig`) with explicit `_headers` rules (`X-Content-Type-Options: nosniff`, `Cache-Control: no-cache, must-revalidate` for staging, `max-age=300` for future production).
- **Large Immutable FFmpeg/FFprobe ZIP Artifacts (`205.45 MiB`):** Hosted on **GitHub Releases** as an isolated **non-latest prerelease** (`prerelease: true, make_latest: "false"`, tag `tools-ffmpeg-N-129150-g7ddf7bc8a4`, Release ID `453686141`) on `robijoychakma375-hash/tori-download-manager` (GitHub supports up to `2 GiB` per file and `github.com` / `release-assets.githubusercontent.com` are already in TORI's strict HTTPS allowlist).

### Live Staging Endpoints Verified

| Resource | Live HTTPS URL | HTTP Status | Exact SHA-256 |
|---|---|---|---|
| Staging Manifest (rev 1) | `https://toridownload.xyz/assets/tools/staging/tools-manifest.json` | `200 OK` | `587e83d9b4ffe2e362d21321e4c0be5026df1beba1201440ef4462ca6339437e` |
| Staging Ed25519 Signature | `https://toridownload.xyz/assets/tools/staging/tools-manifest.json.sig` | `200 OK` | `5ba19899788ea7d1f598267a81f7d7e19de7890124c03304c0702bd93b82e1b5` |
| Immutable FFmpeg ZIP (`205,445,856 B`) | `https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/tools-ffmpeg-N-129150-g7ddf7bc8a4/ffmpeg-N-129150-g7ddf7bc8a4-win64-gpl.zip` | `200 OK` | `03d33066832e7149a8577bed73713c5d5344aed14199063e521b798cf1b60076` |
| Website Staging Commit | `robijoychakma375-hash/tori-website-private` `main` | `8cd035f1df0e6bd486db001340c001e1fa42ce4e` | Only `assets/tools/staging/tools-manifest.json`, `.sig`, and `_headers` modified (`index.html`, `sitemap.xml`, `robots.txt` untouched) |

**Production Endpoint Status:** `https://toridownload.xyz/assets/tools/tools-manifest.json` is **deliberately NOT deployed** in Gate 32.1 so existing public Desktop `v1.0.6` users remain completely unaffected until an authorized production promotion gate.

---

## 7. Real-World Reliability Hardening Discovered During Live HTTPS Testing

During live HTTPS testing of the `205.45 MiB` GitHub CDN archive over a ~340–410 KB/s link, `reqwest`'s `.timeout(600s)` fired as a total-request deadline at `600.12s`, aborting a healthy active transfer. Gate 32.1 resolved this production reliability defect cleanly:

- **`crates/tdm-core/src/tools/types.rs`:** Increased `download_timeout_secs` from `600` to `1800` (30 minutes) while keeping metadata `http_timeout_secs: 20`.
- **`crates/tdm-core/src/tools/trust.rs`:** Added per-chunk `.read_timeout(timeout_secs.min(90).max(1))` so genuinely stalled connections fail rapidly while healthy large downloads succeed.
- **`crates/tdm-core/src/tools/staging.rs`:** Added transparent HTTP `Range: bytes=<downloaded>-` resume (up to 3 attempts on transient TCP/CDN drops or premature EOF for non-loopback HTTPS), while preserving strict single-attempt fail-closed semantics on loopback fault-injection tests and strict final byte-size + SHA-256 verification.
- **`crates/tdm-core/src/tools/activation.rs`:** Hardened `acquire_lease` so `resolve_tool_locked` runs inside the same read lock guard as `lease_counter.fetch_add(1)`, eliminating any theoretical interleaving window between path resolution and atomic swap.

---

## 8. Live Remote HTTPS End-to-End Verification Results (`verify_gate32_1_remote_manifest.js`)

Executed against the freshly compiled isolated Desktop binary (`target/release/tori-download-manager.exe`) configured with `TORI_TEST_TOOLS_MANIFEST_URL=https://toridownload.xyz/assets/tools/staging/tools-manifest.json` and **no test public key override** (strictly verifying against embedded production Ed25519 key `CDC23D8CC8DA5397`):

**Result: `19 PASS, 0 FAIL`**

| Check ID | Verification Scope | Observed Result |
|---|---|---|
| `G321-01` | Initial bundled tool detection | **PASS** — `yt-dlp=2026.08.19`, `ffmpeg=N-126374-g089a48eb36-20260831`, `ffprobe=N-126374-g089a48eb36-20260831` (`source=bundled`) |
| `G321-02` | Non-blocking startup & Gate 32 default policy | **PASS** — `startupMs=744`, `idleWsMb=376.76`, `auto_update=true`, `24h`, `auto_install=true`, `notify=true`, `defer=true` |
| `G321-03` | Live HTTPS manifest + `.sig` verification (`CDC23D8CC8DA5397`) | **PASS** — `checkMs=1451`, `ffmpegAvail=N-129150-g7ddf7bc8a4-20261120`, `ffprobeAvail=N-129150-g7ddf7bc8a4-20261120`, `ytdlpAvail=2026.10.26` |
| `G321-04` | Real remote HTTPS `205.45 MiB` FFmpeg/FFprobe download, verify, self-test & atomic switch | **PASS** — `elapsedMs=382505`, activated `N-129150-g7ddf7bc8a4-20261120` (`source=managed`, `rollback_available=true`) |
| `G321-05` | Anti-replay state persisted in SQLite | **PASS** — `highest_accepted_revision=1`, `last_signing_key_id=CDC23D8CC8DA5397`, exact manifest SHA-256 recorded |
| `G321-06` | `active-tools.json` & resolver parity for FFmpeg + FFprobe | **PASS** — both resolve to `...\tools\versions\ffmpeg\N-129150-g7ddf7bc8a4-20261120\` |
| `G321-07` | Full FFmpeg/FFprobe media compatibility matrix on remote `N-129150` | **PASS** — demuxers/muxers, H.264/AAC/Opus/VP9/AV1, MP4 (`36,626 B`), MKV (`35,279 B`), metadata preservation, HLS remux (`36,997 B`), FFprobe JSON |
| `G321-08` | `yt-dlp` live OpenPGP RSA-4096 update regression | **PASS** — `2026.08.19 -> 2026.10.26` (`elapsedMs=52197`, `source=managed`) |
| `G321-09` | Live YouTube metadata & format extraction | **PASS** — `"Me at the zoo"`, `17` formats resolved via managed `yt-dlp` |
| `G321-10` | Live YouTube video+audio download & FFmpeg merge | **PASS** — `completed`, `duration=18.947s`, `size=631,958 B`, verified playable by managed `ffprobe` `N-129150` |
| `G321-11` | Live YouTube playlist resolution & audio-only extraction | **PASS** — `playlistItems=3`, audio `completed` (`duration=19.064s`) |
| `G321-12` | SQLite update history & History UI modal | **PASS** — recorded `tori_ed25519_manifest_verified` (`ffmpeg`) and `publisher_openpgp_verified` (`yt-dlp`) |
| `G321-13` | Atomic manual rollback (`N-129150 -> N-126374`) + media checks | **PASS** — BOTH `ffmpeg` & `ffprobe` reverted atomically to `bundled` `N-126374` and passed full media compatibility suite |
| `G321-14` | Reapply verified remote FFmpeg/FFprobe update over live HTTPS | **PASS** — cleanly re-activated `N-129150-g7ddf7bc8a4-20261120` |
| `G321-15` | `yt-dlp` manual rollback regression | **PASS** — cleanly restored `bundled` `2026.08.19` |
| `G321-16` | Performance & resource stability | **PASS** — `startupMs=744`, `idleWsMb=376.76`, `postUpdateWsMb=582.88`, `consoleCount=0` |
| `G321-17` | OEM Registry & Native Messaging parity | **PASS** — all 8 checks `true` |
| `G321-18` | OEM SQLite DB & `.tdm-part` preservation | **PASS** — `PRAGMA integrity_check=ok`, `rawFileSha256Match=true`, `42` downloads, `355` chunks, `4` protected settings, `11` `.tdm-part` files |
| `G321-19` | OEM installed `v1.0.6` binary untouched | **PASS** — `exeShaMatch=true` |

### Visual Evidence (Inspected Screenshots)

- `docs/reports/screenshots/gate32_1/gate32_1_01_live_staging_update_available_light.png` — Live HTTPS discovery showing `Update Available` for `yt-dlp` (`2026.10.26`), `FFmpeg` (`N-129150`), and `FFprobe` (`N-129150`).
- `docs/reports/screenshots/gate32_1/gate32_1_02_ffmpeg_updated_light.png` — Light theme after live HTTPS FFmpeg & FFprobe atomic activation (`Managed`, green `Updated` badges, enabled `Roll Back`, update banner).
- `docs/reports/screenshots/gate32_1/gate32_1_03_ffmpeg_updated_dark.png` — Dark theme parity after live HTTPS FFmpeg & FFprobe update.
- `docs/reports/screenshots/gate32_1/gate32_1_04_update_history_modal.png` — External Tools Update History modal showing both live `yt-dlp` and `ffmpeg` entries.
- `docs/reports/screenshots/gate32_1/gate32_1_05_ffmpeg_rolled_back.png` — Atomic rollback restoring BOTH `FFmpeg` & `FFprobe` to `Bundled` `N-126374` (`Rolled Back`) while keeping `yt-dlp` independently updated (`2026.10.26`).

---

## 9. Gate 29.4 `G294-SAFETY-DB` Root-Cause Investigation & Genuine Fix

### Root Cause Confirmed

In `scripts/verify_gate29_4_final_integration.js`, `initialOemDbHash = sha256File(OEM_DB_PATH)` was previously computed **before** pausing the running production `tori-download-manager.exe` (which operates SQLite in active WAL mode). Live browser companion heartbeats (`last_extension_ping`) and SQLite WAL checkpoints running between hash capture and process shutdown legitimately mutated raw `.sqlite` file bytes even when **zero user download rows, zero chunks, zero protected settings, and zero `.tdm-part` files changed**.

### Genuine Fix Implemented

1. Added `snapshotOemDatabase(dbPath)` and `compareOemDatabaseSnapshots(before, after)` to `scripts/lib/qa_oem_state_guard.js`:
   - Opens production SQLite strictly read-only (`mode=ro`) via Python `sqlite3`.
   - Verifies `PRAGMA integrity_check === ['ok']`.
   - Computes canonical sorted SHA-256 digests of **all** `downloads` rows, **all** `download_chunks` rows, **all** protected `engine_settings` rows (explicitly allowlisting only volatile operational keys `last_extension_ping` and `active_server_port`), and **all** existing `.tdm-part` partial files referenced by downloads, plus the raw `.sqlite` file SHA-256.
2. Updated `scripts/verify_gate29_4_final_integration.js` (and `scripts/verify_gate32_external_tools_updater.js`) to capture `before` strictly **after** pausing idle OEM Desktop and `after` strictly **before** restarting OEM Desktop.
3. **Result:** Gate 29.4 now genuinely passes **`18 PASS, 0 FAIL, 0 TIMEOUT, 0 NOT TESTED`**, with `G294-SAFETY-DB` confirming `beforeIntegrityOk=true`, `afterIntegrityOk=true`, `rawFileSha256Match=true`, `downloadsCount=42`, `chunksCount=355`, `protectedSettingsCount=4`, and `partFilesCount=11`.

---

## 10. Security, Anti-Replay & Failure Test Matrix (`external_tools_updater_tests.rs`)

All **11 integration tests** and **7 unit tests** pass (`0` failures), deterministically proving:

- Schema v2 valid manifest + `highest_accepted_revision` persistence
- Replayed older `manifest_revision` rejected (`SourceUntrusted`)
- Same `manifest_revision` with mutated bytes (equivocation) rejected (`SourceUntrusted`)
- Expired manifest (`expires_at` in past) rejected while active tools keep working
- Future-dated manifest (`published_at > now + 15m`) rejected
- Duplicate JSON keys (`{"manifest_revision":3,"manifest_revision":99}`) rejected despite valid signature
- Mismatched `signing_key_id` rejected
- Unsupported `schema_version` (`99`) rejected
- Missing `.sig` (`404`) and malformed base64 `.sig` rejected
- Incompatible `min_tori_version` (`9.9.9`) & `max_tori_version` (`1.0.5`) rejected
- Exact byte-size mismatch (`+1 byte`) rejected during staged download
- Untrusted `302` redirect (`https://evil.untrusted.example/...`) rejected by custom redirect policy
- Unauthorized downgrade (`allow_rollback_to: false`) rejected
- Authorized emergency signed rollback (`allow_rollback_to: true` + strictly higher `manifest_revision`) accepted
- Missing `ffprobe.exe` inside signed ZIP rejected
- Corrupted/failing `ffmpeg.exe` inside signed ZIP rejected
- FFmpeg/FFprobe version mismatch inside signed ZIP rejected
- Zip-Slip (`../`), Windows drive prefix (`C:/`), symlink (`0o120777`), and zip bomb rejected
- Active tool usage deferral (both `yt-dlp` and `FFmpeg`/`FFprobe` leases) + automatic promotion when idle
- Post-switch automatic rollback + quarantine of broken version
- Failed automatic rollback (missing previous managed binary) cleanly falls back to verified bundled binary for both `ffmpeg` and `ffprobe`
- Offline, HTTP timeout, HTTP 429 (`Retry-After`), HTTP 500 exponential backoff, truncated stream, wrong SHA-256, invalid OpenPGP signature, corrupted `active-tools.json` backup recovery, and locked Windows executable safety

---

## 11. Full Post-Final-Edit TORI Regression Results (Phase 20)

All 12 suites ran **after** the final code edit with **0 failures**:

| Suite | Command | Result |
|---|---|---|
| Rust Workspace Tests | `cargo test --workspace -j 2 --no-fail-fast` | **270 PASS, 0 FAIL, 0 IGNORED** |
| Rust Clippy | `cargo clippy --workspace --all-targets` | **0 ERRORS** (exit 0) |
| UI Lint & Production Build | `npm --prefix ui run lint` & `npm --prefix ui run build` | **0 ERRORS** (`371 ms` Vite build) |
| Emergency Rollback CLI Dry-Run | `publish_trusted_tools_manifest.js --rollback-manifest --revision 2 ...` | **PASS** (signed cleanly with `CDC23D8CC8DA5397`) |
| **Gate 32.1 Live Remote HTTPS Suite** | `node scripts\verify_gate32_1_remote_manifest.js` | **19 PASS, 0 FAIL** |
| Gate 32 Live External Tools Suite | `node scripts\verify_gate32_external_tools_updater.js` | **18 PASS, 0 FAIL** |
| Gate 29.1 IDM Desktop UI | `node scripts\verify_gate29_1_idm_desktop_ui.js` | **20 PASS, 0 FAIL** |
| Gate 29.2 IDM Progress Window | `node scripts\verify_gate29_2_idm_progress_window.js` | **17 PASS, 0 FAIL** |
| **Gate 29.4 Final Integration** | `node scripts\verify_gate29_4_final_integration.js` | **18 PASS, 0 FAIL, 0 TIMEOUT, 0 NOT TESTED** |
| Gate 31.4 Toast Replacement | `node scripts\verify_gate31_4_toast_replacement.js` | **15 PASS, 0 FAIL** |
| Gate 31.5 Installed v1.0.6 Preflight | `node scripts\verify_gate31_5_install_repair_and_preflight.js` | **23 PASS, 0 FAIL, 0 TIMEOUT, 0 NOT TESTED** |
| Gate 31.6 Live Public Release Audit | `node scripts\verify_gate31_6_live_release.js` | **13 PASS, 0 FAIL** |

---

## 12. Maintainer Operational Runbook (Phase 21)

### A. Routine FFmpeg/FFprobe Update Publication (Staging First)

1. Discover newest immutable dated `BtbN/FFmpeg-Builds` release:
   ```powershell
   node scripts/publish_trusted_tools_manifest.js --discover
   ```
2. Stage, verify SHA-256 + `checksums.sha256` + PE32+ x64 + full 7-check media compatibility suite locally:
   ```powershell
   node scripts/publish_trusted_tools_manifest.js --stage --release-tag <autobuild-YYYY-MM-DD-HH-MM>
   ```
3. Publish immutable ZIP to isolated GitHub prerelease (`prerelease=true, make_latest=false`), verify `releases/latest` untouched, sign schema v2 manifest with strictly incremented `--revision <N>`, and deploy to Cloudflare Pages staging:
   ```powershell
   node scripts/publish_trusted_tools_manifest.js --publish-staging --release-tag <autobuild-YYYY-MM-DD-HH-MM> --revision <N>
   ```
4. Validate end-to-end over real HTTPS using `node scripts/verify_gate32_1_remote_manifest.js` (must achieve `19/19 PASS`).

### B. Production Promotion (Authorized Release Gate Only)

Only after staging verification passes and operator authorization is granted:
1. Copy the verified `tools-manifest.json` and `tools-manifest.json.sig` from `assets/tools/staging/` to `assets/tools/` in `tori-website-private` (ensuring `manifest_revision` is strictly greater than any prior production revision).
2. Commit and push to `tori-website-private` `main`; verify live `200 OK` and exact SHA-256 at `https://toridownload.xyz/assets/tools/tools-manifest.json` and `.sig`.

### C. Emergency Rollback Procedure (Defective Tool Release)

Because clients enforce strictly monotonic anti-replay (`manifest_revision` can **never** decrease), **never** revert by re-serving an older manifest file! Instead:
1. Generate and sign a **strictly higher** `manifest_revision` (`prev + 1`) pointing to the previous known-good immutable GitHub artifact with `allow_rollback_to: true`:
   ```powershell
   node scripts/publish_trusted_tools_manifest.js --rollback-manifest `
     --revision <PREV_REV + 1> `
     --version <PREV_KNOWN_GOOD_VERSION> `
     --url <PREV_IMMUTABLE_GITHUB_ZIP_URL> `
     --sha256 <PREV_SHA256> `
     --size <PREV_BYTES>
   ```
2. Deploy the newly signed `tools-manifest.json` and `.sig` to `assets/tools/` and push to Cloudflare Pages.
3. Clients verify the higher-revision Ed25519 signature, observe `allow_rollback_to: true`, and safely revert to the previous known-good FFmpeg/FFprobe bundle atomically.

### D. Signing Key Rotation / Compromise Response

1. Generate a new out-of-repo Ed25519 keypair (`cargo tauri signer generate`) with a new 16-hex key ID.
2. Update `TORI_ED25519_PUBKEY_B64` and `TORI_ED25519_KEY_ID` in `crates/tdm-core/src/tools/trust.rs` and ship an emergency TORI Desktop release (with `tauri.conf.json` updated if rotating the shared key, or dedicated `tori-tools.key` if separating keys).
3. Remove or revoke the compromised manifest on Cloudflare Pages immediately and re-sign all active manifests with the new key ID.

---

## 13. Strict Verification Honesty Matrix

| Component / Capability | Status | Scope Verified |
|---|---|---|
| Schema v2 manifest + Ed25519 + anti-replay + anti-downgrade + emergency rollback + failed auto-rollback | **Implemented & Tested** | Rust unit & integration tests (`270/270 PASS`) |
| Live HTTPS staging manifest (`toridownload.xyz`) + `.sig` + immutable GitHub prerelease artifact (`205.45 MiB`) | **Deployed to Staging & Tested Over Real HTTPS** | `verify_gate32_1_remote_manifest.js` (`19/19 PASS`) with embedded production key `CDC23D8CC8DA5397` |
| Production manifest URL (`https://toridownload.xyz/assets/tools/tools-manifest.json`) | **NOT Deployed to Production** | Intentionally withheld until an authorized Desktop `v1.0.7` / tools-promotion gate so public `v1.0.6` stays untouched |
| Windows Authenticode signing | **Not Available** | Unchanged pre-existing limitation; documented honestly |
| Independent clean Windows VM test | **Not Performed** | All QA executed in strict host isolation (`TORI_DATA_DIR`, `WEBVIEW2_USER_DATA_FOLDER`, `QaOemStateGuard`) |
| Dedicated separate tools-only Ed25519 key (`tori-tools.key`) | **Deferred (Supported by Architecture)** | Gate 32.1 uses existing protected out-of-repo key `CDC23D8CC8DA5397` without rotation; config is decoupled for future separation |
| Upstream `BtbN/FFmpeg-Builds` publisher signature | **Not Provided Upstream** | Trust relies on maintainer provenance review, automated compatibility testing, and TORI Ed25519 manifest signature |

---

## 14. Remaining Blockers & Recommended Next Gate

- **Remaining Blockers for Gate 32.1:** **NONE.** All 15 Gate 32.1 acceptance criteria pass cleanly.
- **Recommended Next Gate:** **Gate 32.2 / Desktop v1.0.7 Release Preflight & Production Tools Manifest Promotion** — when the operator authorizes shipping the Gate 32 + Gate 32.1 External Tools Auto-Update Manager to public users, promote the verified staging manifest to `https://toridownload.xyz/assets/tools/tools-manifest.json` (and optionally generate a dedicated `tori-tools.key`), build the `v1.0.7-rc` NSIS installer + updater bundle, and run full release preflight.
