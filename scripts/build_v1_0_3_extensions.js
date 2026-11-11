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

// 2. Package Firefox Extension (AMO Validated Forward-Slash Package)
console.log('\n--- Packaging Firefox MV3 Extension v1.0.3 ---');
const ffZip = path.join(targetDir, 'tori-download-manager-firefox-v1.0.3.zip');
const amoBuildDir = path.join(PROJECT_ROOT, 'target', 'firefox_amo_build');

if (fs.existsSync(amoBuildDir)) {
  fs.rmSync(amoBuildDir, { recursive: true, force: true });
}
fs.mkdirSync(amoBuildDir, { recursive: true });

// Use Mozilla's official web-ext toolchain to guarantee forward-slash ZIP entry formatting
console.log('Invoking web-ext build for strict Mozilla AMO compatibility...');
execSync(`npx web-ext build --source-dir "${ffDir}" --artifacts-dir "${amoBuildDir}" --overwrite-dest`, {
  cwd: PROJECT_ROOT,
  stdio: 'inherit'
});

const builtZips = fs.readdirSync(amoBuildDir).filter(f => f.endsWith('.zip'));
if (builtZips.length === 0) {
  throw new Error('web-ext build did not produce any zip package!');
}

const generatedZipPath = path.join(amoBuildDir, builtZips[0]);
fs.copyFileSync(generatedZipPath, ffZip);
fs.rmSync(amoBuildDir, { recursive: true, force: true });

const ffStat = fs.statSync(ffZip);
const ffBuf = fs.readFileSync(ffZip);
const ffHash = crypto.createHash('sha256').update(ffBuf).digest('hex').toLowerCase();
console.log(`[OK] Created Firefox extension package: ${ffZip}`);
console.log(`     Size: ${ffStat.size.toLocaleString()} bytes | SHA-256: ${ffHash}`);
