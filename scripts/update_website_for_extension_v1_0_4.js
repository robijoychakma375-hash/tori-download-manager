const fs = require('fs');
const path = require('path');

const WEBSITE_DIR = 'C:/Users/ritud/Downloads/tori-website';
const indexPath = path.join(WEBSITE_DIR, 'index.html');
const publicIndexPath = path.join(WEBSITE_DIR, 'public', 'index.html');

let content = fs.readFileSync(indexPath, 'utf8');

// 1. Update Firefox and Chrome extension cards
content = content.replace(
  '<span>.xpi · Mozilla-signed · v1.0.3</span>',
  '<span>.xpi · Mozilla-signed · v1.0.4</span>'
);
content = content.replace(
  '<span>.zip · 72 KB · Load unpacked · v1.0.3</span>',
  '<span>.zip · 73 KB · Load unpacked · v1.0.4</span>'
);
content = content.replace(
  'href="/assets/tori-download-manager-firefox-v1.0.3.xpi"',
  'href="/assets/tori-download-manager-firefox-v1.0.4.xpi"'
);
content = content.replace(
  'href="https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.3/tori-download-manager-firefox-v1.0.3.xpi" download="tori-download-manager-firefox-v1.0.3.xpi"',
  'href="https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/extension-v1.0.4/tori-download-manager-firefox-v1.0.4.xpi" download="tori-download-manager-firefox-v1.0.4.xpi"'
);
content = content.replace(
  'href="https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.3/tori-download-manager-extension-v1.0.3.zip" download="tori-download-manager-extension-v1.0.3.zip"',
  'href="https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/extension-v1.0.4/tori-download-manager-extension-v1.0.4.zip" download="tori-download-manager-extension-v1.0.4.zip"'
);
console.log('[OK] Replaced extension cards with v1.0.4');

// 2. Update static URL map
const oldUrlMap = `  var D = B + '/releases/download/v1.0.3/';
  var U = {
    repo: B,
    latest: B + '/releases/tag/v1.0.3',
    releases: B + '/releases',
    issues: B + '/issues',
    exe: D + 'TORI.Download.Manager_1.0.3_x64-setup.exe',
    firefoxInstall: '/assets/tori-download-manager-firefox-v1.0.3.xpi',
    firefoxDl: D + 'tori-download-manager-firefox-v1.0.3.xpi',
    extzip: D + 'tori-download-manager-extension-v1.0.3.zip',
    sums: D + 'SHA256SUMS.txt'
  };`;

const newUrlMap = `  var D = B + '/releases/download/v1.0.3/';
  var D_EXT = B + '/releases/download/extension-v1.0.4/';
  var U = {
    repo: B,
    latest: B + '/releases/tag/v1.0.3',
    releases: B + '/releases',
    issues: B + '/issues',
    exe: D + 'TORI.Download.Manager_1.0.3_x64-setup.exe',
    firefoxInstall: '/assets/tori-download-manager-firefox-v1.0.4.xpi',
    firefoxDl: D_EXT + 'tori-download-manager-firefox-v1.0.4.xpi',
    extzip: D_EXT + 'tori-download-manager-extension-v1.0.4.zip',
    sums: D + 'SHA256SUMS.txt'
  };`;

if (!content.includes(oldUrlMap)) {
  console.error('Could not find old URL map block!');
} else {
  content = content.replace(oldUrlMap, newUrlMap);
  console.log('[OK] Replaced static URL map with v1.0.4');
}

// 3. Update download attributes in applyUrlMap
const oldDlAttrs = `        if (k === 'extzip') {
          a.setAttribute('download', 'tori-download-manager-extension-v1.0.3.zip');
        }
        if (k === 'firefox-dl') {
          a.setAttribute('download', 'tori-download-manager-firefox-v1.0.3.xpi');
        }`;

const newDlAttrs = `        if (k === 'extzip') {
          a.setAttribute('download', 'tori-download-manager-extension-v1.0.4.zip');
        }
        if (k === 'firefox-dl') {
          a.setAttribute('download', 'tori-download-manager-firefox-v1.0.4.xpi');
        }`;

if (!content.includes(oldDlAttrs)) {
  console.error('Could not find old download attributes block!');
} else {
  content = content.replace(oldDlAttrs, newDlAttrs);
  console.log('[OK] Replaced download attributes with v1.0.4');
}

// 4. Preserve extension URLs in applyLatestRelease
const oldApplyExt = `    // Update global map
    if (installer) U.exe = installer.browser_download_url;
    if (extension) U.extzip = extension.browser_download_url;
    if (firefox) {
      U.firefoxDl = firefox.browser_download_url;
      U.firefoxInstall = '/assets/' + (firefox.name || 'tori-download-manager-firefox-v1.0.3.xpi');
    }
    if (checksum) U.sums = checksum.browser_download_url;`;

const newApplyExt = `    // Update global map (preserve dedicated extension v1.0.4 companion URLs)
    if (installer) U.exe = installer.browser_download_url;
    if (checksum) U.sums = checksum.browser_download_url;`;

if (!content.includes(oldApplyExt)) {
  console.error('Could not find old applyLatestRelease extension override block!');
} else {
  content = content.replace(oldApplyExt, newApplyExt);
  console.log('[OK] Pinned extension companion URLs to v1.0.4 in applyLatestRelease');
}

// 5. Update changelog row
const oldChangelog = `<div class="cl-r" data-t="new"><span class="ri"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg></span><div class="rt"><b>Firefox companion extension v1.0.3</b><p>Official Mozilla-signed extension (.xpi) for Firefox. Installs permanently and integrates via Native Messaging.</p></div></div>`;
const newChangelog = `<div class="cl-r" data-t="new"><span class="ri"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg></span><div class="rt"><b>Browser companion extension v1.0.4</b><p>Official Mozilla-signed extension (.xpi) for Firefox and Chromium .zip with verified modern popup and draggable video overlay.</p></div></div>`;

if (content.includes(oldChangelog)) {
  content = content.replace(oldChangelog, newChangelog);
  console.log('[OK] Updated changelog highlight to v1.0.4');
}

fs.writeFileSync(indexPath, content, 'utf8');
fs.writeFileSync(publicIndexPath, content, 'utf8');
console.log('Successfully written to index.html and public/index.html');
