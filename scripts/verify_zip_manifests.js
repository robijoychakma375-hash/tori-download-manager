const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const files = [
  'release/v1.0.1-firefox-candidate/tori-download-manager-firefox-v1.0.2.zip',
  'release/v1.0.1-firefox-candidate/tori-download-manager-firefox-v1.0.1.zip',
  'release/v1.0.1-firefox-final-candidate/tori-download-manager-firefox-v1.0.2.zip',
  'release/v1.0.1-firefox-final-candidate/tori-download-manager-firefox-v1.0.1.zip',
  'release/v1.0.1-firefox-final-candidate/tori-download-manager-extension-v1.0.2.zip',
  'release/v1.0.1-firefox-final-candidate/tori-download-manager-extension-v1.0.1.zip',
  'target/release/tori-download-manager-extension-v1.0.2.zip',
  'target/release/tori-download-manager-extension-v1.0.1.zip'
];

for (const f of files) {
  const full = path.resolve(f);
  if (!fs.existsSync(full)) {
    console.log(`${f} -> NOT FOUND`);
    continue;
  }
  const content = execSync(`tar -xOf "${full}" manifest.json`, { encoding: 'utf8' });
  const parsed = JSON.parse(content);
  console.log(`${f} -> version: ${parsed.version}, name: ${parsed.name}`);
}
