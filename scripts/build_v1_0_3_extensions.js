const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const extDir = path.join(PROJECT_ROOT, 'extension');
const ffDir = path.join(extDir, 'firefox');
const targetDir = path.join(PROJECT_ROOT, 'target', 'release');

if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

// 1. Package Chromium Extension
console.log('--- Packaging Chromium / Edge MV3 Extension v1.0.3 ---');
const crZip = path.join(targetDir, 'tori-download-manager-extension-v1.0.3.zip');
const tempStagingCr = path.join(PROJECT_ROOT, 'target', 'chromium_ext_v103_staging');

if (fs.existsSync(tempStagingCr)) {
  fs.rmSync(tempStagingCr, { recursive: true, force: true });
}
fs.mkdirSync(tempStagingCr, { recursive: true });

function copyFiltered(src, dst) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'firefox' || entry.name === '.git' || entry.name.endsWith('.tmp')) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyFiltered(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

copyFiltered(extDir, tempStagingCr);

// Remove existing target zip if present
if (fs.existsSync(crZip)) {
  fs.unlinkSync(crZip);
}

execSync(
  `powershell -NoProfile -Command "Compress-Archive -Path '${tempStagingCr}\\*' -DestinationPath '${crZip}' -Force"`,
  { stdio: 'inherit' }
);
fs.rmSync(tempStagingCr, { recursive: true, force: true });

const crStat = fs.statSync(crZip);
const crBuf = fs.readFileSync(crZip);
const crHash = crypto.createHash('sha256').update(crBuf).digest('hex').toLowerCase();
console.log(`[OK] Created Chromium extension package: ${crZip}`);
console.log(`     Size: ${crStat.size.toLocaleString()} bytes | SHA-256: ${crHash}`);

// 2. Package Firefox Extension (Unsigned Source Package)
console.log('\n--- Packaging Firefox MV3 Extension v1.0.3 ---');
const ffZip = path.join(targetDir, 'tori-download-manager-firefox-v1.0.3.zip');
const tempStagingFf = path.join(PROJECT_ROOT, 'target', 'firefox_ext_v103_staging');

if (fs.existsSync(tempStagingFf)) {
  fs.rmSync(tempStagingFf, { recursive: true, force: true });
}
fs.mkdirSync(tempStagingFf, { recursive: true });

function copyRecursive(src, dst) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name.endsWith('.tmp')) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyRecursive(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

copyRecursive(ffDir, tempStagingFf);

if (fs.existsSync(ffZip)) {
  fs.unlinkSync(ffZip);
}

execSync(
  `powershell -NoProfile -Command "Compress-Archive -Path '${tempStagingFf}\\*' -DestinationPath '${ffZip}' -Force"`,
  { stdio: 'inherit' }
);
fs.rmSync(tempStagingFf, { recursive: true, force: true });

const ffStat = fs.statSync(ffZip);
const ffBuf = fs.readFileSync(ffZip);
const ffHash = crypto.createHash('sha256').update(ffBuf).digest('hex').toLowerCase();
console.log(`[OK] Created Firefox extension package: ${ffZip}`);
console.log(`     Size: ${ffStat.size.toLocaleString()} bytes | SHA-256: ${ffHash}`);
