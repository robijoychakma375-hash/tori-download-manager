#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 31.6
 * Desktop v1.0.6 Public Stable Release Stager & GitHub Publisher
 *
 * Strictly Desktop-only release using the FROZEN Gate 31.5 RC artifacts in
 * release/v1.0.6-rc/. Never rebuilds binaries, never modifies Browser Companion
 * v1.0.10, and never removes historical Desktop v1.0.5 or extension releases.
 *
 * Usage:
 *   node scripts/publish_desktop_v1_0_6_release.js --stage-only
 *   node scripts/publish_desktop_v1_0_6_release.js --publish
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync, execSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RC_DIR = path.join(ROOT, 'release', 'v1.0.6-rc');
const PUB_DIR = path.join(ROOT, 'release', 'v1.0.6-public');
const RECORD_DIR = path.join(ROOT, 'target', 'gate31_6_prepub_backup');

const REPO = 'robijoychakma375-hash/tori-download-manager';
const TAG = 'v1.0.6';
const VERSION = '1.0.6';
const RELEASE_NAME = 'TORI Download Manager v1.0.6';
const APPROVED_RELEASE_COMMIT = '6087db99eb0da4ebf69e2d0d6c489bcf5837ed11';

const EXPECTED_FROZEN = {
  installerFile: 'TORI Download Manager_1.0.6_x64-setup.exe',
  installerPublicName: 'TORI.Download.Manager_1.0.6_x64-setup.exe',
  installerBytes: 117794132,
  installerSha256: 'c29ee1080b0c3587d29a2e95fd4374524d49fc16055dfa74f9f66554161c6c7c',
  sigFile: 'TORI Download Manager_1.0.6_x64-setup.exe.sig',
  sigPublicName: 'TORI.Download.Manager_1.0.6_x64-setup.exe.sig',
  sigBytes: 436,
  sigSha256: '2a3f4b217ae381a7a1d1042ca8b395480132d89d5d58c46a2c8dcccba765624a',
  desktopExe: 'tori-download-manager.exe',
  desktopBytes: 30559232,
  desktopSha256: '57cce9fd0207b769ff74f4395a07c184b310c0fcc82bdc38ca5924edb4ce9b3d',
  nativeHostExe: 'tdm-native-host.exe',
  nativeHostBytes: 19397632,
  nativeHostSha256: 'd02da8be8056cd987bd4b5cdca9535a016f60bcb7cbed94fb43d56c042967671',
  cliExe: 'tdm-cli.exe',
  cliBytes: 17067008,
  cliSha256: '2d8286a091caed95979893a1c2e7941163a8acf417d916d01bf31d6b72f58e76',
};

function sha256File(filePath) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.allocUnsafe(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex').toLowerCase();
}

function getGitHubToken() {
  return new Promise((resolve, reject) => {
    if (process.env.GITHUB_TOKEN) return resolve(process.env.GITHUB_TOKEN.trim());
    if (process.env.GH_TOKEN) return resolve(process.env.GH_TOKEN.trim());
    const proc = spawn('git', ['credential', 'fill']);
    proc.stdin.write('protocol=https\nhost=github.com\n\n');
    proc.stdin.end();
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('close', () => {
      const m = out.match(/^password=(.+)$/m);
      if (m) resolve(m[1].trim());
      else reject(new Error('No GitHub credential found in Git Credential Manager'));
    });
    proc.on('error', reject);
  });
}

async function requestJson(method, urlPath, token, body = null, maxAttempts = 4) {
  const postData = body !== null ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const headers = {
          'User-Agent': 'TORI-Gate31-6-Release-Manager',
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          Connection: 'close',
        };
        if (postData !== null) {
          headers['Content-Type'] = 'application/json';
          headers['Content-Length'] = Buffer.byteLength(postData);
        }
        const req = https.request({ hostname: 'api.github.com', path: urlPath, method, headers, agent: false }, (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            let data = raw;
            try { data = JSON.parse(raw); } catch {}
            resolve({ status: res.statusCode, headers: res.headers, data });
          });
        });
        req.setTimeout(30000, () => req.destroy(new Error('GitHub API request timeout')));
        req.on('error', reject);
        if (postData !== null) req.write(postData);
        req.end();
      });
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, attempt * 1500));
    }
  }
}

