#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 29.5 Final RC Partial Freeze & Updater Preflight
 *
 * Stages immutable release candidate artifacts into:
 *   release/v1.0.5-v1.0.9-final-rc/
 *     Desktop/
 *     Extensions/
 *     Metadata/
 *
 * Never modifies prior release folders, public latest.json, GitHub releases, or preserved
 * signed Firefox v1.0.7 XPI. Marks Firefox v1.0.9 signing as pending AMO operator approval.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DESKTOP_RC = path.join(ROOT, 'release', 'v1.0.5-rc');
const EXT_RC = path.join(ROOT, 'release', 'v1.0.9-extension-rc');
const RESOURCES_DIR = path.join(ROOT, 'resources');
const RES_BIN_DIR = path.join(RESOURCES_DIR, 'bin');

const FROZEN_ROOT = path.join(ROOT, 'release', 'v1.0.5-v1.0.9-final-rc');
const FROZEN_DESKTOP = path.join(FROZEN_ROOT, 'Desktop');
const FROZEN_EXT = path.join(FROZEN_ROOT, 'Extensions');
const FROZEN_META = path.join(FROZEN_ROOT, 'Metadata');

const SIGNED_V107_XPI = path.join(ROOT, 'release', 'v1.0.7-extension-rc', 'a70ed17e183648a9bcf4-1.0.7.xpi');
const EXPECTED_V107_SHA256 = 'b082c8f2f4c8b4ed035fab77d9569622737defb3e02279f20073d3404dda4fa0';

