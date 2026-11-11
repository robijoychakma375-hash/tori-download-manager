/**
 * TORI Browser Companion — Publish Extension v1.0.4 Dedicated Release
 *
 * Requirements:
 * - Do NOT make latest (Desktop v1.0.3 remains Latest Stable)
 * - Do NOT modify desktop release assets, installer, or latest.json
 * - Create release tagged extension-v1.0.4 targeting commit cb87c9d
 * - Upload:
 *   1. tori-download-manager-firefox-v1.0.4.xpi (Mozilla-signed XPI)
 *   2. tori-download-manager-extension-v1.0.4.zip (Chromium/Edge MV3)
 *   3. tori-download-manager-firefox-v1.0.4.zip (AMO source ZIP)
 *   4. SHA256SUMS.txt
 * - Verify that Desktop v1.0.3 remains the official Latest Stable release.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release', 'v1.0.4-extension');

const REPO_OWNER = 'robijoychakma375-hash';
const REPO_NAME = 'tori-download-manager';
const TAG_NAME = 'extension-v1.0.4';
const TARGET_COMMIT = 'extension/v1.0.4';
const RELEASE_NAME = 'TORI Browser Companion v1.0.4';

const RELEASE_BODY = `## TORI Browser Companion v1.0.4

This is a dedicated browser extension release featuring the verified toolbar popup and video download overlay redesigns for Chrome, Edge, and Mozilla Firefox.

### Compatibility
- **Compatible with:** TORI Download Manager Desktop v1.0.3 (and v1.0.2)
- **Local Engine Port:** \`127.0.0.1:6800\`
- **Native Messaging Identity:** \`tori_download_manager_host\`

---

### What's New in Extension v1.0.4
- **Toolbar Popup (Design 1):** Modern unified dark theme, real-time live connection status indicator, smooth settings drawer, capture downloads switch, and direct desktop launcher.
- **Floating Video Overlay (Design 2):** Compact floating pill button with 5px drag threshold and boundary clamping, expanding format card panel with video and audio-only download modes, format selection, and copy-link utilities.
- **Mozilla Firefox Permanent Installation:** Official Mozilla-signed \`.xpi\` package (AMO signed), supporting permanent installation without developer mode warnings.
- **Stream Classification:** Excludes HLS and DASH transport fragments (.m4s, .ts) while preserving master playlist and direct stream downloads.

---

### Release Assets & Checksums (SHA-256)
- \`tori-download-manager-firefox-v1.0.4.xpi\`  
  **SHA-256:** \`f7f8f6044b4daf56b1519825798ad8884bc4500585b921b5803b5ee295692b59\`  
  *(Officially signed by Mozilla AMO)*

- \`tori-download-manager-extension-v1.0.4.zip\`  
  **SHA-256:** \`8bb803a3c3e68427b984980dd6c7633162a75d2f48c360ac6cfca95e3ac7c626\`  
  *(For Google Chrome, Microsoft Edge, and Brave via Developer Mode / Load Unpacked)*

- \`tori-download-manager-firefox-v1.0.4.zip\`  
  **SHA-256:** \`9575da0d8eb2ef16ab123dd43e7216c09f521cb23cc347af192659a58b63eced\`  
  *(AMO source submission package with forward-slash entry formatting)*

---

*Note: TORI Download Manager Desktop remains at **v1.0.3 Latest Stable**. Desktop installers are available under the [v1.0.3 Release](https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/v1.0.3).*
`;

function getGitHubToken() {
  return new Promise((resolve, reject) => {
    if (process.env.GITHUB_TOKEN) return resolve(process.env.GITHUB_TOKEN.trim());
    if (process.env.GH_TOKEN) return resolve(process.env.GH_TOKEN.trim());

    const proc = spawn('git', ['credential', 'fill']);
    proc.stdin.write('protocol=https\nhost=github.com\n\n');
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('close', () => {
      const lines = out.split('\n');
      const passLine = lines.find((l) => l.startsWith('password='));
      if (passLine) {
        resolve(passLine.substring('password='.length).trim());
      } else {
        reject(new Error('No GitHub credential found in Git Credential Manager'));
      }
    });
    proc.on('error', reject);
  });
}

function requestJson(method, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const postData = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const reqHeaders = {
      'User-Agent': 'TORI-Release-Manager',
      Accept: 'application/vnd.github+json',
      ...headers,
    };
    if (postData) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(postData);
    }
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: urlPath,
        method,
        headers: reqHeaders,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = raw;
          try { json = JSON.parse(raw); } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, data: json });
        });
      }
    );
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function uploadAssetViaCurl(uploadUrlTemplate, filePath, fileName, contentType, token) {
  const cleanUrl = uploadUrlTemplate.replace(/\{.*?\}$/, '') + `?name=${encodeURIComponent(fileName)}`;
  const args = [
    '-s',
    '-w', '\n%{http_code}',
    '-X', 'POST',
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Accept: application/vnd.github+json',
    '-H', `Content-Type: ${contentType || 'application/octet-stream'}`,
    '--data-binary', `@${filePath}`,
    cleanUrl,
  ];
  const res = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  if (res.error) throw res.error;
  const lines = res.stdout.trim().split('\n');
  const code = parseInt(lines[lines.length - 1], 10);
  const body = lines.slice(0, lines.length - 1).join('\n');
  let data = body;
  try { data = JSON.parse(body); } catch (_) {}
  return { status: code, data };
}

async function main() {
  console.log('================================================================');
  console.log('TORI Gate 24.1: Publish Dedicated Extension v1.0.4 Release');
  console.log('================================================================\n');

  const token = await getGitHubToken();
  const headers = { Authorization: `Bearer ${token}` };

  // 1. Check existing releases to see if extension-v1.0.4 already exists
  console.log('[1/5] Checking existing GitHub releases...');
  const relsRes = await requestJson('GET', `/repos/${REPO_OWNER}/${REPO_NAME}/releases`, headers);
  if (relsRes.status !== 200) {
    throw new Error(`Failed to list releases: ${relsRes.status} ${JSON.stringify(relsRes.data)}`);
  }

  let existingRelease = relsRes.data.find((r) => r.tag_name === TAG_NAME);
  let releaseData = null;

  if (existingRelease) {
    console.log(`  Found existing release for tag ${TAG_NAME} (ID: ${existingRelease.id}).`);
    releaseData = existingRelease;
  } else {
    // 2. Create Release with make_latest: "false"
    console.log(`[2/5] Creating dedicated non-latest release ${TAG_NAME}...`);
    const createPayload = {
      tag_name: TAG_NAME,
      target_commitish: TARGET_COMMIT,
      name: RELEASE_NAME,
      body: RELEASE_BODY,
      draft: false,
      prerelease: false,
      make_latest: 'false',
    };

    const createRes = await requestJson('POST', `/repos/${REPO_OWNER}/${REPO_NAME}/releases`, headers, createPayload);
    if (createRes.status !== 201) {
      throw new Error(`Failed to create release: ${createRes.status} ${JSON.stringify(createRes.data)}`);
    }
    releaseData = createRes.data;
    console.log(`  [OK] Created release ${TAG_NAME} (ID: ${releaseData.id})`);
    console.log(`  HTML URL: ${releaseData.html_url}`);
  }

  // 3. Upload assets
  console.log('\n[3/5] Uploading verified v1.0.4 extension assets...');
  const assetsToUpload = [
    {
      name: 'tori-download-manager-firefox-v1.0.4.xpi',
      path: path.join(RELEASE_DIR, 'tori-download-manager-firefox-v1.0.4.xpi'),
      contentType: 'application/x-xpinstall',
    },
    {
      name: 'tori-download-manager-extension-v1.0.4.zip',
      path: path.join(RELEASE_DIR, 'tori-download-manager-extension-v1.0.4.zip'),
      contentType: 'application/zip',
    },
    {
      name: 'tori-download-manager-firefox-v1.0.4.zip',
      path: path.join(RELEASE_DIR, 'tori-download-manager-firefox-v1.0.4.zip'),
      contentType: 'application/zip',
    },
    {
      name: 'SHA256SUMS.txt',
      path: path.join(RELEASE_DIR, 'SHA256SUMS.txt'),
      contentType: 'text/plain',
    },
  ];

  const existingAssets = releaseData.assets || [];
  for (const asset of assetsToUpload) {
    if (!fs.existsSync(asset.path)) {
      throw new Error(`Asset file missing: ${asset.path}`);
    }

    const matched = existingAssets.find((a) => a.name === asset.name);
    if (matched) {
      console.log(`  Asset ${asset.name} already exists (ID: ${matched.id}), removing old upload...`);
      await requestJson('DELETE', `/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${matched.id}`, headers);
    }

    console.log(`  Uploading ${asset.name} (${fs.statSync(asset.path).size.toLocaleString()} bytes)...`);
    const uploadRes = uploadAssetViaCurl(releaseData.upload_url, asset.path, asset.name, asset.contentType, token);
    if (uploadRes.status !== 201) {
      throw new Error(`Failed to upload ${asset.name}: HTTP ${uploadRes.status} ${JSON.stringify(uploadRes.data)}`);
    }
    console.log(`    [OK] Uploaded ${asset.name}`);
  }

  // 4. Verify Latest Release on GitHub
  console.log('\n[4/5] Verifying Latest Stable release on GitHub...');
  const latestRes = await requestJson('GET', `/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`, headers);
  if (latestRes.status !== 200) {
    throw new Error(`Failed to query latest release: ${latestRes.status}`);
  }
  console.log(`  Current GitHub Latest Tag: ${latestRes.data.tag_name}`);
  console.log(`  Current GitHub Latest Name: ${latestRes.data.name}`);

  if (latestRes.data.tag_name !== 'v1.0.3') {
    throw new Error(`CRITICAL: GitHub Latest is ${latestRes.data.tag_name}, expected v1.0.3!`);
  }
  console.log('  [PASS] Desktop v1.0.3 remains the official Latest Stable release!');

  // 5. Output Summary
  console.log('\n================================================================');
  console.log('EXTENSION V1.0.4 GITHUB PUBLICATION COMPLETE');
  console.log('================================================================');
  console.log(`Release URL: ${releaseData.html_url}`);
  console.log('Assets:');
  for (const a of assetsToUpload) {
    console.log(`  - https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${TAG_NAME}/${a.name}`);
  }
  console.log('================================================================\n');
}

main().catch((err) => {
  console.error('Fatal publication error:', err);
  process.exit(1);
});
