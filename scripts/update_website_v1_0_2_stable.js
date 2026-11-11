const fs = require('fs');
const path = require('path');

const WEBSITE_INDEX = path.resolve('C:/Users/ritud/Downloads/tori-website/index.html');

if (!fs.existsSync(WEBSITE_INDEX)) {
  console.error(`Error: Website index not found at ${WEBSITE_INDEX}`);
  process.exit(1);
}

let content = fs.readFileSync(WEBSITE_INDEX, 'utf8');

console.log('=== TORI Website v1.0.2 Stable Release Update ===');

// 1. Remove candidate / test wording
content = content.replace(
  /<span id="hero-pill-text">New · v1\.0\.2 for Windows \(Stable Candidate\)<\/span>/g,
  '<span id="hero-pill-text">New · v1.0.2 for Windows (Stable)</span>'
);

content = content.replace(
  /<p id="card-version-label">Version 1\.0\.2 · Stable Candidate · Installer<\/p>/g,
  '<p id="card-version-label">Version 1.0.2 · Stable · Installer</p>'
);

// 2. Update release dates
content = content.replace(
  /<li><span>Released<\/span><span id="meta-date">Nov 10, 2026<\/span><\/li>/g,
  '<li><span>Released</span><span id="meta-date">Nov 11, 2026</span></li>'
);

content = content.replace(
  /released <span id="rel-published">Nov 10, 2026<\/span>/g,
  'released <span id="rel-published">Nov 11, 2026</span>'
);

// 3. Update footer version badge
content = content.replace(
  /<span class="vp" id="footer-ver-badge">v1\.0\.0 · Windows 10 \/ 11 \(64-bit\)<\/span>/g,
  '<span class="vp" id="footer-ver-badge">v1.0.2 · Windows 10 / 11 (64-bit)</span>'
);

// 4. Licensing Audit & Corrections
content = content.replace(
  /"license": "https:\/\/github\.com\/robijoychakma375-hash\/tori-download-manager\/blob\/master\/LICENSE"/g,
  '"license": "https://github.com/robijoychakma375-hash/tori-download-manager/blob/master/LICENSE-GPLv3.txt"'
);

content = content.replace(
  /"text": "Yes, TORI Download Manager is 100% free and open-source software distributed under dual MIT or Apache-2.0 licenses\. There are no subscriptions, ads, telemetry tracking, or bundled adware\."/g,
  '"text": "Yes, TORI Download Manager is 100% free and open-source software. The desktop application and installer bundle are distributed under the GNU General Public License v3 (GPLv3) due to bundled FFmpeg media tools, with core source code dual-licensed under MIT and Apache-2.0. There are no subscriptions, ads, telemetry tracking, or bundled adware."'
);

content = content.replace(
  /<div class="note">Windows 10 \/ 11 · 64-bit · Free &amp; Open Source \(MIT \/ Apache-2\.0\) · <a href="#download" style="color:var\(--at\);text-decoration:underline">Extension &amp; release notes<\/a><\/div>/g,
  '<div class="note">Windows 10 / 11 · 64-bit · Free &amp; Open Source (GPLv3 / MIT) · <a href="#download" style="color:var(--at);text-decoration:underline">Extension &amp; release notes</a></div>'
);

content = content.replace(
  /<p style="margin:0;color:var\(--mut\);font-size:14\.5px;line-height:1\.6">Yes\. TORI Download Manager is 100% free software distributed under open-source dual MIT and Apache-2\.0 licenses\. There are no subscription fees, tracking analytics, or bundled promotional software\.<\/p>/g,
  '<p style="margin:0;color:var(--mut);font-size:14.5px;line-height:1.6">Yes. TORI Download Manager is 100% free software. The desktop application and installer bundle are distributed under the GNU General Public License v3 (GPLv3) due to bundled FFmpeg media tools, with core source code dual-licensed under MIT and Apache-2.0. There are no subscription fees, tracking analytics, or bundled promotional software.</p>'
);

content = content.replace(
  /<a id="footer-license-link" href="https:\/\/github\.com\/robijoychakma375-hash\/tori-download-manager\/blob\/master\/LICENSE" target="_blank" rel="noopener">License \(MIT\/Apache\)<\/a>/g,
  '<a id="footer-license-link" href="https://github.com/robijoychakma375-hash/tori-download-manager/blob/master/LICENSE-GPLv3.txt" target="_blank" rel="noopener">License (GPLv3 / MIT)</a>'
);

// 5. JavaScript Fallback Releases Array (lines 980-985)
const oldFallbackBlock = `  var FALLBACK_RELEASE = {
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

const newFallbackBlock = `  var FALLBACK_RELEASE = {
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
  };

  var FALLBACK_RELEASES = [
    FALLBACK_RELEASE,
    {
      tag_name: 'v1.0.1',
      name: 'TORI Download Manager v1.0.1',
      published_at: '2026-11-10T17:30:13Z',
      html_url: GITHUB_BASE + '/releases/tag/v1.0.1',
      assets: [
        {
          name: 'TORI.Download.Manager_1.0.1_x64-setup.exe',
          size: 117044352,
          browser_download_url: GITHUB_BASE + '/releases/download/v1.0.1/TORI.Download.Manager_1.0.1_x64-setup.exe'
        }
      ]
    },
    {
      tag_name: 'v1.0.0',
      name: 'TORI Download Manager v1.0.0',
      published_at: '2026-11-06T18:00:00Z',
      html_url: GITHUB_BASE + '/releases/tag/v1.0.0',
      assets: [
        {
          name: 'TORI.Download.Manager_1.0.0_x64-setup.exe',
          size: 116996177,
          browser_download_url: GITHUB_BASE + '/releases/download/v1.0.0/TORI.Download.Manager_1.0.0_x64-setup.exe'
        }
      ]
    }
  ];`;

if (content.includes(oldFallbackBlock)) {
  content = content.replace(oldFallbackBlock, newFallbackBlock);
}

// Fallback in fetch handler
content = content.replace(
  /renderReleaseHistory\(\[FALLBACK_RELEASE\]\);/g,
  'renderReleaseHistory(FALLBACK_RELEASES);'
);

fs.writeFileSync(WEBSITE_INDEX, content, 'utf8');
console.log('Successfully updated website index.html with stable v1.0.2 and corrected licensing.');

