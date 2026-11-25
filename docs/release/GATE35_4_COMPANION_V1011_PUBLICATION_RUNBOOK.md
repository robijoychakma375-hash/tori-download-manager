# TORI Browser Companion v1.0.11 — Publication, Cloudflare Deployment & Rollback Runbook

**Target Tag:** `extension-v1.0.11`  
**Target Website:** `https://toridownload.xyz/` (`robijoychakma375-hash/tori-website-private` → Cloudflare Pages `public/`)  
**Preserved Public Desktop:** `v1.0.8` (GitHub Release ID `455125259`, repository **Latest Stable**)  
**Preserved Production Tools Manifest:** Revision 2 (untouched)  
**Pre-Condition:** **DO NOT EXECUTE ANY REMOTE STEP BELOW UNTIL EXPLICIT SEPARATE OWNER AUTHORIZATION IS GRANTED (Gate 35.5 / Release Execution Gate).**

---

## 1. Exact Release Asset Inventory (`release/v1.0.11-extension-rc/`)

Only the 5 files below are published to GitHub Release `extension-v1.0.11` (the unsigned `tori-companion-v1.0.11-firefox.zip` reference build is intentionally **excluded** from public release assets):

| Asset Name | Content-Type | Size (Bytes) | Required SHA-256 |
| :--- | :--- | ---: | :--- |
| `tori-companion-v1.0.11-firefox-signed.xpi` | `application/x-xpinstall` | `111,347` | `4cd6d6fbf067cb98538fd807eaba360d40b409df07cbfb515b8d9b702b37c0fd` |
| `tori-companion-v1.0.11-chromium.zip` | `application/zip` | `94,625` | `1e77592bb05e548d832df373331aee4f90788a004cdaef7ca80c97df84b88559` |
| `SHA256SUMS.txt` | `text/plain` | `210` | `70eb787011706a543d6c2ac607fc946bbe1de7a0451dd38a0a651ca76131bc38` |
| `RELEASE_NOTES.md` | `text/markdown` | `5,067` | `f971e6c32b669fc6cbbc4b444045851ae10756b301581192cd025ca2fa65f983` |
| `INSTALLATION_AND_UPGRADE.md` | `text/markdown` | `2,746` | `6a4b3d6a37911c76923a149ff9d3bdefc56746a37a7a3aea0cc373b453a461d6` |

---

## 2. Phase A — Authorized GitHub Release Publication (`extension-v1.0.11`)

### Step A1 — Mandatory Dry-Run Check (Safe Anytime, Zero Remote Writes)
```powershell
Set-Location "F:\TORI\final tori download manager"
node scripts/publish_extension_v1_0_11.js --dry-run
```
Confirm:
- Exit code `0`, `remote_writes_performed: 0`.
- `make_latest_false_enforced: true`, `unsigned_firefox_zip_excluded: true`.
- Live `/releases/latest` reports `tag_name: "v1.0.8"` (`id: 455125259`).

### Step A2 — Authorized Live GitHub Publication (Requires Explicit Owner Approval)
```powershell
Set-Location "F:\TORI\final tori download manager"
node scripts/publish_extension_v1_0_11.js --execute --owner-authorized
```
What the script enforces automatically:
1. Re-verifies exact SHA-256 hashes of `tori-companion-v1.0.11-firefox-signed.xpi` and `tori-companion-v1.0.11-chromium.zip` plus all 5 `META-INF/` signature files before opening any write request.
2. Creates/updates `extension-v1.0.11` idempotently with **`make_latest: "false"`**.
3. Uploads ONLY the 5 verified release assets.
4. Publishes `extension-v1.0.11` and immediately audits `GET /repos/robijoychakma375-hash/tori-download-manager/releases/latest` to confirm Desktop `v1.0.8` (`455125259`) remains repository Latest Stable (auto-restoring `455125259` if anything shifted).

### Step A3 — Live GitHub Verification
```powershell
curl.exe -sI "https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/extension-v1.0.11/tori-companion-v1.0.11-firefox-signed.xpi"
curl.exe -sI "https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/extension-v1.0.11/tori-companion-v1.0.11-chromium.zip"
curl.exe -s "https://api.github.com/repos/robijoychakma375-hash/tori-download-manager/releases/latest" | python -c "import sys,json; d=json.load(sys.stdin); print(d['id'], d['tag_name'])"
```
Expected:
- Both `extension-v1.0.11` download URLs return `302` → `200 OK` and downloaded bytes match exact SHA-256 hashes.
- `/releases/latest` returns `455125259 v1.0.8`.
- `extension-v1.0.10` assets remain reachable (`200 OK`) for rollback/legacy users.

---

## 3. Phase B — Authorized Cloudflare Pages Website Deployment (`toridownload.xyz`)

