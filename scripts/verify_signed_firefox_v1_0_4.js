const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const XPI_SRC = 'C:/Users/ritud/.gemini/antigravity/brain/4cb6b42b-ac51-4843-b5b6-6960f8030e35/.user_uploaded/media_1794436060054_2f9a21d5.xpi';
const DEST_DIR = path.join(PROJECT_ROOT, 'target', 'verify_signed_xpi_v104');

if (fs.existsSync(DEST_DIR)) fs.rmSync(DEST_DIR, { recursive: true, force: true });
fs.mkdirSync(DEST_DIR, { recursive: true });

// 1. SHA256 of XPI
const xpiBuf = fs.readFileSync(XPI_SRC);
const xpiSha256 = crypto.createHash('sha256').update(xpiBuf).digest('hex').toLowerCase();
console.log('XPI Size:', xpiBuf.length, 'bytes');
console.log('XPI SHA256:', xpiSha256);

// 2. Unpack XPI
cp.execSync(`tar.exe -xf "${XPI_SRC}" -C "${DEST_DIR}"`);

// 3. Manifest checks
const manifestPath = path.join(DEST_DIR, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
console.log('\n--- Manifest Check ---');
console.log('Name:', manifest.name);
console.log('Version:', manifest.version);
console.log('Gecko ID:', manifest.browser_specific_settings?.gecko?.id);
console.log('Strict Min Version:', manifest.browser_specific_settings?.gecko?.strict_min_version);

// 4. Check Mozilla Signature files
console.log('\n--- Mozilla Signature Check ---');
const metaInf = path.join(DEST_DIR, 'META-INF');
if (fs.existsSync(metaInf)) {
  const files = fs.readdirSync(metaInf);
  console.log('META-INF entries:', files.join(', '));
  const hasRsa = files.includes('mozilla.rsa');
  const hasSf = files.includes('mozilla.sf');
  const hasMf = files.includes('manifest.mf');
  console.log('Mozilla Signed:', hasRsa && hasSf && hasMf ? 'YES' : 'NO');
} else {
  console.log('META-INF missing!');
}

// 5. Compare content.js, content.css, popup files against extension/
console.log('\n--- Presentation File Parity Check ---');
const filesToCompare = [
  'content.js',
  'content.css',
  'popup/popup.html',
  'popup/popup.css',
  'popup/popup.js'
];

for (const f of filesToCompare) {
  const signedF = path.join(DEST_DIR, f);
  const srcF = path.join(PROJECT_ROOT, 'extension', f);
  if (fs.existsSync(signedF) && fs.existsSync(srcF)) {
    const b1 = fs.readFileSync(signedF);
    const b2 = fs.readFileSync(srcF);
    console.log(`Parity ${f}:`, b1.equals(b2) ? 'MATCH' : 'DIFF');
  } else {
    console.log(`Missing file: ${f}`);
  }
}
