# TORI Download Manager Desktop v1.0.9 — Publication, Website Deployment & Rollback Runbook

**Target Release Tag:** `v1.0.9`  
**Target Tag Commit:** `b60770b1c5124a5a9e5b5c2b883e9a0ecd3fc308` (Gate 36.1 verified RC commit, or approved Gate 36.2 descendant with zero source changes)  
**Target Website:** `https://toridownload.xyz` (`robijoychakma375-hash/tori-website-private` → Cloudflare Pages)  
**Preserved Assets:** Desktop `v1.0.8` (GitHub ID `455125259`), Browser Companion `v1.0.11` (GitHub ID `458864802`), Production External Tools Manifest Revision 2 (`caa2d4ed2a7e424badcd8662e67b986a3fdfbf2847dded0625ea2b2547663f3a`)  
**Pre-Condition:** **DO NOT EXECUTE ANY REMOTE STEP BELOW UNTIL EXPLICIT SEPARATE PROJECT OWNER AUTHORIZATION AND RISK DISPOSITION (`RISK-36-01`, `RISK-36-02`, `RISK-36-03`) ARE GRANTED.**

---

## 1. Exact 16-Asset Release Inventory (`release/v1.0.9-public-staging/`)

Matches the established `v1.0.8` Desktop GitHub release contract (`16` assets; zero invented assets; zero secret files):

1. `TORI.Download.Manager_1.0.9_x64-setup.exe` (`118,170,722` B, SHA-256 `460f5da00d09267a5f33274645250d92162bbfa3605f0348cc656a39a8a19ead`)
2. `TORI.Download.Manager_1.0.9_x64-setup.exe.sig` (`436` B, SHA-256 `9fd6f9e8a46e93dd1e1f6212b9d174aba3cc23761c55704f2a407965cb385aa0`)
3. `latest.json` (UTF-8 no-BOM, `version: "1.0.9"`, exact `.sig` & dotted installer URL parity)
4. `tori-download-manager.exe` (`32,290,304` B, SHA-256 `94995ea2eae40ec9101dd9f5f08f64ff717662143e8db936aae650f7daf17442`)
5. `tdm-native-host.exe` (`19,449,344` B, SHA-256 `90cbb76fe03c42b03736df78262b3486068f410d604c664d5e22fd4c7247479f`)
6. `tdm-cli.exe` (`17,102,848` B, SHA-256 `f25c29376e27d3a1025bbc39d09bae273c21d1fa6da4b62f44e0eea93a6ac368`)
7. `SHA256SUMS.txt`
8. `RELEASE_NOTES_v1.0.9.md`
9. `INSTALLATION_AND_UPGRADE.md`
10. `BUILD_METADATA.json`
11. `RELEASE_MANIFEST.json`
12. `LICENSE`, `LICENSE-MIT`, `LICENSE-APACHE`, `LICENSE-GPLv3.txt`, `LICENSE-THIRD-PARTY.txt`

---

## 2. Phase A — Authorized GitHub Release Publication (`v1.0.9`)

### Step A1 — Mandatory Read-Only Dry-Run (Safe Anytime)
```powershell
Set-Location "F:\TORI\final tori download manager"
node scripts/publish_desktop_v1_0_9.js --dry-run
```
Verify: `remote_writes_performed: 0`, `asset_count: 16`, Ed25519 valid + tamper rejected, live `/releases/latest` == `v1.0.8` (`455125259`), `v1.0.9` not yet published, `extension-v1.0.11` intact (`458864802`).

### Step A2 — Create & Push Annotated Tag `v1.0.9` (Only After Owner Authorization)
```powershell
git tag -a v1.0.9 b60770b1c5124a5a9e5b5c2b883e9a0ecd3fc308 -m "TORI Download Manager Desktop v1.0.9 Stable Release"
git push origin refs/tags/v1.0.9
```
Never force-push; never alter `v1.0.8`, `extension-v1.0.11`, or `origin/master` without separate review.

### Step A3 — Stage Draft & Roundtrip-Verify All 16 Assets
```powershell
node scripts/publish_desktop_v1_0_9.js --stage-draft --owner-authorized --target-commit b60770b1c5124a5a9e5b5c2b883e9a0ecd3fc308
```
The publisher uploads all 16 assets to a `draft: true` release and downloads back EVERY asset via GitHub API to verify exact byte sizes and SHA-256 hashes before returning.

