const fs = require('fs');
const path = require('path');

const WEBSITE_INDEX = path.resolve('C:/Users/ritud/Downloads/tori-website/index.html');

function updateWebsiteToStable() {
  if (!fs.existsSync(WEBSITE_INDEX)) {
    console.error('Website index.html not found at:', WEBSITE_INDEX);
    process.exit(1);
  }

  let html = fs.readFileSync(WEBSITE_INDEX, 'utf8');

  // 1. Update Hero Pill
  html = html.replace(
    '<span id="hero-pill-text">New · v1.0.0 for Windows (Stable)</span>',
    '<span id="hero-pill-text">New · v1.0.1 for Windows (Stable)</span>'
  );

  // 2. Update Hero Download Button
  html = html.replace(
    'href="https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.0/TORI.Download.Manager_1.0.0_x64-setup.exe"',
    'href="https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.1/TORI.Download.Manager_1.0.1_x64-setup.exe"'
  );

  // 3. Update Step 1 Card Version Label
  html = html.replace(
    '<p id="card-version-label">Version 1.0.0 · Stable · Installer</p>',
    '<p id="card-version-label">Version 1.0.1 · Stable · Installer</p>'
  );

  // 4. Update Main Card Download Button (all remaining occurrences of v1.0.0 installer)
  html = html.replaceAll(
    'https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.0/TORI.Download.Manager_1.0.0_x64-setup.exe',
    'https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.1/TORI.Download.Manager_1.0.1_x64-setup.exe'
  );

  // 5. Update Meta Size & SHA Checksum
  html = html.replace(
    '<span class="v" id="meta-size">111.4 MB</span>',
    '<span class="v" id="meta-size">111.6 MB</span>'
  );
  html = html.replace(
    'href="https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.0/SHA256SUMS.txt"',
    'href="https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.1/SHA256SUMS.txt"'
  );

  // 6. Update Release Details Card
  html = html.replace(
    '<b style="font-size:18px" id="rel-title">TORI v1.0.0</b>',
    '<b style="font-size:18px" id="rel-title">TORI v1.0.1</b>'
  );
  html = html.replace(
    '<span class="tag" id="rel-tag">v1.0.0</span>',
    '<span class="tag" id="rel-tag">v1.0.1</span>'
  );
  html = html.replace(
    '<span class="v" id="rel-published">Nov 7, 2026</span>',
    '<span class="v" id="rel-published">Nov 10, 2026</span>'
  );

  // 7. Update Assets Row in Release Card
  html = html.replace(
    '<span id="asset-installer-name">TORI.Download.Manager_1.0.0_x64-setup.exe</span>',
    '<span id="asset-installer-name">TORI.Download.Manager_1.0.1_x64-setup.exe</span>'
  );
  html = html.replace(
    '<span id="asset-installer-size">111.4 MB</span>',
    '<span id="asset-installer-size">111.6 MB</span>'
  );
  html = html.replace(
    '<span id="asset-ext-name">tori-download-manager-extension-v1.0.0.zip</span>',
    '<span id="asset-ext-name">tori-download-manager-extension-v1.0.2.zip</span>'
  );
  html = html.replace(
    '<span id="asset-ext-size">60.4 KB</span>',
    '<span id="asset-ext-size">70.3 KB</span>'
  );

  // 8. Hide or remove temporary pre-release card
  html = html.replace(
    'id="prerelease-card"',
    'id="prerelease-card" style="display:none"'
  );

  // 9. Update FALLBACK_RELEASE in JS
  const oldFallback = `  var FALLBACK_RELEASE = {
    tag_name: 'v1.0.0',
    name: 'TORI Download Manager v1.0.0',
    published_at: '2026-11-07T08:40:56Z',
    html_url: GITHUB_BASE + '/releases/tag/v1.0.0',
    assets: [
      {
        name: 'TORI.Download.Manager_1.0.0_x64-setup.exe',
        size: 116812832,
        browser_download_url: GITHUB_BASE + '/releases/download/v1.0.0/TORI.Download.Manager_1.0.0_x64-setup.exe'
      },
      {
        name: 'tori-download-manager-extension-v1.0.0.zip',
        size: 61842,
        browser_download_url: GITHUB_BASE + '/releases/download/v1.0.0/tori-download-manager-extension-v1.0.0.zip'
      },
      {
        name: 'SHA256SUMS.txt',
        size: 1248,
        browser_download_url: GITHUB_BASE + '/releases/download/v1.0.0/SHA256SUMS.txt'
      }
    ]
  };`;

  const newFallback = `  var FALLBACK_RELEASE = {
    tag_name: 'v1.0.1',
    name: 'TORI Download Manager v1.0.1',
    published_at: '2026-11-10T17:30:13Z',
    html_url: GITHUB_BASE + '/releases/tag/v1.0.1',
    assets: [
      {
        name: 'TORI.Download.Manager_1.0.1_x64-setup.exe',
        size: 117044352,
        browser_download_url: GITHUB_BASE + '/releases/download/v1.0.1/TORI.Download.Manager_1.0.1_x64-setup.exe'
      },
      {
        name: 'tori-download-manager-extension-v1.0.2.zip',
        size: 71971,
        browser_download_url: GITHUB_BASE + '/releases/download/v1.0.1/tori-download-manager-extension-v1.0.2.zip'
      },
      {
        name: 'tori-download-manager-firefox-v1.0.2.xpi',
        size: 86743,
        browser_download_url: GITHUB_BASE + '/releases/download/v1.0.1/tori-download-manager-firefox-v1.0.2.xpi'
      },
      {
        name: 'SHA256SUMS.txt',
        size: 888,
        browser_download_url: GITHUB_BASE + '/releases/download/v1.0.1/SHA256SUMS.txt'
      }
    ]
  };`;

  if (html.includes(oldFallback)) {
    html = html.replace(oldFallback, newFallback);
  }

  // Write updated HTML
  fs.writeFileSync(WEBSITE_INDEX, html, 'utf8');
  console.log('[SUCCESS] Website index.html prepared for v1.0.1 Stable promotion.');
}

if (process.argv.includes('--execute')) {
  updateWebsiteToStable();
} else {
  console.log('Website update script prepared. Run with --execute only after user approval.');
}