function downloadToFileViaCurl(url, destPath, token = null, acceptOctet = false) {
  const args = ['-sS', '-L', '--http1.1', '--retry', '3', '--retry-delay', '2', '-o', destPath, '-w', '%{http_code}'];
  if (token) args.push('-H', `Authorization: Bearer ${token}`);
  if (acceptOctet) args.push('-H', 'Accept: application/octet-stream');
  args.push('-H', 'User-Agent: TORI-Gate31-6-Release-Manager', url);
  const res = spawnSync('curl.exe', args, { encoding: 'utf8', timeout: 600000 });
  if (res.error) throw res.error;
  return parseInt((res.stdout || '').trim(), 10) || 0;
}

function uploadAssetStreamingWithRetry(uploadUrlTemplate, filePath, fileName, contentType, token, maxAttempts = 6) {
  const cleanUrl = uploadUrlTemplate.replace(/\{.*?\}$/, '') + `?name=${encodeURIComponent(fileName)}`;
  const expectedSize = fs.statSync(filePath).size;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`  [UPLOAD attempt ${attempt}/${maxAttempts}] ${fileName} (${expectedSize} bytes)...`);
    const args = [
      '-sS',
      '--http1.1',
      '-w', '\n%{http_code}',
      '-X', 'POST',
      '-H', `Authorization: Bearer ${token}`,
      '-H', 'Accept: application/vnd.github+json',
      '-H', `Content-Type: ${contentType}`,
      '-H', 'Expect:',
      '-T', filePath,
      cleanUrl,
    ];
    const res = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 900000 });
    const stdout = (res.stdout || '').trim();
    const lines = stdout ? stdout.split(/\r?\n/) : [];
    const code = lines.length ? parseInt(lines[lines.length - 1], 10) : 0;
    const body = lines.slice(0, -1).join('\n');
    let data = body;
    try { data = JSON.parse(body); } catch {}

    if (code === 201 && data && data.id && data.size === expectedSize) {
      console.log(`    -> OK (HTTP 201, asset ID=${data.id}, size=${data.size})`);
      return { ok: true, status: code, data };
    }
    console.warn(`    -> Attempt ${attempt} failed: HTTP=${code} curlExit=${res.status} stderr=${(res.stderr || '').trim().slice(0, 220)}`);
    if (attempt < maxAttempts) {
      spawnSync('powershell', ['-NoProfile', '-Command', `Start-Sleep -Seconds ${Math.min(attempt * 3, 12)}`]);
    }
  }
  return { ok: false };
}