### Local Staged Website Branch
Website changes are already staged and committed locally in `C:\Users\ritud\Downloads\tori-website` on local branch `feat/gate35_4-companion-v1011-website-prep` (commit `3edb4293b09e16921877381394a8be38e5d3d02c`), with production `main` untouched and checked out at `181b3fb7c4d2abb9889d7d988b223fe63e02506f`. The reviewed text diff is archived at `docs/release/GATE35_4_WEBSITE_V1011_DIFF.patch` (and `release/v1.0.11-extension-rc/website_v1011.patch`):
- Adds `assets/tori-download-manager-firefox-v1.0.11.xpi` (exact copy of signed XPI `4cd6d6fb...`, while keeping `assets/tori-download-manager-firefox-v1.0.10.xpi` intact for zero-downtime rollback!).
- Adds `/assets/tori-download-manager-firefox-v1.0.11.xpi` and `/tori-download-manager-firefox-v1.0.11.xpi` `Content-Type: application/x-xpinstall` rules in `_headers` (preserving existing `v1.0.10` rules!).
- Updates ONLY Companion `v1.0.11` URLs, version labels, sizes (`109 KB` Firefox XPI, `92 KB` Chromium ZIP), and SHA-256 hashes in `index.html` while keeping Desktop `v1.0.8` installer URLs, size, release notes, and tools manifest revision 2 **100% untouched**.

### Step B1 — Authorized Website Merge & Cloudflare Pages Deployment (ONLY After Phase A Succeeds)
```powershell
Set-Location "C:\Users\ritud\Downloads\tori-website"
git checkout main
git merge --ff-only feat/gate35_4-companion-v1011-website-prep
git push origin main
```
*(Or if deploying directly via Wrangler Pages after owner approval, build `public/` identically to `DEPLOYMENT.md` and deploy to the production Cloudflare Pages project.)*

### Step B2 — Post-Deploy Live Website Verification
Verify all endpoints return `200 OK` with expected headers and hashes:
1. `https://toridownload.xyz/` → HTML references `v1.0.8` Desktop installer (`728d0d25...`) AND `Companion v1.0.11` (`4cd6d6fb...`, `1e77592b...`).
2. `https://toridownload.xyz/assets/tori-download-manager-firefox-v1.0.11.xpi` → `HTTP 200`, `Content-Type: application/x-xpinstall`, exact SHA-256 `4cd6d6fbf067cb98538fd807eaba360d40b409df07cbfb515b8d9b702b37c0fd`.
3. `https://toridownload.xyz/assets/tori-download-manager-firefox-v1.0.10.xpi` → still `HTTP 200` (rollback continuity).
4. `https://toridownload.xyz/assets/tools/tools-manifest.json` → still revision 2 (100% untouched).
5. `https://toridownload.xyz/assets/updater/latest.json` (or GitHub release `latest.json`) → still Desktop `v1.0.8` (100% untouched).

---

## 4. Emergency Rollback Runbook (GitHub + Cloudflare Pages)

Because `v1.0.10` GitHub assets (`extension-v1.0.10`) and `assets/tori-download-manager-firefox-v1.0.10.xpi` remain preserved throughout deployment, rollback completes in under 2 minutes with zero data loss:

### Rollback Step 1 — Instant Cloudflare Pages Rollback (< 30 seconds)
- **Option 1 (Fastest — Cloudflare Dashboard):** Open **Cloudflare Dashboard → Workers & Pages → tori-website → Deployments** → select the prior `main` deployment (`181b3fb7c4d2abb9889d7d988b223fe63e02506f`) → click **Rollback to this deployment**.
- **Option 2 (Git Revert):**
  ```powershell
  Set-Location "C:\Users\ritud\Downloads\tori-website"
  git checkout main
  git revert --no-edit HEAD
  git push origin main
  ```
- Verify `https://toridownload.xyz/` serves Companion `v1.0.10` (`a93a4387...`, `f220fab2...`) and Desktop `v1.0.8` (`728d0d25...`).

### Rollback Step 2 — GitHub Release Containment
If a critical regression is discovered in `extension-v1.0.11`:
1. Mark `extension-v1.0.11` as `prerelease: true` (or `draft: true` / prepend a rollback advisory in the release body) via GitHub Releases UI or API.
2. Confirm `extension-v1.0.10` (release ID `451270856`) remains published and downloadable.
3. Confirm `/releases/latest` remains Desktop `v1.0.8` (release ID `455125259`).
4. Note: Existing Firefox users who installed `v1.0.11` can reinstall `tori-companion-v1.0.10-firefox-signed.xpi` directly without data loss; existing Desktop `v1.0.8` installations and tools manifest rev 2 are unaffected.
