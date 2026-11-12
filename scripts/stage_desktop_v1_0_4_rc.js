#!/usr/bin/env node
/**
 * Stages TORI Desktop v1.0.4 Release Candidate artifacts in `release/v1.0.4-rc/`
 * without modifying public v1.0.3 releases, latest.json, website, or installed TORI.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const STAGE_DIR = path.join(ROOT, 'release', 'v1.0.4-rc');

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function main() {
  if (fs.existsSync(STAGE_DIR)) {
    fs.rmSync(STAGE_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(STAGE_DIR, { recursive: true });

  const artifacts = [
    {
      src: path.join(ROOT, 'target', 'release', 'tori-download-manager.exe'),
      destName: 'tori-download-manager-v1.0.4-rc.exe',
    },
    {
      src: path.join(ROOT, 'target', 'release', 'tdm-native-host.exe'),
      destName: 'tdm-native-host-v1.0.4-rc.exe',
    },
    {
      src: path.join(ROOT, 'target', 'release', 'tdm-cli.exe'),
      destName: 'tdm-cli-v1.0.4-rc.exe',
    },
  ];

  const nsisInstaller = path.join(
    ROOT,
    'target',
    'release',
    'bundle',
    'nsis',
    'TORI Download Manager_1.0.4_x64-setup.exe'
  );
  if (fs.existsSync(nsisInstaller)) {
    artifacts.push({
      src: nsisInstaller,
      destName: 'TORI-Download-Manager-v1.0.4-rc-x64-setup.exe',
    });
  }

  const sums = [];
  for (const item of artifacts) {
    if (!fs.existsSync(item.src)) {
      throw new Error(`Required release candidate binary missing: ${item.src}`);
    }
    const destPath = path.join(STAGE_DIR, item.destName);
    fs.copyFileSync(item.src, destPath);
    const hash = sha256File(destPath);
    const size = fs.statSync(destPath).size;
    sums.push(`${hash}  ${item.destName}`);
    console.log(`[STAGED] ${item.destName} (${size} bytes, sha256=${hash})`);
  }

  fs.writeFileSync(path.join(STAGE_DIR, 'SHA256SUMS.txt'), sums.join('\n') + '\n', 'utf8');
  console.log(`[OK] Staged Desktop v1.0.4-rc in ${STAGE_DIR}`);
}

main();