function buildReleaseNotesMarkdown() {
  return `# TORI Download Manager v1.0.6 — Progress Window & Installation Stability Update

> **Release Type:** Desktop-only stable production release (Windows 10 / 11, 64-bit)  
> **Compatible Browser Companion:** \`v1.0.10\` (unchanged — available separately under [\`extension-v1.0.10\`](https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/extension-v1.0.10))

---

## Major Improvements

### 1. IDM-Style Download Progress Window
- Standalone per-download native Windows window (\`progress_<id>\`)
- **Download Status** tab with live transfer progress, speed, ETA, file size, and resume capability
- **Speed Limiter** tab with per-download bandwidth cap controls
- **Options on Completion** tab with per-download completion action toggles
- Real-time active connection count and multi-segment progress bars
- Working **Pause / Resume / Cancel / Retry** controls
- **Compact mode** toggle (collapsible 38px progress bar)
- **Always-on-Top** window support

### 2. Legacy Toast Replacement
- Replaced the outdated dark floating progress toast as the download progress interface
- Unified standalone progress window creation across manual, browser-captured, Native Messaging, queued, and YouTube media downloads
- Prevented duplicate progress window creation per download job
- Preserved Windows download completion notifications as a separate feature
- Preserved user \`showDownloadPopup\` preferences (\`always\`, \`when_hidden\`, \`never\`)

### 3. Installation and Upgrade Reliability
- Corrected stale installation-path handling in NSIS (\`NSIS_HOOK_PREINSTALL\` automatically redirects stale \`%TEMP%\` or QA paths back to \`%LOCALAPPDATA%\\TORI Download Manager\\\`)
- Improved NSIS upgrade and passive auto-update (\`/P /UPDATE\`) behavior
- Prevented stale Desktop process interference during upgrades (\`NSIS_HOOK_POSTINSTALL\` cleans up lingering respawned instances)
- Improved Native Messaging host executable registration across Chrome, Edge, and Firefox
- Improved single-instance startup reliability (preventing false \`SECONDARY_INSTANCE\` exits)

### 4. Browser Companion Compatibility
- Verified full compatibility with **Browser Companion v1.0.10** (unchanged)
- Chrome, Edge, and Mozilla-signed Firefox integration preserved
- Browser-initiated download progress uses the updated standalone Desktop progress window, including while the main window is hidden in the system tray

### 5. Data Safety
- Existing downloads in SQLite preserved during verified upgrades
- User theme, accent, popup, and engine settings preserved
- Incomplete \`.tdm-part\` partial download files preserved intact

---

## SHA-256 Checksums

| File | Size (Bytes) | SHA-256 |
|---|---:|---|
| \`TORI.Download.Manager_1.0.6_x64-setup.exe\` | \`117,794,132\` | \`c29ee1080b0c3587d29a2e95fd4374524d49fc16055dfa74f9f66554161c6c7c\` |
| \`TORI.Download.Manager_1.0.6_x64-setup.exe.sig\` | \`436\` | \`2a3f4b217ae381a7a1d1042ca8b395480132d89d5d58c46a2c8dcccba765624a\` |
| \`tori-download-manager.exe\` | \`30,559,232\` | \`57cce9fd0207b769ff74f4395a07c184b310c0fcc82bdc38ca5924edb4ce9b3d\` |
| \`tdm-native-host.exe\` | \`19,397,632\` | \`d02da8be8056cd987bd4b5cdca9535a016f60bcb7cbed94fb43d56c042967671\` |
| \`tdm-cli.exe\` | \`17,067,008\` | \`2d8286a091caed95979893a1c2e7941163a8acf417d916d01bf31d6b72f58e76\` |

Verify in PowerShell:
\`\`\`powershell
Get-FileHash .\\TORI.Download.Manager_1.0.6_x64-setup.exe -Algorithm SHA256
\`\`\`

---

## Known Limitations

- **Windows Authenticode code signing remains unavailable** (\`NotSigned\`). Although the Tauri auto-updater Ed25519 signature (\`.sig\`) is cryptographically valid for in-app update verification, manual downloads may trigger a Windows Defender SmartScreen prompt until an OV/EV Authenticode certificate is configured.
- **Independent clean Windows VM verification remains unperformed** (\`NOT TESTED\`); verification was performed on Windows 11 using isolated profiles, isolated QA directories, and live production upgrade checks.
- **Paid DRM-protected media remains unsupported.**
`;
}

function buildInstallNotesMarkdown() {
  return `# TORI Download Manager v1.0.6 — Installation & Upgrade Notes

## System Requirements
- Windows 10 or Windows 11 (64-bit, x64)
- No external prerequisites required (self-contained NSIS installer bundles \`tdm-native-host.exe\`, \`tdm-cli.exe\`, \`ffmpeg.exe\`, \`ffprobe.exe\`, and \`yt-dlp.exe\`)

## Clean Installation
1. Download \`TORI.Download.Manager_1.0.6_x64-setup.exe\`.
2. *(Optional)* Verify integrity in PowerShell:
   \`\`\`powershell
   Get-FileHash .\\TORI.Download.Manager_1.0.6_x64-setup.exe -Algorithm SHA256
   \`\`\`
   Expected SHA-256: \`c29ee1080b0c3587d29a2e95fd4374524d49fc16055dfa74f9f66554161c6c7c\`
3. Run the installer. Because commercial Windows Authenticode signing is not yet configured (\`NotSigned\`), click **More info → Run anyway** if Windows Defender SmartScreen prompts.
4. TORI installs to \`%LOCALAPPDATA%\\TORI Download Manager\\\` and automatically registers the Native Messaging Host for Chrome, Edge, and Firefox.

## Upgrading from v1.0.3, v1.0.4, or v1.0.5
- **Automatic In-App Update:** Existing installations with Tauri updater support will detect \`v1.0.6\` via \`latest.json\`, verify the Ed25519 signature, and apply the update automatically.
- **Manual Upgrade:** Run \`TORI.Download.Manager_1.0.6_x64-setup.exe\`. The installer automatically cleans up lingering background instances and repairs any stale temporary installation path registration.
- **Data Preservation:** Your SQLite download database (\`%APPDATA%\\tori-download-manager\\tdm_storage.sqlite\`), settings, completed downloads, and incomplete \`.tdm-part\` files are preserved.

## Browser Companion v1.0.10 (Unchanged)
Desktop v1.0.6 is fully compatible with **Browser Companion v1.0.10** (no extension reinstall required if already on v1.0.10). Download v1.0.10 packages from the separate [\`extension-v1.0.10\`](https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/extension-v1.0.10) release or [https://toridownload.xyz/#extension](https://toridownload.xyz/#extension).

## Rollback
To roll back to \`v1.0.5\`, exit TORI from the system tray and run \`TORI.Download.Manager_1.0.5_x64-setup.exe\` from the preserved [\`v1.0.5\` release](https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/v1.0.5).
`;
}

