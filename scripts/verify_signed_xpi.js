const fs = require('fs');
const crypto = require('crypto');
const cp = require('child_process');
const path = require('path');

const xpiPath = 'C:\\Users\\ritud\\Downloads\\a70ed17e183648a9bcf4-1.0.2.xpi';

if (!fs.existsSync(xpiPath)) {
  console.error('File not found:', xpiPath);
  process.exit(1);
}

const buf = fs.readFileSync(xpiPath);
const hash = crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
const expectedHash = '520424ff38ddb1bf84152e7fd3c9bf4678ce6af1542995a6d4b58c4dc4fbb8d0';

console.log('--- Mozilla Signed XPI Verification ---');
console.log('File path:      ', xpiPath);
console.log('File size:      ', buf.length, 'bytes');
console.log('Computed SHA256:', hash);
console.log('Expected SHA256:', expectedHash);
console.log('Hash Match:     ', hash === expectedHash);

if (hash !== expectedHash) {
  console.error('FATAL: SHA256 checksum mismatch!');
  process.exit(1);
}

// Inspect internal manifest.json
const manifestRaw = cp.execSync(`tar -xOf "${xpiPath}" manifest.json`, { encoding: 'utf8' });
const manifest = JSON.parse(manifestRaw);
console.log('\n--- Internal Manifest.json ---');
console.log('Name:           ', manifest.name);
console.log('Version:        ', manifest.version);
console.log('Manifest Version:', manifest.manifest_version);
console.log('Gecko ID:       ', manifest.browser_specific_settings?.gecko?.id);

// Inspect META-INF signatures
const entries = cp.execSync(`tar -tf "${xpiPath}"`, { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
const metaInf = entries.filter(e => e.startsWith('META-INF') || e.includes('mozilla'));
console.log('\n--- Mozilla Signature Metadata ---');
console.log('Signature entries:', metaInf);

const isSigned = metaInf.some(e => e.includes('mozilla.rsa') || e.includes('mozilla.sf') || e.includes('cose.sig'));
console.log('Mozilla Signed: ', isSigned);
