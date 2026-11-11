const cp = require('child_process');
const https = require('https');

const REPO_OWNER = 'robijoychakma375-hash';
const REPO_NAME = 'tori-download-manager';
const RELEASE_ID = 442083394;

function getGitToken() {
  const p = cp.spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n',
    encoding: 'utf8'
  });
  for (const line of p.stdout.split('\n')) {
    if (line.startsWith('password=')) return line.substring(9).trim();
  }
  return null;
}

const token = getGitToken();
if (!token) {
  console.error('[ERROR] Unable to retrieve GitHub token from Git credential helper');
  process.exit(1);
}

const NEW_RELEASE_BODY = `# TORI Download Manager v1.0.3

TORI Download Manager v1.0.3 is the latest stable release for Windows 10 and 11 (64-bit). This update delivers major desktop lifecycle hardening, eliminates the startup white flash across dark and light themes, introduces draggable browser video overlays, and ensures full compatibility with the official Mozilla-signed Firefox companion extension.

---

## What's New & Bug Fixes

- **Eliminated Startup White Flash:** The desktop window now pre-initializes with system-matched theme colors before rendering, providing an instantaneous, seamless dark/light launch experience without bright flashes.
- **Hardened Close-to-Tray & Single-Instance Mutex:** Relaunching TORI while minimized or hidden in the notification tray instantly restores the active window. Single-instance protection guarantees zero duplicate background processes and prevents port collisions.
- **Draggable Video Overlay:** The browser video download pill now supports smooth pointer dragging across the media player with a 5px drag threshold, viewport boundary clamping, and coordinate memory across player redraws.
- **Dynamic Media Stream Recovery:** Dynamic media lifecycle monitoring for HTML5, HLS (.m3u8), and MPEG-DASH (.mpd) video players resolves media streams continuously, eliminating the false "Unavailable" state on delayed-loading sites.
- **Synchronized Companion Extensions:** Companion extensions for Firefox and Chromium browsers are fully updated to v1.0.3 with native messaging stream capture.

---

## Windows Installation

### Fresh Install
1. Download **\`TORI.Download.Manager_1.0.3_x64-setup.exe\`** below.
2. If Windows SmartScreen appears, click **More info** $\\to$ **Run anyway**.
3. Follow the setup wizard to complete installation.

### Upgrading from v1.0.0, v1.0.1, or v1.0.2
1. Exit your currently running TORI application completely (Right-click tray icon $\\to$ **Exit**).
2. Run **\`TORI.Download.Manager_1.0.3_x64-setup.exe\`** directly over your existing installation.
3. All download queues, history, settings, and database entries are automatically preserved.

---

## Browser Companion Extensions

TORI integrates seamlessly with your web browser to capture downloads and grab streaming media in one click.

### Mozilla Firefox (Signed \`.xpi\`)
- **Package:** **\`tori-download-manager-firefox-v1.0.3.xpi\`**
- **Format:** The \`.xpi\` file is the official add-on package cryptographically signed and verified by Mozilla Add-ons (AMO).
- **How to Install:**
  1. Download **\`tori-download-manager-firefox-v1.0.3.xpi\`**.
  2. Open Firefox and navigate to \`about:addons\` (or press \`Ctrl+Shift+A\`).
  3. Click the gear icon in the top right $\\to$ select **Install Add-on From File...**.
  4. Select the downloaded \`.xpi\` file and click **Add** when prompted.

### Google Chrome & Microsoft Edge (Manifest V3 \`.zip\`)
- **Package:** **\`tori-download-manager-extension-v1.0.3.zip\`**
- **Format:** The \`.zip\` archive contains the unpacked Manifest V3 browser companion for Chromium-based browsers.
- **How to Install:**
  1. Download **\`tori-download-manager-extension-v1.0.3.zip\`** and extract it into a permanent folder on your PC.
  2. In Google Chrome, go to \`chrome://extensions\`. In Microsoft Edge, go to \`edge://extensions\`.
  3. Toggle **Developer mode** ON (top-right in Chrome, left sidebar in Edge).
  4. Click the **Load unpacked** button and select the extracted folder containing \`manifest.json\`.

---

## Automatic Updates

TORI Download Manager includes built-in in-app auto-update capabilities. Existing clients on versions 1.0.0, 1.0.1, and 1.0.2 will automatically detect this release through the secure update endpoint:
- Manifest: **\`latest.json\`**
- Verification: Every update payload is authenticated via Minisign Ed25519 digital signature against TORI's trusted public key before execution.

---

## Cryptographic Checksums (SHA-256)

Download **\`SHA256SUMS.txt\`** to verify package integrity:

| Asset | SHA-256 Checksum |
| :--- | :--- |
| \`TORI.Download.Manager_1.0.3_x64-setup.exe\` | \`3804727ebeeeb1ed20de5e81f498f9adb01323481ec767c6813e6f77f1e890f5\` |
| \`TORI.Download.Manager_1.0.3_x64-setup.exe.sig\` | \`56713119d722c3218fc0c70af68484b87bcb4c31a0348d19f2e17c49271cfba4\` |
| \`tori-download-manager-firefox-v1.0.3.xpi\` | \`790f6b8f623bdf5c47b508bde78404876bb18c8d07290be45475aed04e3ecff5\` |
| \`tori-download-manager-extension-v1.0.3.zip\` | \`e4c80356f00bba5befef60397914db983930d2f2f3436de753d521c83a5c2156\` |

To verify on Windows PowerShell:
\`\`\`powershell
Get-FileHash -Algorithm SHA256 "TORI.Download.Manager_1.0.3_x64-setup.exe"
\`\`\`

---

## Open Source & Licensing

TORI Download Manager is free, open-source software:
- Core desktop source code is licensed under dual MIT / Apache-2.0 licenses ([\`LICENSE\`](https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.3/LICENSE)).
- Bundled binary distribution and installer incorporate FFmpeg media tooling under the GNU General Public License v3 ([\`LICENSE-GPLv3.txt\`](https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.3/LICENSE-GPLv3.txt)).
- Third-party dependency notices and source availability are documented in [\`LICENSE-THIRD-PARTY.txt\`](https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.3/LICENSE-THIRD-PARTY.txt).

---

## Previous Releases

All previous releases, release notes, and changelogs remain accessible in the [Releases Archive](https://github.com/robijoychakma375-hash/tori-download-manager/releases):
- [v1.0.2 Stable Release](https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/v1.0.2)
- [v1.0.1 Pre-Release](https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/v1.0.1)
- [v1.0.0 Initial Stable Release](https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/v1.0.0)

For more information, documentation, and user guides, visit the official website: [https://toridownload.xyz](https://toridownload.xyz).`;

function apiRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'User-Agent': 'TORI-Gate23-4-Cleanup',
        'Authorization': 'token ' + token,
        'Accept': 'application/vnd.github.v3+json',
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {})
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const ASSETS_TO_REMOVE = [
  'a70ed17e183648a9bcf4-1.0.3.xpi',
  'tori-download-manager-firefox-v1.0.3.zip',
  'RELEASE_NOTES.md',
  'INSTALLATION_AND_UPGRADE_NOTES.md',
  'RELEASE_MANIFEST.json'
];

const PRESERVED_ASSETS = [
  'TORI.Download.Manager_1.0.3_x64-setup.exe',
  'TORI.Download.Manager_1.0.3_x64-setup.exe.sig',
  'tori-download-manager-firefox-v1.0.3.xpi',
  'tori-download-manager-extension-v1.0.3.zip',
  'latest.json',
  'SHA256SUMS.txt',
  'LICENSE',
  'LICENSE-GPLv3.txt',
  'LICENSE-THIRD-PARTY.txt'
];

async function run() {
  console.log('=== TORI GATE 23.4: RELEASE ASSET CLEANUP ===\n');

  // 1. Fetch current release info
  console.log('[AUDIT] Fetching current release info from GitHub API...');
  const relRes = await apiRequest('GET', `/repos/${REPO_OWNER}/${REPO_NAME}/releases/${RELEASE_ID}`);
  if (relRes.status !== 200) {
    console.error(`[ERROR] Failed to fetch release: HTTP ${relRes.status}`);
    process.exit(1);
  }

  const rel = relRes.data;
  const originalCount = rel.assets.length;
  console.log(`[AUDIT] Release ${rel.tag_name} (ID: ${rel.id}) currently has ${originalCount} assets.`);

  // Verify critical assets exist
  for (const expected of PRESERVED_ASSETS) {
    const found = rel.assets.find(a => a.name === expected || a.name === expected.replace(/ /g, '.'));
    if (!found) {
      console.error(`[FATAL] Critical asset ${expected} not found on release! Aborting.`);
      process.exit(1);
    }
    console.log(`  [PRESERVE CHECK] Found: ${found.name} (ID: ${found.id}, ${found.size} bytes)`);
  }

  // 2. Update release body
  console.log('\n[UPDATE] Updating release description with professional user-facing content...');
  const updateRes = await apiRequest('PATCH', `/repos/${REPO_OWNER}/${REPO_NAME}/releases/${RELEASE_ID}`, JSON.stringify({
    body: NEW_RELEASE_BODY
  }));
  if (updateRes.status !== 200) {
    console.error(`[ERROR] Failed to update release body: HTTP ${updateRes.status}`);
    process.exit(1);
  }
  console.log('[PASS] Release description successfully updated on GitHub.');

  // 3. Delete non-essential assets
  console.log('\n[CLEANUP] Deleting redundant and internal development assets...');
  const removedNames = [];
  for (const assetName of ASSETS_TO_REMOVE) {
    const asset = rel.assets.find(a => a.name === assetName);
    if (!asset) {
      console.log(`  [SKIP] Asset ${assetName} already absent.`);
      continue;
    }

    console.log(`  [DELETE] Deleting asset ${asset.name} (ID: ${asset.id})...`);
    const delRes = await apiRequest('DELETE', `/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${asset.id}`);
    if (delRes.status === 204) {
      console.log(`  [PASS] Deleted ${asset.name}`);
      removedNames.push(asset.name);
    } else {
      console.error(`  [FAIL] Failed to delete ${asset.name}: HTTP ${delRes.status}`);
    }
  }

  // 4. Verify post-cleanup asset inventory
  console.log('\n[VERIFY] Fetching post-cleanup release info...');
  const postRes = await apiRequest('GET', `/repos/${REPO_OWNER}/${REPO_NAME}/releases/${RELEASE_ID}`);
  const postRel = postRes.data;
  const finalCount = postRel.assets.length;
  console.log(`[AUDIT] Release now has ${finalCount} assets.`);

  console.log('\n=== FINAL ASSET INVENTORY ===');
  postRel.assets.forEach((a, i) => {
    console.log(`${i + 1}. ${a.name} (${a.size} bytes, ID: ${a.id})`);
  });

  return {
    originalCount,
    finalCount,
    removedNames,
    preservedNames: postRel.assets.map(a => a.name)
  };
}

if (require.main === module) {
  run().catch(err => {
    console.error('[FATAL ERROR]', err);
    process.exit(1);
  });
}

module.exports = { run, PRESERVED_ASSETS, ASSETS_TO_REMOVE };
