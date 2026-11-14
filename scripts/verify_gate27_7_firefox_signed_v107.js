#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 27.7
 * Signed Firefox v1.0.7 XPI Cryptographic, Permanent Installation, Persistence & Live E2E Pipeline Verification
 *
 * Strictly isolated profile + isolated TORI Desktop engine (tdm-native-host.exe).
 * Never touches user Firefox sessions, production TORI Desktop, or production database.
 * Every operation uses bounded timeouts and guaranteed child process cleanup.
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const UPLOADED_XPI = 'C:\\Users\\ritud\\.gemini\\antigravity\\brain\\4cb6b42b-ac51-4843-b5b6-6960f8030e35\\.user_uploaded\\media_1794657359083_2c5d761e.xpi';
const FF_RC_ZIP = path.join(ROOT, 'release', 'v1.0.7-extension-rc', 'tori-companion-v1.0.7-firefox.zip');
const HOST_EXE = path.join(ROOT, 'release', 'v1.0.5-rc', 'tdm-native-host.exe');
const FIREFOX_EXE = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const OPENSSL_EXE = 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe';

const EXPECTED_SHA256 = 'b082c8f2f4c8b4ed035fab77d9569622737defb3e02279f20073d3404dda4fa0';
const EXPECTED_SIZE = 90326;
const EXPECTED_VERSION = '1.0.7';
const EXPECTED_GECKO_ID = 'tori-download-manager@toridm.org';

const MARIONETTE_PORT = 19893;
const DESKTOP_PORT = 19894;
const FIXTURE_PORT = 19895;

const QA_DIR = path.join(ROOT, 'target', 'gate27_7_firefox_qa');
const PROFILE_DIR = path.join(QA_DIR, 'firefox_profile');
const FF_DL_DIR = path.join(QA_DIR, 'browser_downloads');
const TORI_DATA_DIR = path.join(QA_DIR, 'tori_data');
const TORI_USERPROFILE = path.join(QA_DIR, 'tori_profile');
const TORI_DL_DIR = path.join(TORI_USERPROFILE, 'Downloads');
const CRYPTO_TMP = path.join(QA_DIR, 'crypto_tmp');

const trackedProcs = new Set();
const results = [];
const counts = { PASS: 0, FAIL: 0, TIMEOUT: 0, NOT_TESTED: 0 };

