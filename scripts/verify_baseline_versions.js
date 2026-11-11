const fs = require('fs');

const cargo = fs.readFileSync('Cargo.toml', 'utf8');
const cargoMatch = cargo.match(/version\s*=\s*"([^"]+)"/);
const tauriConf = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const uiPkg = JSON.parse(fs.readFileSync('ui/package.json', 'utf8'));
const extManifest = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));

console.log('Cargo.toml version:       ', cargoMatch ? cargoMatch[1] : 'NOT FOUND');
console.log('src-tauri/tauri.conf.json:', tauriConf.version);
console.log('ui/package.json:          ', uiPkg.version);
console.log('extension/manifest.json:  ', extManifest.version);

const stablePath = 'C:\\Program Files\\Tori Download Manager\\tdm.exe';
console.log('Stable v1.0.0 exists:     ', fs.existsSync(stablePath));