function stagePublicAssets() {
  console.log('=== PHASE 4 & 5: STAGING FROZEN DESKTOP v1.0.6 PUBLIC ASSETS ===');

  // 1. Verify frozen RC artifacts strictly (NEVER rebuild!)
  const checks = [
    [path.join(RC_DIR, EXPECTED_FROZEN.installerFile), EXPECTED_FROZEN.installerBytes, EXPECTED_FROZEN.installerSha256],
    [path.join(RC_DIR, EXPECTED_FROZEN.sigFile), EXPECTED_FROZEN.sigBytes, EXPECTED_FROZEN.sigSha256],
    [path.join(RC_DIR, EXPECTED_FROZEN.desktopExe), EXPECTED_FROZEN.desktopBytes, EXPECTED_FROZEN.desktopSha256],
    [path.join(RC_DIR, EXPECTED_FROZEN.nativeHostExe), EXPECTED_FROZEN.nativeHostBytes, EXPECTED_FROZEN.nativeHostSha256],
    [path.join(RC_DIR, EXPECTED_FROZEN.cliExe), EXPECTED_FROZEN.cliBytes, EXPECTED_FROZEN.cliSha256],
  ];
  for (const [p, expBytes, expSha] of checks) {
    if (!fs.existsSync(p)) throw new Error(`Frozen RC artifact missing: ${p}`);
    const sz = fs.statSync(p).size;
    const h = sha256File(p);
    if (sz !== expBytes || h !== expSha) {
      throw new Error(`Frozen RC mismatch on ${p}: size=${sz} (exp ${expBytes}), sha256=${h} (exp ${expSha})`);
    }
  }
  console.log('[OK] All 5 frozen v1.0.6 RC binaries & signature match Gate 31.5 approved hashes bit-for-bit.');

  // Preserve existing pub_date if re-running against an already-staged draft
  let existingPubDate = null;
  const existingLatestPath = path.join(PUB_DIR, 'latest.json');
  if (fs.existsSync(existingLatestPath)) {
    try { existingPubDate = JSON.parse(fs.readFileSync(existingLatestPath, 'utf8')).pub_date || null; } catch {}
  }

  fs.rmSync(PUB_DIR, { recursive: true, force: true });
  fs.mkdirSync(PUB_DIR, { recursive: true });

  // 2. Copy frozen binaries (filename-only rename for public dotted installer & .sig)
  fs.copyFileSync(path.join(RC_DIR, EXPECTED_FROZEN.installerFile), path.join(PUB_DIR, EXPECTED_FROZEN.installerPublicName));
  fs.copyFileSync(path.join(RC_DIR, EXPECTED_FROZEN.sigFile), path.join(PUB_DIR, EXPECTED_FROZEN.sigPublicName));
  fs.copyFileSync(path.join(RC_DIR, EXPECTED_FROZEN.desktopExe), path.join(PUB_DIR, EXPECTED_FROZEN.desktopExe));
  fs.copyFileSync(path.join(RC_DIR, EXPECTED_FROZEN.nativeHostExe), path.join(PUB_DIR, EXPECTED_FROZEN.nativeHostExe));
  fs.copyFileSync(path.join(RC_DIR, EXPECTED_FROZEN.cliExe), path.join(PUB_DIR, EXPECTED_FROZEN.cliExe));

  // Verify renamed public installer & sig are byte-identical
  const renamedSha = sha256File(path.join(PUB_DIR, EXPECTED_FROZEN.installerPublicName));
  const renamedSigSha = sha256File(path.join(PUB_DIR, EXPECTED_FROZEN.sigPublicName));
  if (renamedSha !== EXPECTED_FROZEN.installerSha256 || renamedSigSha !== EXPECTED_FROZEN.sigSha256) {
    throw new Error('Renamed public installer/sig hash mismatch');
  }

  // 3. Copy exact license files
  const licenseMap = [
    [path.join(ROOT, 'LICENSE'), 'LICENSE'],
    [path.join(ROOT, 'LICENSE-MIT'), 'LICENSE-MIT'],
    [path.join(ROOT, 'LICENSE-APACHE'), 'LICENSE-APACHE'],
    [path.join(ROOT, 'resources', 'LICENSE-GPLv3.txt'), 'LICENSE-GPLv3.txt'],
    [path.join(ROOT, 'resources', 'LICENSE-THIRD-PARTY.txt'), 'LICENSE-THIRD-PARTY.txt'],
  ];
  for (const [src, dstName] of licenseMap) {
    if (!fs.existsSync(src)) throw new Error(`Required license file missing: ${src}`);
    fs.copyFileSync(src, path.join(PUB_DIR, dstName));
  }

  // 4. Write RELEASE_NOTES.md & INSTALLATION_AND_UPGRADE_NOTES.md
  fs.writeFileSync(path.join(PUB_DIR, 'RELEASE_NOTES.md'), buildReleaseNotesMarkdown(), 'utf8');
  fs.writeFileSync(path.join(PUB_DIR, 'INSTALLATION_AND_UPGRADE_NOTES.md'), buildInstallNotesMarkdown(), 'utf8');

  // 5. Generate & validate Tauri v2 latest.json matching exact project schema
  const sigText = fs.readFileSync(path.join(PUB_DIR, EXPECTED_FROZEN.sigPublicName), 'utf8').trim();
  const decodedSig = Buffer.from(sigText, 'base64').toString('utf8');
  if (!decodedSig.includes('untrusted comment: signature from tauri secret key') || !decodedSig.includes('TORI Download Manager_1.0.6_x64-setup.exe')) {
    throw new Error(`Unexpected Ed25519 signature content in .sig file: ${decodedSig.slice(0, 120)}`);
  }

  const publicInstallerUrl = `https://github.com/${REPO}/releases/download/${TAG}/${EXPECTED_FROZEN.installerPublicName}`;
  const latestJsonObj = {
    version: VERSION,
    notes:
      'TORI Download Manager v1.0.6 — Progress Window & Installation Stability Update.\n\n' +
      '- New: Standalone IDM-style Download Progress Window unified across manual, browser-captured, queued, and media downloads (Download Status, Speed Limiter, and Options on Completion tabs, live transfer metrics, Pause/Resume, Compact mode, Always-on-Top)\n' +
      '- Fix: Replaced legacy dark floating progress toast while preserving completion notifications and popup preferences\n' +
      '- Fix: Hardened NSIS installer with stale temporary/QA installation path auto-recovery and lingering background process cleanup to prevent single-instance conflicts\n' +
      '- Compat: Verified full compatibility with Browser Companion v1.0.10 (Chrome, Edge, Firefox) while preserving existing SQLite downloads, settings, and .tdm-part files',
    pub_date: existingPubDate || new Date().toISOString(),
    platforms: {
      'windows-x86_64': {
        signature: sigText,
        url: publicInstallerUrl,
      },
      'windows-x86_64-nsis': {
        signature: sigText,
        url: publicInstallerUrl,
      },
    },
  };
  const latestJsonStr = JSON.stringify(latestJsonObj, null, 2) + '\n';
  fs.writeFileSync(path.join(PUB_DIR, 'latest.json'), latestJsonStr, 'utf8');

  // Strict validation of latest.json
  const parsedLj = JSON.parse(fs.readFileSync(path.join(PUB_DIR, 'latest.json'), 'utf8'));
  if (
    parsedLj.version !== VERSION ||
    parsedLj.platforms['windows-x86_64'].url !== publicInstallerUrl ||
    parsedLj.platforms['windows-x86_64-nsis'].url !== publicInstallerUrl ||
    parsedLj.platforms['windows-x86_64'].signature !== sigText ||
    parsedLj.platforms['windows-x86_64-nsis'].signature !== sigText ||
    latestJsonStr.includes('1.0.5') ||
    latestJsonStr.includes('1.0.4')
  ) {
    throw new Error('latest.json strict pre-upload validation failed');
  }
  console.log(`[OK] Generated & validated latest.json (version=${parsedLj.version}, pub_date=${parsedLj.pub_date})`);

  // 6. Generate SHA256SUMS.txt covering all Desktop v1.0.6 published assets
  const sumTargets = [
    EXPECTED_FROZEN.installerPublicName,
    EXPECTED_FROZEN.sigPublicName,
    EXPECTED_FROZEN.desktopExe,
    EXPECTED_FROZEN.nativeHostExe,
    EXPECTED_FROZEN.cliExe,
    'latest.json',
    'RELEASE_NOTES.md',
    'INSTALLATION_AND_UPGRADE_NOTES.md',
    'LICENSE',
    'LICENSE-MIT',
    'LICENSE-APACHE',
    'LICENSE-GPLv3.txt',
    'LICENSE-THIRD-PARTY.txt',
  ];
  const sumLines = sumTargets.map((f) => `${sha256File(path.join(PUB_DIR, f))}  ${f}`);
  fs.writeFileSync(path.join(PUB_DIR, 'SHA256SUMS.txt'), sumLines.join('\n') + '\n', 'utf8');

  const assets = [
    { name: EXPECTED_FROZEN.installerPublicName, contentType: 'application/vnd.microsoft.portable-executable' },
    { name: EXPECTED_FROZEN.sigPublicName, contentType: 'text/plain' },
    { name: EXPECTED_FROZEN.desktopExe, contentType: 'application/vnd.microsoft.portable-executable' },
    { name: EXPECTED_FROZEN.nativeHostExe, contentType: 'application/vnd.microsoft.portable-executable' },
    { name: EXPECTED_FROZEN.cliExe, contentType: 'application/vnd.microsoft.portable-executable' },
    { name: 'latest.json', contentType: 'application/json' },
    { name: 'SHA256SUMS.txt', contentType: 'text/plain' },
    { name: 'RELEASE_NOTES.md', contentType: 'text/markdown' },
    { name: 'INSTALLATION_AND_UPGRADE_NOTES.md', contentType: 'text/markdown' },
    { name: 'LICENSE', contentType: 'text/plain' },
    { name: 'LICENSE-MIT', contentType: 'text/plain' },
    { name: 'LICENSE-APACHE', contentType: 'text/plain' },
    { name: 'LICENSE-GPLv3.txt', contentType: 'text/plain' },
    { name: 'LICENSE-THIRD-PARTY.txt', contentType: 'text/plain' },
  ].map((a) => ({
    ...a,
    filePath: path.join(PUB_DIR, a.name),
    size: fs.statSync(path.join(PUB_DIR, a.name)).size,
    sha256: sha256File(path.join(PUB_DIR, a.name)),
  }));

  console.log(`\nStaged ${assets.length} Desktop-only public assets in ${PUB_DIR}:`);
  for (const a of assets) {
    console.log(`  ${a.name.padEnd(46)} ${String(a.size).padStart(11)} B  ${a.sha256}`);
  }
  return { assets, latestJsonObj };
}

