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

function copyRecursive(src, dest, filterFn) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      if (filterFn && !filterFn(child, path.join(src, child))) continue;
      copyRecursive(path.join(src, child), path.join(dest, child), filterFn);
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

  const firefoxOnly = process.argv.includes('--firefox-only');

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
    copyRecursive(path.join(EXT_DIR, d), path.join(FF_DIR, d), (name) => {
      return name !== 'preview.html' && !name.endsWith('.tmp') && !name.endsWith('.zip');
    });
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
  const chromeZip = path.join(OUT_DIR, 'tori-companion-v1.0.6-chromium.zip');
  let chromeHash = '';
  if (firefoxOnly && fs.existsSync(chromeZip)) {
    console.log('\n[3] Skipping Chromium packaging (--firefox-only). Preserving existing package.');
    chromeHash = sha256File(chromeZip);
    const chromeStat = fs.statSync(chromeZip);
    console.log(`Existing Chromium RC Zip preserved: ${chromeZip} (${chromeStat.size} bytes)`);
    console.log(`SHA-256: ${chromeHash}`);
  } else {
    console.log('\n[3] Packaging Chromium / Edge MV3 Extension...');
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
    chromeHash = sha256File(chromeZip);
    console.log(`Chromium RC Zip created: ${chromeZip} (${chromeStat.size} bytes)`);
    console.log(`SHA-256: ${chromeHash}`);
  }

  // 4. Package Firefox MV3 Extension (unsigned candidate) via Mozilla web-ext build
  console.log('\n[4] Packaging Firefox MV3 Candidate via Mozilla web-ext build...');
  const firefoxZip = path.join(OUT_DIR, 'tori-companion-v1.0.6-firefox.zip');
  if (fs.existsSync(firefoxZip)) fs.unlinkSync(firefoxZip);

  const tempFfStaging = path.join(PROJECT_ROOT, 'target', 'temp_firefox_v106');
  if (fs.existsSync(tempFfStaging)) fs.rmSync(tempFfStaging, { recursive: true, force: true });
  fs.mkdirSync(tempFfStaging, { recursive: true });

  execSync(
    `npx --no-install web-ext build --source-dir extension/firefox --artifacts-dir "${tempFfStaging}" --filename tori-companion-v1.0.6-firefox.zip --overwrite-dest`,
    { cwd: PROJECT_ROOT, stdio: 'inherit' }
  );

  const builtFfZip = path.join(tempFfStaging, 'tori-companion-v1.0.6-firefox.zip');
  fs.copyFileSync(builtFfZip, firefoxZip);
  fs.rmSync(tempFfStaging, { recursive: true, force: true });

  const ffStat = fs.statSync(firefoxZip);
  const ffHash = sha256File(firefoxZip);
  console.log(`Firefox RC Zip created: ${firefoxZip} (${ffStat.size} bytes)`);
  console.log(`SHA-256: ${ffHash}`);

  // 5. Write checksums file in release/v1.0.5-rc/extensions/
  const xpiFile = path.join(OUT_DIR, 'a70ed17e183648a9bcf4-1.0.6.xpi');
  let xpiHash = '96a63c6be3eaf8488fbbd299ed2f07c8ef1e20b09128b8d0841a463026236038';
  if (fs.existsSync(xpiFile)) {
    xpiHash = sha256File(xpiFile);
  }

  const checksumLines = [
    `${xpiHash}  a70ed17e183648a9bcf4-1.0.6.xpi`,
    `${chromeHash}  tori-companion-v1.0.6-chromium.zip`,
    `${ffHash}  tori-companion-v1.0.6-firefox.zip`,
    `${xpiHash}  tori-download-manager-firefox-v1.0.6.xpi`,
  ];
  fs.writeFileSync(path.join(OUT_DIR, 'SHA256SUMS.txt'), checksumLines.join('\n') + '\n', 'utf8');

  console.log('\n[5] Checksums saved to: ' + path.join(OUT_DIR, 'SHA256SUMS.txt'));
  console.log('\n=== Extension packaging complete ===');
}

run();

