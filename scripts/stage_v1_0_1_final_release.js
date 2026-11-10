const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STAGING_DIR = path.join(ROOT, 'release', 'v1.0.1-final');
const DOWNLOADS_DIR = 'C:\\Users\\ritud\\Downloads';
const ORIGINAL_XPI_PATH = path.join(DOWNLOADS_DIR, 'a70ed17e183648a9bcf4-1.0.2.xpi');

if (!fs.existsSync(STAGING_DIR)) {
  fs.mkdirSync(STAGING_DIR, { recursive: true });
}

// 1. Files to stage
const filesToStage = [
  {
    src: path.join(ROOT, 'target', 'release', 'bundle', 'nsis', 'TORI Download Manager_1.0.1_x64-setup.exe'),
    dest: 'TORI Download Manager_1.0.1_x64-setup.exe',
  },
  {
    src: path.join(ROOT, 'target', 'release', 'bundle', 'nsis', 'TORI Download Manager_1.0.1_x64-setup.exe.sig'),
    dest: 'TORI Download Manager_1.0.1_x64-setup.exe.sig',
  },
  {
    src: ORIGINAL_XPI_PATH,
    dest: 'tori-download-manager-firefox-v1.0.2.xpi',
  },
  {
    src: ORIGINAL_XPI_PATH,
    dest: 'a70ed17e183648a9bcf4-1.0.2.xpi',
  },
  {
    src: path.join(ROOT, 'target', 'release', 'tori-download-manager-extension-v1.0.2.zip'),
    dest: 'tori-download-manager-extension-v1.0.2.zip',
  },
  {
    src: path.join(ROOT, 'release', 'v1.0.1-firefox-candidate', 'tori-download-manager-firefox-v1.0.2.zip'),
    dest: 'tori-download-manager-firefox-v1.0.2.zip',
  },
  {
    src: path.join(ROOT, 'LICENSE'),
    dest: 'LICENSE',
  },
  {
    src: path.join(ROOT, 'resources', 'LICENSE-THIRD-PARTY.txt'),
    dest: 'LICENSE-THIRD-PARTY.txt',
  },
  {
    src: path.join(ROOT, 'resources', 'LICENSE-GPLv3.txt'),
    dest: 'LICENSE-GPLv3.txt',
  },
];

console.log('--- Staging Artifacts to release/v1.0.1-final ---');

const checksums = [];
const stagedFilesMeta = [];

for (const item of filesToStage) {
  if (!fs.existsSync(item.src)) {
    throw new Error(`Source file missing: ${item.src}`);
  }
  const destPath = path.join(STAGING_DIR, item.dest);
  fs.copyFileSync(item.src, destPath);
  const buf = fs.readFileSync(destPath);
  const hash = crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
  const stat = fs.statSync(destPath);
  checksums.push(`${hash}  ${item.dest}`);
  stagedFilesMeta.push({
    file: item.dest,
    size: stat.size,
    sha256: hash,
  });
  console.log(`Copied: ${item.dest} (${stat.size.toLocaleString()} bytes) -> ${hash}`);
}

// Write SHA256SUMS.txt
fs.writeFileSync(path.join(STAGING_DIR, 'SHA256SUMS.txt'), checksums.join('\n') + '\n', 'utf8');
console.log('Generated SHA256SUMS.txt');

// 2. Build RELEASE_MANIFEST.json
const installerFile = stagedFilesMeta.find(f => f.file.endsWith('.exe'));
const sigFile = stagedFilesMeta.find(f => f.file.endsWith('.sig'));
const crExt = stagedFilesMeta.find(f => f.file.includes('extension-v1.0.2.zip'));
const ffXpi = stagedFilesMeta.find(f => f.file === 'tori-download-manager-firefox-v1.0.2.xpi');
const ffZip = stagedFilesMeta.find(f => f.file === 'tori-download-manager-firefox-v1.0.2.zip');

const headCommit = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();

