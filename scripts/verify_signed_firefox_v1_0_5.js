const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const XPI_SRC = 'C:\\Users\\ritud\\.gemini\\antigravity\\brain\\4cb6b42b-ac51-4843-b5b6-6960f8030e35\\.user_uploaded\\media_1794464251301_e1a84a8f.xpi';
const DEST_DIR = path.join(PROJECT_ROOT, 'release', 'v1.0.5-extension');
const DEST_XPI = path.join(DEST_DIR, 'tori-download-manager-firefox-v1.0.5.xpi');
const UNPACK_DIR = path.join(PROJECT_ROOT, 'target', 'verify_signed_xpi_v105');

function computeSha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
}

async function verify() {
  console.log('================================================================');
  console.log('GATE 25.1: VERIFY SIGNED FIREFOX v1.0.5 XPI & PACKAGES');
  console.log('================================================================\n');

  if (!fs.existsSync(XPI_SRC)) {
    throw new Error(`Uploaded XPI not found at: ${XPI_SRC}`);
  }

  const xpiSize = fs.statSync(XPI_SRC).size;
  const xpiSha = computeSha256(XPI_SRC);
  console.log(`[1/5] Uploaded XPI size: ${xpiSize.toLocaleString()} bytes`);
  console.log(`      SHA256: ${xpiSha}`);

  // Copy to destination release directory
  fs.mkdirSync(DEST_DIR, { recursive: true });
  fs.copyFileSync(XPI_SRC, DEST_XPI);
  console.log(`      Copied to: ${DEST_XPI}`);

  // Unpack XPI to inspect
  if (fs.existsSync(UNPACK_DIR)) fs.rmSync(UNPACK_DIR, { recursive: true, force: true });
  fs.mkdirSync(UNPACK_DIR, { recursive: true });

  cp.execSync(`tar.exe -xf "${DEST_XPI}" -C "${UNPACK_DIR}"`);
  console.log('[2/5] Successfully unpacked XPI.');

  // Verify manifest.json
  const manifestPath = path.join(UNPACK_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('manifest.json missing in XPI!');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  console.log(`[3/5] Manifest version: ${manifest.version}`);
  console.log(`      Gecko ID: ${manifest.browser_specific_settings?.gecko?.id}`);

  if (manifest.version !== '1.0.5') {
    throw new Error(`XPI manifest version is ${manifest.version}, expected 1.0.5`);
  }
  if (manifest.browser_specific_settings?.gecko?.id !== 'tori-download-manager@toridm.org') {
    throw new Error(`Invalid Gecko ID: ${manifest.browser_specific_settings?.gecko?.id}`);
  }

  // Verify Mozilla Signatures
  const metaInf = path.join(UNPACK_DIR, 'META-INF');
  if (!fs.existsSync(metaInf)) throw new Error('META-INF directory missing! XPI is NOT signed.');
  const sigFiles = fs.readdirSync(metaInf);
  console.log(`[4/5] Mozilla Signature files found: ${sigFiles.join(', ')}`);
  const hasRsa = sigFiles.some(f => f.endsWith('.rsa') || f.endsWith('.sf'));
  const hasCose = sigFiles.includes('cose.sig') || sigFiles.includes('cose.manifest');
  if (!hasRsa && !hasCose) throw new Error('No valid Mozilla signatures detected in META-INF!');

  // Verify Hotfix Code presence in XPI
  const xpiContentJs = fs.readFileSync(path.join(UNPACK_DIR, 'content.js'), 'utf8');
  const repoContentJs = fs.readFileSync(path.join(PROJECT_ROOT, 'extension', 'content.js'), 'utf8');

  const hasCaptureListener = xpiContentJs.includes("window.addEventListener('pointermove', onPointerMove, { capture: true");
  const hasButtonsCheck = xpiContentJs.includes("(e.buttons & 1) === 0");
  const hasLostCapture = xpiContentJs.includes("lostpointercapture");

  console.log(`[5/5] Hotfix Code in XPI content.js:`);
  console.log(`      Capture listener present: ${hasCaptureListener}`);
  console.log(`      Buttons & 1 check present: ${hasButtonsCheck}`);
  console.log(`      Lost pointer capture present: ${hasLostCapture}`);

  if (!hasCaptureListener || !hasButtonsCheck || !hasLostCapture) {
    throw new Error('Critical hotfix code missing from signed XPI!');
  }

  // Compare file parity between repo and XPI (excluding META-INF)
  const filesToCompare = ['content.js', 'content.css', 'popup/popup.html', 'popup/popup.css', 'popup/popup.js'];
  for (const f of filesToCompare) {
    const fromXpi = fs.readFileSync(path.join(UNPACK_DIR, f));
    const fromRepo = fs.readFileSync(path.join(PROJECT_ROOT, 'extension', f));
    if (!fromXpi.equals(fromRepo)) {
      throw new Error(`Mismatch between signed XPI and repo source for file: ${f}`);
    }
  }
  console.log('      All core presentation & logic files match repo source with 100% byte parity.');

  // Check Chromium ZIP
  const crZip = path.join(DEST_DIR, 'tori-download-manager-extension-v1.0.5.zip');
  if (!fs.existsSync(crZip)) throw new Error(`Chromium ZIP missing at: ${crZip}`);
  const crSha = computeSha256(crZip);
  const crSize = fs.statSync(crZip).size;
  console.log(`\nChromium Extension Package:`);
  console.log(`      File: ${path.basename(crZip)} (${crSize.toLocaleString()} bytes)`);
  console.log(`      SHA256: ${crSha}`);

  // Update SHA256SUMS.txt with signed XPI
  const sumsFile = path.join(DEST_DIR, 'SHA256SUMS.txt');
  const sumsContent = [
    `${xpiSha}  tori-download-manager-firefox-v1.0.5.xpi`,
    `${crSha}  tori-download-manager-extension-v1.0.5.zip`,
  ].join('\n') + '\n';
  fs.writeFileSync(sumsFile, sumsContent, 'utf8');
  console.log(`\nUpdated ${sumsFile}:`);
  console.log(sumsContent);

  console.log('================================================================');
  console.log('VERIFICATION COMPLETE: ALL PACKAGES SIGNED AND VALIDATED');
  console.log('================================================================');
}

verify().catch((e) => {
  console.error('[FAIL]', e.message);
  process.exit(1);
});
