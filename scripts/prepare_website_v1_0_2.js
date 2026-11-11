const fs = require('fs');
const path = require('path');

const WEBSITE_INDEX = path.resolve('C:/Users/ritud/Downloads/tori-website/index.html');

if (!fs.existsSync(WEBSITE_INDEX)) {
  console.error(`Error: Website index not found at ${WEBSITE_INDEX}`);
  process.exit(1);
}

let content = fs.readFileSync(WEBSITE_INDEX, 'utf8');
const original = content;

console.log('=== TORI Website v1.0.2 Preparation ===');
console.log(`Target: ${WEBSITE_INDEX}`);

// 1. JSON-LD Schema
content = content.replace(
  /"downloadUrl": "https:\/\/github\.com\/robijoychakma375-hash\/tori-download-manager\/releases\/download\/v1\.0\.1\/TORI\.Download\.Manager_1\.0\.1_x64-setup\.exe"/g,
  '"downloadUrl": "https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.2/TORI.Download.Manager_1.0.2_x64-setup.exe"'
);
content = content.replace(
  /"softwareVersion": "1\.0\.1"/g,
  '"softwareVersion": "1.0.2"'
);

// 2. Hero Pill
content = content.replace(
  /<span id="hero-pill-text">New · v1\.0\.1 for Windows \(Stable\)<\/span>/g,
  '<span id="hero-pill-text">New · v1.0.2 for Windows (Stable Candidate)</span>'
);

// 3. Hero CTA Download Button
content = content.replace(
  /<a class="btn pri" id="hero-dl-btn" href="https:\/\/github\.com\/robijoychakma375-hash\/tori-download-manager\/releases\/download\/v1\.0\.1\/TORI\.Download\.Manager_1\.0\.1_x64-setup\.exe">/g,
  '<a class="btn pri" id="hero-dl-btn" href="https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.2/TORI.Download.Manager_1.0.2_x64-setup.exe">'
);

// 4. Main Download Card
content = content.replace(
  /<p id="card-version-label">Version 1\.0\.1 · Stable · Installer<\/p>/g,
  '<p id="card-version-label">Version 1.0.2 · Stable Candidate · Installer</p>'
);
content = content.replace(
  /<a class="btn pri" id="main-dl-btn" style="width:100%;justify-content:center" href="https:\/\/github\.com\/robijoychakma375-hash\/tori-download-manager\/releases\/download\/v1\.0\.1\/TORI\.Download\.Manager_1\.0\.1_x64-setup\.exe">/g,
  '<a class="btn pri" id="main-dl-btn" style="width:100%;justify-content:center" href="https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.2/TORI.Download.Manager_1.0.2_x64-setup.exe">'
);
content = content.replace(
  /<code id="meta-sha"><a id="meta-sha-link" href="https:\/\/github\.com\/robijoychakma375-hash\/tori-download-manager\/releases\/download\/v1\.0\.1\/SHA256SUMS\.txt" target="_blank" rel="noopener">SHA-256 Verified<\/a><\/code>/g,
  '<code id="meta-sha"><a id="meta-sha-link" href="https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.2/SHA256SUMS.txt" target="_blank" rel="noopener">SHA-256 Verified</a></code>'
);

// 5. Release Card Details
content = content.replace(
  /<b style="font-size:18px" id="rel-title">TORI v1\.0\.1<\/b>\s*<span class="tag" id="rel-tag">v1\.0\.1<\/span>/g,
  '<b style="font-size:18px" id="rel-title">TORI v1.0.2</b>\n    <span class="tag" id="rel-tag">v1.0.2</span>'
);
content = content.replace(
  /<h4>What’s included in v1\.0\.1<\/h4>/g,
  '<h4>What’s included in v1.0.2</h4>'
);

// Update release highlights list
const oldHighlights = `    <ul class="n" id="rel-notes-list">
    <li>Generic download interception for ISO, ZIP, RAR, 7Z, EXE, PDF, video, and audio</li>
    <li>Official Mozilla-signed Firefox companion extension v1.0.2 with Native Messaging</li>
    <li>Reliable Close-to-Tray background execution keeping transfers active when window is hidden</li>
    <li>Native time-based download scheduler and crash-proof queue recovery</li>
    <li>Direct stream capture &amp; remuxing: native Apple HLS (.m3u8) &amp; MPEG-DASH (.mpd) with FFmpeg</li>
   </ul>`;

const newHighlights = `    <ul class="n" id="rel-notes-list">
    <li>Synchronized desktop and companion browser extension versions to v1.0.2</li>
    <li>Generic download interception for ISO, ZIP, RAR, 7Z, EXE, PDF, video, and audio</li>
    <li>Official Mozilla-signed Firefox companion extension v1.0.2 with Native Messaging</li>
    <li>Reliable Close-to-Tray background execution keeping transfers active when window is hidden</li>
    <li>Native time-based download scheduler and crash-proof queue recovery</li>
    <li>Direct stream capture &amp; remuxing: native Apple HLS (.m3u8) &amp; MPEG-DASH (.mpd) with FFmpeg</li>
   </ul>`;

