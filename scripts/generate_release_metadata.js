/**
 * TORI Download Manager v1.0.0 — Release Metadata & Checksum Generator
 * 
 * Generates:
 * 1. target/release/latest.json (official Tauri v2 signed updater manifest)
 * 2. target/release/SHA256SUMS.txt (cryptographic checksums of all release deliverables)
 * 3. target/release/tori-download-manager-extension-v1.0.0.zip (packed browser extension)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(PROJECT_ROOT, 'target', 'release');
const BUNDLE_NSIS_DIR = path.join(RELEASE_DIR, 'bundle', 'nsis');

function computeSha256(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(fileBuffer).digest('hex').toUpperCase();
}

function getSigningKeyPath() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const keyPath = path.join(home, '.tori-keys', 'tori-updater.key');
  if (fs.existsSync(keyPath)) {
    return keyPath;
  }
  return null;
}

function getSigningPassword(keyPath) {
  if (process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    return process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  }
  const pwdFile = `${keyPath}.pwd`;
  if (fs.existsSync(pwdFile)) {
    return fs.readFileSync(pwdFile, 'utf8').trim();
  }
  return '';
}

function ensureSignature(targetFile, keyPath) {
  const sigFile = `${targetFile}.sig`;
  if (fs.existsSync(sigFile)) {
    const targetStat = fs.statSync(targetFile);
    const sigStat = fs.statSync(sigFile);
    if (sigStat.mtimeMs >= targetStat.mtimeMs) {
      return fs.readFileSync(sigFile, 'utf8').trim();
    }
    // Stale signature file from previous build: delete and re-sign
    console.log(`[SIGN] Stale signature detected for ${path.basename(targetFile)} (sig mtime < installer mtime); re-signing...`);
    fs.unlinkSync(sigFile);
  }

  if (!keyPath || !fs.existsSync(keyPath)) {
    throw new Error(`Signing key not found at: ${keyPath}. Run 'cargo tauri signer generate' first.`);
  }

  const pwd = getSigningPassword(keyPath);
  console.log(`[SIGN] Signing ${path.basename(targetFile)} with Ed25519 key...`);
  const cmd = `cargo tauri signer sign "${targetFile}" -f "${keyPath}" -p "${pwd}"`;
  execSync(cmd, { stdio: 'pipe', shell: 'cmd.exe' });

  if (!fs.existsSync(sigFile)) {
    throw new Error(`Failed to generate signature file: ${sigFile}`);
  }

  const sig = fs.readFileSync(sigFile, 'utf8').trim();
  console.log(`[SIGN] Generated valid signature (${sig.length} bytes).`);
  return sig;
}

function packExtension(outputZip) {
  const extensionDir = path.join(PROJECT_ROOT, 'extension');
  if (!fs.existsSync(extensionDir)) {
    console.warn('[WARN] Extension directory not found.');
    return null;
  }

  console.log(`[PACK] Packing extension from ${extensionDir} into ${path.basename(outputZip)}...`);
  // Use PowerShell Compress-Archive with single-quoted paths to avoid space splitting
  const psCmd = `Compress-Archive -Path '${extensionDir}\\*' -DestinationPath '${outputZip}' -Force`;
  execSync(`powershell -NoProfile -Command "${psCmd}"`, { stdio: 'pipe' });
  return outputZip;
}

function main() {
  console.log('================================================================');
  console.log('TORI Download Manager v1.0.0 — Release Metadata Generator');
  console.log('================================================================\n');

  if (!fs.existsSync(RELEASE_DIR)) {
    fs.mkdirSync(RELEASE_DIR, { recursive: true });
  }

  const version = '1.0.0';
  const owner = 'tori-download-manager';
  const repo = 'tori-download-manager';
  const pubDate = new Date().toISOString();

  // 1. Locate Installer Artifact for target version
  let installerPath = null;
  if (fs.existsSync(BUNDLE_NSIS_DIR)) {
    const nsisFiles = fs.readdirSync(BUNDLE_NSIS_DIR);
    const installerFile = nsisFiles.find(f => f.includes(`_${version}_`) && f.endsWith('.exe') && !f.includes('uninstall'))
      || nsisFiles.find(f => f.endsWith('.exe') && !f.includes('uninstall'));
    if (installerFile) {
      installerPath = path.join(BUNDLE_NSIS_DIR, installerFile);
    }
  }

  // Fallback to searching release dir
  if (!installerPath) {
    const releaseFiles = fs.readdirSync(RELEASE_DIR);
    const match = releaseFiles.find(f => f.includes(`_${version}_`) && f.endsWith('.exe'))
      || releaseFiles.find(f => f.includes('TORI') && f.endsWith('.exe'));
    if (match) installerPath = path.join(RELEASE_DIR, match);
  }

  // 2. Read Release Notes
  const releaseNotesPath = path.join(PROJECT_ROOT, 'RELEASE_NOTES.md');
  let releaseNotes = `TORI Download Manager v${version} Production Release.`;
  if (fs.existsSync(releaseNotesPath)) {
    releaseNotes = fs.readFileSync(releaseNotesPath, 'utf8');
  }

  // 3. Signing
  const keyPath = getSigningKeyPath();
  let signature = null;
  if (installerPath && fs.existsSync(installerPath)) {
    try {
      signature = ensureSignature(installerPath, keyPath);
    } catch (e) {
      console.warn(`[WARN] Could not sign installer: ${e.message}`);
    }
  }

  // 4. Generate latest.json
  const downloadUrl = `https://github.com/${owner}/${repo}/releases/download/v${version}/${installerPath ? path.basename(installerPath) : `TORI_Download_Manager_${version}_x64-setup.exe`}`;

  const latestJson = {
    version: version,
    notes: releaseNotes,
    pub_date: pubDate,
    platforms: {
      'windows-x86_64': {
        signature: signature || 'PENDING_BUILD_SIGNATURE',
        url: downloadUrl
      }
    }
  };

  const latestJsonPath = path.join(RELEASE_DIR, 'latest.json');
  fs.writeFileSync(latestJsonPath, JSON.stringify(latestJson, null, 2), 'utf8');
  console.log(`[GEN] Generated: ${latestJsonPath}`);

  // 5. Pack Extension Zip
  const extZipPath = path.join(RELEASE_DIR, `tori-download-manager-extension-v${version}.zip`);
  try {
    packExtension(extZipPath);
  } catch (e) {
    console.warn(`[WARN] Extension packaging failed: ${e.message}`);
  }

  // 6. Generate SHA256SUMS.txt
  const deliverables = [
    installerPath,
    path.join(RELEASE_DIR, 'tori-download-manager.exe'),
    path.join(RELEASE_DIR, 'tdm-native-host.exe'),
    path.join(RELEASE_DIR, 'tdm-cli.exe'),
    extZipPath,
    latestJsonPath
  ].filter(p => p && fs.existsSync(p));

  const checksumLines = [];
  console.log('\n[CHECKSUMS]');
  for (const itemPath of deliverables) {
    const hash = computeSha256(itemPath);
    const fileName = path.basename(itemPath);
    const line = `${hash}  ${fileName}`;
    checksumLines.push(line);
    console.log(`  ${line}`);
  }

  const checksumPath = path.join(RELEASE_DIR, 'SHA256SUMS.txt');
  fs.writeFileSync(checksumPath, checksumLines.join('\n') + '\n', 'utf8');
  console.log(`\n[GEN] Generated: ${checksumPath}`);

  // 7. Verification Assertions
  if (signature) {
    if (!signature.startsWith('untrusted comment:') && !signature.startsWith('dW50')) {
      throw new Error(`CRITICAL: Generated signature is invalid minisign format! Got: ${signature.slice(0, 30)}`);
    }
    const installerHash = deliverables.find(p => p === installerPath) ? computeSha256(installerPath) : '';
    if (signature === installerHash) {
      throw new Error('CRITICAL: Signature and SHA-256 hash are identical! Minisign signature must not be confused with raw hash.');
    }
  }

  console.log('\n✓ Release metadata and checksums generated successfully!');
  return {
    latestJsonPath,
    checksumPath,
    extZipPath,
    installerPath,
    version
  };
}

if (require.main === module) {
  main();
}

module.exports = { main };