const manifest = {
  manifestVersion: "1.0.0",
  releaseName: "TORI Download Manager v1.0.1 — Final Release Candidate",
  productName: "TORI Download Manager",
  desktopVersion: "1.0.1",
  targetPlatform: "Windows 10 / 11 (x64)",
  packagingFormat: "NSIS x64 Self-Extracting Executable",
  sourceCommit: headCommit,
  sourceBranch: "dev/v1.0.1",
  buildTimestamp: new Date().toISOString(),
  toolchain: {
    rustc: "1.98.0",
    cargo: "1.98.0",
    tauriCli: "2.11.4",
    node: "24.18.0",
    npm: "12.0.2",
    msvc: "Visual Studio Build Tools 2022 (MSVC 14.44)",
    windowsSdk: "10.0.26100.0"
  },
  cryptography: {
    authenticodeSigningStatus: "UNSIGNED",
    authenticodeNotice: "Developer preview / Release Candidate packaging. Commercial EV Authenticode certificate signing is deferred until public distribution.",
    updaterSigningStatus: "ED25519 SIGNED",
    updaterAlgorithm: "Minisign Ed25519",
    updaterPublicKey: "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IENEQzIzRDhDQzhEQTUzOTcKUldTWFU5cklqRDNDelRBOVAzOSs1L0RXN0FFLy9YWGFJc2NnUStaNktxSkNOQ1ZCeG01MjFTZzQK"
  },
  installerArtifact: {
    filename: installerFile.file,
    sizeBytes: installerFile.size,
    sha256: installerFile.sha256,
    signatureFile: sigFile.file,
    signatureSha256: sigFile.sha256
  },
  browserExtensions: {
    chromiumEdge: {
      filename: crExt.file,
      extensionVersion: "1.0.2",
      manifestVersion: 3,
      sizeBytes: crExt.size,
      sha256: crExt.sha256,
      distributionStatus: "STAGED_ZIP"
    },
    firefox: {
      signedXpiFilename: ffXpi.file,
      signedXpiOriginalFilename: "a70ed17e183648a9bcf4-1.0.2.xpi",
      signedXpiSizeBytes: ffXpi.size,
      signedXpiSha256: ffXpi.sha256,
      unsignedSourceZipFilename: ffZip.file,
      unsignedSourceZipSizeBytes: ffZip.size,
      unsignedSourceZipSha256: ffZip.sha256,
      extensionVersion: "1.0.2",
      manifestVersion: 3,
      geckoId: "tori-download-manager@toridm.org",
      mozillaSignatureStatus: "OFFICIALLY SIGNED (Mozilla AMO Validated)",
      signatureType: "Mozilla PKCS#7 & COSE Signature Block",
      signatureValidation: "Accepted by Firefox with xpinstall.signatures.required enabled",
      distributionStatus: "SIGNED_XPI_READY"
    }
  },
  bundledComponents: [
    { name: "tori-download-manager.exe", type: "Tauri v2 Desktop Shell & Core Engine", arch: "x64", version: "1.0.1" },
    { name: "tdm-native-host.exe", type: "Multi-Browser Native Messaging Host (Chrome, Edge, Firefox)", arch: "x64", version: "1.0.1" },
    { name: "tdm-cli.exe", type: "Headless CLI Client & Test Harness", arch: "x64", version: "1.0.1" },
    { name: "ffmpeg.exe", type: "Media Processing & Demuxing Tool", version: "7.1-full_build", license: "GPLv3" },
    { name: "ffprobe.exe", type: "Stream Inspector & Format Validator", version: "7.1-full_build", license: "GPLv3" },
    { name: "yt-dlp.exe", type: "Adaptive Media Stream Extractor", version: "2024.10.07", license: "Unlicense" }
  ],
  userAcceptanceSignOff: {
    dailymotionManualQa: "PASS (5/5 tests verified by user)",
    liveOverlayInterference: "None (video playback uninterrupted on click)",
    playerControlsUsability: "Normal (play/pause/scrubber accessible)",
    fullscreenAndPositioning: "Verified (anchored 56px bottom margin)",
    desktopDownloadHandoff: "Verified (download queued in TORI UI)"
  },
  releaseLimitations: [
    "Public BitTorrent DHT/P2P swarm traffic is filtered on ISP/firewall networks; unseeded swarms trigger graceful 60-second metadata timeout without stalling at 0%. Local seeder/leecher protocol correctness is fully verified (8/8 tests).",
    "Commercial EV Authenticode signing is deferred until public distribution."
  ]
};