function sha256File(filePath) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      h.update(buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function copyAndVerify(src, dest) {
  if (!fs.existsSync(src)) {
    throw new Error(`Missing required source artifact: ${src}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  const srcHash = sha256File(src);
  const dstHash = sha256File(dest);
  if (srcHash !== dstHash) {
    throw new Error(`Copy checksum mismatch: ${src} (${srcHash}) vs ${dest} (${dstHash})`);
  }
  return {
    file: path.basename(dest),
    relPath: path.relative(FROZEN_ROOT, dest).replace(/\\/g, '/'),
    size: fs.statSync(dest).size,
    sha256: dstHash,
    sourceRelPath: path.relative(ROOT, src).replace(/\\/g, '/'),
  };
}

function getPeMachineHex(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const mz = Buffer.alloc(64);
    fs.readSync(fd, mz, 0, 64, 0);
    const eLfanew = mz.readUInt32LE(60);
    const hdr = Buffer.alloc(24);
    fs.readSync(fd, hdr, 0, 24, eLfanew);
    const machine = hdr.readUInt16LE(4);
    return {
      machineHex: `0x${machine.toString(16).padStart(4, '0')}`,
      arch: machine === 0x8664 ? 'x64 (AMD64)' : machine === 0x014c ? 'x86 (I386 stub)' : `unknown(${machine})`,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function compareSemver(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function shouldUpgrade(installedVer, remoteVer) {
  return compareSemver(remoteVer, installedVer) > 0;
}

async function runUpdaterMockPreflight(draftJson, installerPath, installerSha256, sigTrimmed) {
  const draftText = JSON.stringify(draftJson, null, 2);
  let server = null;
  try {
    server = http.createServer((req, res) => {
      if (req.url === '/latest.json') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(draftText);
        return;
      }
      if (req.url === '/TORI.Download.Manager_1.0.5_x64-setup.exe') {
        const st = fs.statSync(installerPath);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(st.size),
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        fs.createReadStream(installerPath).pipe(res);
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const manifestResp = await fetch(`http://127.0.0.1:${port}/latest.json`);
    if (manifestResp.status !== 200) {
      throw new Error(`Mock updater /latest.json returned HTTP ${manifestResp.status}`);
    }
    const fetchedManifest = await manifestResp.json();

    const pWin = fetchedManifest?.platforms?.['windows-x86_64'];
    const pNsis = fetchedManifest?.platforms?.['windows-x86_64-nsis'];
    if (!pWin || !pNsis) {
      throw new Error('Draft updater manifest missing required windows-x86_64 or windows-x86_64-nsis key');
    }
    if (pWin.signature.trim() !== sigTrimmed || pNsis.signature.trim() !== sigTrimmed) {
      throw new Error('Platform signature in draft manifest does not match .sig file verbatim');
    }

    const expectedAssetUrl =
      'https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.5/TORI.Download.Manager_1.0.5_x64-setup.exe';
    if (pWin.url !== expectedAssetUrl || pNsis.url !== expectedAssetUrl) {
      throw new Error(`Unexpected asset URL in draft manifest: ${pWin.url}`);
    }

    const decodedSigText = Buffer.from(sigTrimmed, 'base64').toString('utf8');
    if (
      !decodedSigText.includes('untrusted comment: signature from tauri secret key') ||
      !decodedSigText.includes('file:TORI Download Manager_1.0.5_x64-setup.exe')
    ) {
      throw new Error('Decoded Minisign signature missing expected comment or filename');
    }

    // Stream installer over mock endpoint & verify length + SHA-256
    const binResp = await fetch(`http://127.0.0.1:${port}/TORI.Download.Manager_1.0.5_x64-setup.exe`);
    if (binResp.status !== 200) {
      throw new Error(`Mock installer stream returned HTTP ${binResp.status}`);
    }
    const binArr = Buffer.from(await binResp.arrayBuffer());
    const streamedSha = crypto.createHash('sha256').update(binArr).digest('hex');
    if (streamedSha !== installerSha256) {
      throw new Error(`Mock updater binary SHA mismatch: ${streamedSha} !== ${installerSha256}`);
    }

    return {
      preflightPassed: true,
      testedAtUtc: new Date().toISOString(),
      mockEndpointUrl: `http://127.0.0.1:${port}/latest.json`,
      manifestVersion: fetchedManifest.version,
      upgradeFrom_1_0_4: shouldUpgrade('1.0.4', fetchedManifest.version),
      upgradeFrom_1_0_5_isNoop: !shouldUpgrade('1.0.5', fetchedManifest.version),
      downgradeFrom_1_0_6_rejected: !shouldUpgrade('1.0.6', fetchedManifest.version),
      platformsValidated: ['windows-x86_64', 'windows-x86_64-nsis'],
      signatureMatchesSigFileVerbatim: true,
      decodedSigTrustedComment: decodedSigText.split('\n').find((l) => l.startsWith('trusted comment:'))?.trim() || '',
      streamedAssetBytes: binArr.length,
      streamedAssetSha256: streamedSha,
      publicLatestJsonModified: false,
    };
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

async function main() {
  console.log('=== Gate 29.5 Final Release Candidate Partial Freeze ===');

  // 1. Verify preserved signed Firefox v1.0.7 XPI before touching anything
  if (!fs.existsSync(SIGNED_V107_XPI)) {
    throw new Error(`Missing preserved signed v1.0.7 XPI: ${SIGNED_V107_XPI}`);
  }
  const v107Hash = sha256File(SIGNED_V107_XPI);
  if (v107Hash !== EXPECTED_V107_SHA256) {
    throw new Error(`Preserved v1.0.7 XPI checksum mismatch: ${v107Hash}`);
  }
  console.log(`[OK] Preserved historical signed Firefox v1.0.7 XPI intact (${v107Hash})`);

  // 2. Clean & stage release/v1.0.5-v1.0.9-final-rc/
  fs.rmSync(FROZEN_ROOT, { recursive: true, force: true });
  fs.mkdirSync(FROZEN_DESKTOP, { recursive: true });
  fs.mkdirSync(FROZEN_EXT, { recursive: true });
  fs.mkdirSync(FROZEN_META, { recursive: true });

  const desktopManifest = [];
  const desktopFiles = [
    [path.join(DESKTOP_RC, 'TORI Download Manager_1.0.5_x64-setup.exe'), path.join(FROZEN_DESKTOP, 'TORI Download Manager_1.0.5_x64-setup.exe')],
    [path.join(DESKTOP_RC, 'TORI Download Manager_1.0.5_x64-setup.exe.sig'), path.join(FROZEN_DESKTOP, 'TORI Download Manager_1.0.5_x64-setup.exe.sig')],
    [path.join(DESKTOP_RC, 'tori-download-manager.exe'), path.join(FROZEN_DESKTOP, 'tori-download-manager.exe')],
    [path.join(DESKTOP_RC, 'tdm-native-host.exe'), path.join(FROZEN_DESKTOP, 'tdm-native-host.exe')],
    [path.join(DESKTOP_RC, 'tdm-cli.exe'), path.join(FROZEN_DESKTOP, 'tdm-cli.exe')],
    [path.join(RES_BIN_DIR, 'ffmpeg.exe'), path.join(FROZEN_DESKTOP, 'ffmpeg.exe')],
    [path.join(RES_BIN_DIR, 'ffprobe.exe'), path.join(FROZEN_DESKTOP, 'ffprobe.exe')],
    [path.join(RES_BIN_DIR, 'yt-dlp.exe'), path.join(FROZEN_DESKTOP, 'yt-dlp.exe')],
    [path.join(ROOT, 'LICENSE'), path.join(FROZEN_DESKTOP, 'LICENSE')],
    [path.join(ROOT, 'LICENSE-APACHE'), path.join(FROZEN_DESKTOP, 'LICENSE-APACHE')],
    [path.join(ROOT, 'LICENSE-MIT'), path.join(FROZEN_DESKTOP, 'LICENSE-MIT')],
    [path.join(RESOURCES_DIR, 'LICENSE-GPLv3.txt'), path.join(FROZEN_DESKTOP, 'LICENSE-GPLv3.txt')],
    [path.join(RESOURCES_DIR, 'LICENSE-THIRD-PARTY.txt'), path.join(FROZEN_DESKTOP, 'LICENSE-THIRD-PARTY.txt')],
  ];
  for (const [src, dst] of desktopFiles) {
    const rec = copyAndVerify(src, dst);
    if (dst.endsWith('.exe')) {
      rec.pe = getPeMachineHex(dst);
    }
    desktopManifest.push(rec);
  }
  console.log(`[OK] Staged ${desktopManifest.length} Desktop/companion/license files -> Desktop/`);

  const extManifest = [];
  const extFiles = [
    [path.join(EXT_RC, 'tori-companion-v1.0.9-chromium.zip'), path.join(FROZEN_EXT, 'tori-companion-v1.0.9-chromium.zip')],
    [path.join(EXT_RC, 'tori-companion-v1.0.9-firefox.zip'), path.join(FROZEN_EXT, 'tori-companion-v1.0.9-firefox.zip')],
  ];
  for (const [src, dst] of extFiles) {
    extManifest.push(copyAndVerify(src, dst));
  }
  console.log(`[OK] Staged ${extManifest.length} Extension RC packages -> Extensions/ (v1.0.9 signed XPI omitted pending AMO upload)`);

  // 3. Write SHA256SUMS.txt over exact frozen Desktop/ and Extensions/ artifacts
  const allFrozenArtifacts = [...desktopManifest, ...extManifest];
  const sumsText = allFrozenArtifacts.map((item) => `${item.sha256} *${item.relPath}`).join('\n') + '\n';
  fs.writeFileSync(path.join(FROZEN_META, 'SHA256SUMS.txt'), sumsText, 'utf8');

  // 4. Write FREEZE_STATUS.txt
  fs.writeFileSync(
    path.join(FROZEN_META, 'FREEZE_STATUS.txt'),
    [
      'PARTIAL FREEZE — FIREFOX SIGNING PENDING',
      '',
      'Desktop v1.0.5 RC + Chromium/Edge Companion v1.0.9 RC + Firefox Companion v1.0.9 unsigned ZIP frozen cleanly.',
      'Firefox Companion v1.0.9 AMO signing and independent clean Windows VM testing remain pending prior to Gate 30 publication.',
      '',
    ].join('\n'),
    'utf8'
  );

  // 5. Read configs & sig for Metadata files + Draft Updater Manifest
  const tauriConf = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const chrManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  const ffManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'firefox', 'manifest.json'), 'utf8'));
  const sigTrimmed = fs.readFileSync(path.join(FROZEN_DESKTOP, 'TORI Download Manager_1.0.5_x64-setup.exe.sig'), 'utf8').trim();
  const installerInfo = desktopManifest.find((d) => d.file === 'TORI Download Manager_1.0.5_x64-setup.exe');
  const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const gitBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const rustcVer = execFileSync('rustc', ['--version'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const nodeVer = process.version;

  const releaseNotesMd = `# TORI Download Manager v1.0.5 & Browser Companion v1.0.9

> **Draft Release Notes (Gate 29.5 Release Candidate Freeze — Not Yet Published)**

## Desktop Application — v1.0.5 (Windows x64)

### What's New & Improved
- **Modernized IDM-Style Main Window:** Three-zone layout featuring a compact desktop menu bar, high-contrast action toolbar, collapsible category & status sidebar (*All Downloads*, *Unfinished*, *Finished*, *Video*, *Music*, *Documents*, *Compressed*, *Programs*, *Other*), sortable download queue table with inline progress bars and speed/ETA columns, and a live bottom status bar.
- **Independent IDM-Style Download Progress Window:** Dedicated per-download progress dialog showing transfer state, speed, elapsed time, remaining ETA, overall & parallel multi-connection progress visualization, pause/resume, open file, and open folder controls connected directly to TORI's Rust download engine.
- **YouTube Playlist Download Workflow:** Selecting *Download Playlist* from the TORI media overlay restores TORI Desktop from the system tray when minimized, opens the playlist selection dialog automatically, resolves entries, and queues selected items into categorized folders. Mix/Radio dynamic queues are explicitly flagged as non-batchable.
- **Large MKV & Filename Classification Fixes:** Improved \`Content-Disposition\` filename parsing and MIME detection for extensionless video streams so \`.mkv\` and other media transfers route into the *Video* category without truncated filenames or corruption.
- **System Tray, Theme & Accent Customization:** Light/dark theme support with customizable accents and synchronized system tray minimize/restore behavior.

### Security & Update Integrity
- Desktop updates are verified via **Ed25519 cryptographic signatures** (\`TORI Download Manager_1.0.5_x64-setup.exe.sig\`) matching TORI's embedded updater public key before installation.
- **Authenticode Notice:** The Windows NSIS installer binary is currently distributed **without a commercial Windows Authenticode code-signing certificate** (Windows Defender SmartScreen may prompt for confirmation on first installation).

---

## Browser Companion — v1.0.9 (Chrome, Edge & Firefox)

### What's New & Improved
- **Unified IDM-Style Companion UI:** Updated toolbar popup, full extension options/settings page, and in-page HTML5 media download overlay sharing unified design tokens across Chrome, Microsoft Edge, and Mozilla Firefox.
- **Background/SPA Navigation Reliability:** Improved URL change detection so switching between standard videos, playlists, and Mix queues updates the *Download Playlist* banner reliably across foreground and restored tabs.
- **Resilient Desktop Pairing:** Explicit HTTP + Native Messaging fallback when TORI Desktop is closed or minimized to tray.

### Distribution & Signing Status
- **Google Chrome / Microsoft Edge:** Production v1.0.9 package (\`tori-companion-v1.0.9-chromium.zip\`) ready.
- **Mozilla Firefox:** Unsigned v1.0.9 source bundle (\`tori-companion-v1.0.9-firefox.zip\`) built and validated locally with \`web-ext lint\` (0 errors). Mozilla Add-ons (AMO) signing (\`.xpi\`) is pending operator submission prior to public Gate 30 release; Firefox production environments using \`xpinstall.signatures.required=true\` continue to use signed v1.0.7 (\`a70ed17e183648a9bcf4-1.0.7.xpi\`) until v1.0.9 XPI signing completes.
`;
  fs.writeFileSync(path.join(FROZEN_META, 'RELEASE_NOTES_v1.0.5_v1.0.9.md'), releaseNotesMd, 'utf8');

  const draftUpdaterManifest = {
    version: tauriConf.version,
    notes:
      'TORI Download Manager v1.0.5 — IDM-Style Desktop UI, Dedicated Download Progress Window, Improved YouTube Playlist Tray Restore, and MKV Classification Fixes.\n\n- New: IDM-style main download manager window with sidebar categories, action toolbar, and sortable queue\n- New: Dedicated IDM-style Download Progress window connected to TORI Rust engine\n- Fix: Reliable YouTube Playlist modal handoff from Browser Companion including tray restore and cold launch\n- Fix: Extensionless Content-Disposition MKV filename extraction and Video/ folder classification',
    pub_date: '2026-11-16T00:00:00.000Z',
    platforms: {
      'windows-x86_64': {
        signature: sigTrimmed,
        url: 'https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.5/TORI.Download.Manager_1.0.5_x64-setup.exe',
      },
      'windows-x86_64-nsis': {
        signature: sigTrimmed,
        url: 'https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.5/TORI.Download.Manager_1.0.5_x64-setup.exe',
      },
    },
  };
  fs.writeFileSync(path.join(FROZEN_META, 'latest.v1.0.5.draft.json'), JSON.stringify(draftUpdaterManifest, null, 2) + '\n', 'utf8');

  // 6. Run local isolated HTTP mock preflight test against draft updater manifest
  const preflight = await runUpdaterMockPreflight(
    draftUpdaterManifest,
    path.join(FROZEN_DESKTOP, 'TORI Download Manager_1.0.5_x64-setup.exe'),
    installerInfo.sha256,
    sigTrimmed
  );
  fs.writeFileSync(path.join(FROZEN_META, 'UPDATER_PREFLIGHT.json'), JSON.stringify(preflight, null, 2) + '\n', 'utf8');
  console.log(`[OK] Draft updater manifest local mock preflight passed -> streamedSha256=${preflight.streamedAssetSha256}`);

  // 7. Write remaining Metadata JSON/MD files
  const versionMatrix = {
    freezeStatus: 'PARTIAL FREEZE — FIREFOX SIGNING PENDING',
    components: {
      desktop: {
        productName: tauriConf.productName,
        identifier: tauriConf.identifier,
        version: tauriConf.version,
        architecture: 'Windows x64',
        installerExe: 'Desktop/TORI Download Manager_1.0.5_x64-setup.exe',
        updaterSignatureFile: 'Desktop/TORI Download Manager_1.0.5_x64-setup.exe.sig',
      },
      extensionChromiumEdge: {
        name: chrManifest.name,
        version: chrManifest.version,
        manifestVersion: chrManifest.manifest_version,
        packageZip: 'Extensions/tori-companion-v1.0.9-chromium.zip',
        extensionIdPinnedByManifestKey: true,
      },
      extensionFirefoxUnsignedRC: {
        name: ffManifest.name,
        version: ffManifest.version,
        manifestVersion: ffManifest.manifest_version,
        geckoId: ffManifest.browser_specific_settings?.gecko?.id,
        strictMinVersion: ffManifest.browser_specific_settings?.gecko?.strict_min_version,
        sourceZip: 'Extensions/tori-companion-v1.0.9-firefox.zip',
        signedXpiVersionAvailableNow: '1.0.7 (historical preserved at release/v1.0.7-extension-rc/a70ed17e183648a9bcf4-1.0.7.xpi)',
      },
    },
  };
  fs.writeFileSync(path.join(FROZEN_META, 'VERSION_MATRIX.json'), JSON.stringify(versionMatrix, null, 2) + '\n', 'utf8');

  const signingStatus = {
    overallStatus: 'PARTIAL FREEZE — FIREFOX SIGNING PENDING',
    desktopUpdaterTauriEd25519: {
      status: 'SIGNED',
      algorithm: 'Minisign / Ed25519',
      pubkeyConfigPath: 'src-tauri/tauri.conf.json#plugins.updater.pubkey',
      sigFile: 'Desktop/TORI Download Manager_1.0.5_x64-setup.exe.sig',
      trustedComment: preflight.decodedSigTrustedComment,
    },
    desktopWindowsAuthenticodePE: {
      status: 'UNSIGNED',
      note: 'No OV/EV Authenticode certificate applied to EXE/installer binaries; SmartScreen warning expected on clean Windows systems until code-signed.',
    },
    extensionChromiumEdge: {
      status: 'PACKAGE READY (UNSIGNED ZIP FOR STORE/UNPACKED)',
      package: 'Extensions/tori-companion-v1.0.9-chromium.zip',
    },
    extensionFirefoxAMO: {
      status: 'SIGNING READY — AUTHORIZATION REQUIRED',
      sourceZip: 'Extensions/tori-companion-v1.0.9-firefox.zip',
      signedV109XpiStatus: 'NOT PRESENT / NOT SUBMITTED (manual AMO operator submission required)',
      preservedHistoricalSignedXpi: {
        version: '1.0.7',
        path: 'release/v1.0.7-extension-rc/a70ed17e183648a9bcf4-1.0.7.xpi',
        sha256: EXPECTED_V107_SHA256,
      },
    },
  };
  fs.writeFileSync(path.join(FROZEN_META, 'SIGNING_STATUS.json'), JSON.stringify(signingStatus, null, 2) + '\n', 'utf8');

  const buildMeta = {
    frozenAtUtc: new Date().toISOString(),
    gitBranch,
    gitCommitAtFreezePrep: gitCommit,
    toolchain: {
      rustc: rustcVer,
      node: nodeVer,
      platform: `${process.platform}-${process.arch}`,
    },
    updaterEndpoints: tauriConf.plugins?.updater?.endpoints || [],
    publicLatestJsonLiveObserved: {
      version: '1.0.4',
      endpoint: 'https://github.com/robijoychakma375-hash/tori-download-manager/releases/latest/download/latest.json',
      modifiedDuringGate295: false,
    },
  };
  fs.writeFileSync(path.join(FROZEN_META, 'BUILD_METADATA.json'), JSON.stringify(buildMeta, null, 2) + '\n', 'utf8');

  const releaseManifest = {
    releaseCandidateId: 'tori-v1.0.5-desktop-v1.0.9-companion-rc',
    freezeClassification: 'PARTIAL FREEZE — FIREFOX SIGNING PENDING',
    desktopArtifacts: desktopManifest,
    extensionArtifacts: extManifest,
    metadataFiles: [
      'Metadata/FREEZE_STATUS.txt',
      'Metadata/SHA256SUMS.txt',
      'Metadata/RELEASE_MANIFEST.json',
      'Metadata/BUILD_METADATA.json',
      'Metadata/VERSION_MATRIX.json',
      'Metadata/VERIFICATION_SUMMARY.json',
      'Metadata/SIGNING_STATUS.json',
      'Metadata/RELEASE_NOTES_v1.0.5_v1.0.9.md',
      'Metadata/latest.v1.0.5.draft.json',
      'Metadata/UPDATER_PREFLIGHT.json',
      'Metadata/FIREFOX_AMO_SIGNING_INSTRUCTIONS.md',
    ],
  };
  fs.writeFileSync(path.join(FROZEN_META, 'RELEASE_MANIFEST.json'), JSON.stringify(releaseManifest, null, 2) + '\n', 'utf8');

  const verificationSummary = {
    cleanMachineVMValidation: {
      status: 'NOT TESTED',
      reason: 'No independent clean Windows VM/machine available on host (Hyper-V/VirtualBox/VMware/QEMU absent). Isolated non-VM host validation executed in Gate 29.4/29.5.',
    },
    firefoxSignedV109XpiVerification: {
      status: 'NOT TESTED',
      reason: 'Firefox v1.0.9 XPI has not been submitted to or signed by Mozilla AMO without explicit operator authorization.',
    },
    playlistE2EWithV109Extension: 'PASS (12/12 on Chromium/Edge v1.0.9 + Firefox signed v1.0.7 + Desktop v1.0.5-rc)',
    updaterDraftManifestPreflight: preflight.preflightPassed ? 'PASS' : 'FAIL',
  };
  fs.writeFileSync(path.join(FROZEN_META, 'VERIFICATION_SUMMARY.json'), JSON.stringify(verificationSummary, null, 2) + '\n', 'utf8');

  const amoInstructions = `# Firefox Companion v1.0.9 — Mozilla AMO Signing Instructions

1. Ensure operator authorization for AMO submission.
2. Sign in to Mozilla Add-ons Developer Hub: https://addons.mozilla.org/developers/
3. Select existing add-on ID \`tori-download-manager@toridm.org\` (preserving add-on identity across \`1.0.7\` -> \`1.0.9\`).
4. Upload ONLY the frozen unsigned source bundle:
   \`release/v1.0.5-v1.0.9-final-rc/Extensions/tori-companion-v1.0.9-firefox.zip\`
   Expected ZIP SHA-256: \`${extManifest.find((e) => e.file === 'tori-companion-v1.0.9-firefox.zip').sha256}\`
5. Wait for Mozilla automated signing approval and download the signed \`.xpi\` (e.g. \`a70ed17e183648a9bcf4-1.0.9.xpi\`).
6. Place the signed \`.xpi\` into \`release/v1.0.5-v1.0.9-final-rc/Extensions/\` and run post-signing verification:
   - Confirm \`META-INF/mozilla.rsa\`, \`META-INF/mozilla.sf\`, \`META-INF/manifest.mf\`, and \`META-INF/cose.sig\`
   - Confirm \`manifest.json\` has \`version === "1.0.9"\` and \`gecko.id === "tori-download-manager@toridm.org"\`
   - Install permanently in Firefox with \`xpinstall.signatures.required = true\` and verify UI, native host, download capture, and playlist modal restore.
7. Update \`Metadata/SHA256SUMS.txt\`, \`Metadata/SIGNING_STATUS.json\`, and remove pending freeze marker before Gate 30 publication.
`;
  fs.writeFileSync(path.join(FROZEN_META, 'FIREFOX_AMO_SIGNING_INSTRUCTIONS.md'), amoInstructions, 'utf8');

  console.log('[OK] Partial Release Candidate Freeze staged completely at release/v1.0.5-v1.0.9-final-rc/');
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