if (content.includes(oldHighlights)) {
  content = content.replace(oldHighlights, newHighlights);
}

// 6. Assets List
content = content.replace(
  /<a class="as" id="asset-installer-row" href="https:\/\/github\.com\/robijoychakma375-hash\/tori-download-manager\/releases\/download\/v1\.0\.1\/TORI\.Download\.Manager_1\.0\.1_x64-setup\.exe">\s*<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0-4\.5-4\.5M12 15l4\.5-4\.5M5 20h14"\/><\/svg>\s*<b id="asset-installer-name">TORI\.Download\.Manager_1\.0\.1_x64-setup\.exe<\/b>\s*<span id="asset-installer-size">111\.6 MB<\/span>\s*<\/a>/g,
  `<a class="as" id="asset-installer-row" href="https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.2/TORI.Download.Manager_1.0.2_x64-setup.exe">\n     <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14"/></svg>\n     <b id="asset-installer-name">TORI.Download.Manager_1.0.2_x64-setup.exe</b>\n     <span id="asset-installer-size">111.6 MB</span>\n    </a>`
);

content = content.replace(
  /<a class="as" id="asset-ext-row" href="https:\/\/github\.com\/robijoychakma375-hash\/tori-download-manager\/releases\/download\/v1\.0\.1\/tori-download-manager-extension-v1\.0\.2\.zip">/g,
  '<a class="as" id="asset-ext-row" href="https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.2/tori-download-manager-extension-v1.0.2.zip">'
);

content = content.replace(
  /<a class="as" id="asset-sha-row" href="https:\/\/github\.com\/robijoychakma375-hash\/tori-download-manager\/releases\/download\/v1\.0\.1\/SHA256SUMS\.txt"/g,
  '<a class="as" id="asset-sha-row" href="https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.2/SHA256SUMS.txt"'
);

// 7. Companion Extension buttons
content = content.replace(
  /href="https:\/\/github\.com\/robijoychakma375-hash\/tori-download-manager\/releases\/download\/v1\.0\.1\/tori-download-manager-firefox-v1\.0\.2\.xpi"/g,
  'href="https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.2/tori-download-manager-firefox-v1.0.2.xpi"'
);

content = content.replace(
  /href="https:\/\/github\.com\/robijoychakma375-hash\/tori-download-manager\/releases\/download\/v1\.0\.1\/tori-download-manager-extension-v1\.0\.2\.zip"/g,
  'href="https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.2/tori-download-manager-extension-v1.0.2.zip"'
);

// 8. Band Download Button
content = content.replace(
  /<a class="btn" id="band-dl-btn" href="https:\/\/github\.com\/robijoychakma375-hash\/tori-download-manager\/releases\/download\/v1\.0\.1\/TORI\.Download\.Manager_1\.0\.1_x64-setup\.exe">Download for Windows<\/a>/g,
  '<a class="btn" id="band-dl-btn" href="https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.2/TORI.Download.Manager_1.0.2_x64-setup.exe">Download for Windows</a>'
);

// 9. JavaScript FALLBACK_RELEASE
const oldFallback = `  var FALLBACK_RELEASE = {
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

const newFallback = `  var FALLBACK_RELEASE = {
    tag_name: 'v1.0.2',
    name: 'TORI Download Manager v1.0.2',
    published_at: '2026-11-11T12:00:00Z',
    html_url: GITHUB_BASE + '/releases/tag/v1.0.2',
    assets: [
      {
        name: 'TORI.Download.Manager_1.0.2_x64-setup.exe',
        size: 117073652,
        browser_download_url: GITHUB_BASE + '/releases/download/v1.0.2/TORI.Download.Manager_1.0.2_x64-setup.exe'
      },
      {
        name: 'tori-download-manager-extension-v1.0.2.zip',
        size: 71971,
        browser_download_url: GITHUB_BASE + '/releases/download/v1.0.2/tori-download-manager-extension-v1.0.2.zip'
      },
      {
        name: 'tori-download-manager-firefox-v1.0.2.xpi',
        size: 86743,
        browser_download_url: GITHUB_BASE + '/releases/download/v1.0.2/tori-download-manager-firefox-v1.0.2.xpi'
      },
      {
        name: 'SHA256SUMS.txt',
        size: 888,
        browser_download_url: GITHUB_BASE + '/releases/download/v1.0.2/SHA256SUMS.txt'
      }
    ]
  };`;

if (content.includes(oldFallback)) {
  content = content.replace(oldFallback, newFallback);
}

if (content === original) {
  console.log('No modifications were made. Please inspect patterns.');
} else {
  fs.writeFileSync(WEBSITE_INDEX, content, 'utf8');
  console.log('Successfully updated website index.html to v1.0.2.');
}

