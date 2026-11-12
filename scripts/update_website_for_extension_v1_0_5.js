/**
 * Update Website for Extension v1.0.5 Companion
 */

const fs = require('fs');
const path = require('path');

const WEBSITE_DIR = 'C:/Users/ritud/Downloads/tori-website';
const files = [
  path.join(WEBSITE_DIR, 'index.html'),
  path.join(WEBSITE_DIR, 'public', 'index.html'),
];

for (const filePath of files) {
  if (!fs.existsSync(filePath)) {
    console.log(`Skipping non-existent ${filePath}`);
    continue;
  }
  let content = fs.readFileSync(filePath, 'utf8');

  // 1. Extension cards version badge
  content = content.replace(
    /<span>\.xpi · Mozilla-signed · v1\.0\.4<\/span>/g,
    '<span>.xpi · Mozilla-signed · v1.0.5</span>'
  );
  content = content.replace(
    /<span>\.zip · 73 KB · Load unpacked · v1\.0\.4<\/span>/g,
    '<span>.zip · 73 KB · Load unpacked · v1.0.5</span>'
  );
  content = content.replace(
    /Browser companion extension v1\.0\.4/g,
    'Browser companion extension v1.0.5'
  );

  // 2. Buttons & links
  content = content.replace(
    /\/assets\/tori-download-manager-firefox-v1\.0\.4\.xpi/g,
    '/assets/tori-download-manager-firefox-v1.0.5.xpi'
  );
  content = content.replace(
    /releases\/download\/extension-v1\.0\.4\/tori-download-manager-firefox-v1\.0\.4\.xpi/g,
    'releases/download/extension-v1.0.5/tori-download-manager-firefox-v1.0.5.xpi'
  );
  content = content.replace(
    /releases\/download\/extension-v1\.0\.4\/tori-download-manager-extension-v1\.0\.4\.zip/g,
    'releases/download/extension-v1.0.5/tori-download-manager-extension-v1.0.5.zip'
  );
  content = content.replace(
    /download="tori-download-manager-firefox-v1\.0\.4\.xpi"/g,
    'download="tori-download-manager-firefox-v1.0.5.xpi"'
  );
  content = content.replace(
    /download="tori-download-manager-extension-v1\.0\.4\.zip"/g,
    'download="tori-download-manager-extension-v1.0.5.zip"'
  );

  // 3. Asset row text labels
  content = content.replace(
    /id="asset-firefox-name">tori-download-manager-firefox-v1\.0\.4\.xpi<\/b>/g,
    'id="asset-firefox-name">tori-download-manager-firefox-v1.0.5.xpi</b>'
  );
  content = content.replace(
    /id="asset-ext-name">tori-download-manager-extension-v1\.0\.4\.zip<\/b>/g,
    'id="asset-ext-name">tori-download-manager-extension-v1.0.5.zip</b>'
  );

  // 4. JS URL map & download attributes
  content = content.replace(
    /var D_EXT = B \+ '\/releases\/download\/extension-v1\.0\.4\/';/g,
    "var D_EXT = B + '/releases/download/extension-v1.0.5/';"
  );
  content = content.replace(
    /firefoxDl: D_EXT \+ 'tori-download-manager-firefox-v1\.0\.4\.xpi',/g,
    "firefoxDl: D_EXT + 'tori-download-manager-firefox-v1.0.5.xpi',"
  );
  content = content.replace(
    /extzip: D_EXT \+ 'tori-download-manager-extension-v1\.0\.4\.zip',/g,
    "extzip: D_EXT + 'tori-download-manager-extension-v1.0.5.zip',"
  );
  content = content.replace(
    /'tori-download-manager-extension-v1\.0\.4\.zip'/g,
    "'tori-download-manager-extension-v1.0.5.zip'"
  );
  content = content.replace(
    /'tori-download-manager-firefox-v1\.0\.4\.xpi'/g,
    "'tori-download-manager-firefox-v1.0.5.xpi'"
  );
  content = content.replace(
    /preserve dedicated extension v1\.0\.4 companion URLs/g,
    'preserve dedicated extension v1.0.5 companion URLs'
  );

  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`[OK] Updated ${filePath} for extension v1.0.5`);
}

console.log('Website HTML files successfully updated.');

