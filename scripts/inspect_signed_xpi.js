const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const xpiPath = 'C:/Users/ritud/.gemini/antigravity/brain/4cb6b42b-ac51-4843-b5b6-6960f8030e35/.user_uploaded/media_1794575136702_dbf15b08.xpi';
const buf = fs.readFileSync(xpiPath);

let eocdOffset = -1;
for (let i = buf.length - 22; i >= 0; i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) {
    eocdOffset = i;
    break;
  }
}

const cdEntries = buf.readUInt16LE(eocdOffset + 10);
const cdOffset = buf.readUInt32LE(eocdOffset + 16);

let cur = cdOffset;
const entries = [];
for (let i = 0; i < cdEntries; i++) {
  const compMethod = buf.readUInt16LE(cur + 10);
  const compSize = buf.readUInt32LE(cur + 20);
  const uncompSize = buf.readUInt32LE(cur + 24);
  const nameLen = buf.readUInt16LE(cur + 28);
  const extraLen = buf.readUInt16LE(cur + 30);
  const commentLen = buf.readUInt16LE(cur + 32);
  const localOffset = buf.readUInt32LE(cur + 42);
  const name = buf.toString('utf8', cur + 46, cur + 46 + nameLen);
  entries.push({ name, compMethod, compSize, uncompSize, localOffset });
  cur += 46 + nameLen + extraLen + commentLen;
}

console.log('Total entries in XPI:', entries.length);
entries.forEach((e, idx) => {
  console.log(`[${(idx + 1).toString().padStart(2, '0')}] ${e.name} (${e.uncompSize} bytes)`);
});

// Function to extract a file by name
function extractFile(name) {
  const entry = entries.find(e => e.name === name);
  if (!entry) return null;
  const lhOffset = entry.localOffset;
  const lhNameLen = buf.readUInt16LE(lhOffset + 26);
  const lhExtraLen = buf.readUInt16LE(lhOffset + 28);
  const dataOffset = lhOffset + 30 + lhNameLen + lhExtraLen;
  const rawData = buf.subarray(dataOffset, dataOffset + entry.compSize);
  if (entry.compMethod === 0) {
    return rawData;
  } else if (entry.compMethod === 8) {
    return zlib.inflateRawSync(rawData);
  } else {
    throw new Error('Unsupported compression method: ' + entry.compMethod);
  }
}

// 1. Manifest verification
console.log('\n--- Manifest Verification ---');
const manifestBuf = extractFile('manifest.json');
if (manifestBuf) {
  const manifest = JSON.parse(manifestBuf.toString('utf8'));
  console.log('Name:', manifest.name);
  console.log('Version:', manifest.version);
  console.log('Gecko ID:', manifest.browser_specific_settings?.gecko?.id);
  console.log('Strict Min Version:', manifest.browser_specific_settings?.gecko?.strict_min_version);
} else {
  console.log('manifest.json NOT found');
}

// 2. Mozilla Signature verification
console.log('\n--- Mozilla Signature Metadata ---');
const metaEntries = entries.filter(e => e.name.startsWith('META-INF/'));
console.log('Signature entries:', metaEntries.map(e => e.name));

const manifestMf = extractFile('META-INF/manifest.mf');
if (manifestMf) {
  console.log('META-INF/manifest.mf length:', manifestMf.length);
  console.log('First 5 lines of manifest.mf:');
  console.log(manifestMf.toString('utf8').split('\n').slice(0, 5).join('\n'));
}

const coseSig = extractFile('META-INF/cose.sig');
if (coseSig) {
  console.log('META-INF/cose.sig present, size:', coseSig.length, 'bytes');
}

const mozillaRsa = extractFile('META-INF/mozilla.rsa');
if (mozillaRsa) {
  console.log('META-INF/mozilla.rsa present, size:', mozillaRsa.length, 'bytes');
}

const mozillaSf = extractFile('META-INF/mozilla.sf');
if (mozillaSf) {
  console.log('META-INF/mozilla.sf present, size:', mozillaSf.length, 'bytes');
}
