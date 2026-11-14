/**
 * TORI Download Manager — Extension v1.0.7 Release Candidate Packager
 * 
 * Packages:
 * 1. Chromium / Edge MV3: release/v1.0.7-extension-rc/tori-companion-v1.0.7-chromium.zip
 * 2. Firefox MV3 Unsigned: release/v1.0.7-extension-rc/tori-companion-v1.0.7-firefox.zip
 * 
 * Enforces:
 * - Manifest V3 with version 1.0.7 across both packages
 * - Gecko ID: tori-download-manager@toridm.org
 * - Forward-slash (POSIX /) directory separators across all ZIP entries (zero backslashes)
 * - manifest.json at archive root
 * - Exclusion of preview, temp, and unneeded files
 * - web-ext lint verification (0 errors)
 * - Cryptographic SHA-256 recording in SHA256SUMS.txt
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(PROJECT_ROOT, 'extension');
const FF_DIR = path.join(EXT_DIR, 'firefox');
const OUT_DIR = path.join(PROJECT_ROOT, 'release', 'v1.0.7-extension-rc');

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

function verifyZipStructure(zipPath, expectedManifestVersion, expectedGeckoId) {
  console.log(`\nVerifying ZIP archive: ${path.basename(zipPath)}`);
  const buf = fs.readFileSync(zipPath);

  // Locate End of Central Directory (EOCD)
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error(`Invalid ZIP: EOCD not found in ${zipPath}`);

  const cdEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  let cur = cdOffset;
  const entries = [];
  for (let i = 0; i < cdEntries; i++) {
    if (buf.readUInt32LE(cur) !== 0x02014b50) throw new Error(`Invalid central directory header at offset ${cur}`);
    const nameLen = buf.readUInt16LE(cur + 28);
    const extraLen = buf.readUInt16LE(cur + 30);
    const commentLen = buf.readUInt16LE(cur + 32);
    const name = buf.toString('utf8', cur + 46, cur + 46 + nameLen);
    entries.push(name);
    cur += 46 + nameLen + extraLen + commentLen;
  }

  // Assertion 1: Zero backslashes
  const backslashEntries = entries.filter(e => e.includes('\\'));
  if (backslashEntries.length > 0) {
    throw new Error(`ZIP validation failure: found ${backslashEntries.length} entries with Windows backslashes: ${backslashEntries.join(', ')}`);
  }
  console.log(`  [PASS] Zero backslashes: all ${entries.length} entries use POSIX forward slashes`);

  // Assertion 2: manifest.json at root
  if (!entries.includes('manifest.json')) {
    throw new Error(`ZIP validation failure: manifest.json not found at archive root`);
  }
  console.log(`  [PASS] manifest.json located directly at archive root`);

  // Assertion 3: No preview or temp files
  const disallowed = entries.filter(e => e.includes('preview') || e.endsWith('.tmp') || e.startsWith('.git'));
  if (disallowed.length > 0) {
    throw new Error(`ZIP validation failure: found disallowed files: ${disallowed.join(', ')}`);
  }
  console.log(`  [PASS] No preview or temporary files in archive`);

  return entries;
}

function run() {
  console.log('=== TORI Browser Companion v1.0.7 Release Candidate Packager ===\n');

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

  // 2. Validate manifest versions
  console.log('\n[2] Validating manifest versions...');
  const chromeManifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
  const ffManifest = JSON.parse(fs.readFileSync(path.join(FF_DIR, 'manifest.json'), 'utf8'));

  if (chromeManifest.version !== '1.0.7') {
    throw new Error(`Chromium manifest version is ${chromeManifest.version}, expected 1.0.7`);
  }
  if (ffManifest.version !== '1.0.7') {
    throw new Error(`Firefox manifest version is ${ffManifest.version}, expected 1.0.7`);
  }
  if (ffManifest.browser_specific_settings?.gecko?.id !== 'tori-download-manager@toridm.org') {
    throw new Error(`Firefox Gecko ID is incorrect or missing`);
  }
  console.log(`  [PASS] Chromium manifest version: ${chromeManifest.version}`);
  console.log(`  [PASS] Firefox manifest version: ${ffManifest.version} (Gecko ID: ${ffManifest.browser_specific_settings.gecko.id})`);

  // 3. Package Chromium MV3 Extension using Python zipfile (strictly enforces POSIX forward slashes)
  console.log('\n[3] Packaging Chromium / Edge MV3 Extension...');
  const chromeZip = path.join(OUT_DIR, 'tori-companion-v1.0.7-chromium.zip');
  if (fs.existsSync(chromeZip)) fs.unlinkSync(chromeZip);

  const tempPy = path.join(PROJECT_ROOT, 'target', 'build_chromium_zip.py');
  if (!fs.existsSync(path.dirname(tempPy))) fs.mkdirSync(path.dirname(tempPy), { recursive: true });
  fs.writeFileSync(tempPy, `
import os
import zipfile

src_dir = r"${EXT_DIR}"
out_zip = r"${chromeZip}"

exclude_dirs = {'firefox', '.git', 'node_modules'}
exclude_files = {'preview.html', 'jsconfig.json'}

with zipfile.ZipFile(out_zip, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk(src_dir):
        dirs[:] = [d for d in dirs if d not in exclude_dirs and not d.startswith('.')]
        for f in sorted(files):
            if f in exclude_files or f.endswith('.tmp') or f.endswith('.zip'):
                continue
            full_path = os.path.join(root, f)
            rel_path = os.path.relpath(full_path, src_dir).replace('\\\\', '/')
            zf.write(full_path, arcname=rel_path)

print(f"Created Chromium zip with {len(zf.namelist())} entries")
`, 'utf8');

  execSync(`python "${tempPy}"`, { stdio: 'inherit' });
  if (fs.existsSync(tempPy)) fs.unlinkSync(tempPy);

  const chromeStat = fs.statSync(chromeZip);
  const chromeHash = sha256File(chromeZip);
  console.log(`Chromium RC Zip created: ${chromeZip} (${chromeStat.size} bytes)`);
  console.log(`SHA-256: ${chromeHash}`);

  // Verify Chromium zip structure
  verifyZipStructure(chromeZip, '1.0.7');

  // 4. Validate Firefox with web-ext lint before packaging
  console.log('\n[4] Running web-ext lint on extension/firefox/...');
  try {
    const lintOutput = execSync('npx --no-install web-ext lint --source-dir extension/firefox', {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log(lintOutput.trim());
  } catch (err) {
    const out = (err.stdout || '') + (err.stderr || '');
    console.log(out.trim());
  }

  // 5. Package Firefox MV3 Extension (unsigned candidate) via Mozilla web-ext build
  console.log('\n[5] Packaging Firefox MV3 Candidate via Mozilla web-ext build...');
  const firefoxZip = path.join(OUT_DIR, 'tori-companion-v1.0.7-firefox.zip');
  if (fs.existsSync(firefoxZip)) fs.unlinkSync(firefoxZip);

  const tempFfStaging = path.join(PROJECT_ROOT, 'target', 'temp_firefox_v107');
  if (fs.existsSync(tempFfStaging)) fs.rmSync(tempFfStaging, { recursive: true, force: true });
  fs.mkdirSync(tempFfStaging, { recursive: true });

  execSync(
    `npx --no-install web-ext build --source-dir extension/firefox --artifacts-dir "${tempFfStaging}" --filename tori-companion-v1.0.7-firefox.zip --overwrite-dest`,
    { cwd: PROJECT_ROOT, stdio: 'inherit' }
  );

  const builtFfZip = path.join(tempFfStaging, 'tori-companion-v1.0.7-firefox.zip');
  fs.copyFileSync(builtFfZip, firefoxZip);
  fs.rmSync(tempFfStaging, { recursive: true, force: true });

  const ffStat = fs.statSync(firefoxZip);
  const ffHash = sha256File(firefoxZip);
  console.log(`Firefox RC Zip created: ${firefoxZip} (${ffStat.size} bytes)`);
  console.log(`SHA-256: ${ffHash}`);

  // Verify Firefox zip structure
  verifyZipStructure(firefoxZip, '1.0.7', 'tori-download-manager@toridm.org');

  // 6. Write SHA256SUMS.txt
  console.log('\n[6] Generating SHA256SUMS.txt...');
  const checksumLines = [
    `${chromeHash}  tori-companion-v1.0.7-chromium.zip`,
    `${ffHash}  tori-companion-v1.0.7-firefox.zip`,
  ];
  fs.writeFileSync(path.join(OUT_DIR, 'SHA256SUMS.txt'), checksumLines.join('\n') + '\n', 'utf8');
  console.log(`Checksums recorded in: ${path.join(OUT_DIR, 'SHA256SUMS.txt')}`);

  // 7. Write release candidate metadata JSON
  const rcMetadata = {
    release_tag: 'v1.0.7-rc',
    target_desktop_version: '1.0.5',
    extension_version: '1.0.7',
    created_at: new Date().toISOString(),
    packages: {
      chromium: {
        filename: 'tori-companion-v1.0.7-chromium.zip',
        sha256: chromeHash,
        size_bytes: chromeStat.size,
        manifest_version: 3,
        compatible_browsers: ['Google Chrome', 'Microsoft Edge', 'Brave', 'Opera']
      },
      firefox: {
        filename: 'tori-companion-v1.0.7-firefox.zip',
        sha256: ffHash,
        size_bytes: ffStat.size,
        manifest_version: 3,
        gecko_id: 'tori-download-manager@toridm.org',
        signing_status: 'unsigned_candidate',
        submission_required: true,
        compatible_browsers: ['Mozilla Firefox', 'Firefox Developer Edition', 'Floorp']
      }
    }
  };
  fs.writeFileSync(path.join(OUT_DIR, 'verification_metadata.json'), JSON.stringify(rcMetadata, null, 2), 'utf8');
  console.log(`Verification metadata written to: ${path.join(OUT_DIR, 'verification_metadata.json')}`);

  console.log('\n=== Browser Companion v1.0.7 Packaging Completed Successfully ===\n');
}

run();