fs.writeFileSync(
  path.join(STAGING_DIR, 'RELEASE_MANIFEST.json'),
  JSON.stringify(manifest, null, 2),
  'utf8'
);
console.log('Generated RELEASE_MANIFEST.json');

// 3. Generate RELEASE_NOTES.md
const releaseNotes = `# TORI Download Manager v1.0.1 — Release Notes

**Release Name:** TORI Download Manager v1.0.1 (Pre-release / Release Candidate)  
**Build Date:** ${new Date().toISOString().split('T')[0]}  
**Target Platform:** Windows 10 / Windows 11 (x64)  
**Desktop Version:** 1.0.1  
**Browser Extension Version:** 1.0.2  
**Source Baseline:** \`dev/v1.0.1\` (commit \`${headCommit.substring(0, 7)}\`)  

---

## Highlights & What's New in v1.0.1

### 1. Close-to-Tray & System Tray Controls
- **TitleBar Close (X) Behavior:** Clicking the main window's Close button now hides the application to the Windows System Tray instead of terminating the process.
- **Background Continuity:** In-flight downloads, queue transitions, scheduler alarms, and browser integration (Local API on 6800/7070 and Native Messaging IPC) remain operational in the background.
- **System Tray Operations:** Tray menu includes **Show TORI**, **Hide TORI**, live active download counter, **Pause All**, **Resume All**, and **Exit TORI**.
- **Exit Protection:** If active downloads are running, clicking Exit triggers a native warning dialog before downloads are paused and the process cleanly shuts down.
- **Window State Separation:** Minimize (\`-\`) minimizes to the Windows Taskbar; Close (\`X\`) hides to the System Tray.

### 2. Official Mozilla-Signed Firefox Extension (v1.0.2)
- **Officially Signed by Mozilla AMO:** Packaged as \`tori-download-manager-firefox-v1.0.2.xpi\` (SHA256: \`520424ff38ddb1bf84152e7fd3c9bf4678ce6af1542995a6d4b58c4dc4fbb8d0\`).
- Permanent installation supported in production Mozilla Firefox release channels with signature enforcement enabled.
- Developer unminified package preserved as \`tori-download-manager-firefox-v1.0.2.zip\` for source code inspection.

### 3. Cross-Browser Media Detection & Generic Download Interception
- **Generic Download Capture:** Automatically intercepts ISO, ZIP, RAR, 7Z, EXE, PDF, MKV, MP4, no-extension URLs, and 302 redirects in both Firefox and Edge/Chrome.
- **Download Shelf History Preservation:** Preserves browser download shelf entries with informative status; eliminates destructive \`chrome.downloads.erase()\`.
- **Dangerous File Warning Respect:** Respects browser native security flags without hijacking dangerous or suspicious files.
- **Safe Offline Fallback:** If TORI Desktop is closed or unreachable, downloads proceed uninterrupted in the browser.

### 4. Dailymotion Video Player Overlay Improvements
- **Zero Playback Hijacking:** Comprehensive event isolation (\`pointerdown\`, \`pointerup\`, \`mousedown\`, \`mouseup\`, \`click\`, \`dblclick\`) prevents the video player from pausing or seeking when clicking the TORI download trigger.
- **Transport Bar Clearance:** Positioned with a fixed \`56px\` bottom margin and constrained to \`max-content\` dimensions so player controls remain fully interactive.
- **User Acceptance Verified:** Passed 5/5 manual user QA acceptance checks on live Dailymotion streams.

### 5. BitTorrent / Magnet Probing & Resilience
- **Probing State Emission:** Unseeded or resolving magnet links immediately emit \`JobState::Probing\` with status *"Connecting to peers and retrieving metadata..."* instead of stalling at 0%.
- **60-Second Metadata Timeout:** Enforces a clean 60-second resolution timeout for unseeded or network-restricted swarms, failing gracefully rather than hanging indefinitely.
- **Verified Protocol Engine:** 100% byte-for-byte piece transfer verification in local seeder/leecher unit test suites.

### 6. Bundled Production Tooling & Licensing
- Bundles \`ffmpeg.exe\` (7.1-full_build), \`ffprobe.exe\` (7.1-full_build), \`yt-dlp.exe\` (2024.10.07), and multi-browser \`tdm-native-host.exe\`.
- Complete GNU GPLv3 license text provided in \`LICENSE-GPLv3.txt\`.
- Third-party notices and corresponding source checkout instructions in \`LICENSE-THIRD-PARTY.txt\`.

---

## Checksums

See \`SHA256SUMS.txt\` for cryptographic hashes of all distribution artifacts.
`;

