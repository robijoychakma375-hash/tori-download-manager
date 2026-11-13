const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const xpiPath = 'C:/Users/ritud/.gemini/antigravity/brain/4cb6b42b-ac51-4843-b5b6-6960f8030e35/.user_uploaded/media_1794575136702_dbf15b08.xpi';
const ffSourceDir = path.resolve(__dirname, '..', 'extension', 'firefox');

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

console.log('=== Comparing XPI files against extension/firefox/ source ===\n');

const contentEntries = entries.filter(e => !e.name.startsWith('META-INF/'));
let allMatch = true;

for (const entry of contentEntries) {
  const srcPath = path.join(ffSourceDir, entry.name.replace(/\//g, path.sep));
  if (!fs.existsSync(srcPath)) {
    console.log(`[EXTRA IN XPI] ${entry.name}`);
    allMatch = false;
    continue;
  }

  const xpiFileBuf = extractFile(entry.name);
  const srcFileBuf = fs.readFileSync(srcPath);

  const xpiSha = crypto.createHash('sha256').update(xpiFileBuf).digest('hex');
  const srcSha = crypto.createHash('sha256').update(srcFileBuf).digest('hex');

  const match = xpiSha === srcSha;
  if (!match) {
    console.log(`[MISMATCH] ${entry.name} - XPI SHA: ${xpiSha} != SRC SHA: ${srcSha}`);
    allMatch = false;
  } else {
    console.log(`[MATCH] ${entry.name} (${entry.uncompSize} bytes)`);
  }
}

console.log('\nAll content files match source exactly:', allMatch);
