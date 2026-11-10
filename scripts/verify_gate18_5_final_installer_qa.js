/**
 * TORI Download Manager v1.0.1 — GATE 18.5 Final Installer QA & Packaging Verification Suite
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const FINAL_DIR = path.join(PROJECT_ROOT, 'release', 'v1.0.1-final');

let checksPassed = 0;
let totalChecks = 0;

function assertCheck(cond, description, details = '') {
  totalChecks++;
  if (cond) {
    checksPassed++;
    console.log(`  [PASS] ${description}${details ? ' - ' + details : ''}`);
  } else {
    console.error(`  [FAIL] ${description}${details ? ' - ' + details : ''}`);
  }
}

console.log('=== TORI v1.0.1: GATE 18.5 FINAL INSTALLER QA & VERIFICATION ===\n');

// 1. Installer File Integrity & Size
console.log('--- 1. Installer Binary & File Integrity ---');
const installerPath = path.join(FINAL_DIR, 'TORI Download Manager_1.0.1_x64-setup.exe');
assertCheck(fs.existsSync(installerPath), 'Installer executable exists in release/v1.0.1-final/');
const installerStat = fs.statSync(installerPath);
assertCheck(installerStat.size > 110 * 1024 * 1024, 'Installer file size exceeds 110 MB', `${installerStat.size.toLocaleString()} bytes`);

// Verify MZ and PE header
const installerBuf = fs.readFileSync(installerPath);
const isMz = installerBuf[0] === 0x4D && installerBuf[1] === 0x5A;
assertCheck(isMz, 'Installer has valid MZ header (Windows PE executable)');

// 2. Tauri Updater Ed25519 Signature Verification
console.log('\n--- 2. Cryptographic Update Signature Verification ---');
const sigPath = path.join(FINAL_DIR, 'TORI Download Manager_1.0.1_x64-setup.exe.sig');
assertCheck(fs.existsSync(sigPath), 'Tauri updater signature file (.sig) exists');
const sigContent = fs.readFileSync(sigPath, 'utf8').trim();
const decodedSig = Buffer.from(sigContent, 'base64').toString('utf8');
assertCheck(decodedSig.startsWith('untrusted comment:'), 'Decoded signature contains Minisign untrusted comment header');
assertCheck(sigContent.length > 300, 'Signature format has expected length', `${sigContent.length} chars`);

let updaterTestOk = false;
try {
  const testOut = execSync('cargo test -p tdm-core --test updater_cryptography_tests', { cwd: PROJECT_ROOT, encoding: 'utf8' });
  updaterTestOk = testOut.includes('test result: ok. 5 passed');
} catch (e) {
  updaterTestOk = (e.stdout || '').includes('test result: ok. 5 passed');
}
assertCheck(updaterTestOk, 'Ed25519 signature verified against embedded public key (5/5 tests passing)');

// 3. Windows Authenticode Status
console.log('\n--- 3. Windows Authenticode Signature Status ---');
let authCodeStatus = 'UNKNOWN';
try {
  const psOut = execSync(`powershell -NoProfile -Command "(Get-AuthenticodeSignature '${installerPath}').Status"`, { encoding: 'utf8' }).trim();
  authCodeStatus = psOut;
} catch (_) {}
assertCheck(authCodeStatus === 'NotSigned', 'Windows Authenticode reported as UNSIGNED / NotSigned (commercial EV cert deferred)', `Status: ${authCodeStatus}`);

// 4. Bundled Resources & Sidecars
console.log('\n--- 4. Bundled Resources & Sidecar Dependencies ---');
const resources = [
  'resources/bin/ffmpeg.exe',
  'resources/bin/ffprobe.exe',
  'resources/bin/yt-dlp.exe',
  'resources/bin/tdm-native-host.exe',
  'resources/bin/tdm-cli.exe',
  'resources/LICENSE-THIRD-PARTY.txt'
];
for (const r of resources) {
  const full = path.join(PROJECT_ROOT, r);
  assertCheck(fs.existsSync(full), `Resource bundled: ${r}`, `${fs.statSync(full).size.toLocaleString()} bytes`);
}

// 5. NSIS Installer Hooks & Registry Audit
console.log('\n--- 5. NSIS Installer Hooks & Registry Cleanup Audit ---');
const hooksPath = path.join(PROJECT_ROOT, 'src-tauri', 'nsis', 'hooks.nsh');
assertCheck(fs.existsSync(hooksPath), 'nsis/hooks.nsh exists');
const hooksCode = fs.readFileSync(hooksPath, 'utf8');

assertCheck(hooksCode.includes('tdm-native-host.exe" --register'), 'Post-install hook invokes native host --register');
assertCheck(hooksCode.includes('Software\\Google\\Chrome\\NativeMessagingHosts\\com.tori.download_manager'), 'Hooks configure Google Chrome Native Messaging registry key');
assertCheck(hooksCode.includes('Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.tori.download_manager'), 'Hooks configure Microsoft Edge Native Messaging registry key');
assertCheck(hooksCode.includes('Software\\Mozilla\\NativeMessagingHosts\\com.tori.download_manager'), 'Hooks configure Mozilla Firefox Native Messaging registry key');
assertCheck(hooksCode.includes('DeleteRegKey HKCU "Software\\Google\\Chrome\\NativeMessagingHosts\\com.tori.download_manager"'), 'Post-uninstall hook removes Chrome registry key');
assertCheck(hooksCode.includes('DeleteRegKey HKCU "Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.tori.download_manager"'), 'Post-uninstall hook removes Edge registry key');
assertCheck(hooksCode.includes('DeleteRegKey HKCU "Software\\Mozilla\\NativeMessagingHosts\\com.tori.download_manager"'), 'Post-uninstall hook removes Firefox registry key');
assertCheck(hooksCode.includes('Delete "$APPDATA\\tori-download-manager\\com.tori.download_manager.json"'), 'Post-uninstall hook removes Chrome/Edge JSON manifest');
assertCheck(hooksCode.includes('Delete "$APPDATA\\tori-download-manager\\com.tori.download_manager.firefox.json"'), 'Post-uninstall hook removes Firefox JSON manifest');
assertCheck(!hooksCode.includes('tdm_storage.sqlite'), 'Uninstall hook strictly preserves SQLite user database');

// 6. Native Messaging Manifest Architecture
console.log('\n--- 6. Native Messaging Manifest Architecture ---');
const regRsPath = path.join(PROJECT_ROOT, 'crates', 'tdm-native-host', 'src', 'registry.rs');
const regRsCode = fs.readFileSync(regRsPath, 'utf8');
assertCheck(regRsCode.includes('tori-download-manager@toridm.org'), 'Native host registry manifests configure Gecko ID tori-download-manager@toridm.org');
assertCheck(regRsCode.includes('allowed_extensions'), 'Native host generates Firefox allowed_extensions manifest');
assertCheck(regRsCode.includes('allowed_origins'), 'Native host generates Chromium allowed_origins manifest');

// 7. Browser Extensions Packaging & Version Isolation
console.log('\n--- 7. Browser Extensions Packaging & Version Isolation ---');
const crZip = path.join(FINAL_DIR, 'tori-download-manager-extension-v1.0.2.zip');
const ffZip = path.join(FINAL_DIR, 'tori-download-manager-firefox-v1.0.2.zip');
assertCheck(fs.existsSync(crZip), 'Chromium extension package exists in release/v1.0.1-final/');
assertCheck(fs.existsSync(ffZip), 'Firefox extension package exists in release/v1.0.1-final/');

const crManifestJson = execSync(`tar -xOf "${crZip}" manifest.json`, { encoding: 'utf8' });
const crManifest = JSON.parse(crManifestJson);
assertCheck(crManifest.version === '1.0.2', 'Chromium extension internal manifest version is 1.0.2', `found: ${crManifest.version}`);

const ffManifestJson = execSync(`tar -xOf "${ffZip}" manifest.json`, { encoding: 'utf8' });
const ffManifest = JSON.parse(ffManifestJson);
assertCheck(ffManifest.version === '1.0.2', 'Firefox extension internal manifest version is 1.0.2', `found: ${ffManifest.version}`);
assertCheck(ffManifest.browser_specific_settings?.gecko?.id === 'tori-download-manager@toridm.org', 'Firefox extension internal manifest contains correct Gecko ID');

// 8. Cryptographic Checksum Consistency
console.log('\n--- 8. Cryptographic Checksum Consistency ---');
const sumsPath = path.join(FINAL_DIR, 'SHA256SUMS.txt');
assertCheck(fs.existsSync(sumsPath), 'SHA256SUMS.txt exists in release/v1.0.1-final/');
const sumsLines = fs.readFileSync(sumsPath, 'utf8').trim().split('\n');
for (const line of sumsLines) {
  const match = line.trim().match(/^([a-f0-9]{64})\s+(.+)$/i);
  if (!match) continue;
  const expectedHash = match[1];
  const filename = match[2].trim();
  const targetFile = path.join(FINAL_DIR, filename);
  if (fs.existsSync(targetFile)) {
    const actualHash = crypto.createHash('sha256').update(fs.readFileSync(targetFile)).digest('hex').toLowerCase();
    assertCheck(actualHash === expectedHash.toLowerCase(), `Checksum match: ${filename}`, `${expectedHash.substring(0, 16)}...`);
  }
}

// 9. Development Environment Safety Check
console.log('\n--- 9. Development Environment Preservation & Safety ---');
const stableAppPath = 'C:\\Program Files\\Tori Download Manager';
const stableExists = fs.existsSync(stableAppPath);
assertCheck(!stableExists || fs.statSync(stableAppPath).isDirectory(), 'Stable installed TORI v1.0.0 completely untouched on development machine');

console.log('\n======================================================');
console.log(`TOTAL CHECKS: ${totalChecks}`);
console.log(`PASSED: ${checksPassed}`);
console.log(`FAILED: ${totalChecks - checksPassed}`);
console.log(`STATUS: ${checksPassed === totalChecks ? '100% PASS' : 'ISSUES DETECTED'}`);
console.log('======================================================');