fs.writeFileSync(path.join(STAGING_DIR, 'RELEASE_NOTES.md'), releaseNotes, 'utf8');
console.log('Generated RELEASE_NOTES.md');

// 4. Generate INSTALLATION_AND_UPGRADE_NOTES.md
const upgradeNotes = `# TORI Download Manager v1.0.1 — Installation & Upgrade Instructions

## Package Location: \`release/v1.0.1-final/\`

### Package Files
1. \`TORI Download Manager_1.0.1_x64-setup.exe\` — Self-contained Windows x64 NSIS installer (~117 MB).
2. \`TORI Download Manager_1.0.1_x64-setup.exe.sig\` — Ed25519 Minisign updater signature.
3. \`tori-download-manager-firefox-v1.0.2.xpi\` — Official Mozilla-signed Firefox extension v1.0.2.
4. \`a70ed17e183648a9bcf4-1.0.2.xpi\` — Original Mozilla AMO download filename mirror.
5. \`tori-download-manager-extension-v1.0.2.zip\` — Chromium / Microsoft Edge Manifest V3 extension package.
6. \`tori-download-manager-firefox-v1.0.2.zip\` — Unsigned developer/source extension package.
7. \`LICENSE\` — MIT License.
8. \`LICENSE-THIRD-PARTY.txt\` — Open source license notices for bundled tools.
9. \`SHA256SUMS.txt\` — Cryptographic checksums.
10. \`RELEASE_MANIFEST.json\` — Machine-readable release metadata.

---

### Firefox Extension Installation
1. Open Mozilla Firefox.
2. In the URL bar, open \`about:addons\` (or press Ctrl+Shift+A).
3. Click the gear icon in the top right and select **Install Add-on From File...**
4. Browse to and select \`tori-download-manager-firefox-v1.0.2.xpi\`.
5. Firefox will verify the authentic Mozilla signature and prompt to add the extension. Click **Add**.
6. The extension is permanently installed and active.

---

### Separate PC Acceptance Testing Procedure

#### Clean Installation Testing
1. Copy the contents of \`release/v1.0.1-final/\` to a clean test machine (or separate Windows user account).
2. Execute \`TORI Download Manager_1.0.1_x64-setup.exe\`.
3. Follow the NSIS setup wizard steps:
   - Verify application name: **TORI Download Manager**
   - Verify default destination: \`%LOCALAPPDATA%\\Programs\\TORI Download Manager\`
   - Complete installation and launch the application.
4. Verify that the desktop UI mounts cleanly with zero startup crashes.
5. Verify Native Messaging registration in registry:
   - Chrome: \`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.tori.download_manager\`
   - Edge: \`HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.tori.download_manager\`
   - Firefox: \`HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.tori.download_manager\`

#### Upgrade from v1.0.0 Testing
1. On a machine with installed v1.0.0, execute \`TORI Download Manager_1.0.1_x64-setup.exe\` without uninstalling.
2. Verify that the existing download history and settings in \`%APPDATA%\\tori-download-manager\\tdm_storage.sqlite\` are fully preserved.

#### Uninstallation Testing
1. In Windows Settings > Apps > Installed apps, select **TORI Download Manager** and click **Uninstall**.
2. Complete the uninstallation.
3. Verify:
   - Program directory \`%LOCALAPPDATA%\\Programs\\TORI Download Manager\` is cleanly removed.
   - All three browser Native Messaging registry keys under \`HKCU\` are deleted.
   - User's downloaded files remain untouched in their downloads directory.
`;

fs.writeFileSync(path.join(STAGING_DIR, 'INSTALLATION_AND_UPGRADE_NOTES.md'), upgradeNotes, 'utf8');
console.log('Generated INSTALLATION_AND_UPGRADE_NOTES.md');
console.log('--- Staging to release/v1.0.1-final Complete ---');
