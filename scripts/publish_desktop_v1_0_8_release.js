#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 34.2
 * Desktop v1.0.8 Public Stable Release Stager & Two-Phase GitHub Publisher
 *
 * Strictly Desktop-only release using the FROZEN Gate 33.3 Final RC artifacts in
 * release/v1.0.8-final-rc/ built from verified source commit 1a24265d247a43371ab2b637e195425df2c78b82.
 * Never rebuilds binaries, never modifies Browser Companion v1.0.10, never alters
 * production tools manifest revision 2, and never removes historical releases.
 *
 * Usage:
 *   node scripts/publish_desktop_v1_0_8_release.js --stage-only
 *   node scripts/publish_desktop_v1_0_8_release.js --draft-only
 *   node scripts/publish_desktop_v1_0_8_release.js --publish
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RC_DIR = path.join(ROOT, 'release', 'v1.0.8-final-rc');
const PUB_DIR = path.join(ROOT, 'release', 'v1.0.8-public');
const RECORD_DIR = 'C:\\Users\\ritud\\.tori-release-backups\\gate34_2_pre_pub_20261123';

const REPO = 'robijoychakma375-hash/tori-download-manager';
const TAG = 'v1.0.8';
const VERSION = '1.0.8';
const RELEASE_NAME = 'TORI Download Manager v1.0.8';
const APPROVED_RELEASE_COMMIT = '1a24265d247a43371ab2b637e195425df2c78b82';
const UPDATER_KEY_ID = 'CDC23D8CC8DA5397';
const DEDICATED_TOOLS_KEY_ID = 'C3FD6626A3718E63';
const DEDICATED_TOOLS_KEY_FP = '6807e183f56c08eb06fdff95347bbbf7174b4ce5185b0245155db315e87fee39';

