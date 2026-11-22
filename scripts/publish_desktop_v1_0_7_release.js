#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 32.3
 * Desktop v1.0.7 Public Stable Release Stager & Two-Phase GitHub Publisher
 *
 * Strictly Desktop-only release using the FROZEN Gate 32.2 RC artifacts in
 * release/v1.0.7-rc/. Never rebuilds binaries, never modifies Browser Companion
 * v1.0.10, and never removes historical Desktop v1.0.6/v1.0.5, extension-v1.0.10,
 * or tools-ffmpeg-N-129150-g7ddf7bc8a4 releases.
 *
 * Usage:
 *   node scripts/publish_desktop_v1_0_7_release.js --stage-only
 *   node scripts/publish_desktop_v1_0_7_release.js --publish
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RC_DIR = path.join(ROOT, 'release', 'v1.0.7-rc');
const PUB_DIR = path.join(ROOT, 'release', 'v1.0.7-public');
const RECORD_DIR = 'C:\\Users\\ritud\\.tori-release-backups\\gate32_3_pre_pub_20261122';

const REPO = 'robijoychakma375-hash/tori-download-manager';
const TAG = 'v1.0.7';
const VERSION = '1.0.7';
const RELEASE_NAME = 'TORI Download Manager v1.0.7';
const APPROVED_RELEASE_COMMIT = '84da0c08256d6abaca253b5612010034237c86f9';

