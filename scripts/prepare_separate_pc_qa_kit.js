/**
 * TORI Download Manager v1.0.1 — GATE 18.7 Separate-PC QA Kit Synchronizer
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const FINAL_DIR = path.join(ROOT, 'release', 'v1.0.1-final');
const QA_KIT_DIR = path.join(ROOT, 'release', 'separate-pc-qa-kit');
const FINAL_QA_KIT_DIR = path.join(FINAL_DIR, 'separate-pc-qa-kit');

if (!fs.existsSync(QA_KIT_DIR)) {
  fs.mkdirSync(QA_KIT_DIR, { recursive: true });
}
if (!fs.existsSync(FINAL_QA_KIT_DIR)) {
  fs.mkdirSync(FINAL_QA_KIT_DIR, { recursive: true });
}

console.log('=== TORI v1.0.1: Synchronizing Separate-PC QA Kit ===');

const filesToSync = [
  'TORI Download Manager_1.0.1_x64-setup.exe',
  'TORI Download Manager_1.0.1_x64-setup.exe.sig',
  'tori-download-manager-firefox-v1.0.2.xpi',
  'tori-download-manager-extension-v1.0.2.zip',
  'LICENSE',
  'LICENSE-THIRD-PARTY.txt'
];

for (const f of filesToSync) {
  const src = path.join(FINAL_DIR, f);
  const dest1 = path.join(QA_KIT_DIR, f);
  const dest2 = path.join(FINAL_QA_KIT_DIR, f);
  if (!fs.existsSync(src)) {
    throw new Error(`Missing source file: ${src}`);
  }
  fs.copyFileSync(src, dest1);
  fs.copyFileSync(src, dest2);
}

// Regenerate SHA256SUMS.txt in QA_KIT_DIR
const qaFiles = fs.readdirSync(QA_KIT_DIR).filter(f => f !== 'SHA256SUMS.txt');
const sums = [];
for (const f of qaFiles) {
  const p = path.join(QA_KIT_DIR, f);
  if (fs.statSync(p).isFile()) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toLowerCase();
    sums.push(`${hash}  ${f}`);
  }
}
fs.writeFileSync(path.join(QA_KIT_DIR, 'SHA256SUMS.txt'), sums.join('\n') + '\n', 'utf8');

// Copy all non-binary script & doc files to FINAL_QA_KIT_DIR as well
for (const f of fs.readdirSync(QA_KIT_DIR)) {
  fs.copyFileSync(path.join(QA_KIT_DIR, f), path.join(FINAL_QA_KIT_DIR, f));
}

console.log(`Kit synchronized successfully: ${qaFiles.length} files in separate-pc-qa-kit/`);
