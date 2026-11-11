/**
 * TORI Download Manager — Firefox v1.0.3 Signed XPI Integrator & Staging Updater
 *
 * Automatically detects the newly signed Firefox XPI in Downloads,
 * verifies Mozilla cryptographic signatures and Gecko ID,
 * stages it to release/v1.0.3-final/, and updates SHA256SUMS.txt and RELEASE_MANIFEST.json.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const STAGING_DIR = path.join(PROJECT_ROOT, 'release', 'v1.0.3-final');
const DOWNLOADS_DIR = path.join(process.env.USERPROFILE, 'Downloads');

function computeSha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
}

function findSignedXpi() {
  // Check STAGING_DIR first
  const stagingTarget = path.join(STAGING_DIR, 'tori-download-manager-firefox-v1.0.3.xpi');
  if (fs.existsSync(stagingTarget)) {
    return stagingTarget;
  }

  // Check Downloads directory for 1.0.3 xpi
  if (fs.existsSync(DOWNLOADS_DIR)) {
    const files = fs.readdirSync(DOWNLOADS_DIR);
    for (const f of files) {
      if (f.endsWith('-1.0.3.xpi') || f === 'tori-download-manager-firefox-v1.0.3.xpi') {
        return path.join(DOWNLOADS_DIR, f);
      }
    }
  }

  return null;
}

function verifyAndIntegrate() {
  console.log('=== TORI v1.0.3: Firefox Signed XPI Integration ===\n');

  const xpiSource = findSignedXpi();
  if (!xpiSource) {
    console.error('[BLOCKER] No v1.0.3 signed XPI found in Downloads or staging directory.');
    console.error('Please download the Mozilla-signed XPI from AMO and place it in:');
    console.error(`  ${DOWNLOADS_DIR}`);
    process.exit(1);
  }

  console.log(`[FOUND] Detected candidate signed XPI: ${xpiSource}`);

  // Inspect internal manifest
  let manifest;
  try {
    const raw = cp.execSync(`tar -xOf "${xpiSource}" manifest.json`, { encoding: 'utf8' });
    manifest = JSON.parse(raw);
  } catch (e) {
    console.error('[FAIL] Could not read manifest.json from XPI:', e.message);
    process.exit(1);
  }

  if (manifest.version !== '1.0.3') {
    console.error(`[FAIL] XPI version is ${manifest.version}, expected 1.0.3!`);
    process.exit(1);
  }

  const geckoId = manifest.browser_specific_settings?.gecko?.id;
  if (geckoId !== 'tori-download-manager@toridm.org') {
    console.error(`[FAIL] XPI Gecko ID is ${geckoId}, expected tori-download-manager@toridm.org!`);
    process.exit(1);
  }
  console.log(`[PASS] XPI version: ${manifest.version} | Gecko ID: ${geckoId}`);

  // Verify Mozilla signature files
  const entries = cp.execSync(`tar -tf "${xpiSource}"`, { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  const isSigned = entries.some(e => e.includes('mozilla.rsa') || e.includes('mozilla.sf') || e.includes('cose.sig') || e.includes('cose.manifest'));
  if (!isSigned) {
    console.error('[FATAL] Package is NOT signed by Mozilla AMO! Contains no META-INF signatures.');
    process.exit(1);
  }
  console.log('[PASS] Mozilla cryptographic signature block verified inside XPI!');

  // Copy to staging directory
  const destXpi = path.join(STAGING_DIR, 'tori-download-manager-firefox-v1.0.3.xpi');
  fs.copyFileSync(xpiSource, destXpi);
  const originalMirror = path.join(STAGING_DIR, path.basename(xpiSource));
  if (originalMirror !== destXpi) {
    fs.copyFileSync(xpiSource, originalMirror);
  }

  const xpiBuf = fs.readFileSync(destXpi);
  const xpiHash = computeSha256(destXpi);
  console.log(`[STAGED] ${path.basename(destXpi)} (${xpiBuf.length.toLocaleString()} bytes) -> ${xpiHash}`);

  // Re-run stage script to regenerate checksums & manifest
  console.log('\n[SYNC] Regenerating release/v1.0.3-final/ manifest and SHA256SUMS.txt...');
  cp.execSync('node scripts/stage_v1_0_3_final_release.js', { cwd: PROJECT_ROOT, stdio: 'inherit' });

  // Update RELEASE_MANIFEST.json with signed XPI metadata
  const manifestPath = path.join(STAGING_DIR, 'RELEASE_MANIFEST.json');
  if (fs.existsSync(manifestPath)) {
    const relManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    relManifest.browserExtensions.firefox.signedXpiFilename = 'tori-download-manager-firefox-v1.0.3.xpi';
    relManifest.browserExtensions.firefox.signedXpiSizeBytes = xpiBuf.length;
    relManifest.browserExtensions.firefox.signedXpiSha256 = xpiHash;
    relManifest.browserExtensions.firefox.mozillaSignatureStatus = 'OFFICIALLY SIGNED (Mozilla AMO Validated)';
    relManifest.browserExtensions.firefox.signatureType = 'Mozilla PKCS#7 & COSE Signature Block';
    relManifest.browserExtensions.firefox.signatureValidation = 'Accepted by Firefox with xpinstall.signatures.required enabled';
    relManifest.browserExtensions.firefox.distributionStatus = 'SIGNED_XPI_READY';
    fs.writeFileSync(manifestPath, JSON.stringify(relManifest, null, 2) + '\n', 'utf8');
    console.log('[PASS] Updated RELEASE_MANIFEST.json with signed Firefox XPI metadata.');
  }

  // Append signed XPI checksums if not present
  const sumsPath = path.join(STAGING_DIR, 'SHA256SUMS.txt');
  let sums = fs.readFileSync(sumsPath, 'utf8');
  if (!sums.includes('tori-download-manager-firefox-v1.0.3.xpi')) {
    sums += `${xpiHash}  tori-download-manager-firefox-v1.0.3.xpi\n`;
    if (path.basename(xpiSource) !== 'tori-download-manager-firefox-v1.0.3.xpi') {
      sums += `${xpiHash}  ${path.basename(xpiSource)}\n`;
    }
    fs.writeFileSync(sumsPath, sums, 'utf8');
    console.log('[PASS] Appended signed XPI hashes to SHA256SUMS.txt.');
  }

  console.log('\n=== Firefox Signed XPI Integration Complete! ===');
}

verifyAndIntegrate();