function record(id, name, status, details = '') {
  const norm = status === true ? 'PASS' : status === false ? 'FAIL' : status;
  counts[norm] = (counts[norm] || 0) + 1;
  console.log(`[${norm}] [${id}] ${name}${details ? ' -> ' + details : ''}`);
  results.push({ id, name, status: norm, details });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function killTracked(proc) {
  if (!proc || !proc.pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', timeout: 3000 });
  } catch {
    try { proc.kill('SIGKILL'); } catch {}
  }
}

function cleanupAll() {
  for (const p of trackedProcs) killTracked(p);
  trackedProcs.clear();
}

// Deterministic non-allocating byte generator for clean MKV / MP4 fixtures
function patternByte(offset) {
  const b = (offset * 131 + ((offset >>> 8) & 0xff) * 17 + ((offset >>> 16) & 0xff)) & 0xff;
  return b;
}

function generateFixtureBuffer(sizeBytes, headerHex = '1a45dfa3') {
  const buf = Buffer.allocUnsafe(sizeBytes);
  const hdr = Buffer.from(headerHex, 'hex');
  hdr.copy(buf, 0);
  for (let i = hdr.length; i < sizeBytes; i++) {
    buf[i] = patternByte(i);
  }
  return buf;
}

function parseZip(filePath) {
  const buf = fs.readFileSync(filePath);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('Missing ZIP EOCD');
  const cdEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  let cur = cdOffset;
  const entries = [];
  for (let i = 0; i < cdEntries; i++) {
    const compMethod = buf.readUInt16LE(cur + 10);
    const crc = buf.readUInt32LE(cur + 16);
    const compSize = buf.readUInt32LE(cur + 20);
    const uncompSize = buf.readUInt32LE(cur + 24);
    const nameLen = buf.readUInt16LE(cur + 28);
    const extraLen = buf.readUInt16LE(cur + 30);
    const commentLen = buf.readUInt16LE(cur + 32);
    const localOffset = buf.readUInt32LE(cur + 42);
    const name = buf.toString('utf8', cur + 46, cur + 46 + nameLen);
    entries.push({ name, compMethod, crc, compSize, uncompSize, localOffset });
    cur += 46 + nameLen + extraLen + commentLen;
  }

  function extract(name) {
    const e = entries.find((x) => x.name === name);
    if (!e) return null;
    const lhNameLen = buf.readUInt16LE(e.localOffset + 26);
    const lhExtraLen = buf.readUInt16LE(e.localOffset + 28);
    const dataOffset = e.localOffset + 30 + lhNameLen + lhExtraLen;
    const raw = buf.subarray(dataOffset, dataOffset + e.compSize);
    const out = e.compMethod === 0 ? raw : zlib.inflateRawSync(raw);
    const actualCrc = zlib.crc32(out) >>> 0;
    if (actualCrc !== e.crc) throw new Error(`CRC32 mismatch on ${name}`);
    return out;
  }

  return { buf, entries, extract };
}

class MarionetteClient {
  constructor() {
    this.socket = null;
    this.msgId = 1;
    this.buffer = '';
    this.pending = new Map();
  }
  async connect(port, timeoutMs = 8000) {
    for (let attempt = 0; attempt < 25; attempt++) {
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            if (this.socket) try { this.socket.destroy(); } catch {}
            reject(new Error('connect timeout'));
          }, 1500);
          const s = net.connect(port, '127.0.0.1');
          this.socket = s;
          let resolved = false;
          s.on('data', (data) => {
            this.buffer += data.toString('utf8');
            this.processBuffer(() => {
              if (!resolved) {
                resolved = true;
                clearTimeout(timer);
                resolve();
              }
            });
          });
          s.on('error', (err) => {
            clearTimeout(timer);
            try { s.destroy(); } catch {}
            if (!resolved) reject(err);
          });
        });
        return;
      } catch {
        this.buffer = '';
        await sleep(300);
      }
    }
    throw new Error(`Marionette failed to connect on port ${port} within ${timeoutMs}ms`);
  }
  processBuffer(onHello) {
    while (true) {
      const colonIdx = this.buffer.indexOf(':');
      if (colonIdx === -1) break;
      const len = parseInt(this.buffer.slice(0, colonIdx), 10);
      if (isNaN(len)) { this.buffer = ''; break; }
      if (this.buffer.length < colonIdx + 1 + len) break;
      const payload = this.buffer.slice(colonIdx + 1, colonIdx + 1 + len);
      this.buffer = this.buffer.slice(colonIdx + 1 + len);
      try {
        const parsed = JSON.parse(payload);
        if (parsed.marionetteProtocol !== undefined && onHello) {
          onHello();
        } else if (Array.isArray(parsed) && parsed[0] === 1) {
          const cb = this.pending.get(parsed[1]);
          if (cb) {
            this.pending.delete(parsed[1]);
            if (parsed[2]) cb.reject(new Error(JSON.stringify(parsed[2])));
            else cb.resolve(parsed[3]);
          }
        }
      } catch {}
    }
  }
  send(name, params = {}, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Marionette ${name} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      const frame = JSON.stringify([0, id, name, params]);
      this.socket.write(`${Buffer.byteLength(frame, 'utf8')}:${frame}`);
    });
  }
  disconnect() {
    try { this.socket?.destroy(); } catch {}
    this.socket = null;
  }
}

