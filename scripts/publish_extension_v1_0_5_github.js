/**
 * TORI Browser Companion — Publish Extension v1.0.5 Dedicated Release
 *
 * Requirements:
 * - Do NOT make latest (Desktop v1.0.3 remains Latest Stable)
 * - Do NOT modify desktop release assets, installer, or latest.json
 * - Create release tagged extension-v1.0.5 targeting branch extension/v1.0.5
 * - Upload:
 *   1. tori-download-manager-firefox-v1.0.5.xpi (Mozilla-signed XPI)
 *   2. tori-download-manager-extension-v1.0.5.zip (Chromium/Edge MV3)
 *   3. SHA256SUMS.txt
 * - Exclude unsigned Firefox source ZIP
 * - Verify that Desktop v1.0.3 remains the official Latest Stable release.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release', 'v1.0.5-extension');

const REPO_OWNER = 'robijoychakma375-hash';
const REPO_NAME = 'tori-download-manager';
const TAG_NAME = 'extension-v1.0.5';
const TARGET_COMMIT = 'extension/v1.0.5';
const RELEASE_NAME = 'TORI Browser Companion v1.0.5 (Overlay Drag Hotfix)';

const RELEASE_BODY = `## TORI Browser Companion v1.0.5 (Overlay Drag Hotfix)

This is a dedicated browser extension hotfix release addressing the floating video download overlay mouse dragging state machine for Chrome, Edge, and Mozilla Firefox.

### Compatibility
- **Compatible with:** TORI Download Manager Desktop v1.0.3 (and v1.0.2)
- **Local Engine Port:** \`127.0.0.1:6800\`
- **Native Messaging Identity:** \`tori_download_manager_host\`

---

### What's Changed in Extension v1.0.5
- **Overlay Drag Gesture State Machine Hotfix:**
  - Resolved sticky dragging issue where a single click on the floating download pill could inadvertently cause it to track the cursor without mouse buttons pressed.
  - Added window capture-phase event listeners (\`{ capture: true }\`) to prevent parent DOM elements and generic isolation handlers from swallowing \`pointerup\`.
  - Enforced strict hardware mouse button state validation (\`e.buttons & 1\`); releasing the left mouse button immediately terminates any drag gesture.
  - Added robust gesture teardown on \`lostpointercapture\`, \`pointercancel\`, and \`window.blur\`.
  - Preserved the 5px movement threshold and relative position persistence.
  - Guaranteed uninterrupted click interactions with all other website controls.
- **Mozilla Firefox Permanent Installation:**
  - Official Mozilla-signed \`.xpi\` package (AMO signed), supporting permanent installation without developer mode warnings.

---

### Release Assets & Checksums (SHA-256)
- \`tori-download-manager-firefox-v1.0.5.xpi\`  
  **SHA-256:** \`94d8ff0ca2ebd84f1412acb616da942d72423d7a11bb9ffc2bcc290c9dda93d6\`  
  *(Officially signed by Mozilla AMO)*

- \`tori-download-manager-extension-v1.0.5.zip\`  
  **SHA-256:** \`ee0a6b133400665cb141185eb8c8bcfd982cdafec3a72309b7f64c097bb17530\`  
  *(For Google Chrome, Microsoft Edge, and Brave via Developer Mode / Load Unpacked)*

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
  console.log('TORI Gate 25.1: Publish Dedicated Extension v1.0.5 Release');
  console.log('================================================================\n');

  const token = await getGitHubToken();
  const headers = { Authorization: `Bearer ${token}` };

  // 1. Check existing releases to see if extension-v1.0.5 already exists
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

  // 3. Upload assets (strictly 3 assets)
  console.log('\n[3/5] Uploading verified v1.0.5 extension assets...');
  const assetsToUpload = [
    {
      name: 'tori-download-manager-firefox-v1.0.5.xpi',
      path: path.join(RELEASE_DIR, 'tori-download-manager-firefox-v1.0.5.xpi'),
      contentType: 'application/x-xpinstall',
    },
    {
      name: 'tori-download-manager-extension-v1.0.5.zip',
      path: path.join(RELEASE_DIR, 'tori-download-manager-extension-v1.0.5.zip'),
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
  console.log('EXTENSION V1.0.5 GITHUB PUBLICATION COMPLETE');
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

