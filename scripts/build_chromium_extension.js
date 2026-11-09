const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const extDir = path.join(PROJECT_ROOT, 'extension');
const stagingZip = path.join(PROJECT_ROOT, 'target', 'release', 'tori-download-manager-extension-v1.0.1.zip');

// We copy extension files (excluding 'firefox' dir) into a clean staging folder, then zip
const tempStaging = path.join(PROJECT_ROOT, 'target', 'chromium_ext_staging');
if (fs.existsSync(tempStaging)) {
  fs.rmSync(tempStaging, { recursive: true, force: true });
}
fs.mkdirSync(tempStaging, { recursive: true });

function copyFiltered(src, dst) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'firefox' || entry.name === '.git') continue;
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

// Use archiver or PowerShell to compress
execSync(
  `powershell -NoProfile -Command "Compress-Archive -Path '${tempStaging}\\*' -DestinationPath '${stagingZip}' -Force"`,
  { stdio: 'inherit' }
);

fs.rmSync(tempStaging, { recursive: true, force: true });

const stat = fs.statSync(stagingZip);
console.log(`[PACK] Created Chromium extension package: ${stagingZip} (${stat.size} bytes)`);

