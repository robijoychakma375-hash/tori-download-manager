/**
 * TORI Download Manager v1.0.0 — Final Distribution Package Stager
 * Gate 13.6 — Final Release Candidate Packaging
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const STAGING_DIR = path.join(PROJECT_ROOT, 'release', 'v1.0.0');

function computeSha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
}

function stageRelease() {
  console.log('================================================================');
  console.log('TORI Download Manager v1.0.0 — Final Distribution Staging');
  console.log('================================================================\n');

  if (!fs.existsSync(STAGING_DIR)) {
    fs.mkdirSync(STAGING_DIR, { recursive: true });
  }

  const installerSource = path.join(PROJECT_ROOT, 'target', 'release', 'bundle', 'nsis', 'TORI Download Manager_1.0.0_x64-setup.exe');
  const sigSource = path.join(PROJECT_ROOT, 'target', 'release', 'bundle', 'nsis', 'TORI Download Manager_1.0.0_x64-setup.exe.sig');
  const latestJsonSource = path.join(PROJECT_ROOT, 'target', 'release', 'latest.json');
  const extensionZipSource = path.join(PROJECT_ROOT, 'target', 'release', 'tori-download-manager-extension-v1.0.0.zip');
  const releaseNotesSource = path.join(PROJECT_ROOT, 'RELEASE_NOTES.md');
  const changelogSource = path.join(PROJECT_ROOT, 'CHANGELOG.md');
  const licenseSource = path.join(PROJECT_ROOT, 'resources', 'LICENSE-THIRD-PARTY.txt');

  const filesToCopy = [
    { src: installerSource, name: 'TORI Download Manager_1.0.0_x64-setup.exe' },
    { src: sigSource, name: 'TORI Download Manager_1.0.0_x64-setup.exe.sig' },
    { src: latestJsonSource, name: 'latest.json' },
    { src: extensionZipSource, name: 'tori-download-manager-extension-v1.0.0.zip' },
    { src: releaseNotesSource, name: 'RELEASE_NOTES.md' },
    { src: changelogSource, name: 'CHANGELOG.md' },
    { src: licenseSource, name: 'LICENSE-THIRD-PARTY.txt' },
  ];

  for (const item of filesToCopy) {
    if (!fs.existsSync(item.src)) {
      throw new Error(`Required release asset missing: ${item.src}`);
    }
    const dest = path.join(STAGING_DIR, item.name);
    fs.copyFileSync(item.src, dest);
    console.log(`  [STAGE] Copied ${item.name} (${(fs.statSync(dest).size / (1024*1024)).toFixed(2)} MB)`);
  }

  // Create INSTALL.md in staging
  const installDoc = `# TORI Download Manager v1.0.0 — Installation Guide

## System Requirements
- **Operating System:** Windows 10 (Build 1809+) or Windows 11 (64-bit)
- **Architecture:** x86_64
- **Runtime Dependencies:** Completely self-contained. No external Python, Node.js, Rust, or FFmpeg installation required.

---

## 1. Standard Installation
Double-click \`TORI Download Manager_1.0.0_x64-setup.exe\` and follow the on-screen setup wizard.

## 2. Silent / Automated Installation (Enterprise / Unattended)
Run Command Prompt or PowerShell as Administrator:
\`\`\`cmd
"TORI Download Manager_1.0.0_x64-setup.exe" /S
\`\`\`
To install to a custom directory:
\`\`\`cmd
"TORI Download Manager_1.0.0_x64-setup.exe" /S /D=C:\\Program Files\\TORI Download Manager
\`\`\`
*(Note: In NSIS, \`/D=\` must be the final argument and must not be enclosed in quotes).*

## 3. Browser Extension Installation
1. Extract \`tori-download-manager-extension-v1.0.0.zip\` into a local folder.
2. In Google Chrome or Microsoft Edge, navigate to \`chrome://extensions\` or \`edge://extensions\`.
3. Enable **Developer mode** toggle.
4. Click **Load unpacked** and select the extracted extension folder.
5. TORI will automatically connect via Native Messaging.

## 4. Cryptographic Hash Verification
To verify the integrity of your installer before execution:
\`\`\`powershell
Get-FileHash "TORI Download Manager_1.0.0_x64-setup.exe" -Algorithm SHA256
\`\`\`
Compare the output against \`SHA256SUMS.txt\`.
`;

  fs.writeFileSync(path.join(STAGING_DIR, 'INSTALL.md'), installDoc);
  console.log('  [STAGE] Generated INSTALL.md');

  // Compute Checksums for all distribution files
  const stagedFiles = fs.readdirSync(STAGING_DIR).filter(f => f !== 'SHA256SUMS.txt');
  const checksumLines = [];

  for (const file of stagedFiles) {
    const filePath = path.join(STAGING_DIR, file);
    const hash = computeSha256(filePath);
    checksumLines.push(`${hash}  ${file}`);
  }

  const sumsPath = path.join(STAGING_DIR, 'SHA256SUMS.txt');
  fs.writeFileSync(sumsPath, checksumLines.join('\n') + '\n');
  console.log('  [STAGE] Generated SHA256SUMS.txt');

  console.log('\n================================================================');
  console.log(`RELEASE STAGED SUCCESSFULLY IN: ${STAGING_DIR}`);
  console.log('================================================================\n');

  for (const line of checksumLines) {
    console.log(`  ${line}`);
  }
}

try {
  stageRelease();
} catch (e) {
  console.error('Staging failed:', e.message);
  process.exit(1);
}

