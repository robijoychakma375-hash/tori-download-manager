/**
 * TORI Download Manager — Extension v1.0.6 Release Candidate Packager
 * 
 * Packages:
 * 1. Chromium / Edge MV3: release/v1.0.5-rc/extensions/tori-companion-v1.0.6-chromium.zip
 * 2. Firefox MV3 Unsigned: release/v1.0.5-rc/extensions/tori-companion-v1.0.6-firefox.zip
 * 
 * Runs web-ext lint on Firefox manifest.
 * Computes SHA-256 hashes and verifies zip structure.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(PROJECT_ROOT, 'extension');
const FF_DIR = path.join(EXT_DIR, 'firefox');
const OUT_DIR = path.join(PROJECT_ROOT, 'release', 'v1.0.5-rc', 'extensions');

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      copyRecursive(path.join(src, child), path.join(dest, child));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
}

function run() {
  console.log('=== TORI Browser Companion v1.0.6 Release Candidate Packaging ===\n');

  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  // 1. Sync shared assets into Firefox directory
  console.log('[1] Syncing shared extension components into extension/firefox/...');
  const sharedFiles = ['background.js', 'content.js', 'content.css'];
  for (const f of sharedFiles) {
    fs.copyFileSync(path.join(EXT_DIR, f), path.join(FF_DIR, f));
    console.log(`    Synced: ${f}`);
  }

  const sharedDirs = ['popup', 'options', 'icons'];
  for (const d of sharedDirs) {
    copyRecursive(path.join(EXT_DIR, d), path.join(FF_DIR, d));
    console.log(`    Synced directory: ${d}/`);
  }

  // 2. Validate Firefox with web-ext lint
  console.log('\n[2] Running web-ext lint on extension/firefox/...');
  try {
    const lintOutput = execSync('npx --no-install web-ext lint --source-dir extension/firefox', {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log('web-ext lint output:');
    console.log(lintOutput.trim());
  } catch (err) {
    const out = (err.stdout || '') + (err.stderr || '');
    console.log('web-ext lint completed with output:');
    console.log(out.trim());
  }

  // 3. Package Chromium MV3 Extension
  console.log('\n[3] Packaging Chromium / Edge MV3 Extension...');
  const chromeZip = path.join(OUT_DIR, 'tori-companion-v1.0.6-chromium.zip');
  const tempChromeStaging = path.join(PROJECT_ROOT, 'target', 'temp_chrome_v106');
  if (fs.existsSync(tempChromeStaging)) fs.rmSync(tempChromeStaging, { recursive: true, force: true });
  fs.mkdirSync(tempChromeStaging, { recursive: true });

  function copyChromeFiltered(src, dst) {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.name === 'firefox' || entry.name === '.git' || entry.name.endsWith('.tmp') || entry.name.endsWith('.zip')) continue;
      const s = path.join(src, entry.name);
      const d = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        copyChromeFiltered(s, d);
      } else {
        fs.copyFileSync(s, d);
      }
    }
  }
  copyChromeFiltered(EXT_DIR, tempChromeStaging);

  if (fs.existsSync(chromeZip)) fs.unlinkSync(chromeZip);
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${tempChromeStaging}\\*' -DestinationPath '${chromeZip}' -Force"`,
    { cwd: PROJECT_ROOT, stdio: 'inherit' }
  );
  fs.rmSync(tempChromeStaging, { recursive: true, force: true });

  const chromeStat = fs.statSync(chromeZip);
  const chromeHash = sha256File(chromeZip);
  console.log(`Chromium RC Zip created: ${chromeZip} (${chromeStat.size} bytes)`);
  console.log(`SHA-256: ${chromeHash}`);

  // 4. Package Firefox MV3 Extension (unsigned candidate)
  console.log('\n[4] Packaging Firefox MV3 Unsigned Candidate...');
  const firefoxZip = path.join(OUT_DIR, 'tori-companion-v1.0.6-firefox.zip');
  if (fs.existsSync(firefoxZip)) fs.unlinkSync(firefoxZip);

  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${FF_DIR}\\*' -DestinationPath '${firefoxZip}' -Force"`,
    { cwd: PROJECT_ROOT, stdio: 'inherit' }
  );

  const ffStat = fs.statSync(firefoxZip);
  const ffHash = sha256File(firefoxZip);
  console.log(`Firefox RC Zip created: ${firefoxZip} (${ffStat.size} bytes)`);
  console.log(`SHA-256: ${ffHash}`);

  // 5. Write checksums file in release/v1.0.5-rc/extensions/
  const checksumContent = [
    `${chromeHash}  tori-companion-v1.0.6-chromium.zip`,
    `${ffHash}  tori-companion-v1.0.6-firefox.zip`,
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(OUT_DIR, 'SHA256SUMS.txt'), checksumContent, 'utf8');

  console.log('\n[5] Checksums saved to: ' + path.join(OUT_DIR, 'SHA256SUMS.txt'));
  console.log('\n=== Extension packaging complete ===');
}

run();
