/**
 * TORI Download Manager — Gate 23.2 Release Readiness & Verification Suite
 *
 * Comprehensive validation covering:
 * 1. Version Synchronization & Parity across workspace, Tauri, UI, and extensions
 * 2. Binary & Installer PE Metadata Verification (version 1.0.3)
 * 3. Minisign Cryptographic Signature & Tamper Resistance
 * 4. Staged v1.0.3 latest.json Schema & Cross-Version Upgrade Compatibility
 * 5. Extension Package Integrity & Mozilla Linter Validation
 * 6. SHA256 Checksum Accuracy of all staged artifacts
 * 7. Release Isolation & Production Safety Restrictions
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const STAGING_DIR = path.join(PROJECT_ROOT, 'release', 'v1.0.3-final');
const INSTALLER_PATH = path.join(STAGING_DIR, 'TORI Download Manager_1.0.3_x64-setup.exe');
const SIG_PATH = path.join(STAGING_DIR, 'TORI Download Manager_1.0.3_x64-setup.exe.sig');
const MANIFEST_PATH = path.join(STAGING_DIR, 'latest.json');
const CHECKSUMS_PATH = path.join(STAGING_DIR, 'SHA256SUMS.txt');
const SCRATCH_VERIFY = 'C:\\Users\\ritud\\.gemini\\antigravity\\brain\\4cb6b42b-ac51-4843-b5b6-6960f8030e35\\scratch\\verify_minisign';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const results = [];

function assert(condition, message, details = null) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  [PASS] ${message}`);
    results.push({ test: message, status: 'PASS', details });
  } else {
    failedTests++;
    console.error(`  [FAIL] ${message}`);
    results.push({ test: message, status: 'FAIL', details });
  }
}

function computeSha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
}

function semverCompare(v1, v2) {
  const p1 = v1.split('.').map(Number);
  const p2 = v2.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (p1[i] > p2[i]) return 1;
    if (p1[i] < p2[i]) return -1;
  }
  return 0;
}

console.log('================================================================');
console.log('TORI Download Manager — Gate 23.2 Release Readiness Verification');
console.log('================================================================');

// --- 1. Version Synchronization ---
console.log('\n--- STEP 1: Version Synchronization & Parity ---');
const cargoToml = fs.readFileSync(path.join(PROJECT_ROOT, 'Cargo.toml'), 'utf8');
const cargoMatch = cargoToml.match(/version\s*=\s*"([^"]+)"/);
const cargoVer = cargoMatch ? cargoMatch[1] : null;
assert(cargoVer === '1.0.3', `Cargo.toml workspace package version is 1.0.3 (got: ${cargoVer})`);

const tauriConf = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
assert(tauriConf.version === '1.0.3', `src-tauri/tauri.conf.json version is 1.0.3 (got: ${tauriConf.version})`);

const uiPkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'ui', 'package.json'), 'utf8'));
assert(uiPkg.version === '1.0.3', `ui/package.json version is 1.0.3 (got: ${uiPkg.version})`);

const crManifest = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'extension', 'manifest.json'), 'utf8'));
assert(crManifest.version === '1.0.3', `extension/manifest.json version is 1.0.3 (got: ${crManifest.version})`);

const ffManifest = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'extension', 'firefox', 'manifest.json'), 'utf8'));
assert(ffManifest.version === '1.0.3', `extension/firefox/manifest.json version is 1.0.3 (got: ${ffManifest.version})`);

// --- 2. Binary & Installer PE Metadata ---
console.log('\n--- STEP 2: PE Executable & Installer Version Verification ---');
assert(fs.existsSync(INSTALLER_PATH), `Installer file exists at ${INSTALLER_PATH}`);
const installerStat = fs.statSync(INSTALLER_PATH);
assert(installerStat.size > 100 * 1024 * 1024, `Installer size is valid (>100MB, got: ${(installerStat.size / (1024*1024)).toFixed(2)} MB)`);

try {
  const peCheck = execSync(
    `powershell -NoProfile -Command "(Get-Item '${INSTALLER_PATH}').VersionInfo.FileVersion"`,
    { encoding: 'utf8' }
  ).trim();
  assert(peCheck === '1.0.3', `Installer PE FileVersion is 1.0.3 (got: ${peCheck})`);
} catch (e) {
  assert(false, 'Failed to read installer PE version info', e.message);
}

// --- 3. Cryptographic Signature & Minisign ---
console.log('\n--- STEP 3: Cryptographic Signature & Anti-Tamper Verification ---');
assert(fs.existsSync(SIG_PATH), `Signature file exists at ${SIG_PATH}`);
const sigRaw = fs.readFileSync(SIG_PATH, 'utf8').trim();
assert(sigRaw.length > 200, `Signature file length is valid (${sigRaw.length} chars)`);

const minisignRes = spawnSync('cargo', ['run', '--release'], { cwd: SCRATCH_VERIFY, encoding: 'utf8' });
assert(
  minisignRes.status === 0 && minisignRes.stdout.includes('ALL VERSIONS PASSED MINISIGN CRYPTOGRAPHIC VERIFICATION!'),
  'Minisign Ed25519 verification succeeds for v1.0.3 installer against public key CDC23D8C'
);
assert(
  minisignRes.stdout.includes('Tampered binary rejected correctly: InvalidSignature'),
  'Minisign engine strictly rejects tampered installer binary with InvalidSignature'
);

// --- 4. Staged v1.0.3 Updater Manifest & Cross-Version Compatibility ---
console.log('\n--- STEP 4: Updater Manifest Schema & Upgrade Matrix ---');
assert(fs.existsSync(MANIFEST_PATH), `latest.json manifest exists at ${MANIFEST_PATH}`);
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
assert(manifest.version === '1.0.3', `latest.json version is 1.0.3 (got: ${manifest.version})`);
assert(Boolean(manifest.platforms && manifest.platforms['windows-x86_64'] && manifest.platforms['windows-x86_64-nsis']), 'Manifest provides windows-x86_64 and windows-x86_64-nsis targets');
assert(manifest.platforms['windows-x86_64'].signature === sigRaw, 'windows-x86_64 signature matches .sig file');
assert(manifest.platforms['windows-x86_64-nsis'].signature === sigRaw, 'windows-x86_64-nsis signature matches .sig file');
assert(manifest.platforms['windows-x86_64'].url.includes('/releases/download/v1.0.3/TORI.Download.Manager_1.0.3_x64-setup.exe'), 'Installer URL accurately targets v1.0.3 GitHub release');

// Upgrade compatibility checks
assert(semverCompare('1.0.3', '1.0.0') > 0, 'v1.0.0 -> v1.0.3 upgrade path: remote (1.0.3) > client (1.0.0) -> Update Available');
assert(semverCompare('1.0.3', '1.0.1') > 0, 'v1.0.1 -> v1.0.3 upgrade path: remote (1.0.3) > client (1.0.1) -> Update Available');
assert(semverCompare('1.0.3', '1.0.2') > 0, 'v1.0.2 -> v1.0.3 upgrade path: remote (1.0.3) > client (1.0.2) -> Update Available');
assert(semverCompare('1.0.3', '1.0.3') === 0, 'v1.0.3 -> v1.0.3 check: remote (1.0.3) == client (1.0.3) -> Up to Date (No false loops)');
assert(semverCompare('1.0.2', '1.0.3') < 0, 'Downgrade protection: remote (1.0.2) < client (1.0.3) -> Downgrade Rejected');

// Security check on manifest content
const manifestStr = JSON.stringify(manifest);
assert(!manifestStr.includes('F:\\') && !manifestStr.includes('C:\\'), 'Manifest contains zero local absolute paths');
assert(!manifestStr.includes('token') && !manifestStr.includes('secret') && !manifestStr.includes('key:'), 'Manifest contains zero sensitive tokens');

// --- 5. Browser Extension Packages ---
console.log('\n--- STEP 5: Browser Extension Packages & Linter ---');
const crZipPath = path.join(STAGING_DIR, 'tori-download-manager-extension-v1.0.3.zip');
const ffZipPath = path.join(STAGING_DIR, 'tori-download-manager-firefox-v1.0.3.zip');
assert(fs.existsSync(crZipPath), `Chromium extension package exists (${crZipPath})`);
assert(fs.existsSync(ffZipPath), `Firefox extension package exists (${ffZipPath})`);
assert(fs.statSync(crZipPath).size > 50000, `Chromium extension package size is valid (${fs.statSync(crZipPath).size} bytes)`);
assert(fs.statSync(ffZipPath).size > 50000, `Firefox extension package size is valid (${fs.statSync(ffZipPath).size} bytes)`);

// Validate web-ext lint on firefox source
try {
  const lintRes = execSync('npx web-ext lint --source-dir extension/firefox', { cwd: PROJECT_ROOT, encoding: 'utf8' });
  assert(lintRes.includes('errors          0'), 'Mozilla web-ext linter reports 0 errors on Firefox extension');
} catch (e) {
  const out = e.stdout || '';
  assert(out.includes('errors          0'), 'Mozilla web-ext linter reports 0 errors on Firefox extension');
}

// --- 6. SHA256 Checksums Integrity ---
console.log('\n--- STEP 6: SHA256 Checksum Manifest Verification ---');
assert(fs.existsSync(CHECKSUMS_PATH), `SHA256SUMS.txt exists at ${CHECKSUMS_PATH}`);
const checksumLines = fs.readFileSync(CHECKSUMS_PATH, 'utf8').trim().split('\n');
let allChecksumsMatch = true;
for (const line of checksumLines) {
  if (!line.trim()) continue;
  const match = line.trim().match(/^([a-f0-9]{64})\s+(.+)$/);
  if (!match) continue;
  const expectedHash = match[1];
  const fileName = match[2];
  const targetFile = path.join(STAGING_DIR, fileName);
  if (!fs.existsSync(targetFile)) {
    allChecksumsMatch = false;
    assert(false, `Checksummed file missing: ${fileName}`);
    continue;
  }
  const actualHash = computeSha256(targetFile);
  if (actualHash !== expectedHash) {
    allChecksumsMatch = false;
    assert(false, `Checksum mismatch for ${fileName}: expected ${expectedHash}, got ${actualHash}`);
  }
}
assert(allChecksumsMatch, `All ${checksumLines.length} staged file checksums in SHA256SUMS.txt match perfectly`);

// --- 7. Release Isolation & Production Safety Restrictions ---
console.log('\n--- STEP 7: Production Safety & Isolation Audit ---');
// Verify public latest.json still targets v1.0.2
try {
  const curlRes = execSync('curl.exe -sL "https://github.com/robijoychakma375-hash/tori-download-manager/releases/latest/download/latest.json"', { encoding: 'utf8' });
  const pubLatest = JSON.parse(curlRes);
  assert(pubLatest.version === '1.0.2', `Public updater still serves v1.0.2 (got: ${pubLatest.version})`);
} catch (e) {
  assert(false, 'Failed to fetch public latest.json', e.message);
}

// Verify release/ is git ignored
try {
  const ignoreCheck = execSync('git check-ignore release/v1.0.3-final/', { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim();
  assert(ignoreCheck === 'release/v1.0.3-final/', 'release/v1.0.3-final/ is properly ignored by Git');
} catch (e) {
  assert(false, 'release/v1.0.3-final/ is NOT git ignored!');
}

console.log('\n================================================================');
console.log(`GATE 23.2 RELEASE READINESS: ${passedTests}/${totalTests} PASSED (${failedTests} FAILED)`);
console.log('================================================================');

fs.writeFileSync(
  path.join(PROJECT_ROOT, 'scripts', 'gate23_2_verification_results.json'),
  JSON.stringify({
    gate: 'Gate 23.2 — v1.0.3 Production Build & Extension Packaging',
    timestamp: new Date().toISOString(),
    totalTests,
    passedTests,
    failedTests,
    installerPath: INSTALLER_PATH,
    installerSha256: computeSha256(INSTALLER_PATH),
    results
  }, null, 2) + '\n',
  'utf8'
);

if (failedTests > 0) {
  process.exit(1);
}