const EXPECTED_FROZEN = {
  installerFile: 'TORI Download Manager_1.0.8_x64-setup.exe',
  installerPublicName: 'TORI.Download.Manager_1.0.8_x64-setup.exe',
  installerBytes: 118110372,
  installerSha256: '728d0d253a8fadc3fea5244723237f267dcd13abf65cac49b91a4ec83a3dcffb',
  sigFile: 'TORI Download Manager_1.0.8_x64-setup.exe.sig',
  sigPublicName: 'TORI.Download.Manager_1.0.8_x64-setup.exe.sig',
  sigBytes: 436,
  sigSha256: '8f2bc20bd2c8994ac04d8d2fc84be37b5569f11caeb47b63f369a4c72b44294c',
  desktopExe: 'tori-download-manager.exe',
  desktopBytes: 32102400,
  desktopSha256: '197d2b6bda12a6a4aa8a71664d0bde8b7db723a836f04980bd48fbccecbb6fbf',
  nativeHostExe: 'tdm-native-host.exe',
  nativeHostBytes: 19365888,
  nativeHostSha256: '703a901c4b0be3c6f956d726e8d0551ba9fe9ea319a4d8cbd76ca9eefddaacdd',
  cliExe: 'tdm-cli.exe',
  cliBytes: 17016832,
  cliSha256: '19d09bb948a8940e36e6a97184c0d13534c87a5aea838b6a2f58ca6d959479e2',
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

function verifyTauriEd25519Sig(payloadPath, sigTextB64) {
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const pubB64 = conf.plugins.updater.pubkey.trim();
  const decPubLines = Buffer.from(pubB64, 'base64').toString('utf8').trim().split(/\r?\n/);
  const pkRaw = Buffer.from(decPubLines[1].trim(), 'base64');
  const keyId = pkRaw.subarray(2, 10);
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pkRaw.subarray(10, 42)]);
  const pubKey = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });

  const sigText = Buffer.from(sigTextB64.trim(), 'base64').toString('utf8').trim();
  const lines = sigText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sigRaw = Buffer.from(lines[1], 'base64');
  const alg = sigRaw.subarray(0, 2).toString('ascii');
  if (!sigRaw.subarray(2, 10).equals(keyId)) throw new Error('Signature key ID mismatch against tauri.conf.json');
  const sigBytes = sigRaw.subarray(10, 74);
  const tc = lines[2].slice('trusted comment: '.length);
  const gsig = Buffer.from(lines[3], 'base64');
  const dataBuf = fs.readFileSync(payloadPath);
  const msg = alg === 'ED' ? crypto.createHash('blake2b512').update(dataBuf).digest() : dataBuf;
  const ok1 = crypto.verify(null, msg, pubKey, sigBytes);
  const ok2 = crypto.verify(null, Buffer.concat([sigBytes, Buffer.from(tc, 'utf8')]), pubKey, gsig);
  if (!ok1 || !ok2) throw new Error(`Ed25519 signature verification failed for ${payloadPath}`);
  return { ok: true, trustedComment: tc };
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
          'User-Agent': 'TORI-Gate34-2-Release-Manager',
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
  args.push('-H', 'User-Agent: TORI-Gate34-2-Release-Manager', url);
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
  return `# TORI Download Manager v1.0.8 — Stage 1 External Tools Key-Separation & Security Hardening

> **Release Type:** Desktop-only stable production release (Windows 10 / 11, 64-bit)  
> **Compatible Browser Companion:** \`v1.0.10\` (unchanged — available separately under [\`extension-v1.0.10\`](https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/extension-v1.0.10))

---

## Security & Reliability Improvements

### 1. Stage 1 Dual-Key External Tools Trust Architecture
- Embeds TORI's dedicated External Tools Ed25519 public key (\`${DEDICATED_TOOLS_KEY_ID}\`, SHA-256 fingerprint \`${DEDICATED_TOOLS_KEY_FP}\`) alongside the existing legacy shared production key (\`${UPDATER_KEY_ID}\`) in \`TrustedToolsKeyring\`.
- Preserves full backward compatibility with live production External Tools manifest revision 2 (\`https://toridownload.xyz/assets/tools/tools-manifest.json\`, signed by \`${UPDATER_KEY_ID}\`) and with existing Desktop \`v1.0.7\` installations.
- Keeps TORI Desktop Auto-Updater trust exclusively anchored on \`${UPDATER_KEY_ID}\`, enforcing strict purpose separation between Desktop updater keys and External Tools manifest keys.
- Dedicated-only production manifest signing is **not** activated in this release; Stage 1 dual-key transition maintains seamless compatibility across the fleet.

### 2. Supply-Chain Hardening & Diagnostics
- **Purpose-Bound & Revocation-Aware Verification:** Rejects revoked signing keys, unknown keys, wrong-purpose keys, tampered manifest payloads, corrupted signatures, missing detached signatures, replay downgrades, and equivocation fail-closed.
- **Anti-Trust-Escalation Guard:** Rejects remote manifests attempting to inject inline trust-root or key-rotation directives; trusted keys can only change through an authenticated Desktop release.
- **Manifest Verification Status UI:** **Settings → External Tools** surfaces verified manifest status, active revision, signing key ID and purpose, last verified timestamp, and next check schedule in Light and Dark themes without exposing secret material.
- **Preserved Core Functionality:** Retains multi-connection HTTP/HLS/DASH engine, OpenPGP-verified \`yt-dlp\` updates, Ed25519-verified paired \`FFmpeg\`/\`FFprobe\` updates with atomic rollback and bundled fallback, standalone IDM Progress Window, Close-to-Tray reliability, and full Chrome/Edge/Firefox Native Messaging with Browser Companion \`v1.0.10\`.

---

## SHA-256 Checksums

| File | Size (Bytes) | SHA-256 |
|---|---:|---|
| \`TORI.Download.Manager_1.0.8_x64-setup.exe\` | \`118,110,372\` | \`728d0d253a8fadc3fea5244723237f267dcd13abf65cac49b91a4ec83a3dcffb\` |
| \`TORI.Download.Manager_1.0.8_x64-setup.exe.sig\` | \`436\` | \`8f2bc20bd2c8994ac04d8d2fc84be37b5569f11caeb47b63f369a4c72b44294c\` |
| \`tori-download-manager.exe\` | \`32,102,400\` | \`197d2b6bda12a6a4aa8a71664d0bde8b7db723a836f04980bd48fbccecbb6fbf\` |
| \`tdm-native-host.exe\` | \`19,365,888\` | \`703a901c4b0be3c6f956d726e8d0551ba9fe9ea319a4d8cbd76ca9eefddaacdd\` |
| \`tdm-cli.exe\` | \`17,016,832\` | \`19d09bb948a8940e36e6a97184c0d13534c87a5aea838b6a2f58ca6d959479e2\` |

Verify in PowerShell:
\`\`\`powershell
Get-FileHash .\\TORI.Download.Manager_1.0.8_x64-setup.exe -Algorithm SHA256
\`\`\`

---

## Upgrade Compatibility & Known Limitations

- **Seamless In-Place Upgrade (\`v1.0.7 → v1.0.8\`):** Preserves existing downloads, \`.tdm-part\` partial files, SQLite history, themes, Close-to-Tray settings, and Native Messaging registrations.
- **Browser Companion \`v1.0.10\`:** Fully compatible across Firefox, Chrome, and Edge with no extension update or reinstall required.
- **Windows Authenticode Code Signing Unavailable (\`NotSigned\`):** Manual downloads may display a Windows Defender SmartScreen prompt ("More info" → "Run anyway"). In-app Tauri Desktop Auto-Updater verification independently enforces Ed25519 cryptography (\`${UPDATER_KEY_ID}\`).
- **Independent Clean Windows 10 / 11 VM Verification Not Performed (\`NOT TESTED\`):** Verified on Windows 11 using isolated profiles, isolated install directories, and real \`v1.0.7 → v1.0.8\` upgrades.
- **Paid DRM-Protected Media:** Intentionally unsupported.
`;
}