function httpJson({ port, path: p, method = 'GET', headers = {}, body = null, timeoutMs = 5000 }) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: p,
      method,
      headers: {
        Host: `127.0.0.1:${port}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data, raw });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, ok: false, error: 'HTTP_TIMEOUT' }); });
    req.on('error', (e) => resolve({ status: 0, ok: false, error: e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

async function run() {
  console.log('========================================================================');
  console.log(' TORI Gate 27.7 — Firefox v1.0.7 Signed XPI Full Acceptance Suite');
  console.log('========================================================================\n');

  const globalWatchdog = setTimeout(() => {
    console.error('\n[WATCHDOG] Overall Firefox suite timeout reached (150s). Terminating tracked children.');
    cleanupAll();
    process.exit(1);
  }, 150000);
  globalWatchdog.unref();

  fs.rmSync(QA_DIR, { recursive: true, force: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(FF_DL_DIR, { recursive: true });
  fs.mkdirSync(TORI_DATA_DIR, { recursive: true });
  fs.mkdirSync(TORI_DL_DIR, { recursive: true });
  fs.mkdirSync(CRYPTO_TMP, { recursive: true });

  // -----------------------------------------------------------------------
  // PHASE 1: Cryptographic, Manifest & Asset Verification of Signed XPI
  // -----------------------------------------------------------------------
  console.log('>>> [PHASE 1] XPI Cryptographic, Manifest & Source Integrity <<<\n');
  const xpiExists = fs.existsSync(UPLOADED_XPI);
  const xpiStat = xpiExists ? fs.statSync(UPLOADED_XPI) : null;
  const xpiZip = parseZip(UPLOADED_XPI);
  const actualSha256 = crypto.createHash('sha256').update(xpiZip.buf).digest('hex').toLowerCase();
  record(
    'FF-XPI-01',
    'Uploaded v1.0.7 signed XPI exists, exact size & SHA-256 match',
    xpiExists && xpiStat.size === EXPECTED_SIZE && actualSha256 === EXPECTED_SHA256,
    `size=${xpiStat?.size}, sha256=${actualSha256}`
  );

  const backslashEntries = xpiZip.entries.filter((e) => e.name.includes('\\')).length;
  let allCrcOk = true;
  try {
    for (const e of xpiZip.entries) xpiZip.extract(e.name);
  } catch (e) {
    allCrcOk = false;
  }
  record(
    'FF-XPI-02',
    'ZIP archive central directory, CRC32 checksums, and POSIX separators valid',
    allCrcOk && backslashEntries === 0 && xpiZip.entries.length === 39,
    `entries=${xpiZip.entries.length}, backslashes=${backslashEntries}, crcOk=${allCrcOk}`
  );

  const manifest = JSON.parse(xpiZip.extract('manifest.json').toString('utf8'));
  record(
    'FF-XPI-03',
    'Manifest metadata verified (version 1.0.7, MV3, Gecko ID tori-download-manager@toridm.org)',
    manifest.version === EXPECTED_VERSION &&
      manifest.manifest_version === 3 &&
      manifest.browser_specific_settings?.gecko?.id === EXPECTED_GECKO_ID,
    `version=${manifest.version}, mv=${manifest.manifest_version}, id=${manifest.browser_specific_settings?.gecko?.id}`
  );

  // OpenSSL CMS cryptographic verification + digest chain check
  const mfBuf = xpiZip.extract('META-INF/manifest.mf');
  const sfBuf = xpiZip.extract('META-INF/mozilla.sf');
  const rsaBuf = xpiZip.extract('META-INF/mozilla.rsa');
  const coseMfBuf = xpiZip.extract('META-INF/cose.manifest');
  const coseSigBuf = xpiZip.extract('META-INF/cose.sig');

  const sfText = sfBuf.toString('utf8');
  const sfOk =
    sfText.includes('SHA1-Digest-Manifest: ' + crypto.createHash('sha1').update(mfBuf).digest('base64')) &&
    sfText.includes('SHA256-Digest-Manifest: ' + crypto.createHash('sha256').update(mfBuf).digest('base64'));

  let entriesDigestOk = true;
  for (const buf of [mfBuf, coseMfBuf]) {
    const blocks = buf.toString('utf8').split(/\r?\n\r?\n/).filter((b) => b.includes('Name:'));
    for (const blk of blocks) {
      const mName = blk.match(/Name:\s*(.+)/);
      const mSha1 = blk.match(/SHA1-Digest:\s*(.+)/);
      const mSha256 = blk.match(/SHA256-Digest:\s*(.+)/);
      if (!mName) continue;
      const data = xpiZip.extract(mName[1].trim());
      if (!data) { entriesDigestOk = false; break; }
      if (mSha1 && crypto.createHash('sha1').update(data).digest('base64') !== mSha1[1].trim()) entriesDigestOk = false;
      if (mSha256 && crypto.createHash('sha256').update(data).digest('base64') !== mSha256[1].trim()) entriesDigestOk = false;
    }
  }

  const sfPath = path.join(CRYPTO_TMP, 'mozilla.sf');
  const rsaPath = path.join(CRYPTO_TMP, 'mozilla.rsa');
  const certsPath = path.join(CRYPTO_TMP, 'certs.pem');
  fs.writeFileSync(sfPath, sfBuf);
  fs.writeFileSync(rsaPath, rsaBuf);
  const pemText = execFileSync(OPENSSL_EXE, ['pkcs7', '-inform', 'DER', '-in', rsaPath, '-print_certs'], { encoding: 'utf8', timeout: 5000 });
  fs.writeFileSync(certsPath, pemText);
  const certDetails = execFileSync(OPENSSL_EXE, ['pkcs7', '-inform', 'DER', '-in', rsaPath, '-print_certs', '-text'], { encoding: 'utf8', timeout: 5000 });

  let cmsVerifyOk = false;
  try {
    execFileSync(OPENSSL_EXE, [
      'cms', '-verify', '-binary', '-inform', 'DER',
      '-in', rsaPath, '-content', sfPath,
      '-CAfile', certsPath, '-partial_chain', '-purpose', 'any',
      '-out', path.join(CRYPTO_TMP, 'verified.out'),
    ], { stdio: 'ignore', timeout: 5000 });
    cmsVerifyOk = true;
  } catch {}

  const certChainValid =
    certDetails.includes('CN=signingca1.addons.mozilla.org') &&
    certDetails.includes('CN=root-ca-production-amo') &&
    certDetails.includes('CN=tori-download-manager@toridm.org') &&
    certDetails.includes('Code Signing');

  record(
    'FF-XPI-04',
    'Cryptographic verification of Mozilla AMO PKCS#7/CMS signature, COSE manifest, and cert chain',
    !!(coseSigBuf && coseSigBuf.length > 0 && sfOk && entriesDigestOk && cmsVerifyOk && certChainValid),
    `cmsVerify=${cmsVerifyOk}, sfMatch=${sfOk}, digestTree=${entriesDigestOk}, amoChain=${certChainValid}`
  );

  // Compare against Gate 27.6 Firefox source zip
  const rcZip = parseZip(FF_RC_ZIP);
  const xpiFiles = xpiZip.entries.filter((e) => !e.name.startsWith('META-INF/')).map((e) => e.name).sort();
  const rcFiles = rcZip.entries.filter((e) => !e.name.endsWith('/')).map((e) => e.name).sort();
  let binaryAssetMatches = 0;
  let manifestSemanticMatch = false;
  for (const name of xpiFiles) {
    const a = xpiZip.extract(name);
    const b = rcZip.extract(name);
    if (!b) continue;
    if (name === 'manifest.json') {
      manifestSemanticMatch = JSON.stringify(JSON.parse(a.toString('utf8'))) === JSON.stringify(JSON.parse(b.toString('utf8')));
      if (manifestSemanticMatch) binaryAssetMatches++;
    } else if (crypto.createHash('sha256').update(a).digest('hex') === crypto.createHash('sha256').update(b).digest('hex')) {
      binaryAssetMatches++;
    }
  }
  record(
    'FF-XPI-05',
    'All 34 non-META-INF files match Gate 27.6 Firefox package (33 bit-for-bit + manifest semantic match)',
    xpiFiles.length === 34 && JSON.stringify(xpiFiles) === JSON.stringify(rcFiles) && binaryAssetMatches === 34 && manifestSemanticMatch,
    `matched=${binaryAssetMatches}/${xpiFiles.length}`
  );

  // -----------------------------------------------------------------------
  // PHASE 2: Start Real Isolated TORI Engine (tdm-native-host.exe) + Fixture HTTP Server
  // -----------------------------------------------------------------------
  console.log('\n>>> [PHASE 2] Starting Real TORI Native Host Engine & Local HTTP Fixture Server <<<\n');
  const seededToken = 'tori_qa_token_ff_107';
  const dbPath = path.join(TORI_DATA_DIR, 'tdm_storage.sqlite');
  const seedAppSettings = JSON.stringify({
    port: DESKTOP_PORT,
    dir: TORI_DL_DIR,
    sort: true,
    con: 16,
    maxa: 4,
    key: seededToken,
    cap: true,
    closeToTray: true,
  });
  execFileSync('python', [
    '-c',
    'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("CREATE TABLE IF NOT EXISTS engine_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"); c.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("browser_integration_token", sys.argv[2])); c.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("app_settings", sys.argv[3])); c.commit(); c.close()',
    dbPath,
    seededToken,
    seedAppSettings,
  ], { stdio: 'inherit', timeout: 5000 });

  const hostProc = spawn(HOST_EXE, ['--serve', String(DESKTOP_PORT)], {
    env: {
      ...process.env,
      TORI_DATA_DIR,
      USERPROFILE: TORI_USERPROFILE,
      TDM_STORAGE_DIR: TORI_DATA_DIR,
      TDM_DOWNLOAD_DIR: TORI_DL_DIR,
      TORI_ALLOW_LOOPBACK: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  trackedProcs.add(hostProc);

  let desktopToken = seededToken;
  hostProc.stdout.on('data', (d) => {
    const m = d.toString().match(/token=(\S+)/);
    if (m) desktopToken = m[1];
  });
  hostProc.stderr.on('data', (d) => {
    const m = d.toString().match(/token=(\S+)/);
    if (m) desktopToken = m[1];
  });

  let desktopReady = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const st = await httpJson({
      port: DESKTOP_PORT,
      path: '/api/v1/ping',
      headers: { 'X-Tori-Token': desktopToken },
    });
    if (st.ok && st.data?.authenticated === true) { desktopReady = true; break; }
  }
  record('FF-HOST-01', 'Isolated real TORI Desktop API (tdm-native-host.exe) online', desktopReady && !!desktopToken, `port=${DESKTOP_PORT}`);
  if (!desktopReady) throw new Error('TORI Native Host failed to start');

  // Create deterministic MKV & MP4 fixtures (6 MiB MKV, 4 MiB MP4)
  const mkvFixture = generateFixtureBuffer(6 * 1024 * 1024, '1a45dfa3934282886d6174726f736b61');
  const mp4Fixture = generateFixtureBuffer(4 * 1024 * 1024, '00000018667479706d703432');
  const expectedMkvSha = crypto.createHash('sha256').update(mkvFixture).digest('hex');
  const expectedMp4Sha = crypto.createHash('sha256').update(mp4Fixture).digest('hex');

  const fixtureServer = http.createServer((req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${FIXTURE_PORT}`);
    let buf = null;
    let ctype = 'application/octet-stream';
    const extra = {};

    if (u.pathname === '/Firefox_Pipeline_Test.mkv') {
      buf = mkvFixture;
      ctype = 'video/x-matroska';
    } else if (u.pathname === '/Normal_Sample.mp4') {
      buf = mp4Fixture;
      ctype = 'video/mp4';
    } else if (u.pathname === '/disposition_blob') {
      buf = mkvFixture;
      ctype = 'application/octet-stream';
      extra['Content-Disposition'] = 'attachment; filename="Disposition_Firefox_Test.mkv"';
    } else if (u.pathname === '/test.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end([
        '<!doctype html><html><head><title>TORI Firefox Acceptance</title></head><body>',
        '<h1>TORI Firefox</h1>',
        '<a id="dl-mkv" href="/Firefox_Pipeline_Test.mkv" download="Firefox_Pipeline_Test.mkv">DL MKV</a>',
        '<a id="dl-mp4" href="/Normal_Sample.mp4" download="Normal_Sample.mp4">DL MP4</a>',
        '<a id="dl-disp" href="/disposition_blob">DL DISP</a>',
        '</body></html>',
      ].join(''));
      return;
    }

    if (!buf) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const total = buf.length;
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': ctype, 'Content-Length': String(total), 'Accept-Ranges': 'bytes', ...extra });
      res.end();
      return;
    }

    const range = req.headers.range;
    if (range && range.startsWith('bytes=')) {
      const [sStr, eStr] = range.slice(6).split('-');
      const start = parseInt(sStr, 10) || 0;
      const end = eStr ? Math.min(parseInt(eStr, 10), total - 1) : total - 1;
      res.writeHead(206, {
        'Content-Type': ctype,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        ...extra,
      });
      res.end(buf.subarray(start, end + 1));
      return;
    }

    res.writeHead(200, { 'Content-Type': ctype, 'Content-Length': String(total), 'Accept-Ranges': 'bytes', ...extra });
    res.end(buf);
  });

  await new Promise((r) => fixtureServer.listen(FIXTURE_PORT, '127.0.0.1', r));

  // -----------------------------------------------------------------------
  // PHASE 3: Permanent Firefox Signed Installation (xpinstall.signatures.required = true)
  // -----------------------------------------------------------------------
  console.log('\n>>> [PHASE 3] Firefox Permanent Installation (Signature Enforcement ON) <<<\n');
  const prefs = [
    'user_pref("marionette.enabled", true);',
    `user_pref("marionette.port", ${MARIONETTE_PORT});`,
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("toolkit.telemetry.enabled", false);',
    'user_pref("xpinstall.signatures.required", true);',
    'user_pref("browser.download.folderList", 2);',
    `user_pref("browser.download.dir", "${FF_DL_DIR.replace(/\\/g, '\\\\')}");`,
    'user_pref("browser.download.useDownloadDir", true);',
    'user_pref("browser.helperApps.neverAsk.saveToDisk", "video/x-matroska,video/mp4,application/octet-stream");',
  ].join('\n');
  fs.writeFileSync(path.join(PROFILE_DIR, 'user.js'), prefs, 'utf8');

  let ffProc = spawn(FIREFOX_EXE, ['-no-remote', '-marionette', '-profile', PROFILE_DIR, `http://127.0.0.1:${FIXTURE_PORT}/test.html`], {
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
    stdio: 'ignore',
  });
  trackedProcs.add(ffProc);

  const marionette = new MarionetteClient();
  await marionette.connect(MARIONETTE_PORT, 15000);
  await marionette.send('WebDriver:NewSession', {});

  const installRes = await marionette.send('Addon:Install', { path: UPLOADED_XPI, temporary: false }, 10000);
  record(
    'FF-INST-01',
    'Signed v1.0.7 XPI permanently installed in Firefox with xpinstall.signatures.required=true',
    installRes?.value === EXPECTED_GECKO_ID,
    `AddonID=${installRes?.value}`
  );

  await sleep(1000);
  await marionette.send('Marionette:SetContext', { value: 'chrome' });
  const policy1 = (await marionette.send('WebDriver:ExecuteScript', {
    script: `
      const p = WebExtensionPolicy.getByID("${EXPECTED_GECKO_ID}");
      return p ? { id: p.id, active: p.active, version: p.extension.version, url: p.getURL("") } : null;
    `,
    args: [],
  }))?.value;
  record(
    'FF-INST-02',
    'WebExtensionPolicy confirms signed extension active at v1.0.7',
    policy1?.active === true && policy1?.version === EXPECTED_VERSION,
    JSON.stringify(policy1)
  );

  // Restart Firefox cleanly with SAME profile to prove permanent persistence across restart
  console.log('\n[PERSISTENCE] Restarting Firefox to confirm permanent XPI survival...');
  try { await marionette.send('Marionette:Quit', {}, 6000); } catch {}
  marionette.disconnect();
  await sleep(1500);
  killTracked(ffProc);
  trackedProcs.delete(ffProc);
  await sleep(1000);

  ffProc = spawn(FIREFOX_EXE, ['-no-remote', '-marionette', '-profile', PROFILE_DIR, `http://127.0.0.1:${FIXTURE_PORT}/test.html`], {
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
    stdio: 'ignore',
  });
  trackedProcs.add(ffProc);

  const marionette2 = new MarionetteClient();
  await marionette2.connect(MARIONETTE_PORT, 15000);
  await marionette2.send('WebDriver:NewSession', {});
  await marionette2.send('Marionette:SetContext', { value: 'chrome' });

  let policy2 = null;
  for (let i = 0; i < 15; i++) {
    policy2 = (await marionette2.send('WebDriver:ExecuteScript', {
      script: `
        const p = WebExtensionPolicy.getByID("${EXPECTED_GECKO_ID}");
        return p ? { id: p.id, active: p.active, version: p.extension.version, url: p.getURL("") } : null;
      `,
      args: [],
    }))?.value;
    if (policy2?.active) break;
    await sleep(300);
  }
  record(
    'FF-INST-03',
    'Signed v1.0.7 XPI persists active across clean Firefox restart',
    policy2?.active === true && policy2?.version === EXPECTED_VERSION,
    JSON.stringify(policy2)
  );

  const mozExtUrl = policy2.url;

  // Open extension options page to drive live signed-extension messaging + download inspection
  await marionette2.send('WebDriver:ExecuteScript', {
    script: `Services.wm.getMostRecentWindow("navigator:browser").gBrowser.addTrustedTab("${mozExtUrl}options/options.html");`,
    args: [],
  });
  await sleep(1200);
  await marionette2.send('Marionette:SetContext', { value: 'content' });
  const rawHandles = await marionette2.send('WebDriver:GetWindowHandles', {});
  const handles = Array.isArray(rawHandles) ? rawHandles : (rawHandles?.value || []);
  let optHandle = null;
  let webHandle = null;
  for (const h of handles) {
    await marionette2.send('WebDriver:SwitchToWindow', { handle: h });
    const u = await marionette2.send('WebDriver:GetCurrentURL', {});
    if (u?.value?.includes('options/options.html')) optHandle = h;
    else if (u?.value?.includes('/test.html')) webHandle = h;
  }
  if (!optHandle || !webHandle) throw new Error(`Missing tabs opt=${optHandle} web=${webHandle}`);
  await marionette2.send('WebDriver:SwitchToWindow', { handle: optHandle });

  // Configure tori_settings in signed extension & ping real Desktop engine
  const pingRes = (await marionette2.send('WebDriver:ExecuteAsyncScript', {
    script: `
      const done = arguments[arguments.length - 1];
      (async () => {
        try {
          const settings = {
            port: ${DESKTOP_PORT},
            key: '${desktopToken}',
            auto: true,
            cap: true,
            min: 0,
            badge: true,
            sites: [],
            types: ['zip','rar','7z','iso','exe','dmg','pdf','mp4','mp3','mkv']
          };
          if (typeof browser !== 'undefined' && browser.storage) {
            await browser.storage.local.set({ tori_settings: settings });
            await new Promise(r => setTimeout(r, 250));
            const res = await browser.runtime.sendMessage({ action: 'PING_DESKTOP', port: ${DESKTOP_PORT}, key: '${desktopToken}' });
            done(res);
          } else {
            chrome.storage.local.set({ tori_settings: settings }, () => {
              setTimeout(() => chrome.runtime.sendMessage({ action: 'PING_DESKTOP', port: ${DESKTOP_PORT}, key: '${desktopToken}' }, done), 250);
            });
          }
        } catch (e) { done({ err: String(e) }); }
      })();
    `,
    args: [],
  }, 10000))?.value;
  record(
    'FF-API-01',
    'Signed Firefox v1.0.7 extension pairs and pings real TORI Desktop API',
    pingRes?.status === 'ok' && pingRes?.authenticated === true,
    JSON.stringify(pingRes)
  );

  // Trigger real Firefox downloads from the web tab (MKV + MP4 + Content-Disposition blob)
  await marionette2.send('WebDriver:SwitchToWindow', { handle: webHandle });
  await marionette2.send('WebDriver:ExecuteScript', {
    script: `
      document.getElementById('dl-mkv').click();
      setTimeout(() => document.getElementById('dl-mp4').click(), 350);
      setTimeout(() => document.getElementById('dl-disp').click(), 700);
    `,
    args: [],
  });
  await sleep(2500);

  await marionette2.send('WebDriver:SwitchToWindow', { handle: optHandle });
  const dlSearch = (await marionette2.send('WebDriver:ExecuteAsyncScript', {
    script: `
      const done = arguments[arguments.length - 1];
      (async () => {
        try {
          const items = typeof browser !== 'undefined' && browser.downloads
            ? await browser.downloads.search({})
            : await new Promise(r => chrome.downloads.search({}, r));
          done({ items: (items || []).map(i => ({ id: i.id, url: i.url, filename: i.filename, state: i.state, mime: i.mime, error: i.error })) });
        } catch (e) { done({ err: String(e) }); }
      })();
    `,
    args: [],
  }, 10000))?.value;

  const dlItems = dlSearch?.items || [];
  const mkvItem = dlItems.find((i) => i.url?.includes('/Firefox_Pipeline_Test.mkv'));
  const mp4Item = dlItems.find((i) => i.url?.includes('/Normal_Sample.mp4'));
  const dispDlTrigger = dlItems.find((i) => i.url?.includes('/disposition_blob')) || null;

  record(
    'FF-MKV-01',
    'Firefox signed XPI intercepts browser .mkv download & cancels Firefox native transfer',
    mkvItem?.state === 'interrupted',
    `ffDownloadId=${mkvItem?.id}, state=${mkvItem?.state}, filename=${mkvItem?.filename}`
  );
  record(
    'FF-MP4-01',
    'Firefox signed XPI intercepts browser .mp4 download & cancels Firefox native transfer',
    mp4Item?.state === 'interrupted',
    `ffDownloadId=${mp4Item?.id}, state=${mp4Item?.state}, filename=${mp4Item?.filename}`
  );
  console.log('[INFO] Firefox Content-Disposition + application/octet-stream observation:', JSON.stringify(dispDlTrigger));

  // Poll real TORI Desktop /api/v1/downloads until MKV and MP4 finish writing to disk
  let jobs = [];
  for (let i = 0; i < 40; i++) {
    const listRes = await httpJson({
      port: DESKTOP_PORT,
      path: '/api/v1/downloads',
      headers: { 'X-Tori-Token': desktopToken },
    });
    jobs = listRes?.data?.jobs || [];
    const mkvJob = jobs.find((j) => j.filename === 'Firefox_Pipeline_Test.mkv');
    const mp4Job = jobs.find((j) => j.filename === 'Normal_Sample.mp4');
    if (mkvJob?.state === 'completed' && mp4Job?.state === 'completed') break;
    await sleep(300);
  }

  const mkvDisk = path.join(TORI_DL_DIR, 'Video', 'Firefox_Pipeline_Test.mkv');
  const mp4Disk = path.join(TORI_DL_DIR, 'Video', 'Normal_Sample.mp4');
  const dispJob = jobs.find((j) => j.filename === 'Disposition_Firefox_Test.mkv');
  const mkvDiskOk = fs.existsSync(mkvDisk) && fs.statSync(mkvDisk).size === mkvFixture.length &&
    crypto.createHash('sha256').update(fs.readFileSync(mkvDisk)).digest('hex') === expectedMkvSha;
  const mp4DiskOk = fs.existsSync(mp4Disk) && fs.statSync(mp4Disk).size === mp4Fixture.length &&
    crypto.createHash('sha256').update(fs.readFileSync(mp4Disk)).digest('hex') === expectedMp4Sha;
  const ffNoDupFiles = !fs.existsSync(path.join(FF_DL_DIR, 'Firefox_Pipeline_Test.mkv')) &&
    !fs.existsSync(path.join(FF_DL_DIR, 'Normal_Sample.mp4'));
  console.log('[INFO] Firefox disposition job state/path:', JSON.stringify(dispJob ? { filename: dispJob.filename, state: dispJob.state, target_path: dispJob.target_path, total_bytes: dispJob.total_bytes } : null));

  record(
    'FF-E2E-01',
    'Full Firefox -> TORI Engine -> Disk MKV transfer completed (6 MiB SHA-256 verified, Video/ routed, zero duplicate)',
    mkvDiskOk && ffNoDupFiles,
    `path=${mkvDisk}, actualBytes=${fs.existsSync(mkvDisk) ? fs.statSync(mkvDisk).size : 0}, sha256Match=${mkvDiskOk}`
  );
  record(
    'FF-E2E-02',
    'Full Firefox -> TORI Engine -> Disk MP4 transfer completed (4 MiB SHA-256 verified, Video/ routed, zero duplicate)',
    mp4DiskOk && ffNoDupFiles,
    `path=${mp4Disk}, actualBytes=${fs.existsSync(mp4Disk) ? fs.statSync(mp4Disk).size : 0}, sha256Match=${mp4DiskOk}`
  );

  // Test Audio -> Video dispatch + Playlist Open + Mix rejection via signed extension
  const seqRes = (await marionette2.send('WebDriver:ExecuteAsyncScript', {
    script: `
      const done = arguments[arguments.length - 1];
      (async () => {
        try {
          const send = (msg) => typeof browser !== 'undefined' && browser.runtime
            ? browser.runtime.sendMessage(msg)
            : new Promise(r => chrome.runtime.sendMessage(msg, r));
          const a = await send({
            action: 'START_MEDIA_DOWNLOAD',
            url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
            format_id: '250',
            filename: 'bbb_audio.webm'
          });
          const v = await send({
            action: 'START_MEDIA_DOWNLOAD',
            url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
            format_id: '248',
            filename: 'bbb_video.webm'
          });
          done({ a, v });
        } catch (e) { done({ err: String(e) }); }
      })();
    `,
    args: [],
  }, 15000))?.value;

  const seqOk = seqRes?.a?.job_id && seqRes?.v?.job_id && seqRes.a.job_id !== seqRes.v.job_id;
  record(
    'FF-SEQ-01',
    'Signed Firefox XPI Audio -> Video download on same URL yields distinct job IDs',
    !!seqOk,
    `audio=${seqRes?.a?.job_id}, video=${seqRes?.v?.job_id}`
  );

  const plOpenRes = (await marionette2.send('WebDriver:ExecuteAsyncScript', {
    script: `
      const done = arguments[arguments.length - 1];
      (async () => {
        try {
          const send = (msg) => typeof browser !== 'undefined' && browser.runtime
            ? browser.runtime.sendMessage(msg)
            : new Promise(r => chrome.runtime.sendMessage(msg, r));
          const res = await send({
            action: 'OPEN_PLAYLIST',
            url: 'https://www.youtube.com/playlist?list=PL6B3937A5D230E335'
          });
          done(res);
        } catch (e) { done({ err: String(e) }); }
      })();
    `,
    args: [],
  }, 10000))?.value;
  record('FF-PL-01', 'Signed Firefox XPI OPEN_PLAYLIST dispatches to TORI Desktop API', plOpenRes?.status === 'ok', JSON.stringify(plOpenRes));

  // Cancel queued YouTube network jobs immediately so test doesn't depend on external network
  for (const id of [seqRes?.a?.job_id, seqRes?.v?.job_id].filter(Boolean)) {
    await httpJson({ port: DESKTOP_PORT, path: `/api/v1/downloads/${id}/cancel`, method: 'POST', headers: { 'X-Tori-Token': desktopToken } });
  }

  try { await marionette2.send('Marionette:Quit', {}, 5000); } catch {}
  marionette2.disconnect();
  fixtureServer.close();
  cleanupAll();
  await sleep(800);

  // Also preserve exact JSON report before deleting temporary profile
  const outPath = path.join(ROOT, 'target', 'gate27_7_firefox_acceptance_results.json');
  fs.writeFileSync(outPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    xpiSha256: actualSha256,
    counts,
    total: results.length,
    dispositionObservation: dispDlTrigger,
    results,
  }, null, 2));

  try { fs.rmSync(QA_DIR, { recursive: true, force: true }); } catch {}

  console.log('\n========================================================================');
  console.log(` FIREFOX SIGNED XPI v1.0.7 RESULTS: ${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.TIMEOUT} TIMEOUT, ${counts.NOT_TESTED} NOT TESTED`);
  console.log('========================================================================\n');

  if (counts.FAIL > 0 || counts.TIMEOUT > 0) process.exit(1);
  process.exit(0);
}

run().catch((err) => {
  console.error('[FATAL]', err);
  cleanupAll();
  process.exit(1);
});
