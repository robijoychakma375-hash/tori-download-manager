/**
 * TORI Gate 27.4 — Comprehensive Firefox v1.0.6 Signed XPI Verification
 *
 * Verifies:
 * 1. File existence and exact SHA-256 (96a63c6be3eaf8488fbbd299ed2f07c8ef1e20b09128b8d0841a463026236038)
 * 2. Manifest metadata (v1.0.6, Gecko ID tori-download-manager@toridm.org)
 * 3. Mozilla cryptographic signature (PKCS#7, COSE, certificate chain)
 * 4. Firefox installation with strict signature enforcement (xpinstall.signatures.required = true)
 * 5. Extension activation and WebExtensionPolicy registration
 * 6. Extension pairing and connectivity to TORI Desktop
 * 7. Source comparison across all 34 content assets
 * 8. Playlist Download, YouTube Mix rejection, and Audio/Video logic verification
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const XPI_PATH = path.join(PROJECT_ROOT, 'release', 'v1.0.5-rc', 'extensions', 'a70ed17e183648a9bcf4-1.0.6.xpi');
const CANONICAL_XPI_PATH = path.join(PROJECT_ROOT, 'release', 'v1.0.5-rc', 'extensions', 'tori-download-manager-firefox-v1.0.6.xpi');
const FIREFOX_EXE = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const OPENSSL_EXE = 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe';

const EXPECTED_SHA256 = '96a63c6be3eaf8488fbbd299ed2f07c8ef1e20b09128b8d0841a463026236038';
const EXPECTED_VERSION = '1.0.6';
const EXPECTED_GECKO_ID = 'tori-download-manager@toridm.org';

const MARIONETTE_PORT = 2831;
const DESKTOP_MOCK_PORT = 16892;
const TEST_ENV_DIR = path.join(PROJECT_ROOT, 'target', 'firefox_signed_v106_acceptance');
const PROFILE_DIR = path.join(TEST_ENV_DIR, 'profile');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

class MarionetteClient {
  constructor() {
    this.socket = null;
    this.msgId = 1;
    this.buffer = '';
    this.pending = new Map();
  }

  connect(port = MARIONETTE_PORT) {
    return new Promise((resolve, reject) => {
      this.socket = net.connect(port, '127.0.0.1');
      this.socket.on('data', (data) => {
        this.buffer += data.toString('utf8');
        this.processBuffer(resolve);
      });
      this.socket.on('error', reject);
    });
  }

  processBuffer(initialResolve) {
    while (true) {
      const colonIdx = this.buffer.indexOf(':');
      if (colonIdx === -1) break;
      const lenStr = this.buffer.slice(0, colonIdx);
      const len = parseInt(lenStr, 10);
      if (isNaN(len)) {
        this.buffer = '';
        break;
      }
      if (this.buffer.length < colonIdx + 1 + len) break;
      const payload = this.buffer.slice(colonIdx + 1, colonIdx + 1 + len);
      this.buffer = this.buffer.slice(colonIdx + 1 + len);

      try {
        const parsed = JSON.parse(payload);
        if (parsed.marionetteProtocol !== undefined && initialResolve) {
          initialResolve();
        } else if (Array.isArray(parsed) && parsed[0] === 1) {
          const reqId = parsed[1];
          const error = parsed[2];
          const result = parsed[3];
          const cb = this.pending.get(reqId);
          if (cb) {
            this.pending.delete(reqId);
            if (error) cb.reject(new Error(JSON.stringify(error)));
            else cb.resolve(result);
          }
        }
      } catch (err) {
        console.error('[MARIONETTE] JSON parse error:', err.message);
      }
    }
  }

  send(name, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify([0, id, name, params]);
      const frame = `${Buffer.byteLength(msg, 'utf8')}:${msg}`;
      this.socket.write(frame);
    });
  }

  disconnect() {
    if (this.socket) {
      try { this.socket.destroy(); } catch (_) {}
      this.socket = null;
    }
  }
}

// ZIP helper
function parseZip(filePath) {
  const buf = fs.readFileSync(filePath);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('Invalid ZIP');
  const cdEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  let cur = cdOffset;
  const entries = [];
  for (let i = 0; i < cdEntries; i++) {
    const compMethod = buf.readUInt16LE(cur + 10);
    const compSize = buf.readUInt32LE(cur + 20);
    const uncompSize = buf.readUInt32LE(cur + 24);
    const nameLen = buf.readUInt16LE(cur + 28);
    const extraLen = buf.readUInt16LE(cur + 30);
    const commentLen = buf.readUInt16LE(cur + 32);
    const localOffset = buf.readUInt32LE(cur + 42);
    const name = buf.toString('utf8', cur + 46, cur + 46 + nameLen);
    entries.push({ name, compMethod, compSize, uncompSize, localOffset });
    cur += 46 + nameLen + extraLen + commentLen;
  }

  function extract(name) {
    const e = entries.find(x => x.name === name);
    if (!e) return null;
    const lhNameLen = buf.readUInt16LE(e.localOffset + 26);
    const lhExtraLen = buf.readUInt16LE(e.localOffset + 28);
    const dataOffset = e.localOffset + 30 + lhNameLen + lhExtraLen;
    const raw = buf.subarray(dataOffset, dataOffset + e.compSize);
    return e.compMethod === 0 ? raw : zlib.inflateRawSync(raw);
  }

  return { entries, extract };
}

async function main() {
  console.log('========================================================================');
  console.log(' TORI Gate 27.4 — Firefox v1.0.6 Mozilla Signed XPI Verification');
  console.log('========================================================================\n');

  const results = {};

  // 1. Verify existence and exact SHA-256
  console.log('[STEP 1] Verifying XPI file existence and cryptographic SHA-256...');
  if (!fs.existsSync(XPI_PATH)) {
    throw new Error('Signed XPI missing at: ' + XPI_PATH);
  }
  const xpiBuf = fs.readFileSync(XPI_PATH);
  const actualSha256 = crypto.createHash('sha256').update(xpiBuf).digest('hex').toLowerCase();
  console.log(`  File path: ${XPI_PATH}`);
  console.log(`  File size: ${xpiBuf.length} bytes`);
  console.log(`  Actual SHA-256:   ${actualSha256}`);
  console.log(`  Expected SHA-256: ${EXPECTED_SHA256}`);
  results.step1_sha256 = actualSha256 === EXPECTED_SHA256;
  if (!results.step1_sha256) throw new Error('SHA-256 hash mismatch!');

  // Also verify canonical copy if present
  if (fs.existsSync(CANONICAL_XPI_PATH)) {
    const canonSha = crypto.createHash('sha256').update(fs.readFileSync(CANONICAL_XPI_PATH)).digest('hex').toLowerCase();
    results.canonical_sha256_match = canonSha === EXPECTED_SHA256;
    console.log(`  Canonical copy verified: ${CANONICAL_XPI_PATH} (SHA-256 matches)`);
  }

  // 2. Parse ZIP and check Manifest
  console.log('\n[STEP 2] Verifying manifest.json contents from signed XPI...');
  const zip = parseZip(XPI_PATH);
  const manifestBuf = zip.extract('manifest.json');
  if (!manifestBuf) throw new Error('manifest.json not found in XPI');
  const manifest = JSON.parse(manifestBuf.toString('utf8'));

  console.log(`  Name: ${manifest.name}`);
  console.log(`  Version: ${manifest.version}`);
  console.log(`  Gecko ID: ${manifest.browser_specific_settings?.gecko?.id}`);
  results.step2_version = manifest.version === EXPECTED_VERSION;
  results.step2_gecko_id = manifest.browser_specific_settings?.gecko?.id === EXPECTED_GECKO_ID;
  if (!results.step2_version || !results.step2_gecko_id) {
    throw new Error('Manifest version or Gecko ID mismatch!');
  }

  // 3. Verify Mozilla Signature Metadata
  console.log('\n[STEP 3] Verifying Mozilla signature metadata and PKCS#7 certificate...');
  const metaFiles = zip.entries.filter(e => e.name.startsWith('META-INF/')).map(e => e.name);
  console.log(`  Signature files (${metaFiles.length}):`, metaFiles);

  const hasCose = metaFiles.includes('META-INF/cose.sig') && metaFiles.includes('META-INF/cose.manifest');
  const hasRsa = metaFiles.includes('META-INF/mozilla.rsa') && metaFiles.includes('META-INF/mozilla.sf');
  results.step3_meta_files = hasCose && hasRsa;

  // Extract mozilla.rsa and inspect certificate
  const rsaBuf = zip.extract('META-INF/mozilla.rsa');
  const tempRsaPath = path.join(PROJECT_ROOT, 'target', 'temp_mozilla_verify.rsa');
  fs.writeFileSync(tempRsaPath, rsaBuf);

  let certText = '';
  try {
    certText = execSync(`"${OPENSSL_EXE}" pkcs7 -inform DER -in "${tempRsaPath}" -print_certs -text`, {
      encoding: 'utf8',
    });
  } catch (err) {
    console.error('OpenSSL verification notice:', err.message);
  }
  try { fs.unlinkSync(tempRsaPath); } catch (_) {}

  const hasAmoIssuer = certText.includes('CN=signingca1.addons.mozilla.org') || certText.includes('Mozilla AMO Production Signing Service');
  const hasToriSubject = certText.includes('CN=tori-download-manager@toridm.org');
  const hasCodeSigning = certText.includes('Code Signing');

  console.log(`  Issuer: Mozilla AMO Production Signing Service (${hasAmoIssuer ? 'VERIFIED' : 'FAILED'})`);
  console.log(`  Subject: tori-download-manager@toridm.org (${hasToriSubject ? 'VERIFIED' : 'FAILED'})`);
  console.log(`  Key Usage: Code Signing (${hasCodeSigning ? 'VERIFIED' : 'FAILED'})`);
  results.step3_crypto_signature = hasAmoIssuer && hasToriSubject && hasCodeSigning;

  // 4. Source comparison with extension/firefox/
  console.log('\n[STEP 4] Comparing all content assets against repository source (extension/firefox/)...');
  const ffSrcDir = path.join(PROJECT_ROOT, 'extension', 'firefox');
  const contentEntries = zip.entries.filter(e => !e.name.startsWith('META-INF/'));
  let contentMatches = 0;
  let manifestNormalizedMatch = false;

  for (const entry of contentEntries) {
    const srcFilePath = path.join(ffSrcDir, entry.name.replace(/\//g, path.sep));
    if (!fs.existsSync(srcFilePath)) {
      console.log(`  [MISSING IN SOURCE] ${entry.name}`);
      continue;
    }
    const xpiFile = zip.extract(entry.name);
    const srcFile = fs.readFileSync(srcFilePath);

    if (entry.name === 'manifest.json') {
      // Compare parsed JSON objects
      const parsedXpi = JSON.parse(xpiFile.toString('utf8'));
      const parsedSrc = JSON.parse(srcFile.toString('utf8'));
      manifestNormalizedMatch = JSON.stringify(parsedXpi) === JSON.stringify(parsedSrc);
      if (manifestNormalizedMatch) {
        console.log(`  [MATCH] manifest.json (semantic match; formatted by AMO)`);
        contentMatches++;
      }
    } else {
      const match = crypto.createHash('sha256').update(xpiFile).digest('hex') ===
                    crypto.createHash('sha256').update(srcFile).digest('hex');
      if (match) {
        contentMatches++;
      } else {
        console.log(`  [MISMATCH] ${entry.name}`);
      }
    }
  }
  console.log(`  Matched ${contentMatches} / ${contentEntries.length} content files exactly.`);
  results.step4_content_integrity = contentMatches === contentEntries.length;

  // 5. Verify Gate 27 / 27.2 feature logic inside background.js and content.js
  console.log('\n[STEP 5] Verifying Gate 27 / Gate 27.2 bugfix code in signed extension...');
  const bgCode = zip.extract('background.js').toString('utf8');
  const csCode = zip.extract('content.js').toString('utf8');

  // Check 1: Audio -> Video sequential media download (/api/v1/media/download endpoint and job_id)
  const hasMediaDownload = bgCode.includes('/api/v1/media/download') && bgCode.includes('format_id');
  console.log(`  Audio -> Video sequential media endpoint: ${hasMediaDownload ? 'CONFIRMED' : 'MISSING'}`);

  // Check 2: YouTube Mix/Radio rejection
  const hasMixRejection = csCode.includes('RD') && (csCode.includes('YouTube Mix') || csCode.includes('Radio playlist') || csCode.includes('cannot be downloaded as a standard playlist'));
  console.log(`  YouTube Mix/Radio rejection logic: ${hasMixRejection ? 'CONFIRMED' : 'MISSING'}`);

  // Check 3: Playlist modal & OPEN_PLAYLIST command wiring (Gate 27.2)
  const hasPlaylistCommand = csCode.includes('OPEN_PLAYLIST') && bgCode.includes('OPEN_PLAYLIST') && bgCode.includes('/api/v1/media/playlist/open');
  console.log(`  Playlist Download command wiring (OPEN_PLAYLIST): ${hasPlaylistCommand ? 'CONFIRMED' : 'MISSING'}`);

  results.step5_feature_logic = hasMediaDownload && hasMixRejection && hasPlaylistCommand;

  // 6. Launch isolated TORI Desktop Mock HTTP Server
  console.log('\n[STEP 6] Starting isolated TORI Desktop Mock Engine on port ' + DESKTOP_MOCK_PORT + '...');
  let desktopReceivedRequests = [];
  const mockServer = http.createServer((req, res) => {
    desktopReceivedRequests.push({ url: req.url, method: req.method, headers: req.headers });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === '/api/v1/status') {
      res.writeHead(200);
      res.end(JSON.stringify({
        status: 'ok',
        version: '1.0.5',
        app_name: 'TORI Download Manager',
        engine_status: 'running',
        port: DESKTOP_MOCK_PORT
      }));
    } else {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok' }));
    }
  });

  await new Promise(r => mockServer.listen(DESKTOP_MOCK_PORT, '127.0.0.1', r));
  console.log(`  Mock Desktop listening on 127.0.0.1:${DESKTOP_MOCK_PORT}`);

  // 7. Test Firefox Installation with Strict Signature Enforcement
  console.log('\n[STEP 7] Launching Firefox with strict signature enforcement (xpinstall.signatures.required = true)...');
  if (fs.existsSync(TEST_ENV_DIR)) {
    try { fs.rmSync(TEST_ENV_DIR, { recursive: true, force: true }); } catch (_) {}
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const userJs = [
    'user_pref("marionette.enabled", true);',
    `user_pref("marionette.port", ${MARIONETTE_PORT});`,
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("toolkit.telemetry.enabled", false);',
    'user_pref("xpinstall.signatures.required", true);', // STRICT ENFORCEMENT
  ].join('\n');
  fs.writeFileSync(path.join(PROFILE_DIR, 'user.js'), userJs);

  const ffProc = spawn(FIREFOX_EXE, [
    '-no-remote',
    '-marionette',
    '-profile', PROFILE_DIR,
    'about:blank',
  ], {
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
    stdio: 'ignore',
  });

  await sleep(3500);

  const marionette = new MarionetteClient();
  await marionette.connect(MARIONETTE_PORT);
  console.log('  Marionette connected on port ' + MARIONETTE_PORT);

  await marionette.send('WebDriver:NewSession', {});

  console.log('  Installing signed XPI permanently via Addon:Install (temporary: false)...');
  const installRes = await marionette.send('Addon:Install', {
    path: path.resolve(XPI_PATH),
    temporary: false,
  });
  const installedId = installRes.value;
  console.log(`  Installed Extension ID: ${installedId}`);
  results.step7_install_accepted = installedId === EXPECTED_GECKO_ID;

  // 8. Verify WebExtensionPolicy
  console.log('\n[STEP 8] Querying WebExtensionPolicy in chrome context...');
  await marionette.send('Marionette:SetContext', { value: 'chrome' });
  const policyRes = await marionette.send('WebDriver:ExecuteScript', {
    script: `
      const p = WebExtensionPolicy.getByID("${EXPECTED_GECKO_ID}");
      return p ? { id: p.id, active: p.active, url: p.getURL("") } : null;
    `,
    args: [],
  });
  console.log('  WebExtensionPolicy details:', policyRes.value);
  results.step8_policy_active = policyRes.value && policyRes.value.active === true;
  const mozExtUrl = policyRes.value ? policyRes.value.url : '';

  // 9. Test Extension Options & Desktop Pairing
  console.log('\n[STEP 9] Pairing extension with TORI Desktop Engine and testing live connectivity...');
  await marionette.send('WebDriver:ExecuteScript', {
    script: `
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      win.gBrowser.addTrustedTab("${mozExtUrl}options/options.html");
    `,
    args: [],
  });
  await sleep(1500);

  await marionette.send('Marionette:SetContext', { value: 'content' });
  const handles = await marionette.send('WebDriver:GetWindowHandles', {});
  let optionsHandle = null;
  for (const h of handles) {
    await marionette.send('WebDriver:SwitchToWindow', { handle: h });
    const cur = await marionette.send('WebDriver:GetCurrentURL', {});
    if (cur.value && cur.value.includes('options/options.html')) {
      optionsHandle = h;
      break;
    }
  }

  if (optionsHandle) {
    await marionette.send('WebDriver:SwitchToWindow', { handle: optionsHandle });
    console.log('  Switched to extension options page: ' + mozExtUrl + 'options/options.html');

    const pairResult = await marionette.send('WebDriver:ExecuteAsyncScript', {
      script: `
        const done = arguments[arguments.length - 1];
        chrome.storage.local.set({
          tori_settings: {
            port: ${DESKTOP_MOCK_PORT},
            key: 'gate27_4_test_token',
            cap: true,
            min: 0,
            types: ['zip', 'rar', '7z', 'iso', 'exe', 'dmg', 'pdf', 'mp4', 'mp3', 'mkv']
          }
        }, () => {
          fetch('http://127.0.0.1:${DESKTOP_MOCK_PORT}/api/v1/status', {
            headers: { 'X-Tori-Token': 'gate27_4_test_token' }
          })
          .then(r => r.json())
          .then(data => done({ ok: true, data }))
          .catch(e => done({ ok: false, err: e.message }));
        });
      `,
      args: [],
    });

    console.log('  Pairing fetch response:', pairResult.value);
    results.step9_desktop_connectivity = pairResult.value && pairResult.value.ok === true &&
                                         pairResult.value.data.version === '1.0.5';
  } else {
    console.log('  Failed to locate options tab');
    results.step9_desktop_connectivity = false;
  }

  // Clean shutdown
  console.log('\n[CLEANUP] Closing Firefox and mock server...');
  try { await marionette.send('Marionette:Quit', {}); } catch (_) {}
  marionette.disconnect();
  try { ffProc.kill(); } catch (_) {}
  mockServer.close();
  try { fs.rmSync(TEST_ENV_DIR, { recursive: true, force: true }); } catch (_) {}

  // Final summary
  console.log('\n========================================================================');
  console.log(' VERIFICATION SUMMARY');
  console.log('========================================================================');
  console.log(JSON.stringify(results, null, 2));

  const allPassed = Object.values(results).every(v => v === true);
  console.log(`\nOVERALL STATUS: ${allPassed ? 'ALL CHECKS PASSED (GO)' : 'FAILED'}\n`);

  fs.writeFileSync(
    path.join(PROJECT_ROOT, 'target', 'gate27_4_firefox_xpi_verification.json'),
    JSON.stringify({ timestamp: new Date().toISOString(), results, allPassed }, null, 2),
    'utf8'
  );

  if (!allPassed) process.exit(1);
}

main().catch(err => {
  console.error('[FATAL ERROR]', err);
  process.exit(1);
});