function stagePublicAssets() {
  console.log('=== PHASES 5-7: STAGING FROZEN DESKTOP v1.0.8 PUBLIC ASSETS ===');

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
  console.log('[OK] All 5 frozen v1.0.8 Final RC binaries & signature match approved hashes bit-for-bit.');

  let existingPubDate = null;
  const existingLatestPath = path.join(PUB_DIR, 'latest.json');
  if (fs.existsSync(existingLatestPath)) {
    try { existingPubDate = JSON.parse(fs.readFileSync(existingLatestPath, 'utf8')).pub_date || null; } catch {}
  }

  fs.rmSync(PUB_DIR, { recursive: true, force: true });
  fs.mkdirSync(PUB_DIR, { recursive: true });

  // Byte-identical copy with established dot-separated GitHub installer & .sig asset names
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

  const sigText = fs.readFileSync(path.join(PUB_DIR, EXPECTED_FROZEN.sigPublicName), 'utf8').trim();
  const sigCheck = verifyTauriEd25519Sig(path.join(PUB_DIR, EXPECTED_FROZEN.installerPublicName), sigText);
  console.log(`[OK] Cryptographically verified Ed25519 signature over staged installer (${sigCheck.trustedComment})`);

  // Copy license files matching established v1.0.7 Desktop release inventory
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

  // Metadata & public release documentation
  const rcBuildMeta = JSON.parse(fs.readFileSync(path.join(RC_DIR, 'BUILD_METADATA.json'), 'utf8'));
  const pubBuildMeta = {
    ...rcBuildMeta,
    gate: 'Gate 34.2',
    release_type: 'desktop_minor_public_stable_stage1_dual_key',
    published: true,
    release_source_commit: APPROVED_RELEASE_COMMIT,
    release_tag: TAG,
    dedicated_tools_public_key_id: DEDICATED_TOOLS_KEY_ID,
    dedicated_tools_public_key_sha256: DEDICATED_TOOLS_KEY_FP,
    dedicated_only_production_cutover: false,
  };
  fs.writeFileSync(path.join(PUB_DIR, 'BUILD_METADATA.json'), JSON.stringify(pubBuildMeta, null, 2) + '\n', 'utf8');

  const rcReleaseMan = JSON.parse(fs.readFileSync(path.join(RC_DIR, 'RELEASE_MANIFEST.json'), 'utf8'));
  const pubReleaseMan = {
    ...rcReleaseMan,
    gate: 'Gate 34.2',
    status: 'PUBLIC_STABLE',
    published: true,
    release_source_commit: APPROVED_RELEASE_COMMIT,
    release_tag: TAG,
    owner_accepted_stage1_risks: {
      'RISK-34-01': 'ACCEPTED_FOR_STAGE1_DESKTOP_RELEASE (offline key backup not verified; Stage 2 cutover blocked)',
      'RISK-34-02': 'ACCEPTED_FOR_STAGE1_DESKTOP_RELEASE (clean Windows 10/11 VM not tested)',
      'RISK-34-03': 'ACCEPTED_FOR_STAGE1_DESKTOP_RELEASE (Windows Authenticode NotSigned; Ed25519 mandatory)',
    },
  };
  fs.writeFileSync(path.join(PUB_DIR, 'RELEASE_MANIFEST.json'), JSON.stringify(pubReleaseMan, null, 2) + '\n', 'utf8');

  fs.writeFileSync(path.join(PUB_DIR, 'RELEASE_NOTES_v1.0.8.md'), buildPublicReleaseNotesMarkdown(), 'utf8');
  fs.copyFileSync(path.join(RC_DIR, 'INSTALLATION_AND_UPGRADE.md'), path.join(PUB_DIR, 'INSTALLATION_AND_UPGRADE.md'));

  // Prepare clean public latest.json (strip LOCAL UNPUBLISHED DRAFT, refresh pub_date, keep exact signature & dot-named URL)
  const publicInstallerUrl = `https://github.com/${REPO}/releases/download/${TAG}/${EXPECTED_FROZEN.installerPublicName}`;
  const latestJsonObj = {
    version: VERSION,
    notes:
      'TORI Download Manager v1.0.8 — Stage 1 External Tools Key-Separation & Security Hardening.\n\n' +
      `- Security: Embeds TORI dedicated External Tools Ed25519 public key (${DEDICATED_TOOLS_KEY_ID}) alongside legacy shared key (${UPDATER_KEY_ID}) for Stage 1 dual-key transition\n` +
      '- Hardening: Purpose-bound signing key separation, revocation-aware keyring verification, anti-trust-escalation manifest guards, and Settings -> External Tools manifest verification status UI\n' +
      '- Compat: Preserves full compatibility with live production tools manifest revision 2, existing Desktop v1.0.7 upgrades, SQLite downloads/.tdm-part files, and Browser Companion v1.0.10 (Firefox, Chrome, Edge)',
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
    latestJsonStr.includes('DRAFT') ||
    latestJsonStr.includes('/staging/') ||
    latestJsonStr.includes('127.0.0.1') ||
    latestJsonStr.includes('localhost')
  ) {
    throw new Error('latest.json strict pre-upload validation failed');
  }
  console.log(`[OK] Generated & validated public latest.json (version=${parsedLj.version}, pub_date=${parsedLj.pub_date})`);

  // Generate public SHA256SUMS.txt covering all published Desktop v1.0.8 assets
  const sumTargets = [
    EXPECTED_FROZEN.installerPublicName,
    EXPECTED_FROZEN.sigPublicName,
    EXPECTED_FROZEN.desktopExe,
    EXPECTED_FROZEN.nativeHostExe,
    EXPECTED_FROZEN.cliExe,
    'latest.json',
    'BUILD_METADATA.json',
    'RELEASE_MANIFEST.json',
    'RELEASE_NOTES_v1.0.8.md',
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
    { name: 'RELEASE_NOTES_v1.0.8.md', contentType: 'text/markdown' },
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

  // Verify zero secret/key/companion artifacts in staged public directory
  for (const name of fs.readdirSync(PUB_DIR)) {
    const low = name.toLowerCase();
    if (low.endsWith('.key') || low.endsWith('.pwd') || low.endsWith('.sqlite') || low.endsWith('.xpi') || low.includes('companion')) {
      throw new Error(`Forbidden artifact detected in ${PUB_DIR}: ${name}`);
    }
  }

  console.log(`\nStaged ${assets.length} Desktop-only public assets in ${PUB_DIR}:`);
  for (const a of assets) {
    console.log(`  ${a.name.padEnd(46)} ${String(a.size).padStart(11)} B  ${a.sha256}`);
  }
  return { assets, latestJsonObj };
}

async function ensureDraftVerified() {
  const { assets, latestJsonObj } = stagePublicAssets();
  const token = await getGitHubToken();
  console.log('\n=== PHASE 8: GITHUB DRAFT STAGING & ROUNDTRIP INTEGRITY VERIFICATION ===');

  const localTagCommit = execFileSync('git', ['rev-list', '-n', '1', TAG], { cwd: ROOT, encoding: 'utf8' }).trim();
  const remoteTagLine = execFileSync('git', ['ls-remote', 'origin', `refs/tags/${TAG}^{}`], { cwd: ROOT, encoding: 'utf8' }).trim();
  const remoteTagCommit = remoteTagLine ? remoteTagLine.split(/\s+/)[0] : '';
  if (localTagCommit !== APPROVED_RELEASE_COMMIT || remoteTagCommit !== APPROVED_RELEASE_COMMIT) {
    throw new Error(
      `Tag ${TAG} mismatch! local=${localTagCommit}, remote=${remoteTagCommit}, expected=${APPROVED_RELEASE_COMMIT}. Push annotated tag ${TAG} pointing to ${APPROVED_RELEASE_COMMIT} first.`
    );
  }
  console.log(`[OK] Verified local & remote tag ${TAG} -> ${APPROVED_RELEASE_COMMIT}`);

  const releaseBody = fs.readFileSync(path.join(PUB_DIR, 'RELEASE_NOTES_v1.0.8.md'), 'utf8');

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

  // Pre-publish download, SHA-256 & Ed25519 roundtrip verification of critical draft assets
  const dlCheckDir = path.join(RECORD_DIR, 'draft_v108_download_verify');
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
  verifyTauriEd25519Sig(
    path.join(dlCheckDir, EXPECTED_FROZEN.installerPublicName),
    fs.readFileSync(path.join(dlCheckDir, EXPECTED_FROZEN.sigPublicName), 'utf8').trim()
  );
  console.log('[OK] Roundtrip downloaded DRAFT installer + .sig passed live Ed25519 verification!');
  return { release, uploadedRecords, latestJsonObj, token };
}

async function publishRelease() {
  const { release, uploadedRecords, latestJsonObj, token } = await ensureDraftVerified();

  // Promote draft release to public repository-wide Latest Stable (Phase 10)
  console.log(`\n=== PHASE 10: PUBLISHING RELEASE ID=${release.id} (${TAG}) AS REPOSITORY-WIDE LATEST STABLE ===`);
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

  // Immediate post-publish verification: Latest Stable == v1.0.8, historical releases preserved
  const latestRes = await requestJson('GET', `/repos/${REPO}/releases/latest`, token);
  const v107Res = await requestJson('GET', `/repos/${REPO}/releases/tags/v1.0.7`, token);
  const v106Res = await requestJson('GET', `/repos/${REPO}/releases/tags/v1.0.6`, token);
  const extRes = await requestJson('GET', `/repos/${REPO}/releases/tags/extension-v1.0.10`, token);
  const ffRes = await requestJson('GET', `/repos/${REPO}/releases/tags/tools-ffmpeg-N-129150-g7ddf7bc8a4`, token);

  if (latestRes.data?.tag_name !== TAG) {
    throw new Error(`Expected /releases/latest to be ${TAG}, got ${latestRes.data?.tag_name}`);
  }
  if (v107Res.status !== 200 || v106Res.status !== 200 || extRes.status !== 200 || ffRes.status !== 200) {
    throw new Error(`Preservation check failed: v107=${v107Res.status}, v106=${v106Res.status}, ext=${extRes.status}, ff=${ffRes.status}`);
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
    preserved_v107_id: v107Res.data.id,
    preserved_v106_id: v106Res.data.id,
    preserved_ext_v1010_id: extRes.data.id,
    preserved_tools_ffmpeg_id: ffRes.data.id,
  };
  const outFile = path.join(RECORD_DIR, 'published_v108_release.json');
  fs.writeFileSync(outFile, JSON.stringify(recordOut, null, 2));
  console.log('\n[SUCCESS] Published Desktop v1.0.8 as Latest Stable & recorded metadata in ' + outFile);
}

(async () => {
  const mode = process.argv[2] || '--stage-only';
  if (mode === '--stage-only') {
    stagePublicAssets();
  } else if (mode === '--draft-only') {
    await ensureDraftVerified();
    console.log('\n[DRAFT_VERIFIED] All 16 assets uploaded & roundtrip verified. Ready for Phase 9 GO/NO-GO & --publish.');
  } else if (mode === '--publish') {
    await publishRelease();
  } else {
    console.error('Usage: node scripts/publish_desktop_v1_0_8_release.js [--stage-only|--draft-only|--publish]');
    process.exit(1);
  }
})().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
