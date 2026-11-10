const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const extDir = path.join(PROJECT_ROOT, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
const extVersion = manifest.version || '1.0.2';

const targetDir = path.join(PROJECT_ROOT, 'target', 'release');
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

const stagingZip = path.join(targetDir, `tori-download-manager-extension-v${extVersion}.zip`);
const legacyZip = path.join(targetDir, 'tori-download-manager-extension-v1.0.1.zip');

// We copy extension files (excluding 'firefox' dir and git/cache files) into a clean staging folder, then zip
const tempStaging = path.join(PROJECT_ROOT, 'target', 'chromium_ext_staging');
if (fs.existsSync(tempStaging)) {
  fs.rmSync(tempStaging, { recursive: true, force: true });
}
fs.mkdirSync(tempStaging, { recursive: true });

function copyFiltered(src, dst) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'firefox' || entry.name === '.git' || entry.name.endsWith('.tmp')) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyFiltered(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

copyFiltered(extDir, tempStaging);

// Compress using PowerShell Compress-Archive
execSync(
  `powershell -NoProfile -Command "Compress-Archive -Path '${tempStaging}\\*' -DestinationPath '${stagingZip}' -Force"`,
  { stdio: 'inherit' }
);

// Also copy to legacy filename for backwards compatibility
fs.copyFileSync(stagingZip, legacyZip);

fs.rmSync(tempStaging, { recursive: true, force: true });

const stat = fs.statSync(stagingZip);
const buf = fs.readFileSync(stagingZip);
const hash = crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();

console.log(`[PACK] Created Chromium extension package: ${stagingZip} (${stat.size} bytes)`);
console.log(`[PACK] SHA-256: ${hash}`);