const EXPECTED_FROZEN = {
  installerFile: 'TORI Download Manager_1.0.7_x64-setup.exe',
  installerPublicName: 'TORI.Download.Manager_1.0.7_x64-setup.exe',
  installerBytes: 118097450,
  installerSha256: '142e4528410a70c43cf7166acda87d8b27e293348237113b2350a025467966cb',
  sigFile: 'TORI Download Manager_1.0.7_x64-setup.exe.sig',
  sigPublicName: 'TORI.Download.Manager_1.0.7_x64-setup.exe.sig',
  sigBytes: 436,
  sigSha256: '945b5efdcc69edf85373c54cfdb603d50976f5ba6be75bef5e130ca5350224e8',
  desktopExe: 'tori-download-manager.exe',
  desktopBytes: 32038912,
  desktopSha256: '7707261181fdded28aa99e19ab8334f6f9942943338d3bf25b055889f2b9389c',
  nativeHostExe: 'tdm-native-host.exe',
  nativeHostBytes: 19364864,
  nativeHostSha256: '2a88db0c749dac21cf69fce1580e674cef7d4478d6b98728858277141db60c41',
  cliExe: 'tdm-cli.exe',
  cliBytes: 17018368,
  cliSha256: 'f3a7f78f7d1de67ff3cdfc141387bdafc0380b4a0048bd19f07cfc92f17b7ee4',
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
          'User-Agent': 'TORI-Gate32-3-Release-Manager',
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
  const args = ['-sS', '-L', '--http1.1', '--retry', '4', '--retry-delay', '2', '-o', destPath, '-w', '%{http_code}'];
  if (token) args.push('-H', `Authorization: Bearer ${token}`);
  if (acceptOctet) args.push('-H', 'Accept: application/octet-stream');
  args.push('-H', 'User-Agent: TORI-Gate32-3-Release-Manager', url);
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

function buildPublicReleaseNotesMarkdown() {
  return `# TORI Download Manager v1.0.7 — Independent External Tools Auto-Update Manager

> **Release Type:** Desktop-only stable production release (Windows 10 / 11, 64-bit)  
> **Compatible Browser Companion:** \`v1.0.10\` (unchanged — available separately under [\`extension-v1.0.10\`](https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/extension-v1.0.10))

---

## Major New Features

### 1. Independent External Tools Auto-Update Manager (\`yt-dlp\`, \`FFmpeg\`, \`FFprobe\`)
- Keep \`yt-dlp\`, \`FFmpeg\`, and \`FFprobe\` up to date independently without waiting for a full TORI Desktop release.
- **Automatic Daily Checks (Every 24 Hours):** Non-blocking background checks run on startup if due and every 24 hours by default (configurable to 24 hours, 7 days, or Manual only).
- **Cryptographically Authenticated \`yt-dlp\` Updates:** Verifies official \`yt-dlp/yt-dlp\` GitHub releases in pure Rust using RFC 4880 V4 OpenPGP RSA-4096 detached signatures against \`yt-dlp\`'s pinned signing key (\`AC0CBBE6848D6A873464AF4E57CF65933B5A7581\`) and SHA-256 digests.
- **Trusted Ed25519-Signed \`FFmpeg\` & \`FFprobe\` Updates:** Verified via TORI's production Ed25519-signed tools manifest (\`https://toridownload.xyz/assets/tools/tools-manifest.json\`, \`schema_version: 2\`, key ID \`CDC23D8CC8DA5397\`) with exact byte-size, SHA-256, Windows x64 PE32+, version-parity, and live media pipeline self-tests before activation.
- **Atomic Paired Activation & Rollback:** \`FFmpeg\` and \`FFprobe\` are staged, health-tested, activated, and rolled back together as a single versioned bundle.
- **Active Download Protection & Deferred Activation:** RAII usage leases across every \`yt-dlp\`, \`FFmpeg\`, and \`FFprobe\` execution path ensure active downloads, extractions, and merges are never interrupted; verified updates defer cleanly to \`Pending Activation\` and promote once idle.
- **Automatic Rollback, Quarantine & Bundled Fallback:** Failed post-activation health checks automatically revert to the prior known-good version (or verified bundled binaries in \`<install_dir>\\bin\\\`) and quarantine defective versions.
- **New Settings → External Tools Panel:** Shows installed vs. latest versions, live transfer progress and speed, policy toggles, manual Check / Update / Roll Back / Open Tool Location controls, and SQLite-backed Update History in Light and Dark themes.

### 2. Reliability & Security Hardening
- Resumable large tool downloads over HTTPS with bounded idle timeouts and strict final size/SHA-256 verification.
- Manifest anti-replay (\`manifest_revision\`), publication/expiration bounds, duplicate JSON key rejection, TORI SemVer bounds, and emergency higher-revision signed rollback support.
- Crash-safe \`active-tools.json\` atomic replacement with \`.bak\` recovery and hardened Zip-Slip/symlink/zip-bomb extraction protection.
- Preserves all Gate 29.2 / 31.4 / 31.5 / 31.6 improvements: standalone IDM-style Download Progress Window (legacy dark floating toast removed), Close-to-Tray reliability, NSIS stale-path auto-recovery, and lingering-instance cleanup.

---

## SHA-256 Checksums

| File | Size (Bytes) | SHA-256 |
|---|---:|---|
| \`TORI.Download.Manager_1.0.7_x64-setup.exe\` | \`118,097,450\` | \`142e4528410a70c43cf7166acda87d8b27e293348237113b2350a025467966cb\` |
| \`TORI.Download.Manager_1.0.7_x64-setup.exe.sig\` | \`436\` | \`945b5efdcc69edf85373c54cfdb603d50976f5ba6be75bef5e130ca5350224e8\` |
| \`tori-download-manager.exe\` | \`32,038,912\` | \`7707261181fdded28aa99e19ab8334f6f9942943338d3bf25b055889f2b9389c\` |
| \`tdm-native-host.exe\` | \`19,364,864\` | \`2a88db0c749dac21cf69fce1580e674cef7d4478d6b98728858277141db60c41\` |
| \`tdm-cli.exe\` | \`17,018,368\` | \`f3a7f78f7d1de67ff3cdfc141387bdafc0380b4a0048bd19f07cfc92f17b7ee4\` |

Verify in PowerShell:
\`\`\`powershell
Get-FileHash .\\TORI.Download.Manager_1.0.7_x64-setup.exe -Algorithm SHA256
\`\`\`

---

## Compatibility & Known Limitations

- **Browser Companion \`v1.0.10\`:** Fully compatible across Chrome, Edge, and Mozilla-signed Firefox without reinstallation.
- **Windows Authenticode Code Signing Unavailable (\`NotSigned\`):** Manual downloads may display a Windows Defender SmartScreen prompt until a commercial OV/EV certificate is configured. (In-app Tauri Desktop Auto-Updater and External Tools Manifest verification independently enforce Ed25519 cryptography with key ID \`CDC23D8CC8DA5397\`.)
- **Independent Clean Windows VM Verification Not Performed (\`NOT TESTED\`):** Verified on Windows 11 using isolated profiles, isolated install directories, and physical \`v1.0.6 → v1.0.7\` upgrades.
- **Paid DRM-Protected Media:** Intentionally unsupported.
`;
}

function stagePublicAssets() {
  console.log('=== PHASE 7: STAGING FROZEN DESKTOP v1.0.7 PUBLIC ASSETS ===');

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
  console.log('[OK] All 5 frozen v1.0.7 RC binaries & signature match Gate 32.2 approved hashes bit-for-bit.');

  let existingPubDate = null;
  const existingLatestPath = path.join(PUB_DIR, 'latest.json');
  if (fs.existsSync(existingLatestPath)) {
    try { existingPubDate = JSON.parse(fs.readFileSync(existingLatestPath, 'utf8')).pub_date || null; } catch {}
  }

  fs.rmSync(PUB_DIR, { recursive: true, force: true });
  fs.mkdirSync(PUB_DIR, { recursive: true });

  // Copy frozen binaries (filename-only dotted rename for public GitHub installer & .sig)
  fs.copyFileSync(path.join(RC_DIR, EXPECTED_FROZEN.installerFile), path.join(PUB_DIR, EXPECTED_FROZEN.installerPublicName));
  fs.copyFileSync(path.join(RC_DIR, EXPECTED_FROZEN.sigFile), path.join(PUB_DIR, EXPECTED_FROZEN.sigPublicName));
  fs.copyFileSync(path.join(RC_DIR, EXPECTED_FROZEN.desktopExe), path.join(PUB_DIR, EXPECTED_FROZEN.desktopExe));
  fs.copyFileSync(path.join(RC_DIR, EXPECTED_FROZEN.nativeHostExe), path.join(PUB_DIR, EXPECTED_FROZEN.nativeHostExe));
  fs.copyFileSync(path.join(RC_DIR, EXPECTED_FROZEN.cliExe), path.join(PUB_DIR, EXPECTED_FROZEN.cliExe));

  if (
    sha256File(path.join(PUB_DIR, EXPECTED_FROZEN.installerPublicName)) !== EXPECTED_FROZEN.installerSha256 ||
    sha256File(path.join(PUB_DIR, EXPECTED_FROZEN.sigPublicName)) !== EXPECTED_FROZEN.sigSha256
  ) {
    throw new Error('Renamed public installer/sig hash mismatch');
  }

  // Copy license files
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

  // Copy & prepare metadata/documentation assets
  const rcBuildMeta = JSON.parse(fs.readFileSync(path.join(RC_DIR, 'BUILD_METADATA.json'), 'utf8'));
  const pubBuildMeta = {
    ...rcBuildMeta,
    gate: 'Gate 32.3',
    release_type: 'desktop_minor_public_stable',
    published: true,
    release_source_commit: APPROVED_RELEASE_COMMIT,
    release_tag: TAG,
  };
  fs.writeFileSync(path.join(PUB_DIR, 'BUILD_METADATA.json'), JSON.stringify(pubBuildMeta, null, 2) + '\n', 'utf8');

  const rcReleaseMan = JSON.parse(fs.readFileSync(path.join(RC_DIR, 'RELEASE_MANIFEST.json'), 'utf8'));
  const pubReleaseMan = {
    ...rcReleaseMan,
    gate: 'Gate 32.3',
    status: 'PUBLIC_STABLE',
    published: true,
    release_source_commit: APPROVED_RELEASE_COMMIT,
    release_tag: TAG,
    external_tools_manifest: {
      ...rcReleaseMan.external_tools_manifest,
      production_promoted: true,
    },
  };
  delete pubReleaseMan.planned_release_actions_blocked_until_gate32_3_approval;
  fs.writeFileSync(path.join(PUB_DIR, 'RELEASE_MANIFEST.json'), JSON.stringify(pubReleaseMan, null, 2) + '\n', 'utf8');

  fs.writeFileSync(path.join(PUB_DIR, 'RELEASE_NOTES_v1.0.7.md'), buildPublicReleaseNotesMarkdown(), 'utf8');
  fs.copyFileSync(path.join(RC_DIR, 'INSTALLATION_AND_UPGRADE.md'), path.join(PUB_DIR, 'INSTALLATION_AND_UPGRADE.md'));

  // Validate signature & promote verified draft_latest.json -> latest.json
  const sigText = fs.readFileSync(path.join(PUB_DIR, EXPECTED_FROZEN.sigPublicName), 'utf8').trim();
  const decodedSig = Buffer.from(sigText, 'base64').toString('utf8');
  if (!decodedSig.includes('untrusted comment: signature from tauri secret key') || !decodedSig.includes('TORI Download Manager_1.0.7_x64-setup.exe')) {
    throw new Error(`Unexpected Ed25519 signature content: ${decodedSig.slice(0, 120)}`);
  }

  const publicInstallerUrl = `https://github.com/${REPO}/releases/download/${TAG}/${EXPECTED_FROZEN.installerPublicName}`;
  const latestJsonObj = {
    version: VERSION,
    notes:
      'TORI Download Manager v1.0.7 — Independent External Tools Auto-Update Manager.\n\n' +
      '- New: Independent External Tools Auto-Update Manager for yt-dlp (OpenPGP RSA-4096), FFmpeg, and FFprobe (TORI Ed25519 signed manifest)\n' +
      '- New: Automatic daily (24h) non-blocking checks, atomic paired FFmpeg+FFprobe activation, active download protection, automatic/manual rollback, and Settings -> External Tools panel with Update History\n' +
      '- Improved: Resumable large tool downloads, manifest anti-replay/expiry protection, crash-safe activation, verified bundled fallback, and unified extraction tool leases\n' +
      '- Compat: Fully compatible with Browser Companion v1.0.10 (Chrome, Edge, Firefox) while preserving existing SQLite downloads, settings, and .tdm-part files',
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

  const parsedLj = JSON.parse(fs.readFileSync(path.join(PUB_DIR, 'latest.json'), 'utf8'));
  if (
    parsedLj.version !== VERSION ||
    parsedLj.platforms['windows-x86_64'].url !== publicInstallerUrl ||
    parsedLj.platforms['windows-x86_64-nsis'].url !== publicInstallerUrl ||
    parsedLj.platforms['windows-x86_64'].signature !== sigText ||
    parsedLj.platforms['windows-x86_64-nsis'].signature !== sigText ||
    latestJsonStr.includes('/staging/') ||
    latestJsonStr.includes('127.0.0.1')
  ) {
    throw new Error('latest.json strict pre-upload validation failed');
  }
  console.log(`[OK] Generated & validated latest.json (version=${parsedLj.version}, pub_date=${parsedLj.pub_date})`);

  // Generate SHA256SUMS.txt covering all published Desktop v1.0.7 assets
  const sumTargets = [
    EXPECTED_FROZEN.installerPublicName,
    EXPECTED_FROZEN.sigPublicName,
    EXPECTED_FROZEN.desktopExe,
    EXPECTED_FROZEN.nativeHostExe,
    EXPECTED_FROZEN.cliExe,
    'latest.json',
    'BUILD_METADATA.json',
    'RELEASE_MANIFEST.json',
    'RELEASE_NOTES_v1.0.7.md',
    'INSTALLATION_AND_UPGRADE.md',
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
    { name: 'BUILD_METADATA.json', contentType: 'application/json' },
    { name: 'RELEASE_MANIFEST.json', contentType: 'application/json' },
    { name: 'RELEASE_NOTES_v1.0.7.md', contentType: 'text/markdown' },
    { name: 'INSTALLATION_AND_UPGRADE.md', contentType: 'text/markdown' },
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
  console.log('\n=== PHASE 7: GITHUB TWO-PHASE PUBLICATION (DRAFT -> UPLOAD -> VERIFY -> LATEST STABLE) ===');

  const localTagCommit = execFileSync('git', ['rev-list', '-n', '1', TAG], { cwd: ROOT, encoding: 'utf8' }).trim();
  const remoteTagLine = execFileSync('git', ['ls-remote', 'origin', `refs/tags/${TAG}^{}`], { cwd: ROOT, encoding: 'utf8' }).trim();
  const remoteTagCommit = remoteTagLine ? remoteTagLine.split(/\s+/)[0] : '';
  if (localTagCommit !== APPROVED_RELEASE_COMMIT || remoteTagCommit !== APPROVED_RELEASE_COMMIT) {
    throw new Error(
      `Tag ${TAG} mismatch! local=${localTagCommit}, remote=${remoteTagCommit}, expected=${APPROVED_RELEASE_COMMIT}. Push annotated tag ${TAG} first.`
    );
  }
  console.log(`[OK] Verified local & remote tag ${TAG} -> ${APPROVED_RELEASE_COMMIT}`);

  const releaseBody = fs.readFileSync(path.join(PUB_DIR, 'RELEASE_NOTES_v1.0.7.md'), 'utf8');

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
    console.log(`[RESUME] Using existing DRAFT release ID=${release.id}; updating metadata...`);
    const up = await requestJson('PATCH', `/repos/${REPO}/releases/${release.id}`, token, {
      name: RELEASE_NAME,
      body: releaseBody,
      draft: true,
      prerelease: false,
    });
    if (up.status !== 200) throw new Error(`Failed updating draft release: HTTP ${up.status}`);
    release = up.data;
  }

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
      console.log(`  [DELETE] Removing stale draft asset ${asset.name} (ID=${prev.id}, size=${prev.size})...`);
      await requestJson('DELETE', `/repos/${REPO}/releases/assets/${prev.id}`, token);
    }
    const up = uploadAssetStreamingWithRetry(release.upload_url, asset.filePath, asset.name, asset.contentType, token, 6);
    if (!up.ok) {
      throw new Error(`Failed to upload asset ${asset.name} after retries — draft release NOT published.`);
    }
    uploadedRecords.push({ ...asset, id: up.data.id, url: up.data.url, browser_download_url: up.data.browser_download_url });
  }

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

  // Pre-publish download & SHA-256 verification of critical draft assets
  const dlCheckDir = path.join(RECORD_DIR, 'draft_v107_download_verify');
  fs.rmSync(dlCheckDir, { recursive: true, force: true });
  fs.mkdirSync(dlCheckDir, { recursive: true });
  for (const criticalName of [
    EXPECTED_FROZEN.installerPublicName,
    EXPECTED_FROZEN.sigPublicName,
    'latest.json',
    'SHA256SUMS.txt',
    EXPECTED_FROZEN.desktopExe,
    EXPECTED_FROZEN.nativeHostExe,
  ]) {
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

  // Promote draft release to public repository-wide Latest Stable
  console.log(`\n[PROMOTE] Publishing release ID=${release.id} (${TAG}) as repository-wide Latest Stable...`);
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

  // Immediate post-publish verification: Latest Stable == v1.0.7, v1.0.6, v1.0.5, extension-v1.0.10, tools-ffmpeg preserved
  const latestRes = await requestJson('GET', `/repos/${REPO}/releases/latest`, token);
  const v106Res = await requestJson('GET', `/repos/${REPO}/releases/tags/v1.0.6`, token);
  const v105Res = await requestJson('GET', `/repos/${REPO}/releases/tags/v1.0.5`, token);
  const extRes = await requestJson('GET', `/repos/${REPO}/releases/tags/extension-v1.0.10`, token);
  const ffRes = await requestJson('GET', `/repos/${REPO}/releases/tags/tools-ffmpeg-N-129150-g7ddf7bc8a4`, token);

  if (latestRes.data?.tag_name !== TAG) {
    throw new Error(`Expected /releases/latest to be ${TAG}, got ${latestRes.data?.tag_name}`);
  }
  if (v106Res.status !== 200 || v105Res.status !== 200 || extRes.status !== 200 || ffRes.status !== 200) {
    throw new Error(`Preservation check failed: v106=${v106Res.status}, v105=${v105Res.status}, ext=${extRes.status}, ff=${ffRes.status}`);
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
    preserved_v106_id: v106Res.data.id,
    preserved_v105_id: v105Res.data.id,
    preserved_ext_v1010_id: extRes.data.id,
    preserved_tools_ffmpeg_id: ffRes.data.id,
  };
  fs.writeFileSync(path.join(RECORD_DIR, 'published_v107_release.json'), JSON.stringify(recordOut, null, 2));
  console.log('\n[SUCCESS] Published Desktop v1.0.7 as Latest Stable & recorded metadata in ' + path.join(RECORD_DIR, 'published_v107_release.json'));
}

(async () => {
  const mode = process.argv[2] || '--stage-only';
  if (mode === '--stage-only') {
    stagePublicAssets();
  } else if (mode === '--publish') {
    await publishRelease();
  } else {
    console.error('Usage: node scripts/publish_desktop_v1_0_7_release.js [--stage-only|--publish]');
    process.exit(1);
  }
})().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
