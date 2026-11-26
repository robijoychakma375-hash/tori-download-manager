#!/usr/bin/env node
/**
 * TORI Gate 35.3 — Signed Firefox v1.0.11 XPI Permanent Install, Upgrade,
 * Restart Persistence, Desktop v1.0.8 Compatibility & Live Adversarial QA
 *
 * Tests `release/v1.0.11-extension-rc/tori-companion-v1.0.11-firefox-signed.xpi`
 * in REAL Mozilla Firefox under strict `xpinstall.signatures.required = true`:
 *   1. Cryptographic & byte-parity audit of staged XPI against unsigned ZIP & Chromium ZIP preservation.
 *   2. Real in-place upgrade from Mozilla-signed v1.0.10 XPI -> Mozilla-signed v1.0.11 XPI
 *      (temporary: false) with v1.0.10 settings migration verified.
 *   3. Verifies Firefox AddonManager reports:
 *      - xpinstall.signatures.required === true
 *      - id === 'tori-download-manager@toridm.org'
 *      - version === '1.0.11'
 *      - isActive === true
 *      - temporarilyInstalled === false
 *      - signedState === AddonManager.SIGNEDSTATE_SIGNED
 *   4. Full Firefox shutdown + cold restart on SAME profile (without re-installing):
 *      - Add-on remains permanently installed, active, and Mozilla-signed.
 *      - Zero unsolicited Native Messaging invocations when Desktop is offline.
 *   5. Live Desktop v1.0.8 Native Messaging pairing, popup auth + token minimization,
 *      live adversarial webpage + cross-origin iframe + SPA nav attacks, overlay media download,
 *      real browser download interception with exact SHA-256, and duplicate prevention.
 *   6. Second full Firefox restart WITH completed browser download history:
 *      - Zero stale download replay & zero unsolicited Native Messaging spawns.
 *   7. Restores exact host HKCU NativeMessagingHosts registry values in finally (bit-for-bit verified).
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const V108_DESKTOP_EXE = process.env.TORI_DESKTOP_EXE || path.join(ROOT, 'release', 'v1.0.8-final-rc', 'tori-download-manager.exe');
const V108_HOST_EXE = process.env.TORI_HOST_EXE || path.join(ROOT, 'release', 'v1.0.8-final-rc', 'tdm-native-host.exe');
const FFMPEG_EXE = path.join(ROOT, 'resources', 'bin', 'ffmpeg.exe');

const SIGNED_V1010_XPI = path.join(ROOT, 'release', 'v1.0.10-extension-rc', 'tori-companion-v1.0.10-firefox-signed.xpi');
const SIGNED_V1011_XPI = process.env.TORI_SIGNED_V1011_XPI || path.join(ROOT, 'release', 'v1.0.11-extension-rc', 'tori-companion-v1.0.11-firefox-signed.xpi');
const UNSIGNED_V1011_ZIP = path.join(ROOT, 'release', 'v1.0.11-extension-rc', 'tori-companion-v1.0.11-firefox.zip');
const CHROMIUM_V1011_ZIP = path.join(ROOT, 'release', 'v1.0.11-extension-rc', 'tori-companion-v1.0.11-chromium.zip');

const EXPECTED_SIGNED_V1011_SHA = '4cd6d6fbf067cb98538fd807eaba360d40b409df07cbfb515b8d9b702b37c0fd';
const EXPECTED_UNSIGNED_V1011_SHA = '2df9b5cb1e391b9023f6b4217efee9baa182c36aaeb8c3e891a71515abf9edad';
const EXPECTED_CHROMIUM_V1011_SHA = '1e77592bb05e548d832df373331aee4f90788a004cdaef7ca80c97df84b88559';
const EXPECTED_GECKO_ID = 'tori-download-manager@toridm.org';

const FIREFOX_EXE = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';

const QA_ROOT = path.join(ROOT, 'target', 'gate35_3_signed_ff_qa');
const QA_DATA_DIR = path.join(QA_ROOT, 'data');
const QA_DL_DIR = path.join(QA_ROOT, 'downloads');
const QA_WV2_DIR = path.join(QA_ROOT, 'webview2');
const QA_FF_PROF = path.join(QA_ROOT, 'firefox_profile');
const QA_FF_DL_DIR = path.join(QA_ROOT, 'firefox_dl');
const QA_SAMPLE_MP4 = path.join(QA_ROOT, 'sample_video.mp4');
const QA_NM_LOG = path.join(QA_ROOT, 'nm_invocations.log');
const QA_NM_CMD = path.join(QA_ROOT, 'qa_native_host.cmd');

const DESKTOP_PORT = 26991;
const PIPE_NAME = '\\\\.\\pipe\\tori-gate35-3-signed-ff-ipc';
const FIXTURE_PORT_A = 26995;
const FIXTURE_PORT_B = 26996;
const FF_MARIONETTE_PORT = 2863;
const API_TOKEN = 'tori_qa_g35_3_signed_ff_token_44321';

const ZIP_PAYLOAD = Buffer.alloc(256 * 1024);
for (let i = 0; i < ZIP_PAYLOAD.length; i++) ZIP_PAYLOAD[i] = (i * 37 + 19) & 0xff;
const ZIP_SHA256 = crypto.createHash('sha256').update(ZIP_PAYLOAD).digest('hex');

const NM_REG_KEY_FF = 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.tori.download_manager';

const results = [];
const counts = { PASS: 0, FAIL: 0 };
const trackedProcs = new Set();
let regBackupVal = null;
let serverA = null;
let serverB = null;
let desktopProc = null;

function record(id, desc, ok, detail = '') {
  const status = ok ? 'PASS' : 'FAIL';
  counts[status]++;
  console.log(`[${status}] [Firefox Signed v1.0.11] [${id}] ${desc}${detail ? ' -> ' + detail : ''}`);
  results.push({ id, desc, status, detail });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function killProcTree(pid) {
  if (!pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
  } catch { }
}

function queryRegSz(key) {
  try {
    const out = execFileSync('reg', ['query', key, '/ve'], { encoding: 'utf8', timeout: 4000 });
    const m = out.match(/REG_SZ\s+(.+)/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function setRegSz(key, val) {
  if (val === null) {
    execFileSync('reg', ['delete', key, '/f'], { stdio: 'ignore', timeout: 4000 });
  } else {
    execFileSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', val, '/f'], { stdio: 'ignore', timeout: 4000 });
  }
}

function getNmCount() {
  if (!fs.existsSync(QA_NM_LOG)) return 0;
  return fs.readFileSync(QA_NM_LOG, 'utf8').split(/\r?\n/).filter((l) => l.trim()).length;
}

function ensureSampleMp4() {
  if (fs.existsSync(QA_SAMPLE_MP4) && fs.statSync(QA_SAMPLE_MP4).size > 4096) return;
  execFileSync(
    FFMPEG_EXE,
    ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=480x360:rate=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', QA_SAMPLE_MP4],
    { stdio: 'ignore', timeout: 15000 }
  );
}

function seedQaDesktopSqlite() {
  fs.mkdirSync(QA_DATA_DIR, { recursive: true });
  fs.mkdirSync(QA_DL_DIR, { recursive: true });
  const dbPath = path.join(QA_DATA_DIR, 'tdm_storage.sqlite');
  const py = `
import sqlite3, json, sys
db_path, dl_dir, token, port = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
conn = sqlite3.connect(db_path)
cur = conn.cursor()
cur.execute("CREATE TABLE IF NOT EXISTS engine_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
app_settings = {
  "dir": dl_dir, "sort": False, "con": 4, "maxa": 3, "limMode": "off", "limV": 512, "limU": "KiB/s",
  "retries": 1, "dyn": True, "mps": 256, "mpsU": "KiB", "ua": "", "ssl": False, "lm": False,
  "track": True, "dns": "System DNS", "proxy": "none", "port": port, "key": token,
  "cap": True, "theme": "light", "accent": "indigo", "motion": False, "details": False,
  "showDownloadPopup": "never", "alwaysOnTop": False, "closeToTray": True
}
cur.execute("INSERT OR REPLACE INTO engine_settings(key, value) VALUES ('app_settings', ?)", (json.dumps(app_settings),))
cur.execute("INSERT OR REPLACE INTO engine_settings(key, value) VALUES ('browser_integration_token', ?)", (token,))
cur.execute("INSERT OR REPLACE INTO engine_settings(key, value) VALUES ('active_server_port', ?)", (str(port),))
conn.commit()
conn.close()
`;
  execFileSync('python', ['-c', py, dbPath, QA_DL_DIR, API_TOKEN, String(DESKTOP_PORT)], { stdio: 'inherit' });
}

function httpJson({ port, reqPath, method = 'GET', headers = {}, timeoutMs = 4000 }) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: reqPath, method, headers, timeout: timeoutMs }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch { }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data, raw });
      });
    });
    req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }); });
    req.end();
  });
}

async function listDesktopDownloads() {
  const r = await httpJson({
    port: DESKTOP_PORT,
    reqPath: '/api/v1/downloads',
    headers: { 'X-Tori-Token': API_TOKEN },
  });
  return Array.isArray(r.data?.jobs) ? r.data.jobs : [];
}

async function startDesktopV108() {
  const env = {
    ...process.env,
    TORI_DATA_DIR: QA_DATA_DIR,
    TORI_IPC_PIPE: PIPE_NAME,
    TORI_LOCAL_PORT: String(DESKTOP_PORT),
    TORI_ALLOW_LOOPBACK: '1',
    WEBVIEW2_USER_DATA_FOLDER: QA_WV2_DIR,
  };
  desktopProc = spawn(V108_DESKTOP_EXE, ['--minimized'], { env, stdio: 'ignore' });
  trackedProcs.add(desktopProc);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const r = await httpJson({
      port: DESKTOP_PORT,
      reqPath: '/api/v1/status',
      headers: { 'X-Tori-Token': API_TOKEN },
      timeoutMs: 1500,
    });
    if (r.ok && r.data?.authenticated) return r.data;
    await sleep(300);
  }
  throw new Error('Timed out waiting for Desktop v1.0.8');
}

function startFixtureServers() {
  const mp4Buf = fs.readFileSync(QA_SAMPLE_MP4);
  const videoHtml = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>TORI Gate 35.3 Signed Firefox QA</title>
<style>
  body { background: #111; color: #eee; font-family: sans-serif; padding: 20px; }
  video { width: 480px; height: 360px; display: block; background: #000; }
  #dl-link { display: inline-block; margin-top: 16px; padding: 10px 18px; background: #4f46e5; color: #fff; text-decoration: none; border-radius: 6px; }
  iframe { width: 480px; height: 120px; border: 1px solid #444; margin-top: 16px; display: block; }
</style>
</head>
<body>
  <video id="v1" src="/sample.mp4?signed=1" controls muted autoplay loop playsinline></video>
  <a id="dl-link" href="/sample_archive_signed.zip" download="sample_archive_signed.zip">Download Signed Test Archive</a>
  <iframe id="xframe" src="http://127.0.0.1:${FIXTURE_PORT_B}/evil_iframe.html"></iframe>
  <script>
    window.__iframeAttackResult = null;
    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'IFRAME_ATTACK_DONE') window.__iframeAttackResult = e.data.report;
    });
    window.runHostilePageAttack = async function() {
      const report = {
        toriExtensionUrl: document.documentElement.dataset.toriExtensionUrl ?? null,
        dispatchResponseReceived: false,
        portalExists: !!document.getElementById('tori-overlay-portal-host'),
        portalShadowAccessible: !!(document.getElementById('tori-overlay-portal-host')?.shadowRoot),
      };
      await new Promise((resolve) => {
        const reqId = 'signed_atk_' + Math.random().toString(36).slice(2);
        const onResp = () => { report.dispatchResponseReceived = true; };
        window.addEventListener('__TORI_RESPONSE__' + reqId, onResp, { once: true });
        window.dispatchEvent(new CustomEvent('__TORI_DISPATCH__', { detail: { action: 'INITIATE_PAIRING', payload: {}, id: reqId } }));
        setTimeout(() => { window.removeEventListener('__TORI_RESPONSE__' + reqId, onResp); resolve(); }, 450);
      });
      const pill = document.querySelector('.tori-pill');
      if (pill) { pill.click(); pill.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
      const dlBtn = document.querySelector('[data-act="download"]');
      if (dlBtn) { dlBtn.click(); dlBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
      return report;
    };
  </script>
</body></html>`;

  const evilIframeHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Cross-Origin Evil Iframe</title></head>
<body><script>
  (async () => {
    const report = {
      toriExtensionUrl: document.documentElement.dataset.toriExtensionUrl ?? null,
      dispatchResponseReceived: false,
    };
    await new Promise((resolve) => {
      const id = 'ff_iframe_atk';
      window.addEventListener('__TORI_RESPONSE__' + id, () => { report.dispatchResponseReceived = true; }, { once: true });
      window.dispatchEvent(new CustomEvent('__TORI_DISPATCH__', { detail: { action: 'INITIATE_PAIRING', payload: {}, id } }));
      setTimeout(resolve, 400);
    });
    window.parent.postMessage({ type: 'IFRAME_ATTACK_DONE', report }, '*');
  })();
</script></body></html>`;

  serverA = http.createServer((req, res) => {
    const u = new URL(req.url || '/', `http://127.0.0.1:${FIXTURE_PORT_A}`);
    const p = u.pathname;
    if (p === '/video.html' || p === '/video-nav2') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(videoHtml);
    } else if (p === '/sample.mp4') {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': mp4Buf.length, 'Accept-Ranges': 'bytes' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': mp4Buf.length, 'Accept-Ranges': 'bytes' });
      res.end(mp4Buf);
    } else if (p === '/sample_archive_signed.zip') {
      const hdrs = {
        'Content-Type': 'application/zip',
        'Content-Length': ZIP_PAYLOAD.length,
        'Content-Disposition': 'attachment; filename="sample_archive_signed.zip"',
        'Accept-Ranges': 'bytes',
      };
      if (req.method === 'HEAD') { res.writeHead(200, hdrs); return res.end(); }
      const range = req.headers.range;
      if (range) {
        const m = range.match(/bytes=(\d+)-(\d*)/);
        const start = m ? parseInt(m[1], 10) : 0;
        const end = m && m[2] ? Math.min(parseInt(m[2], 10), ZIP_PAYLOAD.length - 1) : ZIP_PAYLOAD.length - 1;
        const slice = ZIP_PAYLOAD.subarray(start, end + 1);
        res.writeHead(206, { ...hdrs, 'Content-Range': `bytes ${start}-${end}/${ZIP_PAYLOAD.length}`, 'Content-Length': slice.length });
        return res.end(slice);
      }
      res.writeHead(200, hdrs);
      res.end(ZIP_PAYLOAD);
    } else {
      res.writeHead(404); res.end('Not Found');
    }
  });

  serverB = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(evilIframeHtml);
  });

  return Promise.all([
    new Promise((r) => serverA.listen(FIXTURE_PORT_A, '127.0.0.1', r)),
    new Promise((r) => serverB.listen(FIXTURE_PORT_B, '127.0.0.1', r)),
  ]);
}

class MarionetteClient {
  constructor(port = FF_MARIONETTE_PORT) {
    this.port = port;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
  }
  async connect(timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        return await this._connectOnce(Math.max(1000, deadline - Date.now()));
      } catch (e) {
        if (String(e.message || e.code).includes('ECONNREFUSED')) { await sleep(300); continue; }
        throw e;
      }
    }
    throw new Error('Marionette connect timeout');
  }
  _connectOnce(timeoutMs) {
    return new Promise((resolve, reject) => {
      this.buf = Buffer.alloc(0);
      const sock = net.createConnection({ host: '127.0.0.1', port: this.port });
      this.socket = sock;
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; sock.destroy(); reject(new Error('Marionette handshake timeout')); } }, timeoutMs);
      sock.on('error', (err) => { if (!done) { done = true; clearTimeout(timer); reject(err); } });
      sock.on('data', (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        while (true) {
          const ci = this.buf.indexOf(0x3a);
          if (ci === -1) break;
          const len = parseInt(this.buf.subarray(0, ci).toString('ascii'), 10);
          if (Number.isNaN(len) || this.buf.length < ci + 1 + len) break;
          const payload = this.buf.subarray(ci + 1, ci + 1 + len).toString('utf8');
          this.buf = this.buf.subarray(ci + 1 + len);
          const msg = JSON.parse(payload);
          if (msg.marionetteProtocol) {
            if (!done) { done = true; clearTimeout(timer); resolve(msg); }
          } else if (Array.isArray(msg) && msg.length >= 4) {
            const [, id, err, res] = msg;
            if (this.pending.has(id)) {
              const p = this.pending.get(id);
              this.pending.delete(id);
              if (err) p.rej(new Error(JSON.stringify(err)));
              else p.res(res);
            }
          }
        }
      });
    });
  }
  send(cmd, params = {}, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Marionette ${cmd} timeout`)); }, timeoutMs);
      this.pending.set(id, { res: (v) => { clearTimeout(timer); resolve(v); }, rej: (e) => { clearTimeout(timer); reject(e); } });
      const body = JSON.stringify([0, id, cmd, params]);
      this.socket.write(`${Buffer.byteLength(body, 'utf8')}:${body}`);
    });
  }
  async evalAsync(fnBody, timeoutMs = 12000) {
    const r = await this.send('WebDriver:ExecuteAsyncScript', {
      script: `const done = arguments[arguments.length - 1]; Promise.resolve((async () => { ${fnBody} })()).then(v => done({ ok: true, v }), e => done({ ok: false, e: String(e) }));`,
      args: [],
    }, timeoutMs);
    const val = r?.value;
    if (!val?.ok) throw new Error(val?.e || 'Marionette eval failed');
    return val.v;
  }
  close() { try { this.socket?.destroy(); } catch { } }
}

async function waitForCond(fn, timeoutMs = 12000, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v; } catch { }
    await sleep(stepMs);
  }
  return null;
}

async function launchFirefoxOnProfile(url) {
  const proc = spawn(
    FIREFOX_EXE,
    ['-no-remote', '-marionette', '-profile', QA_FF_PROF, url],
    { env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' }, stdio: 'ignore' }
  );
  trackedProcs.add(proc);
  const mar = new MarionetteClient(FF_MARIONETTE_PORT);
  await mar.connect(25000);
  await mar.send('WebDriver:NewSession', { capabilities: {} });
  await mar.send('WebDriver:SetWindowRect', { width: 1280, height: 900 });
  return { proc, mar };
}

async function inspectAddonStateChrome(mar) {
  await mar.send('Marionette:SetContext', { value: 'chrome' });
  try {
    const r = await mar.send('WebDriver:ExecuteAsyncScript', {
      script: `
        const done = arguments[arguments.length - 1];
        (async () => {
          const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
          const sigReq = Services.prefs.getBoolPref("xpinstall.signatures.required", false);
          let addon = null, policy = null;
          for (let i = 0; i < 40; i++) {
            addon = await AddonManager.getAddonByID(${JSON.stringify(EXPECTED_GECKO_ID)});
            policy = WebExtensionPolicy.getByID(${JSON.stringify(EXPECTED_GECKO_ID)});
            if (addon && addon.isActive && policy && policy.active) break;
            await new Promise(r => setTimeout(r, 200));
          }
          done({
            sigRequiredPref: sigReq,
            id: addon?.id || null,
            version: addon?.version || null,
            isActive: !!addon?.isActive,
            temporarilyInstalled: addon?.temporarilyInstalled,
            signedState: addon?.signedState,
            expectedSignedState: AddonManager.SIGNEDSTATE_SIGNED,
            mozExtensionHost: policy?.mozExtensionHostname || null,
          });
        })();
      `,
      args: [],
    });
    return r.value;
  } finally {
    await mar.send('Marionette:SetContext', { value: 'content' });
  }
}

async function main() {
  const watchdog = setTimeout(() => {
    console.error('[WATCHDOG] Hard 150s timeout reached; cleaning up & restoring registry...');
    for (const p of trackedProcs) if (p?.pid) killProcTree(p.pid);
    setRegSz(NM_REG_KEY_FF, regBackupVal);
    process.exit(124);
  }, 150000);
  watchdog.unref();

  console.log('=== TORI Gate 35.3 — Signed Firefox v1.0.11 Permanent Install & QA ===');
  fs.rmSync(QA_ROOT, { recursive: true, force: true });
  fs.mkdirSync(QA_ROOT, { recursive: true });
  fs.mkdirSync(QA_FF_PROF, { recursive: true });
  fs.mkdirSync(QA_FF_DL_DIR, { recursive: true });
  fs.writeFileSync(QA_NM_LOG, '', 'utf8');

  // 1. Artifact hash checks
  const sSha = sha256File(SIGNED_V1011_XPI);
  const uSha = sha256File(UNSIGNED_V1011_ZIP);
  const cSha = sha256File(CHROMIUM_V1011_ZIP);
  record('HASHES', 'Staged signed XPI, unsigned ZIP, and Chromium ZIP SHA-256 verified',
    sSha === EXPECTED_SIGNED_V1011_SHA && uSha === EXPECTED_UNSIGNED_V1011_SHA && cSha === EXPECTED_CHROMIUM_V1011_SHA,
    `signedXpi=${sSha}`
  );

  ensureSampleMp4();
  seedQaDesktopSqlite();
  await startFixtureServers();

  // Setup isolated Native Messaging host wrapper pointing to frozen v1.0.8 tdm-native-host.exe
  regBackupVal = queryRegSz(NM_REG_KEY_FF);
  const cmdBody = [
    '@echo off',
    `echo %DATE% %TIME% INVOKED >> "${QA_NM_LOG}"`,
    `set "TORI_DATA_DIR=${QA_DATA_DIR}"`,
    `set "TORI_IPC_PIPE=${PIPE_NAME}"`,
    `set "TORI_LOCAL_PORT=${DESKTOP_PORT}"`,
    'set "TORI_DISABLE_AUTO_SPAWN=1"',
    'set "TORI_ALLOW_LOOPBACK=1"',
    `"${V108_HOST_EXE}" %*`,
    '',
  ].join('\r\n');
  fs.writeFileSync(QA_NM_CMD, cmdBody, 'ascii');
  const ffManifest = path.join(QA_ROOT, 'nm_firefox.json');
  fs.writeFileSync(ffManifest, JSON.stringify({
    name: 'com.tori.download_manager',
    description: 'TORI Gate 35.3 Signed Firefox QA Host (v1.0.8)',
    path: QA_NM_CMD,
    type: 'stdio',
    allowed_extensions: [EXPECTED_GECKO_ID],
  }, null, 2));
  setRegSz(NM_REG_KEY_FF, ffManifest);

  fs.writeFileSync(
    path.join(QA_FF_PROF, 'user.js'),
    [
      'user_pref("marionette.enabled", true);',
      `user_pref("marionette.port", ${FF_MARIONETTE_PORT});`,
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("browser.startup.homepage_override.mstone", "ignore");',
      'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
      'user_pref("toolkit.telemetry.enabled", false);',
      'user_pref("xpinstall.signatures.required", true);',
      'user_pref("media.autoplay.default", 0);',
      'user_pref("browser.download.folderList", 2);',
      `user_pref("browser.download.dir", ${JSON.stringify(QA_FF_DL_DIR)});`,
      'user_pref("browser.download.useDownloadDir", true);',
    ].join('\n'),
    'utf8'
  );

  let ff = null;
  try {
    // SESSION 1: Install signed public v1.0.10 permanently -> seed v1.0.10 settings -> upgrade permanently to signed v1.0.11!
    ff = await launchFirefoxOnProfile('about:blank');

    const inst10 = await ff.mar.send('Addon:Install', { path: SIGNED_V1010_XPI, temporary: false }, 25000);
    const st10 = await inspectAddonStateChrome(ff.mar);
    record('INSTALL_V1010', 'Baseline signed public v1.0.10 XPI installed permanently under strict signatures',
      inst10?.value === EXPECTED_GECKO_ID && st10.version === '1.0.10' && st10.signedState === st10.expectedSignedState && st10.temporarilyInstalled === false,
      `ver=${st10.version}, signedState=${st10.signedState}, temp=${st10.temporarilyInstalled}`
    );

    // Seed realistic v1.0.10 settings in chrome.storage.local
    await ff.mar.send('WebDriver:Navigate', { url: `moz-extension://${st10.mozExtensionHost}/options/options.html` });
    await sleep(600);
    await ff.mar.evalAsync(`
      await new Promise(r => chrome.storage.local.set({
        tori_settings: { port: ${DESKTOP_PORT}, key: '', auto: true, cap: true, incog: false, pill: true, picker: true, audio: true, badge: true, theme: 'dark', accent: 'emerald', min: 0, types: ['zip', 'mp4', 'exe'], sites: ['excluded.example.com'] },
        tori_theme: 'dark',
        tori_accent: 'emerald'
      }, () => r(true)));
      return true;
    `);

    // Navigate away from moz-extension:// before in-place XPI upgrade so Windows releases the v1.0.10 .xpi file lock
    await ff.mar.send('WebDriver:Navigate', { url: 'about:blank' });
    await sleep(800);

    // Upgrade IN-PLACE to Mozilla-signed v1.0.11 XPI with temporary: false under xpinstall.signatures.required = true!
    const inst11 = await ff.mar.send('Addon:Install', { path: SIGNED_V1011_XPI, temporary: false }, 25000);
    await sleep(800);
    const st11 = await inspectAddonStateChrome(ff.mar);
    const permOk =
      inst11?.value === EXPECTED_GECKO_ID &&
      st11.sigRequiredPref === true &&
      st11.id === EXPECTED_GECKO_ID &&
      st11.version === '1.0.11' &&
      st11.isActive === true &&
      st11.temporarilyInstalled === false &&
      st11.signedState === st11.expectedSignedState;
    record('PERM_INSTALL_V1011', 'Signed v1.0.11 XPI upgraded permanently in standard Firefox (xpinstall.signatures.required=true, SIGNEDSTATE_SIGNED)',
      permOk,
      JSON.stringify(st11)
    );

    // Verify v1.0.10 settings migrated intact into upgraded v1.0.11
    await ff.mar.send('WebDriver:Navigate', { url: `moz-extension://${st11.mozExtensionHost}/options/options.html` });
    await sleep(600);
    const optVer1 = await ff.mar.evalAsync(`return document.getElementById('ab-ver')?.textContent?.trim();`);
    const mig = await ff.mar.evalAsync(`return await new Promise(r => chrome.storage.local.get('tori_settings', v => r(v.tori_settings)));`);
    record('UPGRADE_MIGRATE', 'Real v1.0.10 -> v1.0.11 signed XPI upgrade preserved all user settings',
      optVer1 === '1.0.11' && mig?.theme === 'dark' && mig?.accent === 'emerald' && mig?.port === DESKTOP_PORT && mig?.sites?.includes('excluded.example.com'),
      `ver=${optVer1}, theme=${mig?.theme}, accent=${mig?.accent}, port=${mig?.port}`
    );

    // Close Firefox cleanly (Session 1 end)
    ff.mar.close();
    killProcTree(ff.proc.pid);
    trackedProcs.delete(ff.proc);
    ff = null;
    await sleep(1200);

    // SESSION 2: COLD FIREFOX RESTART (Desktop STILL OFFLINE!) -> verify permanent persistence + ZERO unsolicited NM spawn!
    fs.writeFileSync(QA_NM_LOG, '', 'utf8');
    ff = await launchFirefoxOnProfile('about:blank');
    await sleep(2200);
    const stRestart = await inspectAddonStateChrome(ff.mar);
    const nmOnOfflineRestart = getNmCount();
    const persistOk =
      stRestart.sigRequiredPref === true &&
      stRestart.id === EXPECTED_GECKO_ID &&
      stRestart.version === '1.0.11' &&
      stRestart.isActive === true &&
      stRestart.temporarilyInstalled === false &&
      stRestart.signedState === stRestart.expectedSignedState;
    record('RESTART_PERSIST', 'Signed v1.0.11 XPI persists active & Mozilla-signed across full Firefox restart without re-install',
      persistOk,
      `ver=${stRestart.version}, active=${stRestart.isActive}, temp=${stRestart.temporarilyInstalled}, signedState=${stRestart.signedState}`
    );
    record('OFFLINE_RESTART_NO_SPAWN', 'Cold Firefox restart with unpaired signed v1.0.11 triggers ZERO unsolicited Native Messaging spawns',
      nmOnOfflineRestart === 0,
      `nmInvocations=${nmOnOfflineRestart}`
    );

    // Boot REAL frozen public Desktop v1.0.8 now!
    const deskStatus = await startDesktopV108();
    record('DESKTOP_V108_BOOT', 'Frozen public Desktop v1.0.8 started in isolated sandbox', !!deskStatus.authenticated, `port=${DESKTOP_PORT}`);

    const ffBase = `moz-extension://${stRestart.mozExtensionHost}`;

    // Native Messaging pairing from trusted options.html against Desktop v1.0.8
    await ff.mar.send('WebDriver:Navigate', { url: `${ffBase}/options/options.html` });
    await sleep(600);
    const nmBeforePair = getNmCount();
    const pairRes = await ff.mar.evalAsync(`return await new Promise(r => chrome.runtime.sendMessage({ action: 'INITIATE_PAIRING' }, res => r(res)));`, 12000);
    const nmAfterPair = getNmCount();
    record('NM_PAIR_V108', 'Trusted options.html Native Messaging pairing succeeds with Desktop v1.0.8',
      pairRes?.ok === true && pairRes?.token === API_TOKEN && nmAfterPair > nmBeforePair,
      `ok=${pairRes?.ok}, tokenMatched=${pairRes?.token === API_TOKEN}, port=${pairRes?.port}, nmCalls=${nmAfterPair - nmBeforePair}`
    );

    // Trusted popup.html check & token minimization
    await ff.mar.send('WebDriver:Navigate', { url: `${ffBase}/popup/popup.html` });
    await sleep(500);
    const popPing = await ff.mar.evalAsync(`return await new Promise(r => chrome.runtime.sendMessage({ action: 'PING_DESKTOP', passive: true }, res => r(res)));`, 8000);
    record('POPUP_AUTH', 'Trusted popup.html PING_DESKTOP authenticates with Desktop v1.0.8 & strips raw token',
      popPing?.status === 'ok' && popPing?.authenticated === true && popPing?.token === undefined,
      `auth=${popPing?.authenticated}, tokenLeaked=${popPing?.token !== undefined}`
    );

    // Live adversarial security regression on permanently installed signed XPI
    const jobsBeforeAtk = (await listDesktopDownloads()).length;
    const nmBeforeAtk = getNmCount();
    await ff.mar.send('WebDriver:Navigate', { url: `http://127.0.0.1:${FIXTURE_PORT_A}/video.html` });
    await waitForCond(() => ff.mar.evalAsync(`return !!document.querySelector('.tori-pill') && !!window.__iframeAttackResult;`), 12000);

    const pageAtk = await ff.mar.evalAsync(`return await window.runHostilePageAttack();`, 10000);
    const iframeAtk = await ff.mar.evalAsync(`return window.__iframeAttackResult;`, 5000);
    await ff.mar.evalAsync(`
      history.pushState({}, '', '/video-nav2');
      window.dispatchEvent(new PopStateEvent('popstate'));
      document.getElementById('xframe').src = 'http://127.0.0.1:${FIXTURE_PORT_B}/evil_iframe.html?nav=2';
      await new Promise(r => setTimeout(r, 600));
      return true;
    `, 8000);
    const postNavAtk = await ff.mar.evalAsync(`return await window.runHostilePageAttack();`, 10000);
    const jobsAfterAtk = (await listDesktopDownloads()).length;
    const nmAfterAtk = getNmCount();
    record('ADVERSARIAL_SIGNED_LIVE', 'Live adversarial attacks (page JS, __TORI_DISPATCH__, closed shadow, synthetic click, cross-origin iframe, SPA nav) ALL blocked on permanently installed signed XPI',
      pageAtk.toriExtensionUrl === null &&
      pageAtk.dispatchResponseReceived === false &&
      pageAtk.portalExists === true &&
      pageAtk.portalShadowAccessible === false &&
      iframeAtk?.toriExtensionUrl === null &&
      iframeAtk?.dispatchResponseReceived === false &&
      postNavAtk.toriExtensionUrl === null &&
      postNavAtk.dispatchResponseReceived === false &&
      jobsAfterAtk === jobsBeforeAtk &&
      nmAfterAtk === nmBeforeAtk,
      `urlLeak=${pageAtk.toriExtensionUrl}, dispatchResp=${pageAtk.dispatchResponseReceived}, shadowOpen=${pageAtk.portalShadowAccessible}, iframeResp=${iframeAtk?.dispatchResponseReceived}, jobsDelta=${jobsAfterAtk - jobsBeforeAtk}, nmDelta=${nmAfterAtk - nmBeforeAtk}`
    );

    // Real trusted pointer click: overlay media capture & download + browser archive interception + dedup
    const clickPoint = async (x, y) => {
      await ff.mar.send('WebDriver:PerformActions', {
        actions: [{
          type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', duration: 30, x: Math.round(x), y: Math.round(y), origin: 'viewport' },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 40 },
            { type: 'pointerUp', button: 0 },
          ],
        }],
      });
      await ff.mar.send('WebDriver:ReleaseActions', {});
    };

    const pillRect = await ff.mar.evalAsync(`const r = document.querySelector('.tori-pill')?.getBoundingClientRect(); return r ? { x: r.left + r.width/2, y: r.top + r.height/2 } : null;`);
    if (pillRect) await clickPoint(pillRect.x, pillRect.y);
    const panelOpen = await waitForCond(() => ff.mar.evalAsync(`return !!document.querySelector('.tori-pn.on [data-act="download"]:not([disabled])');`), 8000);
    let mediaQueued = false;
    if (panelOpen) {
      const dlRect = await ff.mar.evalAsync(`const r = document.querySelector('.tori-pn.on [data-act="download"]').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 };`);
      const before = (await listDesktopDownloads()).length;
      await clickPoint(dlRect.x, dlRect.y);
      const after = await waitForCond(async () => { const j = await listDesktopDownloads(); return j.length > before ? j.length : null; }, 8000);
      mediaQueued = after !== null && after > before;
    }
    record('OVERLAY_MEDIA_DL', 'Real trusted click on signed XPI overlay queues media download in Desktop v1.0.8', !!panelOpen && mediaQueued, `panelOpen=${!!panelOpen}, queued=${mediaQueued}`);

    const linkRect = await ff.mar.evalAsync(`const r = document.getElementById('dl-link').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 };`);
    await clickPoint(linkRect.x, linkRect.y);
    const zipJob = await waitForCond(async () => {
      const jobs = await listDesktopDownloads();
      const matched = jobs.filter((j) => String(j.url || '').includes('sample_archive_signed.zip'));
      if (matched.length > 0 && String(matched[matched.length - 1].state || '').toLowerCase() === 'completed') {
        return matched[matched.length - 1];
      }
      return null;
    }, 15000);
    const dlFilePath = zipJob?.filename ? path.join(QA_DL_DIR, zipJob.filename) : null;
    const zipShaOk = dlFilePath && fs.existsSync(dlFilePath) && sha256File(dlFilePath) === ZIP_SHA256;
    record('INTERCEPT_DL', 'Signed XPI intercepts browser download & Desktop v1.0.8 completes with exact SHA-256', !!zipJob && zipShaOk, `file=${zipJob?.filename}, shaMatch=${zipShaOk}`);

    const countAfter1 = (await listDesktopDownloads()).filter((j) => String(j.url || '').includes('sample_archive_signed.zip')).length;
    await clickPoint(linkRect.x, linkRect.y);
    await sleep(1500);
    const countAfter2 = (await listDesktopDownloads()).filter((j) => String(j.url || '').includes('sample_archive_signed.zip')).length;
    record('DEDUP', 'Duplicate download prevented within cooldown window', countAfter1 === 1 && countAfter2 === 1, `before=${countAfter1}, after=${countAfter2}`);

    // SESSION 3: Second full Firefox restart WITH completed download history in persistent profile -> ZERO stale replay!
    ff.mar.close();
    killProcTree(ff.proc.pid);
    trackedProcs.delete(ff.proc);
    ff = null;
    await sleep(1200);

    const jobsBeforeR2 = (await listDesktopDownloads()).length;
    const nmBeforeR2 = getNmCount();
    ff = await launchFirefoxOnProfile('about:blank');
    await sleep(2500);
    const stR2 = await inspectAddonStateChrome(ff.mar);
    const jobsAfterR2 = (await listDesktopDownloads()).length;
    const nmAfterR2 = getNmCount();
    record('RESTART_NO_REPLAY_WITH_HISTORY', 'Full Firefox restart with persisted completed download history triggers ZERO stale replays & ZERO unsolicited NM spawns',
      stR2.isActive === true && stR2.version === '1.0.11' && jobsAfterR2 === jobsBeforeR2 && nmAfterR2 === nmBeforeR2,
      `active=${stR2.isActive}, jobsDelta=${jobsAfterR2 - jobsBeforeR2}, nmDelta=${nmAfterR2 - nmBeforeR2}`
    );
  } finally {
    try { ff?.mar?.close(); } catch { }
    for (const p of trackedProcs) if (p?.pid) killProcTree(p.pid);
    trackedProcs.clear();
    try { serverA?.close(); } catch { }
    try { serverB?.close(); } catch { }
    setRegSz(NM_REG_KEY_FF, regBackupVal);
    const restoredVal = queryRegSz(NM_REG_KEY_FF);
    record('REG_RESTORE', 'Host HKCU Mozilla NativeMessagingHosts registry restored bit-for-bit', restoredVal === regBackupVal, `restored=${restoredVal === regBackupVal}`);
  }

  fs.writeFileSync(path.join(QA_ROOT, 'results.json'), JSON.stringify({ counts, results }, null, 2));
  console.log(`\n=== SIGNED FIREFOX v1.0.11 QA SUMMARY: PASS=${counts.PASS} FAIL=${counts.FAIL} ===`);
  if (counts.FAIL > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  for (const p of trackedProcs) if (p?.pid) killProcTree(p.pid);
  setRegSz(NM_REG_KEY_FF, regBackupVal);
  process.exit(1);
});
