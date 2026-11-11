/**
 * TORI Download Manager — Firefox v1.0.3 AMO ZIP Rebuilder & Validator
 *
 * 1. Invokes Mozilla web-ext build to generate ZIP with standard forward-slash (/) paths.
 * 2. Exhaustively audits every entry:
 *    - 0 backslashes (\)
 *    - 0 absolute paths
 *    - 0 parent traversal (../)
 *    - manifest.json at root
 *    - all icons, scripts, html files exist
 * 3. Runs Mozilla web-ext lint.
 * 4. Staging update: updates release/v1.0.3-final/tori-download-manager-firefox-v1.0.3.zip
 * 5. Updates SHA256SUMS.txt and RELEASE_MANIFEST.json.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const FF_DIR = path.join(PROJECT_ROOT, 'extension', 'firefox');
const TARGET_DIR = path.join(PROJECT_ROOT, 'target', 'release');
const STAGING_DIR = path.join(PROJECT_ROOT, 'release', 'v1.0.3-final');
const AMO_BUILD_DIR = path.join(PROJECT_ROOT, 'target', 'firefox_amo_build');

const TARGET_ZIP = path.join(TARGET_DIR, 'tori-download-manager-firefox-v1.0.3.zip');
const STAGED_ZIP = path.join(STAGING_DIR, 'tori-download-manager-firefox-v1.0.3.zip');

function computeSha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
}

function run() {
  console.log('================================================================');
  console.log('TORI Firefox v1.0.3 — AMO ZIP Rebuild & Strict Path Validation');
  console.log('================================================================\n');

  // 1. Build ZIP via web-ext build
  console.log('[1] Building Firefox Extension ZIP via Mozilla web-ext toolchain...');
  if (fs.existsSync(AMO_BUILD_DIR)) {
    fs.rmSync(AMO_BUILD_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(AMO_BUILD_DIR, { recursive: true });

  cp.execSync(`npx web-ext build --source-dir "${FF_DIR}" --artifacts-dir "${AMO_BUILD_DIR}" --overwrite-dest`, {
    cwd: PROJECT_ROOT,
    stdio: 'inherit'
  });

  const zips = fs.readdirSync(AMO_BUILD_DIR).filter(f => f.endsWith('.zip'));
  if (zips.length === 0) {
    throw new Error('web-ext build failed to produce a zip file!');
  }

  const generatedZip = path.join(AMO_BUILD_DIR, zips[0]);
  fs.copyFileSync(generatedZip, TARGET_ZIP);
  fs.rmSync(AMO_BUILD_DIR, { recursive: true, force: true });
  console.log(`[OK] Generated clean package at: ${TARGET_ZIP}`);

  // 2. Inspect ZIP entries using tar.exe
  console.log('\n[2] Exhaustive ZIP Entry Path & Structure Audit...');
  const tarOut = cp.execSync(`tar.exe -tf "${TARGET_ZIP}"`, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });

  const entryNames = tarOut.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  console.log(`Auditing ${entryNames.length} archive entries...`);

  let backslashCount = 0;
  let absolutePathCount = 0;
  let traversalCount = 0;

  for (const name of entryNames) {
    if (name.includes('\\')) {
      console.error(`  [FAIL] Entry contains backslash: "${name}"`);
      backslashCount++;
    }

    if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
      console.error(`  [FAIL] Entry has absolute path: "${name}"`);
      absolutePathCount++;
    }

    if (name.includes('../') || name.includes('..\\')) {
      console.error(`  [FAIL] Entry contains path traversal: "${name}"`);
      traversalCount++;
    }
  }

  if (backslashCount > 0) throw new Error(`Found ${backslashCount} backslash path separators in ZIP!`);
  if (absolutePathCount > 0) throw new Error(`Found ${absolutePathCount} absolute paths in ZIP!`);
  if (traversalCount > 0) throw new Error(`Found ${traversalCount} traversal paths in ZIP!`);
  console.log('  [PASS] 0 backslashes found across all entries (100% forward slashes).');
  console.log('  [PASS] 0 absolute paths found.');
  console.log('  [PASS] 0 path traversal (../) entries found.');

  // 3. Root manifest.json verification
  if (!entryNames.includes('manifest.json')) {
    throw new Error('manifest.json is NOT at the root of the ZIP!');
  }
  console.log('  [PASS] manifest.json is present at ZIP root.');

  // Check no unwanted top-level container directory
  const hasSubdirManifest = entryNames.some(n => n.endsWith('/manifest.json'));
  if (hasSubdirManifest) {
    throw new Error('Detected duplicate or nested manifest.json in subdirectories!');
  }
  console.log('  [PASS] No unwanted wrapper directory (flat root structure).');

  // 4. Verify all manifest references exist in archive
  console.log('\n[3] Verifying Manifest References in ZIP Archive...');
  const manifest = JSON.parse(fs.readFileSync(path.join(FF_DIR, 'manifest.json'), 'utf8'));

  const requiredFiles = [
    'manifest.json',
    'background.js',
    'content.js',
    'content.css',
    manifest.options_ui?.page,
    manifest.action?.default_popup,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {})
  ].filter(Boolean);

  for (const ref of requiredFiles) {
    const normalizedRef = ref.replace(/\\/g, '/');
    if (!entryNames.includes(normalizedRef)) {
      throw new Error(`Referenced asset missing in ZIP: ${normalizedRef}`);
    }
    console.log(`  [PASS] Verified asset exists: ${normalizedRef}`);
  }

  // 5. Run Mozilla web-ext lint
  console.log('\n[4] Running Mozilla web-ext lint on extension source...');
  const lintRes = cp.execSync('npx web-ext lint --source-dir extension/firefox', {
    cwd: PROJECT_ROOT,
    encoding: 'utf8'
  });
  if (!lintRes.includes('errors          0')) {
    throw new Error('web-ext lint reported errors!');
  }
  console.log('  [PASS] web-ext lint: 0 errors verified.');

  // 6. Stage corrected ZIP
  console.log('\n[5] Staging Corrected ZIP to release/v1.0.3-final/...');
  fs.copyFileSync(TARGET_ZIP, STAGED_ZIP);

  const stat = fs.statSync(STAGED_ZIP);
  const newHash = computeSha256(STAGED_ZIP);
  console.log(`  Target: ${STAGED_ZIP}`);
  console.log(`  Size:   ${stat.size.toLocaleString()} bytes`);
  console.log(`  SHA256: ${newHash}`);

  // 7. Update SHA256SUMS.txt
  console.log('\n[6] Updating release/v1.0.3-final/SHA256SUMS.txt...');
  const sumsPath = path.join(STAGING_DIR, 'SHA256SUMS.txt');
  const sumsLines = fs.readFileSync(sumsPath, 'utf8').trim().split('\n');
  const updatedLines = sumsLines.map(line => {
    if (line.includes('tori-download-manager-firefox-v1.0.3.zip')) {
      return `${newHash}  tori-download-manager-firefox-v1.0.3.zip`;
    }
    return line;
  });
  fs.writeFileSync(sumsPath, updatedLines.join('\n') + '\n', 'utf8');
  console.log('  [PASS] SHA256SUMS.txt updated with new Firefox ZIP hash.');

  // 8. Update RELEASE_MANIFEST.json
  console.log('\n[7] Updating release/v1.0.3-final/RELEASE_MANIFEST.json...');
  const manifestJsonPath = path.join(STAGING_DIR, 'RELEASE_MANIFEST.json');
  const relManifest = JSON.parse(fs.readFileSync(manifestJsonPath, 'utf8'));
  relManifest.browserExtensions.firefox.unsignedSourceZipSizeBytes = stat.size;
  relManifest.browserExtensions.firefox.unsignedSourceZipSha256 = newHash;
  fs.writeFileSync(manifestJsonPath, JSON.stringify(relManifest, null, 2) + '\n', 'utf8');
  console.log('  [PASS] RELEASE_MANIFEST.json updated.');

  // 9. Verify Windows installer and Chromium extension were untouched
  console.log('\n[8] Verifying Installer & Chromium Extension Isolation...');
  const installerPath = path.join(STAGING_DIR, 'TORI Download Manager_1.0.3_x64-setup.exe');
  const installerHash = computeSha256(installerPath);
  const expectedInstallerHash = '3804727ebeeeb1ed20de5e81f498f9adb01323481ec767c6813e6f77f1e890f5';
  if (installerHash !== expectedInstallerHash) {
    throw new Error(`CRITICAL: Installer was modified! Got ${installerHash}, expected ${expectedInstallerHash}`);
  }
  console.log('  [PASS] Windows Installer SHA256 matches verified baseline (UNTOUCHED).');

  const crZipPath = path.join(STAGING_DIR, 'tori-download-manager-extension-v1.0.3.zip');
  const crHash = computeSha256(crZipPath);
  const expectedCrHash = 'e4c80356f00bba5befef60397914db983930d2f2f3436de753d521c83a5c2156';
  if (crHash !== expectedCrHash) {
    throw new Error(`CRITICAL: Chromium extension was modified! Got ${crHash}, expected ${expectedCrHash}`);
  }
  console.log('  [PASS] Chromium Extension ZIP SHA256 matches verified baseline (UNTOUCHED).');

  console.log('\n================================================================');
  console.log('SUCCESS: Firefox v1.0.3 ZIP Rebuilt & Ready for Mozilla AMO!');
  console.log('================================================================');
  console.log(`Path:   ${STAGED_ZIP}`);
  console.log(`SHA256: ${newHash}`);
  console.log(`Size:   ${stat.size.toLocaleString()} bytes\n`);
}

run();
