const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const home = process.env.USERPROFILE;
const key = path.join(home, '.tori-keys', 'tori-updater.key');
const pwd = fs.readFileSync(key + '.pwd', 'utf8').trim();
const target = path.resolve('target/release/bundle/nsis/TORI Download Manager_1.0.1_x64-setup.exe');

console.log('[SIGN] Signing fresh installer with Ed25519 updater key...');
console.log('Target:', target);
execSync(`cargo tauri signer sign "${target}" -f "${key}" -p "${pwd}"`, { stdio: 'inherit', shell: 'cmd.exe' });

const sigFile = target + '.sig';
if (fs.existsSync(sigFile)) {
  console.log('[SIGN] Successfully generated signature file:', sigFile);
  console.log('Signature length:', fs.readFileSync(sigFile, 'utf8').trim().length, 'chars');
} else {
  console.error('[SIGN] Signature file not found!');
  process.exit(1);
}