async function publishRelease() {
  const { assets, latestJsonObj } = stagePublicAssets();
  const token = await getGitHubToken();
  console.log('\n=== PHASE 6 & 7: GITHUB DRAFT CREATION, UPLOAD, VERIFICATION & PROMOTION ===');

  // Verify local & remote tag v1.0.6 point to exact approved commit
  const localTagCommit = execFileSync('git', ['rev-list', '-n', '1', TAG], { cwd: ROOT, encoding: 'utf8' }).trim();
  const remoteTagLine = execFileSync('git', ['ls-remote', 'origin', `refs/tags/${TAG}^{}`], { cwd: ROOT, encoding: 'utf8' }).trim();
  const remoteTagCommit = remoteTagLine ? remoteTagLine.split(/\s+/)[0] : '';
  if (localTagCommit !== APPROVED_RELEASE_COMMIT || remoteTagCommit !== APPROVED_RELEASE_COMMIT) {
    throw new Error(
      `Tag ${TAG} mismatch! local=${localTagCommit}, remote=${remoteTagCommit}, expected=${APPROVED_RELEASE_COMMIT}. Push tag ${TAG} first.`
    );
  }
  console.log(`[OK] Verified local & remote tag ${TAG} -> ${APPROVED_RELEASE_COMMIT}`);

  const releaseBody = fs.readFileSync(path.join(PUB_DIR, 'RELEASE_NOTES.md'), 'utf8');

  // Reuse existing draft if resuming, never overwrite an already published release silently
  const listRes = await requestJson('GET', `/repos/${REPO}/releases?per_page=30`, token);
  if (listRes.status !== 200 || !Array.isArray(listRes.data)) {
    throw new Error(`Failed to list GitHub releases: HTTP ${listRes.status}`);
  }
  let release = listRes.data.find((r) => r.tag_name === TAG);
  if (release && !release.draft) {
    throw new Error(`Release ${TAG} (ID ${release.id}) is already published; refusing to mutate published release.`);
  }

  if (!release) {
    console.log(`[CREATE] Creating DRAFT release for ${TAG}...`);
    const cr = await requestJson('POST', `/repos/${REPO}/releases`, token, {
      tag_name: TAG,
      target_commitish: APPROVED_RELEASE_COMMIT,
      name: RELEASE_NAME,
      body: releaseBody,
      draft: true,
      prerelease: false,
      make_latest: 'false',
    });
    if (cr.status !== 201 || !cr.data?.id) {
      throw new Error(`Failed to create draft release: HTTP ${cr.status} ${JSON.stringify(cr.data)}`);
    }
    release = cr.data;
    console.log(`[OK] Created DRAFT release ID=${release.id}`);
  } else {
    console.log(`[RESUME] Using existing DRAFT release ID=${release.id}; updating body...`);
    const up = await requestJson('PATCH', `/repos/${REPO}/releases/${release.id}`, token, {
      name: RELEASE_NAME,
      body: releaseBody,
      draft: true,
      prerelease: false,
    });
    if (up.status !== 200) throw new Error(`Failed updating draft release: HTTP ${up.status}`);
    release = up.data;
  }

  // Inspect already uploaded draft assets
  const existingAssetsRes = await requestJson('GET', `/repos/${REPO}/releases/${release.id}/assets?per_page=100`, token);
  const existingAssets = Array.isArray(existingAssetsRes.data) ? existingAssetsRes.data : [];

  const uploadedRecords = [];
  for (const asset of assets) {
    const prev = existingAssets.find((a) => a.name === asset.name);
    if (prev && prev.size === asset.size && prev.state === 'uploaded') {
      console.log(`  [KEEP] ${asset.name} already uploaded cleanly (ID=${prev.id}, size=${prev.size})`);
      uploadedRecords.push({ ...asset, id: prev.id, url: prev.url, browser_download_url: prev.browser_download_url });
      continue;
    }
    if (prev) {
      console.log(`  [DELETE] Removing partial/stale draft asset ${asset.name} (ID=${prev.id}, size=${prev.size})...`);
      await requestJson('DELETE', `/repos/${REPO}/releases/assets/${prev.id}`, token);
    }
    const up = uploadAssetStreamingWithRetry(release.upload_url, asset.filePath, asset.name, asset.contentType, token, 6);
    if (!up.ok) {
      throw new Error(`Failed to upload asset ${asset.name} after retries — draft release NOT published.`);
    }
    uploadedRecords.push({ ...asset, id: up.data.id, url: up.data.url, browser_download_url: up.data.browser_download_url });
  }

  // Verify all 14 assets exist on the draft with exact sizes
  const verifyAssetsRes = await requestJson('GET', `/repos/${REPO}/releases/${release.id}/assets?per_page=100`, token);
  const remoteAssets = Array.isArray(verifyAssetsRes.data) ? verifyAssetsRes.data : [];
  if (remoteAssets.length !== assets.length) {
    throw new Error(`Draft asset count mismatch: remote=${remoteAssets.length}, expected=${assets.length}`);
  }
  for (const asset of assets) {
    const r = remoteAssets.find((x) => x.name === asset.name);
    if (!r || r.size !== asset.size || r.state !== 'uploaded') {
      throw new Error(`Draft asset check failed for ${asset.name}: ${JSON.stringify(r)}`);
    }
  }
  console.log(`[OK] All ${assets.length} draft assets verified present with exact sizes.`);

  // Pre-publish download & SHA-256 verification of critical draft assets (installer, .sig, latest.json, SHA256SUMS.txt)
  const dlCheckDir = path.join(RECORD_DIR, 'draft_download_verify');
  fs.rmSync(dlCheckDir, { recursive: true, force: true });
  fs.mkdirSync(dlCheckDir, { recursive: true });
  for (const criticalName of [EXPECTED_FROZEN.installerPublicName, EXPECTED_FROZEN.sigPublicName, 'latest.json', 'SHA256SUMS.txt']) {
    const rec = uploadedRecords.find((a) => a.name === criticalName);
    const outPath = path.join(dlCheckDir, criticalName);
    console.log(`  [VERIFY DRAFT DOWNLOAD] ${criticalName} (asset ID=${rec.id})...`);
    const code = downloadToFileViaCurl(rec.url, outPath, token, true);
    if (code !== 200) throw new Error(`Draft download failed for ${criticalName}: HTTP ${code}`);
    const dlSha = sha256File(outPath);
    if (dlSha !== rec.sha256) {
      throw new Error(`Draft download SHA-256 mismatch for ${criticalName}: got=${dlSha}, exp=${rec.sha256}`);
    }
    console.log(`    -> SHA-256 verified: ${dlSha}`);
  }

  // Promote draft release to public Latest Stable!
  console.log(`\n[PROMOTE] Publishing release ID=${release.id} as repository-wide Latest Stable...`);
  const pubRes = await requestJson('PATCH', `/repos/${REPO}/releases/${release.id}`, token, {
    tag_name: TAG,
    target_commitish: APPROVED_RELEASE_COMMIT,
    name: RELEASE_NAME,
    draft: false,
    prerelease: false,
    make_latest: 'true',
  });
  if (pubRes.status !== 200 || pubRes.data?.draft !== false) {
    throw new Error(`Failed to publish release: HTTP ${pubRes.status} ${JSON.stringify(pubRes.data)}`);
  }
  const published = pubRes.data;
  console.log(`[PUBLISHED] ${published.name} | ID=${published.id} | URL=${published.html_url}`);

  // Immediate post-publish verification: Latest Stable == v1.0.6, v1.0.5 preserved, extension-v1.0.10 preserved
  const latestRes = await requestJson('GET', `/repos/${REPO}/releases/latest`, token);
  const v105Res = await requestJson('GET', `/repos/${REPO}/releases/tags/v1.0.5`, token);
  const extRes = await requestJson('GET', `/repos/${REPO}/releases/tags/extension-v1.0.10`, token);

  if (latestRes.data?.tag_name !== TAG) {
    throw new Error(`Expected /releases/latest to be ${TAG}, got ${latestRes.data?.tag_name}`);
  }
  if (v105Res.status !== 200 || extRes.status !== 200) {
    throw new Error(`Historical releases preservation check failed: v105=${v105Res.status}, ext=${extRes.status}`);
  }

  fs.mkdirSync(RECORD_DIR, { recursive: true });
  const recordOut = {
    published_at: published.published_at,
    release_id: published.id,
    html_url: published.html_url,
    tag_name: published.tag_name,
    target_commitish: published.target_commitish,
    approved_commit: APPROVED_RELEASE_COMMIT,
    latest_stable_tag: latestRes.data.tag_name,
    latest_json: latestJsonObj,
    assets: uploadedRecords.map((a) => ({
      name: a.name,
      id: a.id,
      size: a.size,
      sha256: a.sha256,
      browser_download_url: `https://github.com/${REPO}/releases/download/${TAG}/${a.name}`,
    })),
    preserved_v105_id: v105Res.data.id,
    preserved_ext_v1010_id: extRes.data.id,
  };
  fs.writeFileSync(path.join(RECORD_DIR, 'published_v106_release.json'), JSON.stringify(recordOut, null, 2));
  console.log('\n[SUCCESS] Published Desktop v1.0.6 as Latest Stable & recorded metadata in target/gate31_6_prepub_backup/published_v106_release.json');
}

(async () => {
  const mode = process.argv[2] || '--stage-only';
  if (mode === '--stage-only') {
    stagePublicAssets();
  } else if (mode === '--publish') {
    await publishRelease();
  } else {
    console.error('Usage: node scripts/publish_desktop_v1_0_6_release.js [--stage-only|--publish]');
    process.exit(1);
  }
})().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
