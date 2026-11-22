# TORI Download Manager — Release & External Tools Security Policy

**Policy ID:** `TORI-SEC-POLICY-v1`  
**Effective Scope:** Desktop Releases (`tori-download-manager`), Browser Companion (`extension-v*`), External Tools Signed Manifests (`toridownload.xyz/assets/tools/`), and Artifact Hosting (`robijoychakma375-hash/tori-download-manager` & `tori-website-private`).

---

## 1. Least-Privilege & Trust Separation Principles

1. **Cryptographic Domain Separation:** Desktop application auto-updates (`tauri-plugin-updater`), External Tools manifests (`TrustedToolsKeyring`), and upstream `yt-dlp` releases (pinned OpenPGP RSA-4096) are distinct trust domains. Keys scoped for one purpose MUST NOT verify another once Stage 3 migration completes.
2. **Client-Side Fail-Closed Default:** Clients verify exact raw bytes before JSON parsing, reject duplicate JSON keys, reject unknown/revoked/wrong-purpose keys, enforce monotonic `manifest_revision` anti-replay, enforce UTC expiration bounds, verify exact artifact byte size & SHA-256, and reject unsigned direct upstream FFmpeg binaries (`Source Untrusted`).
3. **Never Ship Signing Secrets to Clients or CI:** Private signing keys (`.key`), passphrases (`.pwd`), and Authenticode certificates NEVER live inside source repositories, client builds, public websites, or unprivileged CI runners.

## 2. Desktop Release Approval

- Every public Desktop release requires:
  1. Frozen release candidate directory (`release/vX.Y.Z-rc/`) with verified `SHA256SUMS.txt`.
  2. Full Rust workspace tests, Clippy (`0` errors), UI lint/build (`0` errors), and full TORI regression matrix passing with zero hidden skips.
  3. Two-phase GitHub release publication: draft upload -> remote re-download SHA-256 parity check -> explicit promotion to Latest Stable.
  4. Explicit project owner authorization before modifying GitHub Latest Stable, `latest.json`, or `toridownload.xyz`.

## 3. External Tools Update Approval

Two strictly separated operations exist — they MUST NEVER be conflated:
- **A. Metadata Renewal (Unchanged Approved Artifact):** Re-verifies immutable artifact availability, exact byte size, and exact SHA-256; strictly increments `manifest_revision`; sets bounded UTC expiration (`7–90` days); preserves artifact URL/hash/version; requires controlled operator signing & approval before production deployment.
- **B. New Binary Release Approval (e.g., New FFmpeg/FFprobe Build):** NEVER automated upon discovering a newer upstream build. Requires:
  1. Immutable dated upstream tag verification (`BtbN/FFmpeg-Builds` `autobuild-YYYY-MM-DD-HH-MM`).
  2. Bit-for-bit SHA-256 cross-check (`checksums.sha256` + GitHub API digest).
  3. Windows x86_64 PE32+ validation and GPLv3 / third-party license review.
  4. Full automated media compatibility matrix (demuxers, muxers, codecs, H.264/AAC MP4/MKV/HLS remux, FFprobe JSON).
  5. Mirroring unmodified archive to an isolated non-latest GitHub prerelease (`prerelease: true, make_latest: "false"`).
  6. Staging deployment + live HTTPS staging test pass.
  7. Explicit maintainer approval before production promotion.

## 4. Manifest Signing & Dedicated Key Custody

- Production keys reside solely in protected out-of-repo storage (`%USERPROFILE%\.tori-keys\` with restricted owner-only NTFS permissions) plus an encrypted offline backup.
- `tori-updater.key` (Desktop updater) and future `tori-tools.key` (External Tools manifest) use distinct keypairs, distinct key IDs, and distinct passphrases.
- Signing tools read passphrases into memory only and never emit secrets to stdout, stderr, JSON reports, or log files.

## 5. Artifact Provenance & Immutability

- Every approved production artifact and signed manifest is recorded append-only in `docs/security/tools-manifest-registry/registry.json` with verbatim archived signed manifests in `docs/security/tools-manifest-registry/history/`.
- Published immutable GitHub prerelease artifact assets (`tools-ffmpeg-*`) MUST NOT be overwritten in place; any new binary requires a new immutable tag.

## 6. Key Rotation & Expiration Policy

- Production manifests use bounded validity windows (`30–45` days recommended; hard bounds `7–90` days).
- Expiry monitoring tracks `30d` (Renewal Due), `14d` (Warning), `7d` (High-Priority Alert), `48h` (Critical Alert), and `<= 0` (Expired Incident).
- Scheduled monitoring prepares/validates proposals only; reaching an expiry threshold NEVER silently auto-signs or auto-deploys to production.
- Key rotations follow the staged dual-key transition specification (`TORI-SEC-G33-001`) so active client fleets are never stranded.

## 7. Emergency Rollback & Artifact Revocation

- Never revert by re-serving a lower `manifest_revision` (blocked by client anti-replay).
- Publish a strictly higher `manifest_revision` (`prev + 1`) pointing to the previous known-good immutable artifact from `registry.json` with `"allow_rollback_to": true`, signed by an active trusted key.
- For defective/compromised artifacts: (1) publish higher-revision emergency rollback manifest, (2) mark compromised entry `revoked` in `registry.json`, (3) unpublish/delete compromised GitHub prerelease artifact so fresh fetches fail, and (4) rely on client post-switch health-check quarantine + bundled fallback.

## 8. CI/CD, GitHub & Cloudflare Access Controls

- **GitHub (`tori-download-manager` & `tori-website-private`):**
  - Use fine-grained PATs or short-lived scoped tokens with minimum required permissions (`contents: write` only during authorized release windows; read-only tokens for monitoring).
  - Protect `main` / `master` branches; never force-push release tags (`v1.0.*`).
  - Never expose signing private keys to pull-request CI workflows.
- **Cloudflare Pages (`toridownload.xyz`):**
  - Deployments come exclusively from `tori-website-private` `main`.
  - `_headers` enforces `X-Content-Type-Options: nosniff`, `Cache-Control: no-cache, must-revalidate` on staging manifests, and `Cache-Control: public, max-age=300, must-revalidate` on production manifests.

## 9. Audit Logging, Secret Rotation & Incident Response

- All local manifest preparations, verifications, staging deployments, and production promotions write structured JSON audit artifacts (manifest SHA-256, signature SHA-256, key ID, revision, timestamp, approver — zero secrets).
- Rotate GitHub tokens on a 90-day cadence or immediately upon suspected exposure.
- **Incident Response Playbook Summary:**
  - *Dedicated `tori-tools.key` compromise:* Revoke key ID via authenticated Desktop update (`CDC23D8CC8DA5397`), introduce new `tori-tools` key, purge tainted manifest & artifact.
  - *Desktop updater key `CDC23D8CC8DA5397` compromise:* Immediately halt automated updates, generate new out-of-repo Desktop & Tools keypairs, publish security advisory + verified manual installer SHA-256s, revoke compromised key across all keyrings.
  - *GitHub / Cloudflare account compromise:* Revoke all tokens/sessions, enable hardware 2FA, audit commit/release/deployment logs against `docs/security/tools-manifest-registry/registry.json`, redeploy verified bytes from trusted offline backup.