### Step A4 — Publish Verified Draft (`make_latest: "true"`)
```powershell
node scripts/publish_desktop_v1_0_9.js --publish-draft --owner-authorized --target-commit b60770b1c5124a5a9e5b5c2b883e9a0ecd3fc308
```
Verify live unauthenticated endpoints immediately:
- `GET /repos/robijoychakma375-hash/tori-download-manager/releases/latest` → `tag_name: "v1.0.9"`
- `GET /releases/latest/download/latest.json` → `version: "1.0.9"`, exact Ed25519 `.sig` & installer URL
- Roundtrip download `TORI.Download.Manager_1.0.9_x64-setup.exe` → `118,170,722` B, SHA-256 `460f5da00d09267a5f33274645250d92162bbfa3605f0348cc656a39a8a19ead`
- Confirm `v1.0.8` (ID `455125259`) and `extension-v1.0.11` (ID `458864802`) remain intact and downloadable.

---

## 3. Phase B — Authorized Website Deployment (`https://toridownload.xyz`)

Staged locally in `C:\Users\ritud\Downloads\tori-website` on branch **`feat/gate36_2-desktop-v109-website-prep`** at commit **`330846d19333a9b98bea83d52bf95c2c3a4a1eef`** (production `main` untouched at `3edb4293b09e16921877381394a8be38e5d3d02c`, live Cloudflare Deployment ID `723c6191-1b46-41b4-aa1b-bd55ae938357`). Reviewed diff archived at `docs/release/GATE36_2_WEBSITE_DESKTOP_V109_DIFF.patch` (and mirrored into `release/v1.0.9-public-staging/website_desktop_v109.patch`).

Only AFTER Phase A succeeds and live `v1.0.9` downloads pass roundtrip hash verification:
```powershell
Set-Location "C:\Users\ritud\Downloads\tori-website"
git checkout main
git merge --ff-only feat/gate36_2-desktop-v109-website-prep
git push origin main
```
Wait for Cloudflare Pages GitHub Check Run `status=completed`, `conclusion=success`, record the new Cloudflare Deployment ID, and verify:
1. `https://toridownload.xyz/` serves Desktop `v1.0.9` (`112.7 MB`, `460f5da0...`) AND preserves Public Companion `v1.0.11` (`4cd6d6fb...`, `1e77592b...`).
2. `https://toridownload.xyz/assets/tori-download-manager-firefox-v1.0.11.xpi` returns `HTTP 200` (`application/x-xpinstall`, `4cd6d6fb...`).
3. `https://toridownload.xyz/assets/tools/tools-manifest.json` + `.sig` remain revision 2 (`caa2d4ed2a7e424badcd8662e67b986a3fdfbf2847dded0625ea2b2547663f3a`).

---

## 4. Rollback & Incident Containment Runbook

### Rollback 1 — Instant Auto-Updater & GitHub Latest Stable Rollback
1. Set GitHub release `v1.0.9` to `prerelease: true` (or `draft: true` / prepend incident advisory).
2. Patch Desktop `v1.0.8` (Release ID `455125259`) with `make_latest: "true"`.
3. Verify `GET /repos/robijoychakma375-hash/tori-download-manager/releases/latest` resolves back to `v1.0.8` (`455125259`) and `/releases/latest/download/latest.json` serves `1.0.8`.
4. Never overwrite or delete `v1.0.8` signed assets; users who installed `v1.0.9` can safely re-run `TORI.Download.Manager_1.0.8_x64-setup.exe` with additive SQLite schema preserved.

### Rollback 2 — Website Rollback (Cloudflare Pages)
1. In Cloudflare Dashboard → **Workers & Pages → tori-download-manager → Deployments**, roll back to verified deployment **`723c6191-1b46-41b4-aa1b-bd55ae938357`** (`3edb4293b09e16921877381394a8be38e5d3d02c`, Desktop `v1.0.8` + Companion `v1.0.11`), or `git revert --no-edit HEAD && git push origin main` on `tori-website-private`.
2. Verify live `https://toridownload.xyz/` serves Desktop `v1.0.8` + Companion `v1.0.11` and tools manifest rev 2 (`caa2d4ed...`).
